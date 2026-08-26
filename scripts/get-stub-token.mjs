// Mint a REAL Defra ID token from the cdp-defra-id-stub, headlessly, so the perf
// suite can call the authenticated backend without a browser login and without
// the backend trusting any special key. The backend simply verifies the stub's
// JWT against the stub's JWKS (its OIDC_DISCOVERY_URL must point at the stub —
// true on local and, once configured, on the CDP perf-test environment).
//
// This mirrors the harness's scripts/get-stub-token.mjs and follows the DEFRA
// pattern used by trade-demo-perf-tests (a Node setup step in entrypoint.sh that
// provisions the stub user via POST <stub>/API/register). Registration uses the
// stub's JSON API with NO relationships, so the token carries no org context and
// matches the relationship-less project the scenario seeds.
//
// Login is one GET: the stub links each user as `<authorize>&user=<email>`,
// which 302s straight back to the redirect_uri with the code; we exchange it at
// `<stub>/token` (PKCE). The user id is a deterministic UUID of the email, so
// re-runs replace the one perf user in place rather than piling up registrations.
//
// Usage:  node scripts/get-stub-token.mjs   (id_token -> stdout, `sub=` -> stderr)
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";

// Progress goes to stderr; stdout carries ONLY the token so entrypoint.sh can
// capture it with a command substitution.
const note = (msg) => process.stderr.write(`${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`✖ stub-token: ${msg}\n`);
  process.exit(1);
};

// STUB_BASE_URL must include the stub's path prefix, e.g.
// https://cdp-defra-id-stub.perf-test.cdp-int.defra.cloud/cdp-defra-id-stub
const STUB = process.env.STUB_BASE_URL ?? "http://localhost:3200/cdp-defra-id-stub";
const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? "63983fc2-cfff-45bb-8ec2-959e21062b9a";
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET ?? "test_value";
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI ?? "http://localhost:3000/auth/callback";
const SCOPE = process.env.OIDC_SCOPES ?? "openid profile email offline_access";
const PERF_USER_EMAIL = process.env.PERF_USER_EMAIL ?? "bng-perf@bng.example.com";

const MAX_REDIRECTS = 10;
// The stub validates enrolment counts as POSITIVE integers (>= 1), even for a
// user with no relationships.
const MIN_ENROLMENT_COUNT = 1;
const ERROR_SNIPPET_MAX = 200;

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const rand = () => b64url(randomBytes(32));

// ── deterministic UUID (same shape/technique as the harness minter) ─────────
// Not RFC-4122 v5 (that mandates SHA-1, a weak hash) but the same shape:
// SHA-256 truncated to 16 bytes with version/variant bits set, so the same name
// always yields the same UUID-shaped id.
const UUID_NAMESPACE = "1b671a64-40d5-491e-99b0-da01ff1f3341";
const UUID_BYTE_LENGTH = 16;
const UUID_VERSION_INDEX = 6;
const UUID_VERSION_MASK = 0x0f;
const UUID_VERSION_BITS = 0x50;
const UUID_VARIANT_INDEX = 8;
const UUID_VARIANT_MASK = 0x3f;
const UUID_VARIANT_RFC = 0x80;
const UUID_HYPHEN_SHAPE = /^(.{8})(.{4})(.{4})(.{4})(.{12})$/;

function deterministicUuid(name) {
  const namespace = Buffer.from(UUID_NAMESPACE.replaceAll("-", ""), "hex");
  const digest = createHash("sha256").update(namespace).update(name).digest();
  const id = digest.subarray(0, UUID_BYTE_LENGTH);
  id[UUID_VERSION_INDEX] = (id[UUID_VERSION_INDEX] & UUID_VERSION_MASK) | UUID_VERSION_BITS;
  id[UUID_VARIANT_INDEX] = (id[UUID_VARIANT_INDEX] & UUID_VARIANT_MASK) | UUID_VARIANT_RFC;
  return id.toString("hex").replace(UUID_HYPHEN_SHAPE, "$1-$2-$3-$4-$5");
}

const PERF_USER_SUB = deterministicUuid(PERF_USER_EMAIL);

// ── tiny cookie jar (resilient across Node versions) ────────────────────────
function makeJar() {
  const jar = new Map();
  const store = (raw) => {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) {
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  return {
    absorb(response) {
      // getSetCookie() (undici) returns each Set-Cookie separately; fall back to
      // the combined header on older runtimes.
      const list = response.headers.getSetCookie?.();
      if (list?.length) {
        for (const raw of list) {
          store(raw);
        }
        return;
      }
      const combined = response.headers.get("set-cookie");
      if (combined) {
        store(combined);
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function get(url, jar) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { cookie: jar.header() },
  });
  jar.absorb(res);
  return res;
}

const abs = (location, base) => new URL(location, base).href;

function buildAuthorizeUrl(challenge, state, nonce, email) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    user: email,
  });
  return `${STUB}/authorize?${q.toString()}`;
}

// 1. Register (or replace) the perf user via the stub's JSON API.
async function registerPerfUser() {
  note(`▸ stub-token: registering perf user ${PERF_USER_SUB} via ${STUB}/API/register`);
  const res = await fetch(`${STUB}/API/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: PERF_USER_SUB,
      email: PERF_USER_EMAIL,
      firstName: "BNG",
      lastName: "Perf",
      loa: "1",
      aal: "1",
      enrolmentCount: MIN_ENROLMENT_COUNT,
      enrolmentRequestCount: MIN_ENROLMENT_COUNT,
      relationships: [],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    fail(
      `API/register returned HTTP ${res.status}: ${detail.slice(0, ERROR_SNIPPET_MAX)} — is the cdp-defra-id-stub reachable at ${STUB}?`,
    );
  }
}

// 2. Follow authorize -> callback (carrying cookies) until a hop lands back on
// the redirect_uri carrying the authorization code.
async function followToCode(startUrl, jar, expectedState) {
  let url = startUrl;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const res = await get(url, jar);
    const location = res.headers.get("location");
    if (!location) {
      fail(`Expected a redirect toward ${REDIRECT_URI} but got HTTP ${res.status} with no Location (hop ${hop}).`);
    }
    const next = abs(location, url);
    if (next.startsWith(REDIRECT_URI)) {
      const params = new URL(next).searchParams;
      const code = params.get("code");
      if (!code) {
        fail(`Callback redirect had no code: ${next}`);
      }
      if (expectedState && params.get("state") !== expectedState) {
        fail("State mismatch on the authorization callback.");
      }
      return code;
    }
    url = next;
  }
  fail(`Did not reach ${REDIRECT_URI} within ${MAX_REDIRECTS} redirects.`);
  return null;
}

// The stub stamps the token's `iss` from the Host header of the /token request
// (scheme from its appBaseUrl + the request's host), while the backend expects
// whatever issuer its own discovery fetch named. When the two reach the stub by
// different names — a containerised run minting via host.docker.internal against
// a backend that discovered via localhost — the issuers disagree and the backend
// rejects every token. STUB_ISSUER_HOST forces the Host header on this one hop
// so the minted issuer matches the backend's expectation; `fetch` silently
// strips a spoofed `host` header, hence the drop to node:http for it. Unset
// (the CDP case, where everything shares one stub URL), the exchange is a plain
// fetch and behaviour is unchanged.
const ISSUER_HOST = process.env.STUB_ISSUER_HOST ?? "";

function postWithHostHeader(url, hostHeader, body) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: hostHeader },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ ok: res.statusCode < 300, status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Exchange the authorization code for tokens at the stub's /token endpoint
 * (PKCE: the code_verifier proves we started the authorize hop).
 *
 * When STUB_ISSUER_HOST is set the POST goes via node:http with that Host
 * header, pinning the `iss` the stub stamps into the token; otherwise a plain
 * fetch. Exits the process via fail() on a non-2xx response.
 *
 * @param {string} code authorization code returned on the redirect back
 * @param {string} verifier PKCE code_verifier matching the challenge sent
 * @returns {Promise<object>} token response ({ id_token, access_token, … })
 */
async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }).toString();
  let res;
  let text;
  if (ISSUER_HOST) {
    res = await postWithHostHeader(`${STUB}/token`, ISSUER_HOST, body);
    text = res.text;
  } else {
    res = await fetch(`${STUB}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    text = await res.text();
  }
  if (!res.ok) {
    fail(`Token endpoint returned HTTP ${res.status}: ${text.slice(0, ERROR_SNIPPET_MAX)}`);
  }
  return JSON.parse(text);
}

// Decode the JWT payload (claims are not secret; the signature is what matters).
// Used only for diagnostics + the sub the entrypoint reads back.
function decodeClaims(idToken) {
  const payload = idToken.split(".")[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json);
}

const MILLIS_PER_SECOND = 1000;
const isoOrNone = (epochSeconds) =>
  epochSeconds ? new Date(epochSeconds * MILLIS_PER_SECOND).toISOString() : "(none)";

async function main() {
  const jar = makeJar();
  const verifier = rand();
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = rand();
  const nonce = rand();

  await registerPerfUser();

  // Log the non-secret authorize inputs before the hop, so a failure here is
  // immediately attributable — in particular the redirect_uri, whose value is
  // what a CDP WAF 403s when it looks like a localhost/SSRF target.
  note(
    `▸ stub-token: authorize hop → GET ${STUB}/authorize (client_id=${CLIENT_ID}, redirect_uri=${REDIRECT_URI})`,
  );
  const authorizeUrl = buildAuthorizeUrl(challenge, state, nonce, PERF_USER_EMAIL);
  const code = await followToCode(authorizeUrl, jar, state);
  const tokens = await exchangeCode(code, verifier);
  const idToken = tokens.id_token ?? tokens.access_token;
  if (!idToken) {
    fail(`Token response had no id_token: ${JSON.stringify(tokens).slice(0, ERROR_SNIPPET_MAX)}`);
  }

  // Surface the claims the backend verifies against (issuer must match the
  // backend's OIDC_ISSUER; a mismatch is the usual cause of a 401 after a
  // successful mint). Never log the token itself — only its non-secret claims.
  const claims = decodeClaims(idToken);
  note(
    `▸ stub-token: minted ok — sub=${claims.sub} iss=${claims.iss ?? "(none)"} aud=${claims.aud ?? "(none)"} exp=${isoOrNone(claims.exp)}`,
  );
  // sub -> stderr (machine-readable line the entrypoint parses); token -> stdout.
  process.stderr.write(`sub=${claims.sub}\n`);
  process.stdout.write(idToken);
}

await main();

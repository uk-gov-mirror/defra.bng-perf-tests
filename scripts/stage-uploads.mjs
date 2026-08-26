/**
 * Prepare everything the upload scenarios need, before JMeter starts.
 *
 * The upload journey is four steps — initiate, POST the file to the CDP
 * Uploader, wait until it is scanned, then validate. The validate-only phases
 * isolate the service's own cost, so their uploads are staged here, in Node,
 * and JMeter is handed a set of ready `uploadId`s to hammer. (The journey
 * phases measure all four steps end-to-end — they drive their own uploads from
 * the plan and need nothing staged beyond the project pool.)
 *
 * It also creates a pool of projects. Validation only runs the full pipeline —
 * extract, size, persist — when a `projectId` is supplied; without one it stops
 * after the geometry checks and would under-measure the real cost. Concurrent
 * uploads to the *same* project serialise on a row lock and 409, so each
 * concurrent thread needs its own project.
 *
 * Output on stdout, one `key=value` per line, for entrypoint.sh to turn into
 * JMeter properties:
 *   uploadId_<label>=<uuid>
 * ONLY for the sizes that actually staged — entrypoint.sh treats a missing
 * uploadId as "skip that phase". Everything else (parcel counts, byte sizes,
 * progress, failures) goes to stderr, which is the run log rather than the
 * property channel. Plus a projects CSV written to disk for JMeter's CSV Data
 * Set.
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { makeGeoPackage } from './make-gpkg.mjs'

const API_BASE_URL = process.env.API_BASE_URL
const BEARER_TOKEN = process.env.BEARER_TOKEN
const CDP_UPLOADER_URL = process.env.CDP_UPLOADER_URL
// `||`, not `??`, throughout: entrypoint.sh passes every one of these on the
// command line whether or not the operator set it, so an unset variable arrives
// as an empty string rather than as undefined. `??` treats that as a deliberate
// value and the defaults below never apply — an empty UPLOAD_READY_TIMEOUT_MS
// becomes a 0 ms deadline, an empty PROJECT_POOL_SIZE a pool of none. This is
// the same guard seed-via-api.mjs's `positiveIntEnv` applies for the same reason.
const STAGE_DIR = process.env.STAGE_DIR || '/opt/perftest/stage'
const FIXTURES_DIR =
  process.env.FIXTURES_DIR || join(import.meta.dirname, '..', 'fixtures')
const PROJECTS_CSV = process.env.PROJECTS_CSV || join(STAGE_DIR, 'projects.csv')
const S3_BUCKET = process.env.UPLOAD_S3_BUCKET || 'baseline-files'

const UPLOAD_READY_TIMEOUT_MS = Number(
  process.env.UPLOAD_READY_TIMEOUT_MS || 180_000
)
const UPLOAD_POLL_INTERVAL_MS = 1000
const PROJECT_POOL_SIZE = Number(process.env.PROJECT_POOL_SIZE || 40)

const HTTP_BAD_REQUEST = 400

/**
 * The file sizes the run profiles, as `label:parcels` pairs.
 *
 * The defaults bracket reality deliberately. Real BNG files in the reference
 * corpus top out around 80 parcels / 124 KB, so `everyday` is what a user
 * actually submits; the larger steps are there to find where the service stops
 * coping, not because anyone uploads them today.
 *
 * The top of the ramp is 12 000 parcels / ~9 MB. Bigger than that is not a size
 * the service will ever be asked to handle — it is already two orders of
 * magnitude past the real corpus — and it costs disproportionately to stage,
 * because bng-library's `partitionPolygon` re-sorts the whole parcel list on
 * every split: generation is roughly quadratic, so 5 000 parcels takes ~1.6 s
 * and 12 000 takes ~9 s.
 */
const DEFAULT_SIZES = 'everyday:80,busy:800,large:5000,xlarge:12000'

/**
 * The size labels the JMeter plan is wired to.
 *
 * `scenarios/bng-perf.jmx` reads `uploadId_everyday` / `_busy` / `_large` /
 * `_xlarge` by name, one hard-coded sampler each, and every concurrency phase
 * reads `uploadId_large`. So UPLOAD_SIZES sets how big each step is — that is
 * what it is for — but not what the steps are called. A label the plan does not
 * know stages a file nothing ever validates; a label the plan expects and does
 * not get leaves a phase POSTing to `/baseline/validate/` with an empty path
 * segment. Neither shows up as anything but bad numbers in the report, so both
 * are rejected here, before a run is spent on them.
 */
const PLAN_SIZE_LABELS = ['everyday', 'busy', 'large', 'xlarge']

/**
 * Labels become `-JuploadId_<label>=` arguments, and entrypoint.sh deliberately
 * leaves that string unquoted so it word-splits into separate arguments — so a
 * label containing whitespace would split one argument into two.
 */
const LABEL_PATTERN = /^[a-z][a-z0-9_]*$/

function parseSizes(spec) {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, parcels] = entry.split(':')
      const size = { label: (label ?? '').trim(), parcels: Number(parcels) }
      // Loud, not lenient: a dropped entry used to leave a phase with no upload
      // and no explanation anywhere.
      if (!LABEL_PATTERN.test(size.label)) {
        throw new Error(
          `bad label in UPLOAD_SIZES entry "${entry}" — labels must match ${LABEL_PATTERN}`
        )
      }
      if (!Number.isFinite(size.parcels) || size.parcels <= 0) {
        throw new Error(
          `bad parcel count in UPLOAD_SIZES entry "${entry}" — expected <label>:<positive integer>`
        )
      }
      return size
    })
}

/** Reject a size spec the plan cannot consume, naming the fix. */
function assertPlanLabels(sizes) {
  const got = sizes.map((s) => s.label)
  const missing = PLAN_SIZE_LABELS.filter((label) => !got.includes(label))
  const unknown = got.filter((label) => !PLAN_SIZE_LABELS.includes(label))
  if (missing.length === 0 && unknown.length === 0) {
    return
  }
  const detail = [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    unknown.length ? `not in the plan: ${unknown.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('; ')
  throw new Error(
    `UPLOAD_SIZES must name exactly the labels scenarios/bng-perf.jmx reads ` +
      `(${PLAN_SIZE_LABELS.join(', ')}) — ${detail}. Change the parcel counts, not the labels.`
  )
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${BEARER_TOKEN}`, ...extra }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (res.status >= HTTP_BAD_REQUEST) {
    throw new Error(`POST ${url} -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : null
}

async function getJson(url) {
  const res = await fetch(url, { headers: authHeaders() })
  const text = await res.text()
  if (res.status >= HTTP_BAD_REQUEST) {
    throw new Error(`GET ${url} -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : null
}

/** Ask the backend for an upload slot. Returns the uploader path to POST to. */
async function initiateUpload() {
  return postJson(`${API_BASE_URL}/upload/initiate`, {
    redirect: '/done',
    s3Bucket: S3_BUCKET,
    s3Path: 'baseline/'
  })
}

/**
 * POST the file to the CDP Uploader. The backend hands back only the *path*
 * (it strips the host), so the uploader's own base URL has to be supplied.
 */
async function postFileToUploader(uploadUrl, filePath, bytes) {
  const fullUrl = uploadUrl.startsWith('http')
    ? uploadUrl
    : `${CDP_UPLOADER_URL}${uploadUrl}`

  const { readFile } = await import('node:fs/promises')
  const fileBytes = await readFile(filePath)
  const form = new FormData()
  form.append(
    'file',
    new Blob([fileBytes], { type: 'application/geopackage+sqlite3' }),
    'baseline.gpkg'
  )

  const res = await fetch(fullUrl, {
    method: 'POST',
    body: form,
    redirect: 'manual'
  })
  // The uploader answers a successful upload with a 302 to the redirect target.
  if (res.status >= HTTP_BAD_REQUEST) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `upload of ${(bytes / 1024).toFixed(0)}KB to ${fullUrl} -> ${res.status}: ${body.slice(0, 300)}`
    )
  }
}

/**
 * Wait for the uploader to finish scanning. Large files take noticeably longer
 * here than small ones — this is the uploader's virus scan, not our service, so
 * it is deliberately outside what the run measures.
 */
async function waitForReady(uploadId) {
  const deadline = Date.now() + UPLOAD_READY_TIMEOUT_MS
  let last
  while (Date.now() < deadline) {
    last = await getJson(`${API_BASE_URL}/upload/${uploadId}/status`)
    if (last?.uploadStatus === 'ready') {
      if (last.numberOfRejectedFiles > 0) {
        throw new Error(
          `upload ${uploadId} was rejected by the uploader: ${JSON.stringify(last).slice(0, 300)}`
        )
      }
      return last
    }
    if (last?.uploadStatus === 'rejected') {
      throw new Error(`upload ${uploadId} rejected: ${JSON.stringify(last).slice(0, 300)}`)
    }
    await new Promise((r) => setTimeout(r, UPLOAD_POLL_INTERVAL_MS))
  }
  throw new Error(
    `upload ${uploadId} never became ready within ${UPLOAD_READY_TIMEOUT_MS}ms (last: ${JSON.stringify(last)})`
  )
}

/**
 * The committed fixture for a size, when there is one. fixtures/manifest.json
 * (written by gen-fixtures.mjs) is matched on label AND parcel count, so a
 * UPLOAD_SIZES override that changes a count simply falls back to generating —
 * the fast path never uploads a file of the wrong size under the right name.
 */
function committedFixture({ label, parcels }) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json')))
  } catch {
    return null
  }
  const entry = manifest.sizes?.find(
    (s) => s.label === label && s.parcels === parcels
  )
  return entry ? { path: join(FIXTURES_DIR, entry.file), bytes: entry.bytes } : null
}

async function stageOneSize({ label, parcels }) {
  const fixture = committedFixture({ label, parcels })
  let filePath
  let bytes
  if (fixture) {
    ;({ path: filePath, bytes } = fixture)
    process.stderr.write(
      `▸ ${label}: ${parcels} parcels, ${(bytes / 1024).toFixed(0)} KB ` +
        `(committed fixture) — uploading\n`
    )
  } else {
    filePath = join(STAGE_DIR, `baseline-${label}.gpkg`)
    let generationMs
    ;({ bytes, generationMs } = makeGeoPackage(filePath, parcels))
    // Generation time is logged because it is super-linear in parcel count and
    // is pure setup cost — a task that looks slow to start is usually the top
    // of the size ramp being built, not the service being slow.
    process.stderr.write(
      `▸ ${label}: ${parcels} parcels, ${(bytes / 1024).toFixed(0)} KB ` +
        `(generated in ${(generationMs / 1000).toFixed(1)}s) — uploading\n`
    )
  }

  try {
    const { uploadId, uploadUrl } = await initiateUpload()
    await postFileToUploader(uploadUrl, filePath, bytes)
    await waitForReady(uploadId)
    process.stderr.write(`  ready: ${uploadId}\n`)
    return { label, parcels, bytes, uploadId }
  } finally {
    // A generated file has served its purpose either way — on success the
    // bytes now live in S3, and on failure a 9 MB scratch file has no reason
    // to sit in the container for the rest of the run. Committed fixtures are
    // repo files and stay put.
    if (!fixture) {
      rmSync(filePath, { force: true })
    }
  }
}

/**
 * Top up the owner's projects to a pool big enough that concurrent threads get
 * their own. Never deletes, so re-running a task does not pile rows up beyond
 * the target.
 */
async function ensureProjectPool() {
  const existing = await getJson(`${API_BASE_URL}/projects`)
  const owned = Array.isArray(existing) ? existing : (existing?.projects ?? [])
  const ids = owned.map((p) => p.id).filter(Boolean)

  while (ids.length < PROJECT_POOL_SIZE) {
    const created = await postJson(`${API_BASE_URL}/projects/new`, {
      project: { name: `perf upload ${ids.length + 1}` }
    })
    ids.push(created.id)
  }

  mkdirSync(dirname(PROJECTS_CSV), { recursive: true })
  writeFileSync(PROJECTS_CSV, ids.slice(0, PROJECT_POOL_SIZE).join('\n') + '\n')
  process.stderr.write(
    `▸ project pool: ${ids.length} available, wrote ${PROJECT_POOL_SIZE} to ${PROJECTS_CSV}\n`
  )
}

async function main() {
  if (!API_BASE_URL || !BEARER_TOKEN) {
    throw new Error('API_BASE_URL and BEARER_TOKEN are required')
  }
  if (!CDP_UPLOADER_URL) {
    throw new Error('CDP_UPLOADER_URL is required to POST the staged files')
  }
  mkdirSync(STAGE_DIR, { recursive: true })

  const sizes = parseSizes(process.env.UPLOAD_SIZES || DEFAULT_SIZES)
  assertPlanLabels(sizes)

  // Fatal on its own: every phase in the plan reads its projectId from this
  // CSV, so there is no partial run to salvage without it.
  await ensureProjectPool()

  // Sequential on purpose: staging is setup, not load. Uploading these in
  // parallel would put the very burst we are about to measure onto the service
  // before the measurement starts.
  //
  // Per-size, and not all-or-nothing: the slowest, largest fixture goes through
  // a virus scanner on someone else's schedule, and one slow scan used to cost
  // the whole task — including the home-page, project-list and project-creation
  // groups, which need no uploads at all. A size that does not stage emits no
  // uploadId, and entrypoint.sh skips the phase that would have used it.
  const staged = []
  const failed = []
  for (const size of sizes) {
    try {
      const result = await stageOneSize(size)
      staged.push(result)
      process.stdout.write(`uploadId_${result.label}=${result.uploadId}\n`)
    } catch (err) {
      failed.push(size.label)
      process.stderr.write(`  ! ${size.label} did not stage: ${err.message}\n`)
    }
  }

  if (staged.length === 0) {
    throw new Error(
      `no size staged (${failed.join(', ')}) — there is no upload load to run`
    )
  }
  if (failed.length > 0) {
    process.stderr.write(
      `▸ WARNING: ${failed.length} of ${sizes.length} size(s) did not stage: ${failed.join(', ')}.\n` +
        '  Their phases will be skipped; the rest of the run continues.\n'
    )
  }
}

main().catch((err) => {
  process.stderr.write(`stage-uploads failed: ${err.message}\n`)
  process.exit(1)
})

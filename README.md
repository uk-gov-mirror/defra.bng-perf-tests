# bng-perf-tests

A JMeter based test runner for the CDP Platform.

- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Build

Test suites are built automatically by the [.github/workflows/publish.yml](.github/workflows/publish.yml) action whenever a change are committed to the `main` branch.
A successful build results in a Docker container that is capable of running your tests on the CDP Platform and publishing the results to the CDP Portal.

## Run

The performance test suites are designed to be run from the CDP Portal.
The CDP Platform runs test suites in much the same way it runs any other service, it takes a docker image and runs it as an ECS task, automatically provisioning infrastructure as required.

## Scenario

Everything lives in a **single** JMeter plan — `scenarios/bng-perf.jmx` — so one run
produces **one** report. Nothing needs selecting: a CDP task with no configuration runs
the whole suite. That is not just convenience — the portal serves a single dashboard
from the **root** of the results prefix, so one report per task is what it can show.

| Thread group                      | Targets               | Covers                                                                    |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------- |
| `Home page`                       | `bng-metric-frontend` | Minimal smoke check against the public home page (`/`), unauthenticated.   |
| `Project list endpoints`          | `bng-metric-backend`  | BMD-933 — the project list endpoints ship the whole project document.     |
| `Everyday user (background probe)`| both                  | What an ordinary user experiences *while* the upload phases run.          |
| `Size ramp`                       | `bng-metric-backend`  | Cost of validating one file, across five file sizes.                      |
| `Concurrency 1/2/5/10/20 user(s)` | `bng-metric-backend`  | Cost as simultaneous uploads increase.                                    |

The first two run **first and alone**, so their numbers are uncontended and mean what
they did before. The upload phases follow, sequenced by wall clock, with the probe
spanning them. A default run is **290 s — under five minutes**:

```
seconds     0    25   55        115  150   185   220   255   290
home + list |====|
probe            |==========================================|
size ramp             |==========|
1 user                            |====|
2 users                                 |====|
5 users                                       |====|
10 users                                            |====|
20 users                                                  |====|
```

Each group targets its own host (`frontendDomain` / `backendDomain`), and the Bearer
header is scoped to the backend groups only, so the home-page request is sent
unauthenticated. The stub token is minted once, the backend data is seeded once, and
the upload fixtures are staged once, all before JMeter starts. Assertion failures do
**not** fail the task (the project-list group is red by design until the BMD-933 fix
lands, and a red Duration Assertion beyond N users *is* the result); only an
infrastructure failure — a missing plan, a failed token mint, a failed seed, a failed
staging step, or no report — makes the task exit non-zero.

`TEST_SCENARIO` is an escape hatch, not something a normal run sets: `TEST_SCENARIO=<name>`
runs `scenarios/<name>.jmx` instead, and an unknown name falls back to `bng-perf`, so a
stale placeholder on the CDP task (e.g. the base image's inherited `TEST_SCENARIO=test`)
never fails the run.

### Project list endpoints (BMD-933)

Drives the two list endpoints — `GET /users/{userId}/projects` and `GET /projects` —
under concurrency and asserts the BMD-933 acceptance criteria. Both handlers currently
`.select()` every column and spread the full JSONB document into each row, so a list
that renders only `id`, `name`, `createdAt`, `updatedAt` ships each project's entire
baseline/postIntervention body (~3 KB per parcel — MBs at scale). The scenario encodes
the fix's acceptance criteria as assertions, so it **fails against an unfixed backend
and passes once the projection + `limit`/`offset` pagination land**:

- **Size Assertion** — each list response stays under `listSizeLimitBytes` regardless
  of baseline size ("response size is flat regardless of baseline size").
- **Response Assertion** — the payload excludes the document-body-only keys `habitats`
  and `postIntervention` ("list responses exclude the document body").
- **Response Assertion** — the payload includes the projected `has_baseline` flag.
- **200 on a paginated request** to each endpoint ("both list endpoints accept
  `limit`/`offset`"). Pre-fix, `GET /users/{userId}/projects` Joi-rejects unknown query
  params with a 400, so this assertion fails until pagination is added.
- **Duration Assertion** — guards against the multi-second event-loop stall a multi-MB
  synchronous `JSON.stringify` causes under load.

The entrypoint targets `bng-metric-backend.<env>.cdp-int.defra.cloud` for this group
automatically, so no override is needed on CDP. Point the two hosts independently with
`FRONTEND_DOMAIN` / `BACKEND_DOMAIN` (and `FRONTEND_PORT` / `BACKEND_PORT` when the ports
differ, e.g. a local stack). `SERVICE_ENDPOINT` still overrides the **backend** host for
back-compat — it no longer touches the frontend group. Do **not** set `SERVICE_ENDPOINT`
to a frontend host: the list traffic would be sent to the frontend, which does not serve
those endpoints. Leave it unset and use `FRONTEND_DOMAIN` / `BACKEND_DOMAIN` instead.

### Upload load profile

The upload phases of the plan profile the **upload and validate** journey. They run
after the home-page and project-list groups have finished, so neither set of numbers
contaminates the other.

They are built to answer four questions, in the order a PM asks them:

| Question                                          | Where the answer is            |
| ------------------------------------------------- | ------------------------------ |
| What does an everyday upload cost?                | `validate everyday (1 user)`   |
| At what file size does it become a problem?       | the rest of the size ramp      |
| At what concurrency does it become a problem?     | `validate large @ N user(s)`   |
| **What does an ordinary user experience meanwhile?** | `probe GET /projects`       |

The last one is the point of the plan. Uploads getting slower under upload load
is expected and mostly affects the person uploading. An unrelated project list
going from 200 ms to a timeout is an availability story, and only a probe
running **concurrently** with the load can show it. Every phase is scheduled, so
they run in sequence while the probe spans the whole run:

```
seconds    30   55        115  150   185   220   255   290
probe      |==========================================|
size ramp       |==========|
1 user                      |====|
2 users                           |====|
5 users                                 |====|
10 users                                      |====|
20 users                                            |====|
```

The 30-55 s stretch, after the probe starts but before any load, is the quiet
baseline every loaded phase is read against.

#### The size ramp is one user, and weighted

The ramp runs a single user through a **fixed, weighted pass** — 20 `everyday`,
8 `busy`, 3 `large`, 2 `xlarge`, 1 `extreme` — rather than looping all five
evenly until the clock runs out.

One user is deliberate: `validate everyday (1 user)` only means "what an
everyday upload costs" if nothing else is hitting the service while it is
measured, which is why each size does **not** get its own thread. But an even
pass has a flaw — every size shares a sample count with the slowest one, because
one loop cannot finish until the 15.5 MB file has. `everyday` is the number a PM
asks for first and the only size real files actually reach (the reference corpus
tops out at ~80 parcels), and it was getting as few samples as `extreme` did.

The weights are roughly inverse to file size, so each size takes a comparable
share of the window and the small ones earn a percentile instead of a single
point. Because the pass is loop-count driven, those counts are **exact** rather
than "whatever fitted" — a run either produces 20 `everyday` samples or the
`SIZE_RAMP_DURATION_SECONDS` guard tripped, which is itself worth knowing.

Set the weights with `SIZE_LOOPS_{EVERYDAY,BUSY,LARGE,XLARGE,EXTREME}`, or run
the whole pass more than once with `SIZE_RAMP_LOOPS`. If you raise them far
enough to overrun the window, raise `SIZE_RAMP_DURATION_SECONDS` too — the rest
of the timeline re-derives around it.

#### What it uploads, and why it is generated

`scripts/make-gpkg.mjs` builds a valid baseline GeoPackage of any size by
driving [`bng-library`](https://github.com/DEFRA/bng-library) — the same
generator the harness CLI and the digital prototype use. Two calls: `generateOne`
writes a synthetic file (baseline *and* proposed columns), then
`deriveBaselineFromSynthetic` clears the proposed columns to leave a baseline
document. The file has to be *valid* — one rejected at the format gate exits
before the expensive work and would measure nothing.

Using the shared library rather than a bespoke generator is what makes the
numbers trustworthy. An earlier hand-rolled version here emitted a uniform grid
of identical single-layer parcels, and measured **slower** than a realistic file
of the same parcel count (40 ms vs 27 ms to parse 2 000 parcels) because its
mostly-NULL attribute columns hit the validator's slow property-lookup path far
more often than a real file does. The library also owns the scope invariant: its
random draws come from `IN_SCOPE_HABITATS` / `IN_SCOPE_HEDGE_TYPES` /
`IN_SCOPE_RIVER_TYPES`, so a fixture can never carry the High / V.High
distinctiveness the service rejects at upload.

Generation is seeded on the parcel count, so a rerun of the same size produces a
byte-identical file — two runs that disagree are a change in the service, not a
change in the fixture.

Files are generated per run rather than committed, so any size can be asked for
via `UPLOAD_SIZES` without putting tens of MB of binaries in git. The cost is
that `bng-library` and its `better-sqlite3` / `xlsx` peers are baked into the
image at build time (see the `Dockerfile`); the CDP task pulls a finished image
and needs no access to GitHub or the npm registry.

For scale: real BNG files in the reference corpus top out around **80 parcels /
124 KB**, which is what `everyday` reproduces. The larger steps exist to find
where the service stops coping, not because anyone submits them today.

| Label      | Parcels | File size | Generation |
| ---------- | ------- | --------- | ---------- |
| `everyday` | 80      | 140 KB    | 0.02 s     |
| `busy`     | 800     | 704 KB    | 0.08 s     |
| `large`    | 5 000   | 4.0 MB    | 1.6 s      |
| `xlarge`   | 12 000  | 9.3 MB    | 9.0 s      |
| `extreme`  | 20 000  | 15.5 MB   | 30 s       |

Generation is **super-linear** in parcel count — `partitionPolygon` in
`bng-library` re-sorts the whole parcel list on every split, so 4× the parcels
costs roughly 19× the time. 60 000 parcels does not finish in a usable time,
which is why the ramp stops at 20 000. That is not a loss of coverage: at
15.5 MB, 20 000 parcels already produces a larger file than the previous
top-of-ramp did, so the service sees the same stress and only the staging cost
changes. Staging the whole ramp costs ~42 s of generation before JMeter starts;
each step's time is logged so a slow-looking start is identifiable as setup.

#### Staging: what is measured and what is not

`scripts/stage-uploads.mjs` runs before JMeter and does the parts that are *not*
the service's work — initiate, POST the file to the CDP Uploader, wait for the
virus scan. JMeter then measures only `POST /baseline/validate/{uploadId}`.
Driving a multipart upload and a polling loop from JMeter would add noise and
complexity for nothing, and the uploader's scan time is not ours to report on.

Staging also creates a **pool of projects**. Validation only runs the full
pipeline — extract, size, persist — when a `projectId` is supplied; without one
it stops after the geometry checks and would under-measure the real cost. And
concurrent uploads to the *same* project serialise on a row lock and 409, so
each concurrent thread needs its own.

Staging is on automatically for this plan and off for every other; override with
`STAGE_UPLOADS`.

#### Reading the result

The task log ends with a plain-English summary (`scripts/summarise-run.mjs`) —
cost by file size, cost by concurrency, and what the probe saw during each
phase. That is the part to paste into a ticket; the JMeter dashboard has the
detail behind it.

Assertion failures do **not** gate the task, and a red Duration Assertion beyond
N users *is* the result rather than a failure. One assertion is different:
`Fixture actually validates` checks the response contains `"valid":true`. If
that goes red the staged file is not passing validation and every number in the
run is meaningless.

| Env var                          | Default                                        | Purpose                                                        |
| -------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `TEST_SCENARIO`                  | `bng-perf`                                     | Escape hatch only — leave unset to run the whole suite.         |
| `UPLOAD_SIZES`                   | `everyday:80,busy:800,large:5000,xlarge:12000,extreme:20000` | `label:parcels` pairs to stage.                    |
| `STAGE_UPLOADS`                  | `true` for this plan                           | Skip staging (e.g. reusing already-staged uploads).             |
| `CDP_UPLOADER_URL`               | `https://cdp-uploader.<ENVIRONMENT>.cdp-int.defra.cloud` | The uploader to POST staged files to.                 |
| `PROJECT_POOL_SIZE`              | `40`                                           | Projects to spread concurrent writes across. Keep ≥ max threads. |
| `UPLOAD_READY_TIMEOUT_MS`        | `180000`                                       | How long to wait for the uploader's scan. Large files are slow. |
| `PHASE_GAP_SECONDS`              | `5`                                            | Dead time between phases, so one phase's in-flight requests drain before the next starts. |
| `EVERYDAY_PHASE_DURATION_SECONDS`| `25`                                           | Cap on the two everyday groups. A guard, not a budget — they are loop-count driven and finish sooner. |
| `PROBE_BASELINE_SECONDS`         | `25`                                           | Quiet stretch between the probe starting and the first load phase. |
| `PROBE_DURATION_SECONDS`         | _derived_                                      | How long the background probe runs. Derived to span every phase; override and you own it. |
| `PROBE_THINK_MS` / `PROBE_MAX_LATENCY_MS` | `2000` / `2000`                       | Probe pacing, and the latency it is judged against.             |
| `VALIDATE_BUDGET_MS`             | `30000`                                        | Latency budget for a validate call under load.                  |
| `EVERYDAY_BUDGET_MS`             | `5000`                                         | Tighter budget for the everyday-sized file.                     |
| `VALIDATE_RESPONSE_TIMEOUT_MS`   | `120000`                                       | Socket timeout — above this a sample is an error, not a slow success. |
| `SIZE_RAMP_DURATION_SECONDS`     | `60`                                           | Guard on the size-ramp pass, and the window the schedule reserves for it. |
| `SIZE_RAMP_LOOPS`                | `1`                                            | Weighted passes over the five sizes.                            |
| `SIZE_LOOPS_{EVERYDAY,BUSY,LARGE,XLARGE,EXTREME}` | `20/8/3/2/1`                  | Samples per size in a pass. Weighted so small files earn a percentile. |
| `SIZE_RAMP_DELAY_SECONDS`        | _derived_                                      | When the size ramp starts.                                      |
| `CONC_STEP_DURATION_SECONDS`     | `30`                                           | How long each concurrency step runs.                            |
| `CONC_DELAY_{1,2,5,10,20}`       | _derived_                                      | When each concurrency step starts.                              |
| `CONC_USERS_{1,2,5,10,20}`       | `1/2/5/10/20`                                  | Threads at each step.                                           |

> **Set durations, not delays.** JMeter starts a thread group at an absolute
> delay from the start of the run, so lengthening one phase means pushing every
> later phase out too — and a missed one does not fail anything, it just makes a
> concurrency figure quietly stop meaning what its label says. `entrypoint.sh`
> therefore **derives** every delay from the phase durations plus
> `PHASE_GAP_SECONDS`, and the probe's duration from where the last phase ends.
> Change a duration and the rest of the timeline moves with it; the plan's own
> `-J` defaults are that same derivation written out, so driving JMeter directly
> still gets a consistent schedule. Setting a delay explicitly overrides the
> derivation, and from there the arithmetic is yours.

**Want more samples rather than a faster answer?** Lengthen the phase you care
about — there is no second "deep" profile, because a duration *is* the knob and
the timeline re-derives around it. `CONC_STEP_DURATION_SECONDS=45` turns the
~5 min run into ~6 min with half as much again behind every concurrency
percentile, and moves the four later steps and the probe to match.

### Authenticating: a real cdp-defra-id-stub token

The endpoints require a Defra ID Bearer token. Rather than replicate the interactive
OIDC login in JMeter — or add an auth-bypass to the backend — this suite **mints a real
token from the `cdp-defra-id-stub`** headlessly, the same login the app performs. This
is the DEFRA perf-test pattern (see `DEFRA/trade-demo-perf-tests`): `entrypoint.sh` runs
`scripts/get-stub-token.mjs` (register → authorize → token, PKCE) before JMeter and
forwards the token into the `bearerToken` property with xtrace off, so it never lands in
the committed `.jmx` or the CDP logs.

**The backend must trust stub tokens on the target environment** — i.e. its
`OIDC_DISCOVERY_URL`/`OIDC_ISSUER` must point at that environment's
`cdp-defra-id-stub` (already the case on **local** and **dev**; for **perf-test** this is
a one-line change in `cdp-app-config` `services/bng-metric-backend/perf-test`). No
backend code, and no `PERF_TEST_AUTH_TOKEN`.

The stub base URL defaults to `https://cdp-defra-id-stub.<ENVIRONMENT>.cdp-int.defra.cloud/cdp-defra-id-stub`;
override any of the minting inputs if needed:

| Env var                 | Default                                                        | Purpose                                             |
| ----------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `BEARER_TOKEN`          | _(minted)_                                                     | Preset a token to **skip** minting (e.g. a pre-minted token on the CDP task). |
| `STUB_BASE_URL`         | `…/cdp-defra-id-stub.<ENVIRONMENT>.cdp-int.defra.cloud/…`      | The stub to mint against.                           |
| `OIDC_REDIRECT_URI`     | frontend callback for the env (local: `http://localhost:3000/auth/callback`) | Echoed back by the stub with the auth code; read off the 302 without being called. Must not contain `localhost` on CDP — the WAF 403s an `/authorize` request whose query carries a localhost target. |
| `OIDC_CLIENT_ID`        | `63983fc2-cfff-45bb-8ec2-959e21062b9a`                        | Stub OIDC client (the shared CDP stub client).      |
| `USER_ID`               | minted token `sub`                                             | `/users/{userId}` path segment (token `sub` is trusted, not this). |
| `LIST_SIZE_LIMIT_BYTES` | `262144`                                                       | Max allowed list response size (256 KB).            |
| `LIST_MAX_LATENCY_MS`   | `2000`                                                         | Max allowed list response time.                     |
| `LIST_LIMIT` / `LIST_OFFSET` | `50` / `0`                                                | Pagination params exercised against both endpoints. |
| `LIST_THREADS` / `LIST_RAMP_SECONDS` / `LIST_LOOPS` | `10` / `10` / `20`                | Backend (project-list) load profile.                |
| `HOME_THREADS` / `HOME_RAMP_SECONDS` / `HOME_LOOPS` | `1` / `1` / `5`                   | Frontend (home-page) load profile.                  |
| `MAX_RESPONSE_MS`       | `2000`                                                        | Home-page per-request time budget.                  |
| `FRONTEND_DOMAIN` / `BACKEND_DOMAIN` | `*.<ENVIRONMENT>.cdp-int.defra.cloud`            | Per-service target hosts.                           |
| `FRONTEND_PORT` / `BACKEND_PORT` | `SERVICE_PORT` (`443`)                              | Per-service ports; override when the hosts differ.  |

### Seed the data — owner must match the minted `sub`

The environment must hold at least one project **owned by the `sub` the stub issues**,
with a baseline uploaded — ideally a large, multi-thousand-parcel one — or the
`has_baseline` and document-body assertions have nothing to exercise (and `has_baseline`
fails against the empty list). The list endpoints only return projects owned by that
`sub`.

`scenarios/project-list-payload.seed.mjs` upserts that project into the local compose
Postgres. Its `--sub` defaults to the stub perf-user's deterministic sub
(`e7ae699f-cfd0-5f66-b770-10248ab5c3c1`, for `bng-perf@bng.example.com`), so a local seed
lines up with the minted token without an argument:

```sh
node scenarios/project-list-payload.seed.mjs            # owner: the stub perf user
node scenarios/project-list-payload.seed.mjs --sub=<other-sub>
```

The seed script talks to local Docker only (it `docker exec`s into the compose
Postgres), so it cannot reach a CDP-managed RDS. For any deployed environment the suite
seeds through the **backend API instead** — see below.

#### Seeding on CDP — `scripts/seed-via-api.mjs`

`entrypoint.sh` seeds the owner's projects by driving the backend's own
`POST /projects/new` with the minted stub token, before the first authenticated scenario
runs. It needs no database access, no GeoPackage upload and no Portal migration — only a
reachable backend that trusts the stub — so the same step works on **local**, **dev** and
**perf-test**. It runs at most once per task and is idempotent to a **target count**: it
first lists what the owner already has and creates only the shortfall, so re-running a
task never piles rows up. Set `SEED_VIA_API=false` to skip it (e.g. when the environment
is already seeded another way).

Two properties of the API path shape it:

- **Payload cap.** Hapi's default request-body limit is 1 MB and the create route sets no
  override, so each project body is sized to a byte budget below that cap. To build a
  larger corpus the step seeds **several** projects rather than one oversized baseline —
  which suits the list scenario, since a longer list is what balloons the payload.
- **No delete.** `POST /projects/new` always inserts a fresh row and the API exposes no
  project delete, so idempotency is at the target-count level, not a fixed id. If you need
  a single multi-MB baseline row (bigger than the 1 MB create cap allows), seed it through
  the DB/Liquibase path instead; the API step cannot.

| Env var              | Default    | Purpose                                                              |
| -------------------- | ---------- | ------------------------------------------------------------------- |
| `SEED_VIA_API`       | `true`     | Set `false` to skip API seeding entirely.                           |
| `SEED_PROJECT_COUNT` | `5`        | Target number of baseline projects the owner should end up with.    |
| `SEED_BYTE_BUDGET`   | `800000`   | Byte budget per project body; kept under Hapi's 1 MB cap.           |

The `scenarios/project-list-payload.seed.mjs` Docker-Postgres seed remains the faster
local option (a single fixed-id, large baseline); `seed-via-api.mjs` is the portable
equivalent for anywhere the DB is out of reach.

> **Local shortcut:** from the harness, `npm run perf` does all of this for you — mints
> the stub token, seeds the project under its sub, runs JMeter, and prints a per-endpoint
> pass/fail summary. The steps below are for running the container directly / on CDP.

Run it locally against a full local stack (frontend on `3000`, backend on `3001`, stub on
`3200`) with:

```sh
docker build . -t bng-perf-tests
docker run --rm --network host \
  -e ENVIRONMENT=local \
  -e FRONTEND_DOMAIN=localhost -e FRONTEND_PORT=3000 \
  -e BACKEND_DOMAIN=localhost  -e BACKEND_PORT=3001 \
  -e SERVICE_URL_SCHEME=http \
  -e STUB_BASE_URL=http://localhost:3200/cdp-defra-id-stub \
  -e RESULTS_OUTPUT_S3_PATH='s3://my-bucket' -e S3_ENDPOINT='http://host.docker.internal:4566' \
  -e AWS_ACCESS_KEY_ID='test' -e AWS_SECRET_ACCESS_KEY='test' -e AWS_REGION='eu-west-2' \
  bng-perf-tests
```

(The backend must be running with its OIDC pointed at that same stub — the default on a
local `tilt up`. `USER_ID` is left to the minted `sub`; the backend trusts the token
`sub`, not the path segment. Seeding runs automatically via the backend API; set
`SEED_VIA_API=false` to skip it.)

## Running the suite locally

You can run the suite locally with Docker Compose. Compose builds the JMeter image
and fires the plan at an **already-running app on your host**, then publishes the
results to a LocalStack S3 bucket (and to `./reports` on your host).

### 1. Start the app under test

The compose stack does **not** stand the app up. The single plan hits **both** the
frontend (home page) and the authenticated backend (project list), and mints a stub
token + seeds data against the backend — so it needs the whole stack (frontend,
backend, Postgres, Redis, Defra ID stub, OIDC discovery), which lives in
`bng-metric-backend`'s own compose. Bring it up first (e.g. `tilt up`) so the
frontend serves on `3000`, the backend on `3001`, and the stub on `3200`.

### 2. Run the suite

```bash
# in bng-perf-tests
docker compose up --build
```

This brings up:

* `development`: the container that runs the plan (`scenarios/bng-perf.jmx`)
* `localstack`: stands in for AWS S3 so the results-publish step succeeds

By default it points the frontend group at `host.docker.internal:3000` and the backend
group at `host.docker.internal:3001`. Once LocalStack is healthy the run starts
automatically, and the container exits when the run finishes.

### 3. Point it somewhere else (optional)

Every target knob is an overridable env var. To hit a deployed CDP environment:

```bash
ENVIRONMENT=dev SERVICE_URL_SCHEME=https \
FRONTEND_DOMAIN=bng-metric-frontend.dev.cdp-int.defra.cloud FRONTEND_PORT=443 \
BACKEND_DOMAIN=bng-metric-backend.dev.cdp-int.defra.cloud  BACKEND_PORT=443 \
docker compose up --build
```

### Notes

* The `test-results` S3 bucket is created automatically inside LocalStack.
* Logs and reports are written to `./reports` on your host.
* If you change `entrypoint.sh` or a scenario, rerun with `docker compose up --build`
  so the image is rebuilt.
* On Docker Desktop `host.docker.internal` resolves to the host natively; on Linux
  the compose file adds the `host-gateway` mapping so it resolves there too.

## Local Testing with LocalStack

### Build a new Docker image
```
docker build . -t my-performance-tests
```
### Create a Localstack bucket
```
aws --endpoint-url=localhost:4566 s3 mb s3://my-bucket
```

### Run performance tests

```
docker run \
-e S3_ENDPOINT='http://host.docker.internal:4566' \
-e RESULTS_OUTPUT_S3_PATH='s3://my-bucket' \
-e AWS_ACCESS_KEY_ID='test' \
-e AWS_SECRET_ACCESS_KEY='test' \
-e AWS_SECRET_KEY='test' \
-e AWS_REGION='eu-west-2' \
my-performance-tests
```

docker run -e S3_ENDPOINT='http://host.docker.internal:4566' -e RESULTS_OUTPUT_S3_PATH='s3://cdp-infra-dev-test-results/cdp-portal-perf-tests/95a01432-8f47-40d2-8233-76514da2236a' -e AWS_ACCESS_KEY_ID='test' -e AWS_SECRET_ACCESS_KEY='test' -e AWS_SECRET_KEY='test' -e AWS_REGION='eu-west-2' -e ENVIRONMENT='perf-test' my-performance-tests


## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.

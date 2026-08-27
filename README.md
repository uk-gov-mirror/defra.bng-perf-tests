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

| Thread group                              | Targets                | Covers                                                                       |
| ----------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| `Home page`                               | `bng-metric-frontend`  | Minimal smoke check against the public home page (`/`), unauthenticated.      |
| `Project list endpoints`                  | `bng-metric-backend`   | BMD-933 — the project list endpoints ship the whole project document.        |
| `Project creation (typical baseline)`     | `bng-metric-backend`   | Write-path load on `POST /projects/new` at a realistic baseline size.         |
| `Project creation (large baseline probe)` | `bng-metric-backend`   | One worst-case create, ~810 KB body, just under Hapi's 1 MB cap.              |
| `Everyday user (background probe)`        | both                   | What an ordinary user experiences *while* the load phases run.                |
| `Size ramp`                               | `bng-metric-backend`   | Cost of validating one file, across four file sizes.                          |
| **`Upload journey <size> @ N user(s)`**   | backend + cdp-uploader | **N people each uploading their own file at once** — initiate, upload, scan, validate. |
| `Revalidate <size> @ N user(s)`           | `bng-metric-backend`   | Validate cost alone as concurrency climbs — one staged upload, replayed.      |
| `Post-intervention validate <size> @ N`   | `bng-metric-backend`   | The peer of `/baseline/validate`, against projects that already hold a baseline. |
| `Habitat edit <size> @ N user(s)`         | `bng-metric-backend`   | `PUT …/habitats/{featureId}` throughput — each thread on its own project.     |
| `Habitat edit contention @ N user(s)`     | `bng-metric-backend`   | The same PUT, all threads on **one** project — where the row lock starts 409ing. |
| `Single-project fetch ramp`               | `bng-metric-backend`   | `GET /projects/{id}` by document size — the unbounded payload every habitat-list page pulls. |
| `Mixed workload`                          | `bng-metric-backend`   | Reads, edits and uploads **together**, rather than one phase at a time.       |

The four everyday groups run **first and alone**, so their numbers are uncontended and
mean what they did before. The load phases follow, sequenced by wall clock, with the
probe spanning them.

### The ladders, and why they are generated

A staircase is one thread group per step, and a thread group is ~95 lines of XML. The
plan used to carry eight of them written out by hand — five concurrency steps and three
journey steps — which is exactly why the journey ladder stopped at 1/2/5: adding a step
meant copying a block, and changing a sampler meant changing every copy.

So the repetitive half of the plan is now **generated** from
[`scenarios/ladders.config.mjs`](scenarios/ladders.config.mjs), and the result is
**committed** — the same call this repo already made for the upload fixtures.
`scenarios/bng-perf.jmx` is still a real file that opens in the JMeter GUI and diffs in
review; it just is not the place you edit a ladder.

```sh
npm run gen-scenario      # rewrite the generated block + scenarios/ladders.sh
npm run check-scenario    # fail if either is stale (CI runs this)
```

Only the region between the `BEGIN GENERATED` / `END GENERATED` markers is written.
Everything outside them — the home page, project list, probe, size ramp and
project-creation groups — is hand-written and never touched.

The generator writes **two** outputs, which is what keeps the plan and the schedule from
drifting apart: the `.jmx`, and `scenarios/ladders.sh`, a POSIX-sh fragment
`entrypoint.sh` sources for the same step lists. A test asserts that the shell and the
generator derive an identical schedule for every profile.

### Profiles — how long a run takes

The plan contains **53 ladder steps**. Which of them run is a run-time choice, because
running all of them takes half an hour and most days you want the shape of a curve, not
every point on it.

| `PERF_PROFILE` | Wall clock | What it runs                                                            |
| -------------- | ---------- | ----------------------------------------------------------------------- |
| `quick`        | ~5 min     | The shape of the curve — a few steps of each ladder. For iterating on a change. |
| `standard`     | ~14 min    | **The default.** The contiguous 1..10 journey ladder, plus one step of every other question. |
| `full`         | ~34 min    | Every step in `ladders.config.mjs`. An overnight answer.                 |
| `soak`         | ~31 min    | The mixed workload and nothing else, held for `SOAK_DURATION_SECONDS`.   |

A profile never changes what the plan **contains** — every step has a thread group
either way. It sets thread counts, and **a step at 0 threads costs nothing and reserves
no wall clock**, because the delays are derived rather than written down. That is the
same contract `SIZE_RAMP_THREADS=0` already had, applied to every step.

To see what a profile would run without running it:

```sh
PERF_PROFILE=quick PERF_DUMP_SCHEDULE=true ./entrypoint.sh
```

A `standard` run looks like this — note how the windows *shrink* as the ladder climbs:

```
seconds  0  25  55        215   220        386          516      598  638  693 723   790  835
home+list|=|
probe        |=========================================================================|
size ramp       |========|
journey everyday 1..10     |=|=|=|=|=|=|=|=|=|=|
journey large 1,2,3                            |===|===|==|
revalidate large 1,5,20                                    |===|=|=|
post-intervention 1,5                                              |=|=|
habitat edit 1,2,5                                                     |=|=|=|
edit contention 2,5                                                          |=|=|
fetch ramp                                                                       |====|
mixed workload                                                                         |==|
```

#### Why the windows shrink

Every step used to run for a flat 30 s. That is the wrong shape: with N concurrent
users, samples accumulate N times faster — so a flat window over-samples the top of a
ladder and under-samples the bottom, while spending the run's most expensive wall clock
on the steps that need it least.

Each step's window is therefore **derived from how many samples it is meant to
produce**:

```
window(N) = clamp(targetSamples × secondsPerIteration ÷ N, 10s, 45s)
```

A 1-user everyday journey step gets 24 s; the 10-user step needs ~2.4 s for the same
sample count and lands on the 10 s floor. That is what makes a contiguous 1..10 ladder
cost ~3 minutes rather than the ~6 a flat window would have.

`secondsPerIteration` is an **allowance, not a measurement** — the same status the
`SIZE_ALLOWANCE_*` numbers have. It only sizes the window; a faster service simply fits
more samples into it, and the run summary reports what each step actually produced, so
these can be tightened from real numbers after the first run.

Each group targets its own host (`frontendDomain` / `backendDomain`), and the Bearer
header is scoped to the backend groups only, so the home-page request is sent
unauthenticated. The stub token is minted once, the backend data is seeded once, and
the upload fixtures and prepared pools are staged once, all before JMeter starts.
Assertion failures do **not** fail the task (the project-list group is red by design
until the BMD-933 fix lands, and a red Duration Assertion beyond N users *is* the
result); only an infrastructure failure — a missing plan, a failed token mint, a failed
seed, a failed staging step that produced *nothing*, or no report — makes the task exit
non-zero.

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
  of baseline size ("response size is flat regardless of baseline size"). Asserted on
  the **paginated samplers only** — see [Why AC1 is paginated-only](#why-ac1-is-asserted-on-the-paginated-samplers-only).
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

### Project creation (write path)

Two thread groups drive `POST /projects/new`. They measure what the read-only list
groups cannot: Joi validating a baseline parcel by parcel, an ~800 KB JSONB insert, and
the `write_audit_log` trigger copying the whole document a second time.

Both are scheduled into the **everyday phase** (0 – `EVERYDAY_PHASE_DURATION_SECONDS`)
alongside the home-page and project-list groups — deliberately not into the quiet
stretch the upload phases are read against, so they cannot contaminate that baseline.

Bodies are built in-plan by a Groovy JSR223 PreProcessor using the same keys as
`scripts/seed-via-api.mjs` — the backend's `habitatSchema` rejects unknown keys, so
every field is one it recognises. Each create gets a fresh name and fresh `featureId`s.

| Group | Profile | Body | Asserts |
| ----- | ------- | ---- | ------- |
| typical baseline | `createThreads` × `createLoops` (default 5 × 10 = 50 creates) | `createParcels` habitats (default 25, ~5 KB) | 200, response carries `projectId`, under `createMaxLatencyMs` |
| large baseline probe | 1 thread × `createLargeLoops` (default 1) | `createLargeParcels` habitats (default 3900, ~810 KB) | 200, response carries `projectId`, under `createLargeMaxLatencyMs` |

#### These groups grow the database permanently

Every create is unreclaimable. The row lands in `bng.projects`, and the
`write_audit_log` trigger copies the entire document into `bng.audit_log`, which is
**append-only by design** — the backend's `changelog/db.changelog-1.9.xml` installs
reject triggers on UPDATE/DELETE/TRUNCATE plus a `REVOKE`. The API exposes no delete
route, and the CDP perf-test environment persists between runs rather than being torn
down. So this profile *is* the database growth rate, bounded here at the source rather
than cleaned up afterwards.

`createParcels` is the dominant lever — bytes written scale linearly with it, and the
3900-parcel documents the **list** scenario needs are a list fixture, not a realistic
create. At ~210 bytes per serialised parcel, doubled for the audit copy:

| Profile | Per run | Daily for a year |
| ------- | ------- | ---------------- |
| defaults (50 × 25 parcels + 1 × 3900) | ~2.1 MiB | ~750 MiB |
| 50 creates × 3900 parcels | ~78 MiB | ~28 GiB |
| `CREATE_THREADS=0`, `CREATE_LARGE_LOOPS=0` | 0 | 0 |

`entrypoint.sh` prints the figure for the configured profile in its run-config banner
(`create growth: up to ~N KiB added by this run`). It is an upper bound: both groups are
scheduled, so a slow backend can cut them short of their loop counts.

> **The create groups are not the largest writer in this plan.** The upload phases call
> `/baseline/validate/{uploadId}` **with a `projectId`**, which runs the full pipeline:
> the geometry rows for that project are deleted and re-inserted (so those tables stay
> bounded), but the project document is **updated**, and an update writes an audit row
> holding *both* the new and the previous document. At the staged fixture sizes
> (`large` = 5 000 parcels, `xlarge` = 12 000) that is a far bigger contributor to
> `bng.audit_log` than anything here. See [Upload load profile](#upload-load-profile).

#### Why AC1 is asserted on the paginated samplers only

Created projects carry baselines, so they join the list the BMD-933 group asserts on —
about 51 new rows per run at the defaults. That matters because a list response's size
has two factors:

```
response bytes  ≈  number of rows  ×  bytes per row
```

The Size Assertion cannot tell them apart. BMD-933 is a *bytes-per-row* regression, but
on the **unpaginated** samplers the *row count* climbs every run: at ~200 bytes per
projected row, `listSizeLimitBytes` (256 KB) is reached at ~1,300 projects — roughly 25
runs. AC1 would then go red on a perfectly projected payload, reading as "the BMD-933
fix regressed" when the backend is fine and the suite has polluted its own fixture.

So the Size Assertion is attached to `GET /projects?limit&offset` and
`GET /users/{userId}/projects?limit&offset` only. A 50-row page is 50 rows however many
projects exist, so it stays a true bytes-per-row check indefinitely — ~7.6 KB post-fix,
megabytes pre-fix. **Do not add a Size Assertion back to the unpaginated samplers.**

The unpaginated samplers keep AC2 (`habitats`/`postIntervention` excluded), AC3
(`has_baseline` present) and the Duration Assertion, none of which scale with row count.

#### Seeding stops topping up

`scripts/seed-via-api.mjs` counts baseline-bearing projects, so once the create groups
have run the owner is permanently above `SEED_PROJECT_COUNT` and the seeder becomes a
no-op. The five original ~800 KB fixtures persist, so the list group keeps its fat
documents — but a future change to the fixture shape will not take effect on its own.

### The load profile

The load phases run after the home-page and project-list groups have finished, so
neither set of numbers contaminates the other.

They are built to answer these questions, in roughly the order a PM asks them:

| Question                                                       | Where the answer is                                   |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| What does an everyday upload cost?                             | `validate everyday file (1 user)`                     |
| At what file size does it become a problem?                    | the rest of the size ramp                             |
| **What happens when N people upload N files at once?**         | `end to end (<size>) @ N user(s)`                     |
| Where does that journey time go?                               | the `journey (<size>) @ N user(s): <leg>` rows        |
| At what concurrency does validate alone become a problem?      | `revalidate <size> file @ N user(s)`                  |
| What does a post-intervention upload cost?                     | `post-intervention validate (<size>) @ N user(s)`     |
| What does editing a habitat cost, once the file is in?         | `habitat edit distinct projects (<size>) @ N user(s)` |
| When do two people editing one project start being refused?    | `habitat edit same project @ N user(s)`               |
| What does loading a project page cost as the document grows?   | `fetch <size> project (GET /projects/{id})`           |
| Do all of these still work when they happen at the same time?  | the mixed workload                                    |
| **What does an ordinary user experience meanwhile?**           | `probe: project list under load`                      |

The last one is the point of the plan. Uploads getting slower under upload load
is expected and mostly affects the person uploading. An unrelated project list
going from 200 ms to a timeout is an availability story, and only a probe
running **concurrently** with the load can show it. Every phase is scheduled, so
they run in sequence while the probe spans the whole run — see the
[timeline](#profiles--how-long-a-run-takes) above.

The 30-55 s stretch, after the probe starts but before any load, is the quiet
baseline every loaded phase is read against.

#### Two upload ladders, and the difference between them

There are two staircases that both climb concurrency against uploads, and they answer
different questions. Reading one as the other is the single easiest mistake to make
with this suite:

| | `Upload journey <size> @ N user(s)` | `Revalidate <size> @ N user(s)` |
| --- | --- | --- |
| What each thread does | initiate → POST its **own** file to the uploader → validate | POST `/baseline/validate/{id}` against **one** pre-staged upload |
| Bytes through the uploader | every iteration | none — staged once, before the run |
| Virus scan | inside the measurement | outside it |
| Answers | "10 people upload 10 files at once" | "what does validate alone cost at 10x?" |

The revalidate ladder used to be called `Concurrency N user(s) — large file`, which
reads in a pasted summary as *"N people uploaded large files"* — and it is not that. It
was renamed for that reason, and the journey ladder is the one that means it.

#### The journey ladder runs per file size

`journey (everyday) @ 10 user(s)` and `journey (large) @ 10 user(s)` are different
questions: 143 KB and 4 MB through the uploader are not the same load, and the second
one is the one nobody had ever run. The summary keeps them apart rather than averaging
them, and the ladder is **contiguous** at `everyday` — 1, 2, 3, …, 10 — because the
point of a ladder is to find the knee, and 1/2/5/10 cannot tell a cliff at 7 from a
slope.

The end-to-end time is reconstructed per iteration from the thread name: an `initiate`
opens a triple and the next `validate` on the same thread closes it. An iteration whose
initiate failed never opens, and one cut off by the window's end never closes — both are
dropped, so the `n` column is a truthful count of *complete* journeys.

#### The habitat-edit ladders

`PUT /projects/{projectId}/habitats/{featureId}` is the operation a user performs
immediately after the upload the rest of the plan measures, and nothing measured it.
Every call is O(document size) in three places, none of them the write:

- the handler `SELECT`s the whole project `FOR UPDATE` and pulls the JSONB into Node
- unit totals are recalculated across the document
- the `write_projects_audit_log` trigger stores **both** the new and the previous
  document

The write itself is a surgical `jsonb_set`. Nothing around it is.

The **distinct projects** ladder puts each thread on its own project, so it measures
throughput. The **contention** ladder puts every thread on one project — which is what
two people editing two different habitats in one project actually do, because
`runUpdate` locks the *project* row, not the feature. Past some concurrency the 5 s
`lock_timeout` fires and the request 409s with *"Another edit for this project is in
progress"*.

That 409 is a **correct answer**, not a failure, so the plan asserts `200|409` there and
the summary reports it as a rate:

```
What happens when two people edit the SAME project at once?
               tried  409 rate  accepted  mean   p95    worst
  @ 2 user(s)  20     10%       18        180ms  180ms  180ms
  @ 5 user(s)  20     35%       13        180ms  180ms  180ms
```

The latency columns cover the **accepted** requests only — mixing in the ones that spent
5 s waiting for a lock they never got would describe an experience nobody had.

> **These ladders write, permanently.** Every edit lands an audit row holding two full
> copies of the document, in an append-only table that cannot be cleared down. That is
> why the edit ladders default to `everyday` and the larger sizes are opt-in — see
> [These groups grow the database permanently](#these-groups-grow-the-database-permanently),
> which applies here too.

#### The single-project fetch ramp

BMD-933 bounded the *list* endpoints' payload and asserts on it. `GET /projects/{id}`
was never bounded and never sampled — and it returns the entire document, which is what
every habitat-list page load pulls, rendering one table row per feature with no
pagination above it.

One user, one size after another, loop-count driven inside a duration guard like the
size ramp: the number is the cost of the payload, not the cost of contention.

#### The mixed workload, and the soak

Every other phase runs one operation in isolation, so each proves that operation scales
**alone**. Production runs reads, edits and uploads against one connection pool at the
same time, and pool contention is invisible to a plan whose phases never overlap.

The mixed workload is the one group that overlaps them, weighted by percent of
iterations (`MIX_*_PERCENT`, defaulting to 40/25/25/10 list/fetch/edit/validate).
`PERF_PROFILE=soak` runs *only* this group, for `SOAK_DURATION_SECONDS` — long enough
for a leak, a growing session store or pool exhaustion to show up, none of which a
30-second phase can see.

#### The size ramp is one user, and weighted

The ramp runs a single user through a **fixed, weighted pass** — 20 `everyday`,
8 `busy`, 3 `large`, 2 `xlarge` — rather than looping all four evenly until the
clock runs out.

One user is deliberate: `validate everyday file (1 user)` only means "what an
everyday upload costs" if nothing else is hitting the service while it is
measured, which is why each size does **not** get its own thread. But an even
pass has a flaw — every size shares a sample count with the slowest one, because
one loop cannot finish until the 9.3 MB file has. `everyday` is the number a PM
asks for first and the only size real files actually reach (the reference corpus
tops out at ~80 parcels), and it was getting as few samples as `xlarge` did.

The weights are roughly inverse to file size, so each size takes a comparable
share of the window and the small ones earn a percentile instead of a single
point. Because the pass is loop-count driven, those counts are **exact** rather
than "whatever fitted" — a run either produces 20 `everyday` samples or the
`SIZE_RAMP_DURATION_SECONDS` guard tripped.

Set the weights with `SIZE_LOOPS_{EVERYDAY,BUSY,LARGE,XLARGE}`, or run the whole
pass more than once with `SIZE_RAMP_LOOPS`.

##### The window is derived from the weights, and a short pass says so

The ramp is the only **loop-count driven** phase — every other one simply runs
for its window — and that makes its window load-bearing in a way theirs are not.
If the pass does not fit, the scheduler cuts the thread group off wherever it has
reached. The pass runs smallest-first, so what it loses is always the **tail**:
`large` and `xlarge`, the two sizes the ramp exists to characterise. Their rows
then do not appear at all, which reads exactly like a size that was never
configured.

So `SIZE_RAMP_DURATION_SECONDS` is not a number to keep in step by hand. It is
**derived**, like every phase delay: each size gets a per-validate time
allowance, and the window is what the weighted pass adds up to.

| Allowance                          | Default | Per validate of |
| ---------------------------------- | ------- | --------------- |
| `SIZE_ALLOWANCE_EVERYDAY_SECONDS`  | `2`     | 80 parcels      |
| `SIZE_ALLOWANCE_BUSY_SECONDS`      | `4`     | 800 parcels     |
| `SIZE_ALLOWANCE_LARGE_SECONDS`     | `12`    | 5 000 parcels   |
| `SIZE_ALLOWANCE_XLARGE_SECONDS`    | `26`    | 12 000 parcels  |

`20×2 + 8×4 + 3×12 + 2×26` = **160 s**, and the rest of the timeline re-derives
around it. Raise a weight and the window widens on its own; suppress the phase
with `SIZE_RAMP_THREADS=0` and it reserves nothing rather than leaving dead air
every later phase is pushed out by.

Those allowances are deliberately generous **estimates, not measurements** —
nobody has a validated latency for a 12 000-parcel file yet, and the plan's own
`validateBudgetMs` red line is 30 s. They only set the guard: a faster service
finishes the pass early and the ramp ends there. The cost of being generous is
dead air, which is why every run reports what it actually used:

```
Did the size ramp complete its pass?
  size      expected  got
  everyday  20        20
  busy      8         8
  large     3         1  ← CUT OFF
  xlarge    2         0  ← CUT OFF

  The ramp used 158s of its 160s window (99%).
```

Tighten the allowances from that number after the first real run. Until then the
window is sized to be wrong in the direction that costs wall clock rather than
the direction that costs the result.

#### What it uploads, and where the fixtures come from

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

The four default sizes are **committed** under `fixtures/` (with a
`manifest.json` recording each file's label, parcel count and size), because
generation is super-linear in parcel count — `xlarge` alone costs ~30 s in the
CDP container — and a committed file doubles as a stable artefact for ad-hoc
upload tests against any environment. Regenerate them with `npm run
gen-fixtures` after changing a size or bumping the `bng-library` pin; being
seeded, an unchanged generator reproduces them byte-for-byte, so a diff on the
binaries means the generator changed.

`stage-uploads.mjs` matches each requested size against the manifest by label
**and** parcel count, so a non-default `UPLOAD_SIZES` still works — that size is
simply generated at run time as before. This is why `bng-library` and its
`better-sqlite3` / `xlsx` peers stay baked into the image at build time (see the
`Dockerfile`); the CDP task pulls a finished image and needs no access to GitHub
or the npm registry.

For scale: real BNG files in the reference corpus top out around **80 parcels /
124 KB**, which is what `everyday` reproduces. The larger steps exist to find
where the service stops coping, not because anyone submits them today.

| Label      | Parcels | File size | Generation |
| ---------- | ------- | --------- | ---------- |
| `everyday` | 80      | 140 KB    | 0.02 s     |
| `busy`     | 800     | 704 KB    | 0.08 s     |
| `large`    | 5 000   | 4.0 MB    | 1.6 s      |
| `xlarge`   | 12 000  | 9.3 MB    | 9.0 s      |

The ramp stops at `xlarge`. At 12 000 parcels it is already two orders of
magnitude past anything the service is submitted in practice, so a bigger step
answers a question nobody is going to ask — and it is the expensive end to
stage, because generation is **super-linear** in parcel count: `partitionPolygon`
in `bng-library` re-sorts the whole parcel list on every split, so 4× the
parcels costs roughly 19× the time. Staging the whole ramp costs ~11 s of
generation before JMeter starts; each step's time is logged so a slow-looking
start is identifiable as setup.

#### Staging: what is measured and what is not

`scripts/stage-uploads.mjs` runs before JMeter and does the parts the
**validate-only** phases deliberately exclude — initiate, POST the file to the
CDP Uploader, wait for the virus scan. The size ramp and the revalidate
staircase then measure only `POST /baseline/validate/{uploadId}`, so their
numbers isolate the service's own cost from the uploader's.

The **upload journey** phases are the deliberate exception: each iteration
drives a real upload from the plan — initiate, multipart POST of that size's
committed fixture (`JOURNEY_FILE_<SIZE>` to override), then validate — so the
uploader and its scan are inside the measurement. There is still no client-side
polling loop: the backend's validate route waits for the scan itself, so the
`validate incl virus scan` leg carries that wait, the same wall clock a frontend
user experiences. Note the journey needs `UPLOAD_S3_BUCKET` to name a bucket the
environment's cdp-uploader may write to (its `CONSUMER_BUCKETS`) — the same
requirement staging has.

##### Prepared pools — projects that already hold a baseline

The edit, post-intervention, fetch and mixed groups all need something the plain
project pool cannot give them: an **empty project has no feature to edit, no
document worth fetching, and no baseline for a post-intervention upload to
reconcile against**. So staging also builds a *prepared* pool per size — N
projects with that size's baseline already validated into each — and writes
`stage/prepared-<size>.csv`:

```
projectId,featureId,broadType,habitatType,condition
```

Three things make this affordable rather than a second run's worth of setup:

- **One upload, N validates.** The same `uploadId` is validated into every project;
  the bytes are uploaded and scanned once. `/baseline/validate/{uploadId}` is not
  single-use — it reads the object from S3 each time.
- **The pool is sized from the active profile.** `entrypoint.sh` works out the widest
  step that will read each size and asks for exactly that many. A profile that does not
  run the `large` edit ladder never spends a 4 MB validate per project on it.
- **The edit is a no-op.** Each row carries the feature's *own* current values, and the
  PUT writes them straight back. That still does the whole read-modify-write — the
  `FOR UPDATE` select, the unit recalculation, the two audit copies — while being
  guaranteed valid, and it means the document does not drift over a run.

The **contention** ladder gets `stage/contention.csv`: many features of **one** project,
because that is the case the project row lock actually serialises.

##### Post-intervention staging — how the pair is built

`/post-intervention/validate` reconciles the upload against the baseline already stored
on the project, so a post-intervention file generated independently would share no
feature refs with it and reconcile against nothing.

`bng-library`'s synthetic mode emits **one** file carrying both the baseline and the
proposed state on every row — that file *is* the post-intervention half — and
`deriveBaselineFromSynthetic` copies it and clears the proposed columns to leave the
baseline. The pair therefore shares a redline, a parcel partition and every feature ref
by construction. Generation is seeded, so regenerating the pair reproduces a baseline
byte-identical to the committed fixture already staged.

`scripts/make-gpkg.mjs` exposes that as `makeGeoPackagePair`; staging uploads the
post-intervention half and emits `piUploadId_<size>`.

##### A phase whose prerequisite is missing is absent, not wrong

Staging is per-size and best-effort throughout, and each ladder has a different
prerequisite:

| Ladder | Needs |
| --- | --- |
| size ramp, revalidate | `uploadId_<size>` — a staged, scanned upload |
| upload journey | the committed fixture on disk, plus the project pool |
| post-intervention | `piUploadId_<size>` **and** the prepared pool |
| habitat edit | `prepared-<size>.csv` |
| edit contention | `contentionProjectId` |
| fetch ramp | `sizedProjectId_<size>` |
| mixed workload | `prepared-everyday.csv` **and** `uploadId_everyday` |

A missing prerequisite zeroes that phase's threads, and because the schedule is
**re-derived after staging**, the phase hands its window back rather than leaving dead
air every later phase is pushed out by. So a failed `large` stage shortens the run
instead of padding it, and the affected rows are *absent* from the report rather than
present and full of 404s.

Only two things still gate the task, because there is no partial run to salvage from
either: a failure to build the project pool, and a failure to stage *any* size at all.

##### The size labels are fixed; the sizes are not

`scenarios/bng-perf.jmx` reads `uploadId_everyday`, `uploadId_busy`,
`uploadId_large` and `uploadId_xlarge` by name — the generator writes one
sampler per size from `SIZE_LABELS` in `scenarios/ladders.config.mjs`. So
`UPLOAD_SIZES` sets **how big each step is**, which is the point of it, but not
what the steps are called.

A label the plan does not know would stage a file nothing ever validates; a label
the plan expects and does not get would leave a phase POSTing to
`/baseline/validate/` with an empty path segment — a phase's worth of 404s,
reported exactly as though the service had failed them. Neither is visible as
anything but bad numbers, so `stage-uploads.mjs` rejects both up front:

```
stage-uploads failed: UPLOAD_SIZES must name exactly the labels
scenarios/bng-perf.jmx reads (everyday, busy, large, xlarge) — not in the plan:
huge. Change the parcel counts, not the labels.
```

Staging also creates a **pool of projects**. Validation only runs the full
pipeline — extract, size, persist — when a `projectId` is supplied; without one
it stops after the geometry checks and would under-measure the real cost. And
concurrent uploads to the *same* project serialise on a row lock and 409, so
each concurrent thread needs its own.

Staging is on automatically for this plan and off for every other; override with
`STAGE_UPLOADS`.

#### Reading the result

The task log ends with a plain-English summary (`scripts/summarise-run.mjs`). That is
the part to paste into a ticket; the JMeter dashboard has the detail behind it. In
order:

1. **What happens when N people upload N files at once** — the end-to-end journey
   times, per size. The headline.
2. How long one upload takes by file size (the size ramp).
3. Where the journey time goes, per leg.
4. What validate alone costs as concurrency climbs.
5. What a post-intervention upload costs.
6. What editing one habitat costs, and how it scales.
7. What fetching a whole project costs, by document size.
8. What the mixed workload looks like.
9. What happens when two people edit the **same** project — as a **409 rate**, not a
   latency.
10. Whether the size ramp completed its pass.
11. What the probe saw during each phase, **chronologically**.

Read the ramp-coverage table (10) before reading anything into the size ramp. Every
other number in the summary is a latency, and a latency is only meaningful once you
know the samples behind it are the samples that were asked for.

Assertion failures do **not** gate the task, and a red Duration Assertion beyond
N users *is* the result rather than a failure. One assertion is different:
`Fixture actually validates` checks the response contains `"valid":true`. If
that goes red the staged file is not passing validation and every number in the
run is meaningless.

| Env var                          | Default                                        | Purpose                                                        |
| -------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `TEST_SCENARIO`                  | `bng-perf`                                     | Escape hatch only — leave unset to run the whole suite.         |
| `UPLOAD_SIZES`                   | `everyday:80,busy:800,large:5000,xlarge:12000` | How big each step is. `label:parcels` pairs — the **labels are fixed**, see below. |
| `STAGE_UPLOADS`                  | `true` for this plan                           | `false` skips staging *and* every phase that needed it.         |
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
| `SIZE_RAMP_DURATION_SECONDS`     | _derived_ (`160`)                              | Window reserved for the size-ramp pass. Derived from the weights and the allowances below; override and you own it. |
| `SIZE_ALLOWANCE_{EVERYDAY,BUSY,LARGE,XLARGE}_SECONDS` | `2/4/12/26`               | Time allowed per validate of each size. This is what the window is derived from. |
| `SIZE_RAMP_THREADS`              | `1`                                            | Users on the size ramp. `0` suppresses the phase — see below.    |
| `SIZE_RAMP_LOOPS`                | `1`                                            | Weighted passes over the four sizes.                            |
| `SIZE_LOOPS_{EVERYDAY,BUSY,LARGE,XLARGE}` | `20/8/3/2`                            | Samples per size in a pass. Weighted so small files earn a percentile. |
| `SIZE_RAMP_DELAY_SECONDS`        | _derived_                                      | When the size ramp starts.                                      |
| `PERF_PROFILE`                   | `standard`                                     | `quick` / `standard` / `full` / `soak` — which steps run. See [Profiles](#profiles--how-long-a-run-takes). |
| `PERF_DUMP_SCHEDULE`             | unset                                          | `true` prints the resolved schedule and exits, touching nothing. |
| `WINDOW_<step>`                  | _derived_                                      | Override one step's window, e.g. `WINDOW_journey_everyday_10=30`. The timeline re-derives around it. |
| `SOAK_DURATION_SECONDS`          | `1800` (soak profile)                          | How long the mixed workload is held for.                        |
| `MIX_THREADS`                    | `8`                                            | Threads on the mixed workload.                                  |
| `MIX_{LIST,FETCH,EDIT,VALIDATE}_PERCENT` | `40/25/25/10`                          | The mix, as percent of iterations. Warns if they do not total 100. |
| `MIX_THINK_MS`                   | `500`                                          | Pacing between mixed-workload iterations.                       |
| `JOURNEY_FILE_{EVERYDAY,BUSY,LARGE,XLARGE}` | the committed fixture               | The file that size's journey ladder uploads.                    |
| `JOURNEY_BUDGET_MS`              | `35000`                                        | Budget for the journey's validate leg. **Above** the backend's own 30 s scan wait — see below. |
| `JOURNEY_LARGE_BUDGET_MS`        | `60000`                                        | The same, for the non-`everyday` sizes.                         |
| `EDIT_BUDGET_MS`                 | `3000`                                         | Latency budget for one habitat edit.                            |
| `FETCH_BUDGET_MS`                | `5000`                                         | Latency budget for `GET /projects/{id}`.                        |
| `CONTENTION_FEATURES`            | `20`                                           | How many features of one project the contention ladder picks from. |
| `PREPARED_SIZES` / `PI_SIZES`    | _derived from the profile_                     | Which prepared pools staging builds, and how big. Override only to force one. |

**Why `JOURNEY_BUDGET_MS` is above 30 seconds.** The backend's validate route waits
for the virus scan itself (`waitForUploadReady`), gives up at **30 s** and throws
`UploadTimeoutError`, which the route turns into a 504. A budget below that made the
journey's failure mode a red *Duration* assertion at 20 s rather than a slow sample —
so "the scan queue backed up" read in the report as "the service broke". At 35 s the
budget sits on the far side of the backend's own timeout, which means a red duration
here is *slow* and a red status is *broken*, and the two can be told apart.

**Running only the everyday half.** `STAGE_UPLOADS=false` is enough on its own:
with no staged uploads there are no `uploadId`s, and every phase that needed one
is skipped. Add `PROBE_THREADS=0` and `SIZE_RAMP_THREADS=0` to collapse the
schedule as well, so the run ends when the everyday groups do (~25 s) instead of
waiting out a window nothing is running in. Useful locally when you are working
on the list endpoints rather than on upload:

```sh
STAGE_UPLOADS=false PROBE_THREADS=0 SIZE_RAMP_THREADS=0 \
docker compose up --build
```

Leave `RESULTS_OUTPUT_S3_PATH` unset and the S3 publish is skipped too, so the
LocalStack service can go with it.

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

**Want more samples rather than a faster answer?** Two knobs, in order of how
often you want them:

- `PERF_PROFILE=full` runs every step in the plan (~34 min). This is the usual answer,
  and it is what the profiles exist for.
- `WINDOW_<step>` lengthens one step — `WINDOW_journey_everyday_10=30` triples the
  samples behind that percentile. The timeline re-derives around it and every later
  phase, plus the probe, moves to match.

There is still no separate "deep" plan to remember: a profile picks *which* steps, a
window picks *how long* one of them runs, and everything else follows from those two.

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
| `CREATE_THREADS` / `CREATE_RAMP_SECONDS` / `CREATE_LOOPS` | `5` / `5` / `10`             | Create load profile. `CREATE_THREADS=0` disables the write load. |
| `CREATE_PARCELS`        | `25`                                                           | Baseline habitats per created project. **Dominant lever on DB growth.** |
| `CREATE_MAX_LATENCY_MS` | `2000`                                                         | Per-create time budget, typical baseline.           |
| `CREATE_LARGE_LOOPS`    | `1`                                                            | Worst-case probes per run (1 thread). `0` disables. |
| `CREATE_LARGE_PARCELS`  | `3900`                                                         | Habitats in the worst-case probe (~810 KB body).    |
| `CREATE_LARGE_MAX_LATENCY_MS` | `5000`                                                   | Time budget for the worst-case probe.               |
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

> **Local shortcut, with a caveat:** from the harness, `npm run perf` mints the stub
> token, seeds the project under its sub, runs JMeter and prints a per-endpoint
> pass/fail summary. It covers the **home-page and project-list groups only**. It
> drives `alpine/jmeter` directly rather than this repo's container, so it never runs
> `entrypoint.sh` — and upload staging lives there. The ten `/baseline/validate/`
> samplers get an empty upload id and the project-pool CSV is missing, so those phases
> report errors that say nothing about the service. **For upload numbers, run the
> container** (below). Closing that gap is harness work, tracked separately.

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

A local run defaults to `PERF_PROFILE=standard`, which is ~14 minutes. When you are
iterating on a change rather than measuring one:

```bash
PERF_PROFILE=quick docker compose up --build       # ~5 minutes
```

And to see what a profile would do before spending the time on it:

```bash
PERF_PROFILE=full PERF_DUMP_SCHEDULE=true ./entrypoint.sh
```

### Working on the suite itself

```bash
npm test               # the schedule arithmetic, the label contract, the summary
npm run check-scenario # fail if the committed plan is stale vs ladders.config.mjs
npm run gen-scenario   # regenerate it after editing scenarios/ladders.config.mjs
```

`npm ci --ignore-scripts` is enough to run the tests — nothing under test needs the
`better-sqlite3` native binary, which only the GeoPackage generator uses.

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

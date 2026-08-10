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

## Scenarios

Each `.jmx` under `scenarios/` is one suite. `entrypoint.sh` picks the file named by
`TEST_SCENARIO` (default `test`), so select a suite by setting that env var on the
CDP task (or `docker run`), e.g. `TEST_SCENARIO=project-list-payload`.

| Scenario                | Targets              | Covers                                                                 |
| ----------------------- | -------------------- | ---------------------------------------------------------------------- |
| `test`                  | any (`/`)            | Template smoke check that ships with the CDP perf-test skeleton.       |
| `project-list-payload`  | `bng-metric-backend` | BMD-933 — the project list endpoints ship the whole project document.  |

### `project-list-payload` (BMD-933)

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

**Point the suite at the backend**, not the frontend — set
`SERVICE_ENDPOINT=bng-metric-backend.<env>.cdp-int.defra.cloud` (and `SERVICE_PORT` /
`SERVICE_URL_SCHEME` if not the 443/https default).

**Seed first.** The environment must hold at least one project visible to the token's
user with a baseline uploaded — ideally a large, multi-thousand-parcel one — or the
`has_baseline` and document-body assertions have nothing to exercise.

The endpoints require a Defra ID Bearer token. Rather than replicate the interactive
OIDC login in JMeter, the token (and other tuning) is forwarded from env vars into
JMeter properties by `entrypoint.sh` — so the secret never lands in the committed
`.jmx` and is never echoed by `set -x`:

| Env var                 | JMeter prop           | Default  | Purpose                                             |
| ----------------------- | --------------------- | -------- | --------------------------------------------------- |
| `BEARER_TOKEN`          | `bearerToken`         | _(none)_ | Defra ID `id_token` for the seeded user. Required.  |
| `USER_ID`               | `userId`              | `me`     | `/users/{userId}` path segment (token `sub` is trusted, not this). |
| `LIST_SIZE_LIMIT_BYTES` | `listSizeLimitBytes`  | `262144` | Max allowed list response size (256 KB).            |
| `LIST_MAX_LATENCY_MS`   | `listMaxLatencyMs`    | `2000`   | Max allowed list response time.                     |
| `LIST_LIMIT`            | `limit`               | `50`     | Pagination `limit` exercised against both endpoints.|
| `LIST_OFFSET`           | `offset`              | `0`      | Pagination `offset`.                                |
| `LIST_THREADS`          | `threads`             | `10`     | Concurrent virtual users.                           |
| `LIST_RAMP_SECONDS`     | `rampSeconds`         | `10`     | Ramp-up period.                                     |
| `LIST_LOOPS`            | `loops`               | `20`     | Iterations per user.                                |

Obtain a token from a logged-in session (the frontend stores the `id_token` in the
`auth` session; against the `cdp-defra-id-stub` complete the register → relationship →
role → login flow and capture the forwarded `Authorization: Bearer` header on any
backend call).

Run it locally against a backend on `localhost:3001` with:

```sh
docker build . -t bng-perf-tests
docker run --rm --network host \
  -e TEST_SCENARIO=project-list-payload \
  -e SERVICE_ENDPOINT=localhost -e SERVICE_PORT=3001 -e SERVICE_URL_SCHEME=http \
  -e BEARER_TOKEN="<id_token>" -e USER_ID="<defra-id-sub>" \
  -e RESULTS_OUTPUT_S3_PATH='s3://my-bucket' -e S3_ENDPOINT='http://host.docker.internal:4566' \
  -e AWS_ACCESS_KEY_ID='test' -e AWS_SECRET_ACCESS_KEY='test' -e AWS_REGION='eu-west-2' \
  bng-perf-tests
```

## Local Testing with Docker Compose

You can run the entire performance test stack locally using Docker Compose, including LocalStack, Redis, and the target service. This is useful for development, integration testing, or verifying your test scripts **before committing to `main`**, which will trigger GitHub Actions to build and publish the Docker image.

### Build the Docker image

```bash
docker compose build --no-cache development
```

This ensures any changes to `entrypoint.sh` or other scripts are picked up properly.

---

### Start the full test stack

```bash
docker compose up --build
```

This brings up:

* `development`: the container that runs your performance tests
* `localstack`: simulates AWS S3, SNS, SQS, etc.
* `redis`: backing service for cache
* `service`: the application under test

Once all services are healthy, your performance tests will automatically start.

---

### Replace `service-name` in Compose File

In the `docker-compose.yml`, make sure to replace:

```yaml
image: defradigital/service-name:${SERVICE_VERSION:-latest}
```

with the actual name of your service’s image.

This is the service under test, which must expose a `/health` endpoint and listen on port `3000`.

---

### Notes

* S3 bucket is expected to be `s3://test-results`, automatically created inside LocalStack.
* Logs and reports are written to `./reports` on your host.
* `entrypoint.sh` should contain the logic to wait for dependencies and kick off the test run.
* The `depends_on` healthchecks ensure services like `localstack` and `service` are ready before tests start.
* If you make changes to test scripts or entrypoints, rerun with:

```bash
docker compose up --build
```

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

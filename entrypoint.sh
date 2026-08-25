#!/bin/sh
set -x

echo "run_id: $RUN_ID in $ENVIRONMENT"

NOW=$(date +"%Y%m%d-%H%M%S")

if [ -z "${JM_HOME}" ]; then
  JM_HOME=/opt/perftest
fi

JM_SCENARIOS=${JM_HOME}/scenarios
JM_REPORTS=${JM_HOME}/reports
JM_LOGS=${JM_HOME}/logs

mkdir -p ${JM_REPORTS} ${JM_LOGS}

SERVICE_PORT=${SERVICE_PORT:-443}
SERVICE_URL_SCHEME=${SERVICE_URL_SCHEME:-https}
STUB_BASE_URL=${STUB_BASE_URL:-https://cdp-defra-id-stub.${ENVIRONMENT}.cdp-int.defra.cloud/cdp-defra-id-stub}

# Redirect URI presented during the stub OIDC dance. The stub echoes the auth
# code back to whatever redirect_uri is given (it does not validate it against a
# registered client), and get-stub-token.mjs reads the code straight off the 302
# Location without ever calling the URL — so this only has to be a string, not a
# reachable endpoint. It MUST NOT contain `localhost`, though: on CDP the WAF
# 403s an /authorize request whose query carries a localhost/SSRF-looking target
# (that is what failed the perf-test run). Use the deployed frontend's callback
# on CDP; local (no WAF) keeps the real localhost callback.
if [ "${ENVIRONMENT}" = "local" ]; then
  OIDC_REDIRECT_URI=${OIDC_REDIRECT_URI:-http://localhost:3000/auth/callback}
else
  OIDC_REDIRECT_URI=${OIDC_REDIRECT_URI:-https://bng-metric-frontend.${ENVIRONMENT}.cdp-int.defra.cloud/auth/callback}
fi

# The suite is a SINGLE JMeter plan holding every thread group — the public home
# page, the authenticated project-list endpoints, and the upload size/concurrency
# ramps with their background probe — so one run produces one report. That is what
# the CDP portal serves: a single dashboard from the root of the results prefix,
# which is why this is one plan rather than several run in sequence. Nothing needs
# selecting; TEST_SCENARIO exists only as an escape hatch, and an unknown name
# falls back to the default, so a stale placeholder (e.g. the base image's
# inherited TEST_SCENARIO=test) can never fail the run.
SCENARIO=${TEST_SCENARIO:-bng-perf}
if [ ! -f "${JM_SCENARIOS}/${SCENARIO}.jmx" ]; then
  echo "WARNING: scenario '${SCENARIO}.jmx' not found in ${JM_SCENARIOS} — falling back to bng-perf" >&2
  SCENARIO=bng-perf
fi
SCENARIOFILE=${JM_SCENARIOS}/${SCENARIO}.jmx

# Per-service targets. The home-page group hits the frontend; the project-list
# group hits the backend. SERVICE_ENDPOINT still overrides the BACKEND host (kept
# for back-compat with existing CDP task config); FRONTEND_DOMAIN / BACKEND_DOMAIN
# override each host directly. All default to the deterministic CDP hostnames.
FRONTEND_DOMAIN=${FRONTEND_DOMAIN:-bng-metric-frontend.${ENVIRONMENT}.cdp-int.defra.cloud}
BACKEND_DOMAIN=${SERVICE_ENDPOINT:-${BACKEND_DOMAIN:-bng-metric-backend.${ENVIRONMENT}.cdp-int.defra.cloud}}
# Ports default to the shared SERVICE_PORT; override per service when the two
# hosts differ (e.g. a local stack: frontend :3000, backend :3001).
FRONTEND_PORT=${FRONTEND_PORT:-${SERVICE_PORT}}
BACKEND_PORT=${BACKEND_PORT:-${SERVICE_PORT}}

# Seed baseline projects through the backend API before the run, so the list
# endpoints have data to exercise on any environment — no DB access needed. Set
# SEED_VIA_API=false to skip (e.g. when the target is already seeded).
SEED_VIA_API=${SEED_VIA_API:-true}

# Write-path (project creation) load for the two "Project creation" thread
# groups. Every create is permanent: the row lands in bng.projects and the
# write_audit_log trigger copies the whole document into bng.audit_log, which is
# append-only (backend changelog/db.changelog-1.9.xml) and cannot be cleared
# down. The CDP perf-test environment persists between runs, so this profile IS
# the database growth rate — it is bounded here rather than cleaned up after.
#
# CREATE_PARCELS is the dominant lever: bytes written scale linearly with it,
# and the 3900-parcel documents the LIST scenario needs are a list fixture, not
# a realistic create. Set CREATE_THREADS=0 to drop the write load entirely, or
# CREATE_LARGE_LOOPS=0 to drop just the worst-case probe.
CREATE_THREADS=${CREATE_THREADS:-5}
CREATE_RAMP_SECONDS=${CREATE_RAMP_SECONDS:-5}
CREATE_LOOPS=${CREATE_LOOPS:-10}
CREATE_PARCELS=${CREATE_PARCELS:-25}
CREATE_MAX_LATENCY_MS=${CREATE_MAX_LATENCY_MS:-2000}
CREATE_LARGE_LOOPS=${CREATE_LARGE_LOOPS:-1}
CREATE_LARGE_PARCELS=${CREATE_LARGE_PARCELS:-3900}
CREATE_LARGE_MAX_LATENCY_MS=${CREATE_LARGE_MAX_LATENCY_MS:-5000}

# Upper bound on the permanent storage the create groups add, so the growth a
# run causes is visible in the log rather than found later on a disk alarm.
# ~210 bytes per serialised parcel (measured against the body the plan builds),
# doubled because the audit trigger stores a full second copy of every document.
# An UPPER bound: both groups are scheduled into the everyday phase, so a slow
# backend can cut them short before the loop counts are reached.
#
# NOTE this covers the create groups ONLY. The upload phases also write —
# /baseline/validate with a projectId replaces the geometry rows and UPDATEs the
# project document, and that update writes an audit row holding BOTH the new and
# previous document. At the staged fixture sizes that is the larger contributor.
PARCEL_BYTES=210
AUDIT_COPIES=2
BYTES_PER_KIB=1024
CREATE_PARCELS_TOTAL=$(( CREATE_THREADS * CREATE_LOOPS * CREATE_PARCELS \
  + CREATE_LARGE_LOOPS * CREATE_LARGE_PARCELS ))
GROWTH_KIB=$(( CREATE_PARCELS_TOTAL * PARCEL_BYTES * AUDIT_COPIES / BYTES_PER_KIB ))

# The plan's upload phases need real uploads sitting in S3 before JMeter starts,
# so they measure the validate call and not the uploader. Staging is therefore ON
# by default. Set STAGE_UPLOADS=false to skip it — the upload thread groups then
# validate an empty uploadId and report errors, so only do that when you care
# solely about the home-page and project-list groups.
STAGE_UPLOADS=${STAGE_UPLOADS:-true}
# The backend hands back only the uploader PATH, so the uploader's own host has
# to be resolved here. Mirrors the backend's own derivation from ENVIRONMENT.
if [ "${ENVIRONMENT}" = "local" ]; then
  CDP_UPLOADER_URL=${CDP_UPLOADER_URL:-http://localhost:7337}
else
  CDP_UPLOADER_URL=${CDP_UPLOADER_URL:-https://cdp-uploader.${ENVIRONMENT}.cdp-int.defra.cloud}
fi
PROJECTS_CSV=${PROJECTS_CSV:-${JM_HOME}/stage/projects.csv}

# ── Phase schedule ───────────────────────────────────────────────────────────
# The upload phases run one after another, and JMeter starts a thread group at an
# ABSOLUTE delay from the start of the run. Writing those delays out by hand means
# every duration change has to be propagated to every later phase; miss one and the
# phases overlap, which does not fail anything — it just makes a concurrency figure
# quietly stop meaning what its label says. So the delays are DERIVED: choose the
# durations, and the start times fall out of them.
#
# The durations below add up to a ~5 minute run — short enough that a change can be
# measured while you wait for it. Want more samples behind a percentile? Lengthen
# the phase you care about and the rest of the timeline follows; there is no second
# "deep" profile to remember, because a duration IS the knob.

# The two everyday groups are loop-count driven (home 1x5, list 10x20 over a 10s
# ramp), so this cap only bites when the backend is slow. It is a guard, not a
# budget — the groups end when their loops do.
EVERYDAY_PHASE_DURATION_SECONDS=${EVERYDAY_PHASE_DURATION_SECONDS:-25}
PROBE_BASELINE_SECONDS=${PROBE_BASELINE_SECONDS:-25}
SIZE_RAMP_DURATION_SECONDS=${SIZE_RAMP_DURATION_SECONDS:-60}
CONC_STEP_DURATION_SECONDS=${CONC_STEP_DURATION_SECONDS:-30}

# Dead time between phases, so the previous step's in-flight requests drain before
# the next one starts and its latencies are not charged to the wrong phase.
PHASE_GAP_SECONDS=${PHASE_GAP_SECONDS:-5}

# Each phase starts a gap after the previous one ends. An explicitly-set delay is
# honoured as-is: override one and you own the arithmetic from there on.
PROBE_DELAY_SECONDS=${PROBE_DELAY_SECONDS:-$((EVERYDAY_PHASE_DURATION_SECONDS + PHASE_GAP_SECONDS))}
# The probe's own baseline window is the quiet stretch between it starting and the
# first load phase — that is what every loaded phase is compared against.
SIZE_RAMP_DELAY_SECONDS=${SIZE_RAMP_DELAY_SECONDS:-$((PROBE_DELAY_SECONDS + PROBE_BASELINE_SECONDS))}

PHASE_CURSOR=$((SIZE_RAMP_DELAY_SECONDS + SIZE_RAMP_DURATION_SECONDS + PHASE_GAP_SECONDS))
CONC_DELAY_1=${CONC_DELAY_1:-${PHASE_CURSOR}}
PHASE_CURSOR=$((CONC_DELAY_1 + CONC_STEP_DURATION_SECONDS + PHASE_GAP_SECONDS))
CONC_DELAY_2=${CONC_DELAY_2:-${PHASE_CURSOR}}
PHASE_CURSOR=$((CONC_DELAY_2 + CONC_STEP_DURATION_SECONDS + PHASE_GAP_SECONDS))
CONC_DELAY_5=${CONC_DELAY_5:-${PHASE_CURSOR}}
PHASE_CURSOR=$((CONC_DELAY_5 + CONC_STEP_DURATION_SECONDS + PHASE_GAP_SECONDS))
CONC_DELAY_10=${CONC_DELAY_10:-${PHASE_CURSOR}}
PHASE_CURSOR=$((CONC_DELAY_10 + CONC_STEP_DURATION_SECONDS + PHASE_GAP_SECONDS))
CONC_DELAY_20=${CONC_DELAY_20:-${PHASE_CURSOR}}

# The probe has to outlive the last phase or the tail of the run is unobserved —
# which is exactly where an availability problem would show up.
RUN_END_SECONDS=$((CONC_DELAY_20 + CONC_STEP_DURATION_SECONDS))
PROBE_DURATION_SECONDS=${PROBE_DURATION_SECONDS:-$((RUN_END_SECONDS - PROBE_DELAY_SECONDS))}

# One-shot run-config banner. xtrace off so it reads as a clean block and so no
# secret can ever be echoed here. Surfaces the resolved config up front — the
# resolved scenario, the two targets, and OIDC_REDIRECT_URI (confirms the
# non-localhost WAF fix is active) — so a run can be triaged from the first
# screen of logs.
set +x
echo "──────────────────────────── bng-perf-tests run config ────────────────────────────"
echo "  run_id:              ${RUN_ID:-<unset>}"
echo "  environment:         ${ENVIRONMENT:-<unset>}"
echo "  scenario:            ${SCENARIO}"
echo "  frontend target:     ${SERVICE_URL_SCHEME}://${FRONTEND_DOMAIN}:${FRONTEND_PORT}"
echo "  backend target:      ${SERVICE_URL_SCHEME}://${BACKEND_DOMAIN}:${BACKEND_PORT}"
echo "  stub base URL:       ${STUB_BASE_URL}"
echo "  oidc redirect_uri:   ${OIDC_REDIRECT_URI}"
echo "  seed via API:        ${SEED_VIA_API} (target ${SEED_PROJECT_COUNT:-5} project(s))"
echo "  create load:         ${CREATE_THREADS}t x ${CREATE_LOOPS}L x ${CREATE_PARCELS} parcels, plus ${CREATE_LARGE_LOOPS} probe(s) x ${CREATE_LARGE_PARCELS} parcels"
echo "  create growth:       up to ~${GROWTH_KIB} KiB added by this run (bng.projects + append-only bng.audit_log — NOT reclaimable; excludes upload phases)"
echo "  nominal run:         ${RUN_END_SECONDS}s"
echo "  phase schedule:      everyday 0-${EVERYDAY_PHASE_DURATION_SECONDS}s | probe ${PROBE_DELAY_SECONDS}s+${PROBE_DURATION_SECONDS}s | ramp ${SIZE_RAMP_DELAY_SECONDS}s+${SIZE_RAMP_DURATION_SECONDS}s"
echo "                       conc ${CONC_DELAY_1}/${CONC_DELAY_2}/${CONC_DELAY_5}/${CONC_DELAY_10}/${CONC_DELAY_20}s, ${CONC_STEP_DURATION_SECONDS}s each"
echo "  stage uploads:       ${STAGE_UPLOADS}"
if [ "${STAGE_UPLOADS}" = "true" ]; then
  echo "  cdp-uploader:        ${CDP_UPLOADER_URL}"
  echo "  upload sizes:        ${UPLOAD_SIZES:-<defaults: everyday,busy,large,xlarge>}"
fi
echo "────────────────────────────────────────────────────────────────────────────────────"
set -x

# Mint the cdp-defra-id-stub token for the authenticated backend group. Sets
# BEARER_TOKEN (and USER_ID to the minted sub when unset). No-op if BEARER_TOKEN
# is already supplied.
mint_token() {
  if [ -n "${BEARER_TOKEN}" ]; then
    return 0
  fi
  # xtrace OFF so the token is never echoed into the CDP logs.
  set +x
  echo "▸ minting a cdp-defra-id-stub token from ${STUB_BASE_URL}"
  MINT_ERR=$(mktemp)
  BEARER_TOKEN=$(STUB_BASE_URL="${STUB_BASE_URL}" OIDC_REDIRECT_URI="${OIDC_REDIRECT_URI}" node "${JM_HOME}/scripts/get-stub-token.mjs" 2>"${MINT_ERR}")
  MINT_STATUS=$?
  cat "${MINT_ERR}" >&2
  if [ ${MINT_STATUS} -ne 0 ] || [ -z "${BEARER_TOKEN}" ]; then
    rm -f "${MINT_ERR}"
    set -x
    echo "ERROR: failed to mint a stub token. Is ${STUB_BASE_URL} reachable, and is the backend's OIDC_DISCOVERY_URL pointed at that stub?" >&2
    return 1
  fi
  # The backend trusts the token sub, not the path segment, but keep USER_ID
  # consistent with the minted sub when the caller has not set one.
  if [ -z "${USER_ID}" ]; then
    USER_ID=$(sed -n 's/^sub=//p' "${MINT_ERR}")
  fi
  rm -f "${MINT_ERR}"
  set -x
  return 0
}

# Seed baseline projects via the backend API, sharing the minted perf user.
# Idempotent to a target count (scripts/seed-via-api.mjs tops up to
# SEED_PROJECT_COUNT, never deletes), so re-runs do not pile rows up.
# $1 = backend base URL (scheme://host:port). No-op when SEED_VIA_API is not true.
seed_via_api() {
  api_base_url="$1"
  if [ "${SEED_VIA_API}" != "true" ]; then
    return 0
  fi
  # xtrace OFF so BEARER_TOKEN is never echoed into the CDP logs.
  set +x
  echo "▸ seeding baseline projects via ${api_base_url}/projects/new"
  API_BASE_URL="${api_base_url}" BEARER_TOKEN="${BEARER_TOKEN}" \
    node "${JM_HOME}/scripts/seed-via-api.mjs"
  SEED_STATUS=$?
  set -x
  if [ ${SEED_STATUS} -ne 0 ]; then
    echo "ERROR: seed-via-api failed against ${api_base_url}" >&2
    return 1
  fi
  return 0
}

# Stage real uploads for the plan's upload phases: generate GeoPackages at each size,
# push them through the CDP Uploader, wait for the scan, and create a pool of
# projects to spread concurrent writes across. Emits `key=value` lines which
# become -J properties, so the plan learns the staged uploadIds.
stage_uploads() {
  api_base_url="$1"
  if [ "${STAGE_UPLOADS}" != "true" ]; then
    return 0
  fi
  STAGE_OUT=$(mktemp)
  # xtrace OFF so BEARER_TOKEN is never echoed into the CDP logs.
  set +x
  echo "▸ staging uploads via ${api_base_url} (uploader: ${CDP_UPLOADER_URL})"
  # --no-warnings keeps node:sqlite's experimental notice out of the run log.
  API_BASE_URL="${api_base_url}" \
  BEARER_TOKEN="${BEARER_TOKEN}" \
  CDP_UPLOADER_URL="${CDP_UPLOADER_URL}" \
  STAGE_DIR="${JM_HOME}/stage" \
  PROJECTS_CSV="${PROJECTS_CSV}" \
  UPLOAD_SIZES="${UPLOAD_SIZES}" \
  PROJECT_POOL_SIZE="${PROJECT_POOL_SIZE}" \
  UPLOAD_READY_TIMEOUT_MS="${UPLOAD_READY_TIMEOUT_MS}" \
    node --no-warnings "${JM_HOME}/scripts/stage-uploads.mjs" > "${STAGE_OUT}"
  STAGE_STATUS=$?
  set -x
  if [ ${STAGE_STATUS} -ne 0 ]; then
    echo "ERROR: staging uploads failed against ${api_base_url}" >&2
    rm -f "${STAGE_OUT}"
    return 1
  fi
  # Each emitted line is uploadId_<label>=<uuid> (plus parcels_/bytes_ for the
  # record); turn them into JMeter properties the plan reads.
  set +x
  while IFS='=' read -r stage_key stage_value; do
    if [ -n "${stage_key}" ]; then
      add_prop "${stage_key}" "${stage_value}"
    fi
  done < "${STAGE_OUT}"
  set -x
  rm -f "${STAGE_OUT}"
  return 0
}

add_prop() {
  # $1 = JMeter property name, $2 = value. Skips empty values so the .jmx default
  # wins rather than being overridden with an empty string.
  if [ -n "$2" ]; then
    SCENARIO_PROPS="${SCENARIO_PROPS} -J$1=$2"
  fi
}

if [ ! -f "${SCENARIOFILE}" ]; then
  echo "ERROR: scenario ${SCENARIO}.jmx not found in ${JM_SCENARIOS}" >&2
  exit 1
fi

echo "=== Scenario: ${SCENARIO} (frontend=${FRONTEND_DOMAIN}, backend=${BACKEND_DOMAIN}) ==="

# The plan drives the authenticated backend endpoints, so a token and seeded data
# are prerequisites — both gate the run. Running the list group against an empty
# owner, or with no token, would prove nothing.
if ! mint_token; then
  echo "ERROR: no stub token — cannot run ${SCENARIO}" >&2
  exit 1
fi
if ! seed_via_api "${SERVICE_URL_SCHEME}://${BACKEND_DOMAIN}:${BACKEND_PORT}"; then
  echo "ERROR: seeding failed — cannot run ${SCENARIO}" >&2
  exit 1
fi

# Assemble properties with xtrace OFF so `set -x` never echoes BEARER_TOKEN. JWTs
# and the numeric tunables contain no whitespace, so leaving ${SCENARIO_PROPS}
# unquoted to word-split into separate args is safe.
set +x
SCENARIO_PROPS=""
add_prop bearerToken "${BEARER_TOKEN}"
add_prop userId "${USER_ID}"
add_prop maxResponseMs "${MAX_RESPONSE_MS}"
add_prop homeThreads "${HOME_THREADS}"
add_prop homeRampSeconds "${HOME_RAMP_SECONDS}"
add_prop homeLoops "${HOME_LOOPS}"
add_prop listThreads "${LIST_THREADS}"
add_prop listRampSeconds "${LIST_RAMP_SECONDS}"
add_prop listLoops "${LIST_LOOPS}"
add_prop listSizeLimitBytes "${LIST_SIZE_LIMIT_BYTES}"
add_prop listMaxLatencyMs "${LIST_MAX_LATENCY_MS}"
add_prop limit "${LIST_LIMIT}"
add_prop offset "${LIST_OFFSET}"
add_prop createThreads "${CREATE_THREADS}"
add_prop createRampSeconds "${CREATE_RAMP_SECONDS}"
add_prop createLoops "${CREATE_LOOPS}"
add_prop createParcels "${CREATE_PARCELS}"
add_prop createMaxLatencyMs "${CREATE_MAX_LATENCY_MS}"
add_prop createLargeLoops "${CREATE_LARGE_LOOPS}"
add_prop createLargeParcels "${CREATE_LARGE_PARCELS}"
add_prop createLargeMaxLatencyMs "${CREATE_LARGE_MAX_LATENCY_MS}"

# Upload load profile. The phase tunables are plain pass-throughs; the staged
# uploadIds are added by stage_uploads itself, which is why it has to run AFTER
# SCENARIO_PROPS is initialised — calling it earlier would have its properties
# wiped by the reset above.
add_prop projectsCsv "${PROJECTS_CSV}"
add_prop everydayPhaseDurationSeconds "${EVERYDAY_PHASE_DURATION_SECONDS}"
add_prop probeDelaySeconds "${PROBE_DELAY_SECONDS}"
add_prop probeDurationSeconds "${PROBE_DURATION_SECONDS}"
add_prop probeThreads "${PROBE_THREADS}"
add_prop probeThinkMs "${PROBE_THINK_MS}"
add_prop probeMaxLatencyMs "${PROBE_MAX_LATENCY_MS}"
add_prop validateBudgetMs "${VALIDATE_BUDGET_MS}"
add_prop everydayBudgetMs "${EVERYDAY_BUDGET_MS}"
add_prop validateResponseTimeoutMs "${VALIDATE_RESPONSE_TIMEOUT_MS}"
add_prop sizeRampDelaySeconds "${SIZE_RAMP_DELAY_SECONDS}"
add_prop sizeRampDurationSeconds "${SIZE_RAMP_DURATION_SECONDS}"
add_prop sizeRampThreads "${SIZE_RAMP_THREADS}"
add_prop sizeRampLoops "${SIZE_RAMP_LOOPS}"
add_prop sizeLoopsEveryday "${SIZE_LOOPS_EVERYDAY}"
add_prop sizeLoopsBusy "${SIZE_LOOPS_BUSY}"
add_prop sizeLoopsLarge "${SIZE_LOOPS_LARGE}"
add_prop sizeLoopsXlarge "${SIZE_LOOPS_XLARGE}"
add_prop concStepDurationSeconds "${CONC_STEP_DURATION_SECONDS}"
add_prop concDelay1 "${CONC_DELAY_1}"
add_prop concDelay2 "${CONC_DELAY_2}"
add_prop concDelay5 "${CONC_DELAY_5}"
add_prop concDelay10 "${CONC_DELAY_10}"
add_prop concDelay20 "${CONC_DELAY_20}"
add_prop concUsers1 "${CONC_USERS_1}"
add_prop concUsers2 "${CONC_USERS_2}"
add_prop concUsers5 "${CONC_USERS_5}"
add_prop concUsers10 "${CONC_USERS_10}"
add_prop concUsers20 "${CONC_USERS_20}"

set -x
if ! stage_uploads "${SERVICE_URL_SCHEME}://${BACKEND_DOMAIN}:${BACKEND_PORT}"; then
  echo "ERROR: upload staging failed — cannot run ${SCENARIO}" >&2
  exit 1
fi
set +x

REPORTFILE=${NOW}-perftest-${SCENARIO}-report.csv
LOGFILE=${JM_LOGS}/perftest-${SCENARIO}.log

# -f forces JMeter to overwrite an existing results file / report folder.
jmeter -n -t ${SCENARIOFILE} -e -l "${REPORTFILE}" -o ${JM_REPORTS} -j ${LOGFILE} -f \
  -Jenv="${ENVIRONMENT}" \
  -JfrontendDomain="${FRONTEND_DOMAIN}" \
  -JbackendDomain="${BACKEND_DOMAIN}" \
  -JfrontendPort="${FRONTEND_PORT}" \
  -JbackendPort="${BACKEND_PORT}" \
  -Jport="${SERVICE_PORT}" \
  -Jprotocol="${SERVICE_URL_SCHEME}" \
  ${SCENARIO_PROPS}
set -x

# Plain-English summary of the run, straight into the task log. The JMeter
# dashboard has the detail; this has the shape — cost by file size, cost by
# concurrency, and what an ordinary user saw while it happened. It is the thing
# you paste into a ticket, so a failure to render it must not fail the run.
if [ -f "${REPORTFILE}" ]; then
  set +x
  node "${JM_HOME}/scripts/summarise-run.mjs" "${REPORTFILE}" || \
    echo "WARNING: could not summarise ${REPORTFILE}" >&2
  set -x
fi

# Publish the single dashboard at the ROOT of the results prefix — the object the
# CDP portal serves as the report. Assertion failures do NOT gate: the list group
# encodes unshipped BMD-933 acceptance criteria and is red by design until the
# backend fix lands. This applies to the home-page group too — a down or slow
# frontend shows red samples in the report but still exits 0, so the portal
# dashboard, not the task exit code, is the source of truth. Only mint/seed and an
# infrastructure failure to publish (no report) gate the run.
if [ -z "${RESULTS_OUTPUT_S3_PATH}" ]; then
  echo "RESULTS_OUTPUT_S3_PATH is not set — skipping S3 publish"
  exit 0
fi
if [ ! -f "${JM_REPORTS}/index.html" ]; then
  echo "ERROR: ${JM_REPORTS}/index.html not found — nothing to publish" >&2
  exit 1
fi
# Both copies must succeed — publishing the report IS the point of the run, so a
# failed upload has to fail the task. Without this the portal shows "No report
# found" on a green task (the exact failure this addresses).
if ! aws --endpoint-url=$S3_ENDPOINT s3 cp "${REPORTFILE}" "${RESULTS_OUTPUT_S3_PATH}/${REPORTFILE}"; then
  echo "ERROR: failed to publish ${REPORTFILE} to ${RESULTS_OUTPUT_S3_PATH}" >&2
  exit 1
fi
if ! aws --endpoint-url=$S3_ENDPOINT s3 cp "${JM_REPORTS}" "${RESULTS_OUTPUT_S3_PATH}" --recursive; then
  echo "ERROR: failed to publish the report dashboard to ${RESULTS_OUTPUT_S3_PATH}" >&2
  exit 1
fi

# End-of-run summary. xtrace off so it stands out as a clean block at the tail.
set +x
echo "──────────────────────────── bng-perf-tests summary ───────────────────────────────"
echo "  run_id: ${RUN_ID:-<unset>} (environment ${ENVIRONMENT:-<unset>})"
echo "  ${SCENARIO}: RAN — report published to ${RESULTS_OUTPUT_S3_PATH}"
echo "  NOTE: red assertions in the report (project-list by design until the BMD-933 backend"
echo "        fix lands, or a slow/down frontend on the home-page group) do NOT gate the run."
echo "────────────────────────────────────────────────────────────────────────────────────"
set -x

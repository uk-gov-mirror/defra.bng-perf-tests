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
# by default. Set STAGE_UPLOADS=false to skip it — every upload phase is then
# skipped too (see disable_unstaged_phases), leaving the home-page, project-list
# and project-creation groups plus the probe.
#
# Staging is per-size and not all-or-nothing: a size that fails to stage costs
# its own phase, not the run. Only a total failure — or a failure to build the
# project pool, which every phase reads its projectId from — gates the task.
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
# The load phases run one after another, and JMeter starts a thread group at an
# ABSOLUTE delay from the start of the run. Writing those delays out by hand means
# every duration change has to be propagated to every later phase; miss one and the
# phases overlap, which does not fail anything — it just makes a concurrency figure
# quietly stop meaning what its label says. So the delays are DERIVED: choose the
# durations, and the start times fall out of them.
#
# What CHANGED: the plan now holds 53 ladder steps rather than 8, and writing a
# duration per step here would be the same copy-paste problem the .jmx had. So
# the durations are derived too — from how many samples a step is meant to
# produce (see scenarios/ladders.config.mjs) — and arrive precomputed per
# profile in scenarios/ladders.sh. This file still owns the one piece of
# arithmetic that has to stay at run time: turning a list of windows into
# absolute start delays, so changing PHASE_GAP_SECONDS or one window still
# slides everything after it.
# A missing ladders.sh would otherwise fail as a bare `.` with no explanation,
# and the whole schedule lives in it — there is no partial run without it.
if [ ! -f "${JM_SCENARIOS}/ladders.sh" ]; then
  echo "ERROR: ${JM_SCENARIOS}/ladders.sh not found. It is generated from" >&2
  echo "       scenarios/ladders.config.mjs — run \`npm run gen-scenario\` and commit it." >&2
  exit 1
fi
. "${JM_SCENARIOS}/ladders.sh"

# Which steps run, and how deeply they sample. A profile never changes what the
# plan CONTAINS — every step has a thread group either way — it sets thread
# counts, and a step at 0 threads costs nothing and reserves no wall clock.
#
#   quick     the shape of the curve, for iterating on a change   (~5 min)
#   standard  the contiguous journey ladder plus one step of
#             every other question — the default                  (~14 min)
#   full      every step in ladders.config.mjs                     (~33 min)
#   soak      the mixed workload only, held for SOAK_DURATION_SECONDS
PERF_PROFILE=${PERF_PROFILE:-${PERF_PROFILE_DEFAULT}}
profile_is_known() {
  for known in ${PERF_PROFILE_NAMES}; do
    if [ "${known}" = "$1" ]; then
      return 0
    fi
  done
  return 1
}
if ! profile_is_known "${PERF_PROFILE}"; then
  echo "ERROR: unknown PERF_PROFILE '${PERF_PROFILE}' — expected one of: ${PERF_PROFILE_NAMES}" >&2
  exit 1
fi

# Read a generated per-profile value. The keys come from ladders.sh, which this
# repo generates, so they are known-safe identifiers rather than operator input.
profile_value() {
  eval "printf '%s' \"\${PROFILE_$1_${PERF_PROFILE}_$2:-$3}\""
}

# The two everyday groups are loop-count driven (home 1x5, list 10x20 over a 10s
# ramp), so this cap only bites when the backend is slow. It is a guard, not a
# budget — the groups end when their loops do.
EVERYDAY_PHASE_DURATION_SECONDS=${EVERYDAY_PHASE_DURATION_SECONDS:-25}
PROBE_BASELINE_SECONDS=${PROBE_BASELINE_SECONDS:-25}

# The size ramp is the one phase that is LOOP-COUNT driven inside a duration
# guard rather than simply running for its window: it makes a fixed, weighted
# pass over the four sizes so each one gets an exact sample count. That only
# holds if the window is big enough for the pass. It was a flat 60s, which the
# default weights cannot fit — 33 validates, two of them a 9.3 MB file — and the
# scheduler cuts the group off wherever it has got to. The pass runs smallest
# first, so what it loses is always the tail: `large` and `xlarge`, the two sizes
# the ramp exists to characterise, and their rows just quietly stop appearing.
#
# So the window is DERIVED from the weights, the same way the delays are derived
# from the durations: allow each size a per-validate budget, and the window is
# what that pass adds up to. Change a weight and the window follows it.
#
# The allowances below are deliberately generous ORDERS OF MAGNITUDE, not
# measurements — nobody has a validated latency for a 12 000-parcel file yet.
# They only set the guard, so a faster service finishes the pass early and the
# ramp simply ends; the cost of being generous is dead air before the next
# phase, which is why summarise-run.mjs reports how much of the window the ramp
# actually used. Tighten them from that number after the first real run.
SIZE_ALLOWANCE_EVERYDAY_SECONDS=${SIZE_ALLOWANCE_EVERYDAY_SECONDS:-2}
SIZE_ALLOWANCE_BUSY_SECONDS=${SIZE_ALLOWANCE_BUSY_SECONDS:-4}
SIZE_ALLOWANCE_LARGE_SECONDS=${SIZE_ALLOWANCE_LARGE_SECONDS:-12}
SIZE_ALLOWANCE_XLARGE_SECONDS=${SIZE_ALLOWANCE_XLARGE_SECONDS:-26}

# The weights themselves. Defaulted HERE rather than only in the .jmx, because
# the window derivation needs them; they are still passed through as properties,
# so the plan's own defaults stay the fallback for a direct JMeter run.
#
# The weights default from the ACTIVE PROFILE rather than from a fixed number,
# because the size ramp sits in front of every ladder: at `quick` its 160s
# default would be most of the run, and at `soak` it is 160s of unrelated load
# before the clock even starts.
SIZE_RAMP_THREADS=${SIZE_RAMP_THREADS:-1}
SIZE_RAMP_LOOPS=${SIZE_RAMP_LOOPS:-1}
SIZE_LOOPS_EVERYDAY=${SIZE_LOOPS_EVERYDAY:-$(profile_value SIZE_LOOPS everyday 20)}
SIZE_LOOPS_BUSY=${SIZE_LOOPS_BUSY:-$(profile_value SIZE_LOOPS busy 8)}
SIZE_LOOPS_LARGE=${SIZE_LOOPS_LARGE:-$(profile_value SIZE_LOOPS large 3)}
SIZE_LOOPS_XLARGE=${SIZE_LOOPS_XLARGE:-$(profile_value SIZE_LOOPS xlarge 2)}

SIZE_RAMP_PASS_SECONDS=$(( SIZE_LOOPS_EVERYDAY * SIZE_ALLOWANCE_EVERYDAY_SECONDS \
  + SIZE_LOOPS_BUSY * SIZE_ALLOWANCE_BUSY_SECONDS \
  + SIZE_LOOPS_LARGE * SIZE_ALLOWANCE_LARGE_SECONDS \
  + SIZE_LOOPS_XLARGE * SIZE_ALLOWANCE_XLARGE_SECONDS ))
# Threads run the pass concurrently, so they do not lengthen it; loops repeat it.
# A suppressed phase reserves nothing, rather than leaving a window of dead air
# that every later phase is pushed out by.
if [ "${SIZE_RAMP_THREADS}" = "0" ]; then
  SIZE_RAMP_PASS_SECONDS=0
fi
SIZE_RAMP_DURATION_SECONDS=${SIZE_RAMP_DURATION_SECONDS:-$(( SIZE_RAMP_PASS_SECONDS * SIZE_RAMP_LOOPS ))}

# Dead time between phases, so the previous step's in-flight requests drain before
# the next one starts and its latencies are not charged to the wrong phase.
PHASE_GAP_SECONDS=${PHASE_GAP_SECONDS:-${PHASE_GAP_SECONDS_DEFAULT}}

# Each phase starts a gap after the previous one ends. An explicitly-set delay is
# honoured as-is: override one and you own the arithmetic from there on.
PROBE_DELAY_SECONDS=${PROBE_DELAY_SECONDS:-$((EVERYDAY_PHASE_DURATION_SECONDS + PHASE_GAP_SECONDS))}
# The probe's own baseline window is the quiet stretch between it starting and the
# first load phase — that is what every loaded phase is compared against.
SIZE_RAMP_DELAY_SECONDS=${SIZE_RAMP_DELAY_SECONDS:-$((PROBE_DELAY_SECONDS + PROBE_BASELINE_SECONDS))}

# ── The ladder walk ─────────────────────────────────────────────────────────
# Every ladder step, the fetch ramp and the mixed workload are scheduled here,
# in one loop, from the profile's phase list. This is the whole of what used to
# be twenty hand-written CONC_DELAY_* / JOURNEY_DELAY_* lines — and it is what
# makes a 53-step plan cost the same maintenance as an 8-step one.
#
# Three properties per phase, and one accumulator:
#   users_<key>   threads, from the profile (0 for a step it does not run)
#   window_<key>  how long it runs, precomputed from its target sample count
#   delay_<key>   when it starts — accumulated here, gap included
#
# A phase the profile leaves out never enters the loop, so it reserves no wall
# clock. That is the same contract SIZE_RAMP_THREADS=0 already had, applied to
# every step rather than to one phase.
# Start from every phase zeroed, so a step the profile omits is inert rather
# than falling back to the .jmx default (which is the STANDARD profile, and
# would quietly run a step `quick` deliberately left out).
for phase_key in ${ALL_PHASE_KEYS}; do
  eval "PHASE_USERS_${phase_key}=0"
  eval "PHASE_WINDOW_${phase_key}=0"
  eval "PHASE_DELAY_${phase_key}=0"
done

eval "PROFILE_PHASE_LIST=\${PROFILE_PHASES_${PERF_PROFILE}}"
for phase_key in ${PROFILE_PHASE_LIST}; do
  # The mixed workload is a workload rather than a staircase step, so it has no
  # user count in the ladder tables and takes MIX_THREADS instead. Its window is
  # SOAK_DURATION_SECONDS when that is set — which is what PERF_PROFILE=soak is.
  if [ "${phase_key}" = "mixed" ]; then
    phase_users=${MIX_THREADS:-${MIXED_THREADS_DEFAULT}}
    eval "phase_window=\${PROFILE_WINDOW_${PERF_PROFILE}_mixed}"
    phase_window=${SOAK_DURATION_SECONDS:-${phase_window}}
  else
    eval "phase_users=\${PROFILE_USERS_${PERF_PROFILE}_${phase_key}}"
    eval "phase_window=\${PROFILE_WINDOW_${PERF_PROFILE}_${phase_key}}"
  fi

  # An explicit WINDOW_<key> override is honoured as-is and the timeline
  # re-derives around it — set durations, not delays, as everywhere else here.
  eval "phase_window=\${WINDOW_${phase_key}:-\${phase_window}}"

  eval "PHASE_USERS_${phase_key}=${phase_users}"
  eval "PHASE_WINDOW_${phase_key}=${phase_window}"
done

# The fetch ramp is loop-count driven inside its window, like the size ramp, so
# its per-size counts come from the profile rather than from a thread count.
for upload_label in ${LADDER_SIZES}; do
  eval "FETCH_LOOPS_${upload_label}=\$(profile_value FETCH_LOOPS ${upload_label} 0)"
done

# Turn the windows into absolute start delays.
#
# This is a FUNCTION rather than a straight-line loop because it has to run
# twice: once here, so the config banner can state the schedule before anything
# slow happens, and again after staging, which is what decides whether a phase
# has anything to run against at all. A step zeroed by staging is skipped on the
# second pass, so it hands its window back to the run instead of leaving dead
# air every later phase is pushed out by — the same reclaim SIZE_RAMP_THREADS=0
# already got.
derive_ladder_delays() {
  PHASE_CURSOR=$((SIZE_RAMP_DELAY_SECONDS + SIZE_RAMP_DURATION_SECONDS + PHASE_GAP_SECONDS))
  LADDER_PHASE_COUNT=0
  for phase_key in ${PROFILE_PHASE_LIST}; do
    eval "phase_users=\${PHASE_USERS_${phase_key}}"
    eval "phase_window=\${PHASE_WINDOW_${phase_key}}"
    if [ "${phase_users}" = "0" ] || [ "${phase_window}" = "0" ]; then
      eval "PHASE_DELAY_${phase_key}=0"
      continue
    fi
    eval "PHASE_DELAY_${phase_key}=${PHASE_CURSOR}"
    PHASE_CURSOR=$((PHASE_CURSOR + phase_window + PHASE_GAP_SECONDS))
    LADDER_PHASE_COUNT=$((LADDER_PHASE_COUNT + 1))
  done

  # The last gap is dead air after the final phase, so the run ends a gap early.
  if [ ${LADDER_PHASE_COUNT} -gt 0 ]; then
    RUN_END_SECONDS=$((PHASE_CURSOR - PHASE_GAP_SECONDS))
  else
    RUN_END_SECONDS=$((SIZE_RAMP_DELAY_SECONDS + SIZE_RAMP_DURATION_SECONDS))
  fi

  # The probe has to outlive the last phase or the tail of the run is
  # unobserved — which is exactly where an availability problem would show up.
  # Re-derived with the rest, so a reclaimed window shortens the probe too.
  PROBE_DURATION_SECONDS=${PROBE_DURATION_SECONDS_OVERRIDE:-$((RUN_END_SECONDS - PROBE_DELAY_SECONDS))}
}

# ── Budgets and timeouts for the new groups ─────────────────────────────────
# A budget is a RED LINE in the report, not a cap on the request; the timeout is
# the point past which a sample is an error rather than a slow success.
#
# JOURNEY_BUDGET_MS deliberately sits ABOVE the backend's own scan wait.
# waitForUploadReady gives up at 30s and throws UploadTimeoutError, which the
# route turns into a 504 — so a budget below 30s made the journey's failure mode
# a red *assertion* at 20s rather than a slow sample, and "the scan queue backed
# up" read in the report as "the service broke". 35s puts the budget on the far
# side of that, so a red duration here means slow and a red status means broken.
JOURNEY_BUDGET_MS=${JOURNEY_BUDGET_MS:-35000}
JOURNEY_LARGE_BUDGET_MS=${JOURNEY_LARGE_BUDGET_MS:-60000}
EDIT_BUDGET_MS=${EDIT_BUDGET_MS:-3000}
EDIT_RESPONSE_TIMEOUT_MS=${EDIT_RESPONSE_TIMEOUT_MS:-30000}
FETCH_BUDGET_MS=${FETCH_BUDGET_MS:-5000}
FETCH_RESPONSE_TIMEOUT_MS=${FETCH_RESPONSE_TIMEOUT_MS:-60000}
INITIATE_RESPONSE_TIMEOUT_MS=${INITIATE_RESPONSE_TIMEOUT_MS:-30000}
UPLOAD_RESPONSE_TIMEOUT_MS=${UPLOAD_RESPONSE_TIMEOUT_MS:-120000}

# The mixed workload's weights, as percent of iterations. They should add up to
# 100 — ThroughputController does not require it, but a mix that does not is a
# mix nobody can reason about.
MIX_LIST_PERCENT=${MIX_LIST_PERCENT:-40}
MIX_FETCH_PERCENT=${MIX_FETCH_PERCENT:-25}
MIX_EDIT_PERCENT=${MIX_EDIT_PERCENT:-25}
MIX_VALIDATE_PERCENT=${MIX_VALIDATE_PERCENT:-10}
MIX_THINK_MS=${MIX_THINK_MS:-500}
MIX_TOTAL_PERCENT=$((MIX_LIST_PERCENT + MIX_FETCH_PERCENT + MIX_EDIT_PERCENT + MIX_VALIDATE_PERCENT))
if [ ${MIX_TOTAL_PERCENT} -ne 100 ]; then
  echo "WARNING: the mixed-workload weights add up to ${MIX_TOTAL_PERCENT}%, not 100% — the mix will not be the one you asked for" >&2
fi

# An operator-set PROBE_DURATION_SECONDS is honoured as-is; kept in its own
# variable so the re-derivation above cannot overwrite it on the second pass.
PROBE_DURATION_SECONDS_OVERRIDE=${PROBE_DURATION_SECONDS}
derive_ladder_delays

# A one-line, human-readable form of the schedule the walk just derived —
# "journey_everyday_1@1u/24s, journey_everyday_2@2u/12s, …" — so a run can be
# triaged from the first screen of logs without counting delays by hand.
LADDER_SCHEDULE_SUMMARY=""
for phase_key in ${PROFILE_PHASE_LIST}; do
  eval "phase_users=\${PHASE_USERS_${phase_key}}"
  eval "phase_window=\${PHASE_WINDOW_${phase_key}}"
  if [ "${phase_users}" = "0" ]; then
    continue
  fi
  LADDER_SCHEDULE_SUMMARY="${LADDER_SCHEDULE_SUMMARY}${phase_key}@${phase_users}u/${phase_window}s "
done

# ── What staging has to prepare ─────────────────────────────────────────────
# The edit, post-intervention, fetch and mixed groups all need PREPARED
# projects — ones that already hold a validated baseline — because an empty
# project has no feature to edit, no document worth fetching and no baseline for
# a post-intervention upload to reconcile against.
#
# How many is derived from the profile rather than fixed, because preparing a
# pool is not free: each project costs a validate of that size's file, and a
# `large` pool is a 4 MB validate per project. A profile that does not run the
# large edit ladder should not spend that setup time on it.
#
# The rule: a size needs as many prepared projects as the widest step that will
# read them, because those groups need each concurrent thread on a DIFFERENT
# project — they serialise on the project row lock otherwise, and would measure
# the lock instead of the work.
PREPARED_SIZES=""
PI_SIZES=""
CONTENTION_FEATURES=${CONTENTION_FEATURES:-20}
for upload_label in ${LADDER_SIZES}; do
  prepared_needed=0
  pi_needed=0
  for phase_key in ${ALL_PHASE_KEYS}; do
    eval "phase_users=\${PHASE_USERS_${phase_key}}"
    if [ "${phase_users:-0}" -eq 0 ]; then
      continue
    fi
    case "${phase_key}" in
      "edit_${upload_label}_"*)
        if [ "${phase_users}" -gt ${prepared_needed} ]; then
          prepared_needed=${phase_users}
        fi
        ;;
      "pi_${upload_label}_"*)
        pi_needed=1
        if [ "${phase_users}" -gt ${prepared_needed} ]; then
          prepared_needed=${phase_users}
        fi
        ;;
      *) ;;
    esac
  done

  # The mixed workload reads the everyday pool, one project per thread.
  if [ "${upload_label}" = "everyday" ] && [ "${PHASE_USERS_mixed:-0}" -gt ${prepared_needed} ]; then
    prepared_needed=${PHASE_USERS_mixed}
  fi
  # The fetch ramp only needs ONE project of each size it loops over.
  eval "fetch_loops=\${FETCH_LOOPS_${upload_label}:-0}"
  if [ "${fetch_loops}" -gt 0 ] && [ ${prepared_needed} -eq 0 ]; then
    prepared_needed=1
  fi
  # The contention ladder edits ONE project, and any prepared one will do.
  if [ "${upload_label}" = "everyday" ] && [ ${prepared_needed} -eq 0 ]; then
    for phase_key in ${ALL_PHASE_KEYS}; do
      case "${phase_key}" in
        editContention_*)
          eval "phase_users=\${PHASE_USERS_${phase_key}}"
          if [ "${phase_users:-0}" -gt 0 ]; then
            prepared_needed=1
          fi
          ;;
        *) ;;
      esac
    done
  fi

  if [ ${prepared_needed} -gt 0 ]; then
    PREPARED_SIZES="${PREPARED_SIZES}${PREPARED_SIZES:+,}${upload_label}:${prepared_needed}"
  fi
  if [ ${pi_needed} -eq 1 ]; then
    PI_SIZES="${PI_SIZES}${PI_SIZES:+,}${upload_label}"
  fi
done

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
echo "  nominal run:         ${RUN_END_SECONDS}s (~$((RUN_END_SECONDS / 60)) min)"
echo "  phase schedule:      everyday 0-${EVERYDAY_PHASE_DURATION_SECONDS}s | probe ${PROBE_DELAY_SECONDS}s+${PROBE_DURATION_SECONDS}s | ramp ${SIZE_RAMP_DELAY_SECONDS}s+${SIZE_RAMP_DURATION_SECONDS}s"
echo "  profile:             ${PERF_PROFILE} — ${LADDER_PHASE_COUNT} ladder phase(s) after the size ramp"
echo "                       ${LADDER_SCHEDULE_SUMMARY}"
echo "  size-ramp window:    ${SIZE_RAMP_DURATION_SECONDS}s for ${SIZE_RAMP_LOOPS} pass(es) of ${SIZE_LOOPS_EVERYDAY}/${SIZE_LOOPS_BUSY}/${SIZE_LOOPS_LARGE}/${SIZE_LOOPS_XLARGE} (everyday/busy/large/xlarge)"
echo "                       derived from ${SIZE_ALLOWANCE_EVERYDAY_SECONDS}/${SIZE_ALLOWANCE_BUSY_SECONDS}/${SIZE_ALLOWANCE_LARGE_SECONDS}/${SIZE_ALLOWANCE_XLARGE_SECONDS}s allowed per validate — the summary reports how much was used"
echo "  stage uploads:       ${STAGE_UPLOADS}"
echo "  prepared pools:      ${PREPARED_SIZES:-<none>} (projects pre-loaded with a baseline, for the edit/fetch/post-intervention groups)"
echo "  post-intervention:   ${PI_SIZES:-<none>}"
if [ "${STAGE_UPLOADS}" = "true" ]; then
  echo "  cdp-uploader:        ${CDP_UPLOADER_URL}"
  echo "  upload sizes:        ${UPLOAD_SIZES:-<defaults: everyday,busy,large,xlarge>}"
fi
echo "────────────────────────────────────────────────────────────────────────────────────"
set -x

# Print the resolved schedule and stop, without touching the network.
#
# The plan holds 53 ladder steps whose windows and delays are all derived, so
# "what would this profile actually run, and for how long?" is a question worth
# being able to ask before spending a run finding out. It is also what the test
# suite compares the shell's arithmetic against the generator's — the two derive
# the same schedule independently, and this is where they are checked to agree.
if [ "${PERF_DUMP_SCHEDULE}" = "true" ]; then
  set +x
  for phase_key in ${PROFILE_PHASE_LIST}; do
    eval "phase_users=\${PHASE_USERS_${phase_key}}"
    eval "phase_window=\${PHASE_WINDOW_${phase_key}}"
    eval "phase_delay=\${PHASE_DELAY_${phase_key}}"
    if [ "${phase_users}" = "0" ]; then
      continue
    fi
    # Marker-prefixed: the config banner writes to stdout too, and a consumer
    # of this has to be able to tell the two apart without parsing prose.
    echo "PHASE ${phase_key} ${phase_users} ${phase_window} ${phase_delay}"
  done
  echo "TOTAL RUN_END ${RUN_END_SECONDS}"
  echo "TOTAL PROBE ${PROBE_DELAY_SECONDS} ${PROBE_DURATION_SECONDS}"
  echo "TOTAL PREPARED ${PREPARED_SIZES:-none}"
  echo "TOTAL PI ${PI_SIZES:-none}"
  exit 0
fi

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
  PREPARED_SIZES="${PREPARED_SIZES}" \
  PI_SIZES="${PI_SIZES}" \
  CONTENTION_FEATURES="${CONTENTION_FEATURES}" \
    node --no-warnings "${JM_HOME}/scripts/stage-uploads.mjs" > "${STAGE_OUT}"
  STAGE_STATUS=$?
  set -x
  if [ ${STAGE_STATUS} -ne 0 ]; then
    echo "ERROR: staging uploads failed against ${api_base_url}" >&2
    rm -f "${STAGE_OUT}"
    return 1
  fi
  # Each emitted line is uploadId_<label>=<uuid>, one per size that STAGED —
  # a size that failed emits nothing, which is how disable_unstaged_phases below
  # knows to skip its phase. Turn them into JMeter properties the plan reads.
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

# True when stage_uploads emitted the property named $1.
staged_prop() {
  case "${SCENARIO_PROPS}" in
    *" -J$1="*) return 0 ;;
    *) return 1 ;;
  esac
}

# True when stage_uploads captured an uploadId for size label $1.
staged_upload() {
  staged_prop "uploadId_$1"
}

# Zero every phase in the ladder whose key starts with $1.
#
# The keys are `<ladder>_<size>_<users>`, so a prefix names exactly one ladder,
# or one ladder at one size. Zeroing the USER count is what suppresses a phase:
# derive_ladder_delays then skips it, and it reserves no wall clock.
disable_phases_matching() {
  for phase_key in ${ALL_PHASE_KEYS}; do
    case "${phase_key}" in
      "$1"*) eval "PHASE_USERS_${phase_key}=0" ;;
      *) ;;
    esac
  done
}

# Zero the loop/thread count of any phase whose prerequisite did not stage.
#
# Without this a phase whose fixture is missing (or the whole set, when
# STAGE_UPLOADS is false) POSTs to `/baseline/validate/` with an empty path
# segment: a phase's worth of 404s, recorded and reported exactly as though the
# service had failed them. Skipping the phase means it is ABSENT from the report
# rather than lying in it.
#
# Each ladder has a different prerequisite, and they are checked separately so
# one missing fixture costs its own phases rather than the run:
#
#   size ramp / revalidate  uploadId_<size>       — a staged, scanned upload
#   journey                 the project pool      — it uploads its own file
#   post-intervention       piUploadId_<size>     — and the prepared pool below
#   edit                    prepared-<size>.csv   — projects with a baseline in
#                                                   them and a feature to edit
#   edit contention         contentionProjectId   — one project, many features
#   fetch ramp              sizedProjectId_<size> — a project of that size
#   mixed                   prepared-everyday.csv + uploadId_everyday
disable_unstaged_phases() {
  # Nothing that touches an upload or a project pool can run without staging.
  if [ "${STAGE_UPLOADS}" != "true" ]; then
    echo "▸ STAGE_UPLOADS is not true — skipping every upload, edit and fetch phase" >&2
    for phase_key in ${ALL_PHASE_KEYS}; do
      eval "PHASE_USERS_${phase_key}=0"
    done
    for upload_label in ${LADDER_SIZES}; do
      eval "FETCH_LOOPS_${upload_label}=0"
    done
    SIZE_LOOPS_EVERYDAY=0
    SIZE_LOOPS_BUSY=0
    SIZE_LOOPS_LARGE=0
    SIZE_LOOPS_XLARGE=0
    return 0
  fi

  for upload_label in ${LADDER_SIZES}; do
    # The size ramp and the revalidate ladder both replay a staged upload.
    if ! staged_upload "${upload_label}"; then
      echo "▸ no staged upload for '${upload_label}' — skipping its size-ramp step and revalidate ladder" >&2
      case "${upload_label}" in
        everyday) SIZE_LOOPS_EVERYDAY=0 ;;
        busy) SIZE_LOOPS_BUSY=0 ;;
        large) SIZE_LOOPS_LARGE=0 ;;
        xlarge) SIZE_LOOPS_XLARGE=0 ;;
      esac
      disable_phases_matching "revalidate_${upload_label}_"
    fi

    # The journey uploads its own file every iteration, so what it needs is the
    # committed fixture on disk rather than anything staged.
    eval "journey_file=\${JOURNEY_FILE_$(printf '%s' "${upload_label}" | tr '[:lower:]' '[:upper:]')}"
    journey_file=${journey_file:-${JM_HOME}/fixtures/baseline-${upload_label}.gpkg}
    if [ ! -f "${journey_file}" ]; then
      echo "▸ no fixture at ${journey_file} — skipping the '${upload_label}' journey ladder" >&2
      disable_phases_matching "journey_${upload_label}_"
    fi

    # Post-intervention needs its own staged upload AND a prepared project to
    # validate it into — a post-intervention document is only meaningful
    # against a project that already holds the matching baseline.
    if ! staged_prop "piUploadId_${upload_label}"; then
      echo "▸ no staged post-intervention upload for '${upload_label}' — skipping its ladder" >&2
      disable_phases_matching "pi_${upload_label}_"
    fi

    # The edit ladder and the fetch ramp both read the prepared pool.
    if ! staged_prop "preparedCsv_${upload_label}"; then
      echo "▸ no prepared project pool for '${upload_label}' — skipping its edit ladder, fetch step and post-intervention ladder" >&2
      disable_phases_matching "edit_${upload_label}_"
      disable_phases_matching "pi_${upload_label}_"
      eval "FETCH_LOOPS_${upload_label}=0"
    fi
    if ! staged_prop "sizedProjectId_${upload_label}"; then
      eval "FETCH_LOOPS_${upload_label}=0"
    fi
  done

  if ! staged_prop contentionProjectId; then
    echo "▸ no contention project — skipping the edit-contention ladder" >&2
    disable_phases_matching "editContention_"
  fi

  # The mixed workload reads the prepared pool and revalidates the everyday
  # upload, so it needs both. It is the one group that would otherwise fail
  # halfway through its weights rather than not run at all.
  if ! staged_prop preparedCsv_everyday || ! staged_upload everyday; then
    echo "▸ mixed workload needs the everyday prepared pool and upload — skipping it" >&2
    PHASE_USERS_mixed=0
  fi

  # The fetch ramp is loop-count driven, so it is empty rather than absent when
  # every size has been zeroed. Zero its threads too, or it reserves a window to
  # do nothing in.
  fetch_loops_total=0
  fetch_window=0
  for upload_label in ${LADDER_SIZES}; do
    eval "fetch_loops=\${FETCH_LOOPS_${upload_label}}"
    eval "fetch_allowance=\${FETCH_SECONDS_PER_ITERATION_${upload_label}}"
    fetch_loops_total=$((fetch_loops_total + fetch_loops))
    fetch_window=$((fetch_window + fetch_loops * fetch_allowance))
  done
  if [ ${fetch_loops_total} -eq 0 ]; then
    PHASE_USERS_fetchRamp=0
  else
    # Re-derived from the sizes that SURVIVED. The profile's window covers all
    # four; if three of them have no prepared project, holding the full window
    # would spend most of it doing nothing while every later phase waited.
    PHASE_WINDOW_fetchRamp=${fetch_window}
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

# The upload journey. uploaderUrl because the backend returns only the upload
# PATH; uploadS3Bucket because /upload/initiate requires the caller to name a
# bucket the environment's cdp-uploader may write to — the same
# UPLOAD_S3_BUCKET staging itself uses.
add_prop uploaderUrl "${CDP_UPLOADER_URL}"
add_prop uploadS3Bucket "${UPLOAD_S3_BUCKET}"
add_prop journeyBudgetMs "${JOURNEY_BUDGET_MS}"
add_prop journeyLargeBudgetMs "${JOURNEY_LARGE_BUDGET_MS}"
# The journey ladder runs per SIZE, so each one names its own fixture. An
# operator override applies to one size rather than to "the journey file".
for upload_label in ${LADDER_SIZES}; do
  eval "journey_file=\${JOURNEY_FILE_$(printf '%s' "${upload_label}" | tr '[:lower:]' '[:upper:]')}"
  add_prop "journeyFile_${upload_label}" "${journey_file}"
done

# The edit and fetch groups.
add_prop editBudgetMs "${EDIT_BUDGET_MS}"
add_prop editResponseTimeoutMs "${EDIT_RESPONSE_TIMEOUT_MS}"
add_prop fetchBudgetMs "${FETCH_BUDGET_MS}"
add_prop fetchResponseTimeoutMs "${FETCH_RESPONSE_TIMEOUT_MS}"
add_prop initiateResponseTimeoutMs "${INITIATE_RESPONSE_TIMEOUT_MS}"
add_prop uploadResponseTimeoutMs "${UPLOAD_RESPONSE_TIMEOUT_MS}"

# The mixed workload's weights. Percent of iterations, so a slow endpoint does
# not quietly become a smaller share of the load.
add_prop mixListPercent "${MIX_LIST_PERCENT}"
add_prop mixFetchPercent "${MIX_FETCH_PERCENT}"
add_prop mixEditPercent "${MIX_EDIT_PERCENT}"
add_prop mixValidatePercent "${MIX_VALIDATE_PERCENT}"
add_prop mixThinkMs "${MIX_THINK_MS}"

set -x
if ! stage_uploads "${SERVICE_URL_SCHEME}://${BACKEND_DOMAIN}:${BACKEND_PORT}"; then
  echo "ERROR: upload staging failed — cannot run ${SCENARIO}" >&2
  exit 1
fi
set +x

# The per-phase loop and thread counts are added AFTER staging, because staging
# is what decides whether a phase has an upload to run against at all. Adding
# them earlier and overriding later would rely on JMeter's last-duplicate-wins
# behaviour for repeated -J flags; this way each property is passed exactly once.
disable_unstaged_phases

# Re-derive the timeline now that staging has decided what can actually run. A
# phase zeroed above hands its window back rather than leaving dead air, so a
# missing fixture shortens the run instead of padding it — and the probe, which
# is derived from where the last phase ends, shortens with it.
derive_ladder_delays
add_prop probeDurationSeconds "${PROBE_DURATION_SECONDS}"

add_prop sizeLoopsEveryday "${SIZE_LOOPS_EVERYDAY}"
add_prop sizeLoopsBusy "${SIZE_LOOPS_BUSY}"
add_prop sizeLoopsLarge "${SIZE_LOOPS_LARGE}"
add_prop sizeLoopsXlarge "${SIZE_LOOPS_XLARGE}"

# Every ladder phase, in one loop — the counterpart of the walk that derived
# them. A zeroed step is still passed explicitly rather than left to the .jmx
# default, because that default is the STANDARD profile and would otherwise run
# a step the active profile deliberately left out.
for phase_key in ${ALL_PHASE_KEYS}; do
  eval "phase_users=\${PHASE_USERS_${phase_key}}"
  eval "phase_window=\${PHASE_WINDOW_${phase_key}}"
  eval "phase_delay=\${PHASE_DELAY_${phase_key}}"
  # add_prop skips empty values so the .jmx default wins; a zero is a deliberate
  # value here, so it is passed as the string it is.
  SCENARIO_PROPS="${SCENARIO_PROPS} -Jusers_${phase_key}=${phase_users}"
  SCENARIO_PROPS="${SCENARIO_PROPS} -Jwindow_${phase_key}=${phase_window}"
  SCENARIO_PROPS="${SCENARIO_PROPS} -Jdelay_${phase_key}=${phase_delay}"
done
for upload_label in ${LADDER_SIZES}; do
  eval "fetch_loops=\${FETCH_LOOPS_${upload_label}}"
  SCENARIO_PROPS="${SCENARIO_PROPS} -JfetchLoops_${upload_label}=${fetch_loops}"
done

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
#
# SIZE_RAMP_EXPECTED is what the weighted pass was scheduled to produce, so the
# summary can say "0 of 2" for a size the window cut off. A truncated ramp is
# otherwise indistinguishable from one that was never configured: both are just
# an absent row.
if [ -f "${REPORTFILE}" ]; then
  set +x
  SIZE_RAMP_EXPECTED="everyday:$(( SIZE_LOOPS_EVERYDAY * SIZE_RAMP_LOOPS * SIZE_RAMP_THREADS ))"
  SIZE_RAMP_EXPECTED="${SIZE_RAMP_EXPECTED},busy:$(( SIZE_LOOPS_BUSY * SIZE_RAMP_LOOPS * SIZE_RAMP_THREADS ))"
  SIZE_RAMP_EXPECTED="${SIZE_RAMP_EXPECTED},large:$(( SIZE_LOOPS_LARGE * SIZE_RAMP_LOOPS * SIZE_RAMP_THREADS ))"
  SIZE_RAMP_EXPECTED="${SIZE_RAMP_EXPECTED},xlarge:$(( SIZE_LOOPS_XLARGE * SIZE_RAMP_LOOPS * SIZE_RAMP_THREADS ))"
  SIZE_RAMP_EXPECTED="${SIZE_RAMP_EXPECTED}" \
  SIZE_RAMP_WINDOW_SECONDS="${SIZE_RAMP_DURATION_SECONDS}" \
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

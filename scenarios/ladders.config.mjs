/**
 * The shape of every staircase in the plan — one source of truth.
 *
 * `scenarios/bng-perf.jmx` used to carry each step of each staircase as its own
 * hand-written thread group: five near-identical 95-line blocks for the
 * concurrency ramp, three more for the upload journey. Adding the contiguous
 * 1..10 ladder this file now describes would have meant ten more copies, and a
 * change to one sampler would have had to be made ten times by hand.
 *
 * So the repetitive half of the plan is GENERATED (scripts/gen-scenario.mjs)
 * from the tables below, and the result is committed — the same call the repo
 * already made for the upload fixtures. The .jmx stays a real file you can open
 * in the JMeter GUI and diff; it just is not the place you edit a ladder.
 *
 * ── Why the STEPS here are a superset ────────────────────────────────────────
 *
 * A JMeter thread group has to exist in the plan before it can run, so this
 * file lists every step any profile might want. Which of them actually run is a
 * RUN-TIME decision: entrypoint.sh sets each step's thread count from the
 * active PERF_PROFILE, and a step set to 0 threads is skipped — and, because
 * the phase delays are derived rather than written down, it reserves no wall
 * clock either. That is the same contract `SIZE_RAMP_THREADS=0` already had.
 *
 * ── Why each step gets its own WINDOW ────────────────────────────────────────
 *
 * Every step used to run for a flat 30 s. That is the wrong shape: with N
 * concurrent users, samples accumulate N times faster, so a flat window
 * over-samples the top of a ladder and under-samples the bottom — while
 * charging the run its most expensive wall clock for the steps that need it
 * least.
 *
 * Each step's window is therefore DERIVED from how many samples it is meant to
 * produce:
 *
 *   window(N) = clamp(targetSamples * secondsPerIteration / N, minStep, maxStep)
 *
 * A 1-user everyday journey step gets ~24 s; the 10-user step needs ~2.4 s for
 * the same sample count and lands on the 10 s floor. A contiguous 1..10 ladder
 * costs ~3 minutes rather than the ~6 a flat 30 s window would have.
 *
 * `secondsPerIteration` is an ALLOWANCE, not a measurement — the same status
 * the SIZE_ALLOWANCE_* numbers have. It only sizes the window; a faster service
 * simply fits more samples into it, and summarise-run.mjs reports what each
 * step actually produced so these can be tightened from real numbers.
 */

/**
 * Fixture labels the plan is wired to. Shared with stage-uploads.mjs, which
 * rejects an UPLOAD_SIZES spec naming anything else — a label the plan does not
 * know stages a file nothing validates.
 */
export const SIZE_LABELS = ['everyday', 'busy', 'large', 'xlarge']

/**
 * Shell-safe identifiers. Step properties become `-Jname=value` arguments and
 * entrypoint.sh deliberately leaves that string unquoted so it word-splits, so
 * anything with whitespace in it would split one argument into two.
 */
export const LADDERS = [
  {
    key: 'journey',
    /**
     * The FULL upload journey — initiate, multipart POST to the CDP Uploader,
     * then validate — as one closed loop per user. This is the only staircase
     * that puts real bytes through the uploader on every iteration, so it is
     * the one that answers "what happens when N people upload N files at once".
     *
     * Run per SIZE, not just at `everyday`: "10 people upload a 4 MB file at
     * once" is a different question from "10 people upload a 143 KB file at
     * once", and only the second one was ever asked before.
     */
    title: 'Upload journey',
    perSize: true,
    sizes: {
      // Contiguous 1..10: the point of a ladder is to find the knee, and
      // 1/2/5/10 cannot tell a cliff at 7 from a slope.
      everyday: { steps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], secondsPerIteration: 4 },
      busy: { steps: [1, 2, 5, 10], secondsPerIteration: 6 },
      large: { steps: [1, 2, 3, 5, 8, 10], secondsPerIteration: 14 },
      xlarge: { steps: [1, 2, 5], secondsPerIteration: 30 }
    },
    targetSamples: 5
  },
  {
    key: 'revalidate',
    /**
     * The original concurrency staircase, renamed.
     *
     * Every thread here re-validates ONE pre-staged upload, so it isolates the
     * service's own validate cost from the uploader's — which is what it is
     * for. It was called "Concurrency N user(s) — large file", which reads in a
     * pasted summary as "N people uploaded large files", and it is not that.
     * The journey ladder above is that.
     */
    title: 'Revalidate staged upload',
    perSize: true,
    sizes: {
      large: { steps: [1, 2, 3, 4, 5, 10, 15, 20], secondsPerIteration: 12 },
      xlarge: { steps: [1, 2, 5], secondsPerIteration: 26 }
    },
    targetSamples: 5
  },
  {
    key: 'pi',
    /**
     * Post-intervention validate — the peer of `/baseline/validate/` that no
     * sampler in the plan had ever touched.
     *
     * It is plausibly the heavier of the two: it reconciles the upload against
     * the baseline already stored on the project (enrichOptionsForPostIntervention
     * reads storedProject.baseline), so it only means anything against a
     * project that HAS a baseline. Staging builds exactly that.
     */
    title: 'Post-intervention validate',
    perSize: true,
    sizes: {
      everyday: { steps: [1, 2, 5, 10], secondsPerIteration: 5 },
      large: { steps: [1, 2, 5], secondsPerIteration: 16 }
    },
    // Three, not more: this ladder answers "does post-intervention cost more
    // than baseline", which is a comparison against the size ramp's numbers
    // rather than a percentile of its own.
    targetSamples: 3
  },
  {
    key: 'edit',
    /**
     * Habitat editing — the operation a user performs immediately after the
     * upload the rest of the plan measures, and the one nothing measured.
     *
     * Every PUT is O(document size) in three places: the handler SELECTs the
     * whole project FOR UPDATE and pulls the JSONB into Node, recalculates the
     * unit totals across it, and the write_projects_audit_log trigger stores
     * BOTH the new and the previous document. The write itself is a surgical
     * jsonb_set; nothing around it is.
     *
     * Each thread edits a DIFFERENT project, so this measures throughput rather
     * than contention. The contention ladder below is the other half.
     */
    title: 'Habitat edit (distinct projects)',
    perSize: true,
    sizes: {
      everyday: { steps: [1, 2, 3, 5, 10], secondsPerIteration: 1 },
      large: { steps: [1, 2, 5], secondsPerIteration: 4 }
    },
    targetSamples: 12
  },
  {
    key: 'editContention',
    /**
     * The same PUT, with every thread aimed at ONE project.
     *
     * runUpdate takes `SET LOCAL lock_timeout = '5s'` then SELECT … FOR UPDATE,
     * so concurrent edits to one project serialise and eventually 409 with
     * "Another edit for this project is in progress". Nobody has measured where
     * that 5 s timeout starts firing. The number to read here is the 409 rate,
     * not the latency — summarise-run.mjs reports it separately for that reason.
     */
    title: 'Habitat edit (same project)',
    perSize: false,
    steps: [2, 3, 5, 10],
    secondsPerIteration: 1,
    targetSamples: 12
  }
]

/**
 * Wall-clock guards every derived window is clamped into.
 *
 * The floor keeps a high-concurrency step long enough to be a measurement
 * rather than a burst.
 *
 * The ceiling stops a generous allowance at 1 user from quietly owning the run,
 * and it binds hard: at 14 s an iteration, a 1-user `large` journey step would
 * want 84 s for its six samples. It is set at 30 s rather than higher because a
 * ladder's 1-user step is a BASELINE FOR THAT LADDER, not the primary
 * single-upload measurement — the size ramp owns that question, at 1 user, with
 * exact loop-driven sample counts. Paying a minute and a half to measure it a
 * second time is the run's worst trade.
 */
export const WINDOW_BOUNDS = { minStepSeconds: 8, maxStepSeconds: 30 }

/**
 * What the JMeter plan's own duration does NOT include.
 *
 * `runSeconds` is the plan's nominal length. The task a person actually waits
 * for is longer: mint a stub token, seed, stage four uploads through a virus
 * scanner, build the prepared pools, then afterwards summarise and publish the
 * report to S3. None of that is in the plan's timeline, and staging is the bulk
 * of it.
 *
 * This is a conservative ESTIMATE, with the same status as the SIZE_ALLOWANCE_*
 * numbers: it only sizes the design-time budget check below. entrypoint.sh
 * measures the real figure every run and reports it, and re-checks the budget
 * against the measurement rather than against this — so a slow scanner is
 * caught on the day, not assumed away here. Tighten it from a real run.
 */
export const SETUP_ALLOWANCE_SECONDS = 90

/**
 * Profiles: which steps run, at what sampling depth.
 *
 * A profile never changes what the plan CONTAINS — every step above exists in
 * the .jmx either way. It sets thread counts, and a step at 0 threads costs
 * nothing and reserves nothing.
 *
 *   quick     — the shape of the curve, for iterating on a change (~6 min)
 *   standard  — the default: the contiguous journey ladder the suite exists
 *               for, plus one step of every other question (~13 min)
 *   full      — every step in this file (~35 min); an overnight answer
 *   soak      — the mixed workload only, held for SOAK_DURATION_SECONDS
 *
 * `steps` here INTERSECTS the ladder's own list — a profile can never invent a
 * step the plan has no thread group for.
 */
export const PROFILES = {
  quick: {
    description: 'the shape of the curve, for iterating on a change',
    budgetMinutes: 6,
    ladders: {
      journey: { everyday: [1, 2, 5] },
      revalidate: { large: [1, 5] },
      pi: {},
      edit: { everyday: [1, 5] },
      editContention: [5]
    },
    fetchRamp: true,
    mixedSeconds: 0,
    targetScale: 0.5,
    sizeRampLoops: { everyday: 6, busy: 3, large: 1, xlarge: 1 }
  },
  standard: {
    description: 'the default — the full journey ladder plus one step of everything else',
    // A HARD ceiling, enforced by a test: this profile is the one a person sits
    // and waits for, and a run they stop waiting for measures nothing. Every
    // trim in this block exists to hold it. If a future step will not fit,
    // that is a decision to make deliberately — put it in `deep`, or move the
    // ceiling on purpose.
    budgetMinutes: 10,
    // Trimmed to hold `budgetMinutes` below. Each cut is a redundancy rather
    // than a compromise:
    //
    //   journey.large [1, 2, 3]  →  [1, 3]
    //     1 and 3 bracket the range; the middle step of a three-step ladder is
    //     the one that buys least, and `full` still runs 1/2/3/5/8/10.
    //
    //   revalidate.large [1, 5, 20]  →  [5, 20]
    //     `revalidate_large_1` was the SAME REQUEST as the size ramp's
    //     `validate large file (1 user)` — one staged upload, one user, one
    //     POST to /baseline/validate. The size ramp already reports it, with an
    //     exact sample count. Read that row as this ladder's 1-user baseline.
    ladders: {
      journey: { everyday: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], large: [1, 3] },
      revalidate: { large: [5, 20] },
      pi: { everyday: [1, 5] },
      // 1 and 5 bracket the edit ladder; 2 sits between two points that are 10s
      // apart and is the one a reader would interpolate anyway. `deep` has it.
      edit: { everyday: [1, 5] },
      // The contention question is "at what concurrency do people start being
      // refused", and 2 users is where the answer is almost always "they don't".
      // 5 is the informative point; `deep` runs the ladder.
      editContention: [5]
    },
    fetchRamp: true,
    mixedSeconds: 25,
    targetScale: 1,
    // 20/8/3/2 reserved 160 s — nearly a third of a ten-minute budget, in front
    // of every ladder in the run. 12 everyday samples still earn a percentile,
    // and `xlarge` becomes a single worst-case probe, which is the pattern the
    // project-creation group already uses (CREATE_LARGE_LOOPS=1) for the same
    // reason: it is a stress fixture, not a size anyone submits.
    sizeRampLoops: { everyday: 8, busy: 3, large: 2, xlarge: 1 }
  },
  deep: {
    description: 'everything standard trims for time, without the full 27 minutes',
    // Nothing standard dropped is LOST — it is here. This is the profile to run
    // when a standard run has raised a question rather than answered it: the
    // intermediate ladder steps, both file sizes on every ladder, and a mixed
    // workload long enough to mean something.
    budgetMinutes: null,
    ladders: {
      journey: {
        everyday: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        busy: [1, 5, 10],
        large: [1, 2, 3, 5, 10]
      },
      revalidate: { large: [1, 2, 5, 10, 20] },
      pi: { everyday: [1, 2, 5, 10], large: [1, 5] },
      edit: { everyday: [1, 2, 3, 5, 10], large: [1, 5] },
      editContention: [2, 3, 5, 10]
    },
    fetchRamp: true,
    mixedSeconds: 120,
    targetScale: 1,
    sizeRampLoops: { everyday: 20, busy: 8, large: 3, xlarge: 2 }
  },
  full: {
    description: 'every step in ladders.config.mjs',
    budgetMinutes: null,
    ladders: 'all',
    fetchRamp: true,
    mixedSeconds: 90,
    targetScale: 1.5,
    sizeRampLoops: { everyday: 30, busy: 12, large: 5, xlarge: 3 }
  },
  soak: {
    description: 'the mixed workload only, held for SOAK_DURATION_SECONDS',
    budgetMinutes: null,
    ladders: {
      journey: {},
      revalidate: {},
      pi: {},
      edit: {},
      editContention: []
    },
    fetchRamp: false,
    mixedSeconds: 1800,
    targetScale: 1,
    // The soak is the mixed workload and nothing else: a size ramp in front of
    // it would just be 160s of unrelated load before the clock starts.
    sizeRampLoops: { everyday: 0, busy: 0, large: 0, xlarge: 0 }
  }
}

/**
 * The mixed workload's weights, as percent of iterations. They should add up to
 * 100 — ThroughputController does not require it, but a mix that does not is a
 * mix nobody can reason about.
 */
export const MIX_DEFAULTS = { list: 40, fetch: 25, edit: 25, validate: 10 }

/** The fetch ramp's per-size loop counts and its window, in seconds. */
export const FETCH_RAMP = {
  // Weighted like the size ramp and for the same reason — the small sizes are
  // cheap, so they can earn a percentile while the expensive ones stay a point
  // on the curve. `xlarge` is a single probe: at ~8 s a fetch it would
  // otherwise be a third of this phase for a document two orders of magnitude
  // past anything in the real corpus.
  loops: { everyday: 5, busy: 3, large: 2, xlarge: 1 },
  secondsPerIteration: { everyday: 1, busy: 2, large: 4, xlarge: 8 }
}

/** Threads the mixed workload runs with. */
export const MIXED_THREADS = 8

/**
 * The hand-written phases the ladder starts after, and what they cost.
 *
 * The size ramp's window is loop-count driven — `loops x allowance` per size —
 * and its ALLOWANCES are deliberately generous guards rather than
 * measurements, so a faster service finishes the pass early. The wall clock is
 * reserved either way, which is why the weights are a profile knob: at 20/8/3/2
 * the ramp is 160 s, and it sits in front of every ladder in the run.
 */
export const SIZE_ALLOWANCE_SECONDS = {
  everyday: 2,
  busy: 4,
  large: 12,
  xlarge: 26
}

export const EVERYDAY_PHASE_SECONDS = 25
export const PROBE_BASELINE_SECONDS = 25

/** The size ramp's reserved window under a given profile's weights. */
export function sizeRampWindowSeconds(profileName) {
  const weights = PROFILES[profileName].sizeRampLoops
  return SIZE_LABELS.reduce(
    (total, size) => total + weights[size] * SIZE_ALLOWANCE_SECONDS[size],
    0
  )
}

/**
 * Where the generated block starts in the timeline: after the everyday groups,
 * the quiet probe baseline and the size ramp.
 *
 * Derived rather than written down, so trimming the size-ramp weights actually
 * shortens the run instead of leaving a hole in front of it. entrypoint.sh
 * computes the same figure from the durations in force at run time; this is
 * what the committed .jmx bakes in so a bare `jmeter -t` still gets a coherent
 * schedule.
 */
export function generatedBlockStartSeconds(profileName) {
  return (
    EVERYDAY_PHASE_SECONDS +
    DEFAULT_PHASE_GAP_SECONDS +
    PROBE_BASELINE_SECONDS +
    sizeRampWindowSeconds(profileName) +
    DEFAULT_PHASE_GAP_SECONDS
  )
}

/** The whole run, end to end, under a profile's own defaults. */
export function runSeconds(profileName) {
  const scheduled = scheduleFrom(
    profilePhases(profileName),
    generatedBlockStartSeconds(profileName)
  )
  return scheduled.length
    ? scheduled.at(-1).delay + scheduled.at(-1).window
    : generatedBlockStartSeconds(profileName)
}

/** The profile the committed .jmx bakes in as its own defaults. */
export const DEFAULT_PROFILE = 'standard'

/**
 * Dead time between phases, so one phase's stragglers drain before the next and
 * its latencies are not charged to the wrong phase.
 *
 * It used to be a flat 5 s everywhere, which across 25 phases was 125 s — a
 * fifth of the ladder — spent waiting for requests that had mostly already
 * finished. What a phase actually needs is roughly **one in-flight request**:
 * an `edit` iteration takes about a second, so five seconds of silence after it
 * is four seconds of nothing. A `large` journey iteration takes fourteen, and
 * that one genuinely needs the full gap.
 *
 * So the gap is derived from the same per-iteration allowance the window is,
 * and clamped: never less than a second (a gap of zero would let a phase's tail
 * land inside the next phase's first samples), never more than the old flat
 * value. summarise-run.mjs already attributes a probe sample caught in an
 * overlap to the DRAINING phase, so a gap that turns out slightly short is
 * reported correctly rather than silently mixing two phases together.
 */
export const PHASE_GAP_BOUNDS = { minSeconds: 1, maxSeconds: 5 }

/** The gap after a phase whose iterations cost `secondsPerIteration`. */
export function phaseGapSeconds(secondsPerIteration) {
  return Math.min(
    PHASE_GAP_BOUNDS.maxSeconds,
    Math.max(PHASE_GAP_BOUNDS.minSeconds, Math.ceil(secondsPerIteration))
  )
}

/**
 * The gap used where there is no per-iteration figure to derive one from — the
 * boundaries around the hand-written phases (everyday groups, probe baseline,
 * size ramp), and the fetch ramp and mixed workload, whose iterations vary.
 */
export const DEFAULT_PHASE_GAP_SECONDS = PHASE_GAP_BOUNDS.maxSeconds

const PERCENT = 100

/**
 * How long one step runs.
 *
 * With N concurrent users, samples accumulate N times faster — so a step's
 * window is the wall clock it needs to produce `targetSamples`, not a flat
 * number repeated up the ladder. That is what makes a contiguous 1..10 ladder
 * affordable: the expensive windows are at the bottom, where one user has to
 * wait out each iteration in turn, and the top of the ladder lands on the floor.
 */
export function windowSeconds({ ladder, size, users }, targetScale = 1) {
  const perIteration = ladder.perSize
    ? ladder.sizes[size].secondsPerIteration
    : ladder.secondsPerIteration
  const target = Math.max(1, Math.round(ladder.targetSamples * targetScale))
  const needed = Math.ceil((target * perIteration) / users)
  return Math.min(
    WINDOW_BOUNDS.maxStepSeconds,
    Math.max(WINDOW_BOUNDS.minStepSeconds, needed)
  )
}

/** The fetch ramp's window, derived from its loop counts the same way. */
export function fetchRampWindowSeconds(targetScale = 1) {
  return SIZE_LABELS.reduce(
    (total, size) =>
      total +
      Math.round(FETCH_RAMP.loops[size] * targetScale) *
        FETCH_RAMP.secondsPerIteration[size],
    0
  )
}

/**
 * Every phase a profile runs, in the order it runs them, with the window each
 * one gets. A step the profile does not enable is absent rather than present
 * with zero threads — that is what lets it reserve no wall clock.
 *
 * The order is: each ladder in the order declared above, by size and then by
 * ascending user count, then the fetch ramp, then the mixed workload. Ascending
 * within a ladder matters — a staircase that does not climb is not a staircase,
 * and a heavy step leaves the service warmer than the step below it would find.
 */
export function profilePhases(profileName) {
  const profile = PROFILES[profileName]
  if (!profile) {
    throw new Error(
      `unknown profile "${profileName}" — expected one of ${Object.keys(PROFILES).join(', ')}`
    )
  }
  const phases = []
  for (const ladder of LADDERS) {
    const enabled = enabledStepsFor(profile, ladder)
    const ordered = ladderSteps(ladder)
      .filter((step) =>
        (ladder.perSize ? enabled[step.size] : enabled).includes(step.users)
      )
      .sort(bySizeThenUsers)
    for (const step of ordered) {
      const perIteration = ladder.perSize
        ? ladder.sizes[step.size].secondsPerIteration
        : ladder.secondsPerIteration
      phases.push({
        key: stepKey(step),
        users: step.users,
        window: windowSeconds(step, profile.targetScale),
        gap: phaseGapSeconds(perIteration)
      })
    }
  }
  if (profile.fetchRamp) {
    phases.push({
      key: 'fetchRamp',
      users: 1,
      window: fetchRampWindowSeconds(profile.targetScale),
      gap: DEFAULT_PHASE_GAP_SECONDS
    })
  }
  if (profile.mixedSeconds > 0) {
    phases.push({
      key: 'mixed',
      users: null,
      window: profile.mixedSeconds,
      gap: DEFAULT_PHASE_GAP_SECONDS
    })
  }
  return phases
}

function bySizeThenUsers(a, b) {
  const sizeDelta =
    SIZE_LABELS.indexOf(a.size ?? '') - SIZE_LABELS.indexOf(b.size ?? '')
  return sizeDelta !== 0 ? sizeDelta : a.users - b.users
}

/**
 * The steps a profile enables for one ladder, intersected with the steps the
 * plan has a thread group for. A profile can narrow the plan; it can never
 * invent a step that does not exist in it.
 */
export function enabledStepsFor(profile, ladder) {
  if (profile.ladders === 'all') {
    return ladder.perSize
      ? Object.fromEntries(
          Object.entries(ladder.sizes).map(([size, spec]) => [size, spec.steps])
        )
      : ladder.steps
  }
  const wanted = profile.ladders[ladder.key]
  if (!ladder.perSize) {
    const available = new Set(ladder.steps)
    return (wanted ?? []).filter((n) => available.has(n))
  }
  return Object.fromEntries(
    Object.entries(ladder.sizes).map(([size, spec]) => {
      const available = new Set(spec.steps)
      return [size, (wanted?.[size] ?? []).filter((n) => available.has(n))]
    })
  )
}

/**
 * Walk a profile's phases and hand each one its absolute start delay.
 *
 * JMeter starts a thread group at an absolute delay from the start of the run,
 * so this is the arithmetic that has to be right: miss it and two phases
 * overlap, which fails nothing and simply makes a concurrency figure stop
 * meaning what its label says. entrypoint.sh runs the identical accumulation in
 * sh so an operator can change a window and have the timeline follow.
 */
export function scheduleFrom(phases, startAtSeconds, gapOverride) {
  let cursor = startAtSeconds
  return phases.map((phase) => {
    const scheduled = { ...phase, delay: cursor }
    // An explicitly-set gap applies to every phase — an operator who sets
    // PHASE_GAP_SECONDS is asking for a uniform one, and from there the
    // arithmetic is theirs, as it already was for an explicitly-set delay.
    cursor += phase.window + (gapOverride ?? phase.gap)
    return scheduled
  })
}

/** Percent → the integer sh can carry, since sh has no floating point. */
export function asPercent(fraction) {
  return Math.round(fraction * PERCENT)
}

/** Every step of a ladder, flattened to `{ ladder, size, users }`. */
export function ladderSteps(ladder) {
  if (!ladder.perSize) {
    return ladder.steps.map((users) => ({ ladder, size: null, users }))
  }
  return Object.entries(ladder.sizes).flatMap(([size, spec]) =>
    spec.steps.map((users) => ({ ladder, size, users, spec }))
  )
}

/**
 * The property-name suffix identifying one step. `journey_everyday_3`,
 * `editContention_5`. Used for both the thread count and the delay, so the
 * generated .jmx and entrypoint.sh cannot drift apart on naming.
 */
export function stepKey({ ladder, size, users }) {
  return size ? `${ladder.key}_${size}_${users}` : `${ladder.key}_${users}`
}

/** The sampler label suffix a step's samples carry into the results CSV. */
export function stepLabel({ size, users }) {
  return size ? `(${size}) @ ${users} user(s)` : `@ ${users} user(s)`
}

/**
 * Does a profile fit its own time budget, once setup is accounted for?
 *
 * Returns null for a profile with no budget (`deep`, `full`, `soak` are
 * deliberately long-running). Otherwise returns the projection and whether it
 * fits, so the caller can decide whether that is a warning or a failure — the
 * test treats it as a failure, entrypoint.sh as a warning against the MEASURED
 * setup time rather than the estimate.
 */
export function budgetCheck(profileName, setupSeconds = SETUP_ALLOWANCE_SECONDS) {
  const budget = PROFILES[profileName].budgetMinutes
  if (!budget) {
    return null
  }
  const limitSeconds = budget * SECONDS_PER_MINUTE
  const projectedSeconds = runSeconds(profileName) + setupSeconds
  return {
    profile: profileName,
    limitSeconds,
    planSeconds: runSeconds(profileName),
    setupSeconds,
    projectedSeconds,
    fits: projectedSeconds <= limitSeconds,
    marginSeconds: limitSeconds - projectedSeconds
  }
}

const SECONDS_PER_MINUTE = 60

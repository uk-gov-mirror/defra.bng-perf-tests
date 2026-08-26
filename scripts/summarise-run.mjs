/**
 * Turn the JMeter results CSV into a plain-English summary.
 *
 * The JMeter dashboard is the detailed report, but it answers "what were the
 * numbers" rather than "is this a problem". This prints the shape a PM needs:
 * what an everyday upload costs, how that changes as files get bigger, how it
 * changes as more people upload at once, and — the one that decides whether any
 * of it matters — what an ordinary user was experiencing at the same time.
 *
 * It also states whether the size ramp completed the pass it was scheduled to
 * make. That check comes before the latencies for a reason: a latency only means
 * something once the samples behind it are the samples that were asked for.
 *
 * Reads the CSV JMeter writes with -l. Usage:
 *   node scripts/summarise-run.mjs <results.csv>
 */
import { readFileSync } from 'node:fs'

import { parse } from 'csv-parse/sync'

const PERCENTILE_95 = 0.95
const MS_PER_SECOND = 1000

/**
 * JMeter quotes the response and failure messages, and those routinely contain
 * newlines (a stack trace, a multi-line body), so this cannot be a line split —
 * that shreds those rows and silently loses samples. `relax_column_count` keeps
 * a short final row (the task killed mid-write) parseable rather than fatal.
 */
const CSV_OPTIONS = {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
  bom: true
}

// A file that ends *inside* an open quote is the other half of the killed-
// mid-write case, and no parser option covers it: the record is genuinely
// incomplete. Drop the trailing partial record and retry. Bounded, because one
// partial record can span several lines but a healthy file needs none of this.
const MAX_TRUNCATION_TRIMS = 8

function parseResults(text) {
  let body = text
  for (let attempt = 0; attempt <= MAX_TRUNCATION_TRIMS; attempt++) {
    try {
      return parse(body, CSV_OPTIONS)
    } catch (err) {
      const lastNewline = body.lastIndexOf('\n')
      if (err.code !== 'CSV_QUOTE_NOT_CLOSED' || lastNewline === -1) {
        throw err
      }
      body = body.slice(0, lastNewline)
    }
  }
  throw new Error('results CSV is still unparseable after trimming its tail')
}

function readSamples(path) {
  return parseResults(readFileSync(path, 'utf8'))
    .map((r) => ({
      ts: Number(r.timeStamp),
      elapsed: Number(r.elapsed),
      label: r.label,
      thread: r.threadName,
      ok: r.success === 'true'
    }))
    // A truncated final row has no label; drop it rather than letting it skew a
    // phase it cannot be attributed to.
    .filter((s) => s.label && Number.isFinite(s.ts) && Number.isFinite(s.elapsed))
}

function percentile(sorted, p) {
  if (sorted.length === 0) {
    return 0
  }
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

function stats(samples) {
  const times = samples.map((s) => s.elapsed).sort((a, b) => a - b)
  const failed = samples.filter((s) => !s.ok).length
  return {
    count: samples.length,
    mean: Math.round(times.reduce((a, b) => a + b, 0) / (times.length || 1)),
    p95: Math.round(percentile(times, PERCENTILE_95)),
    max: times.at(-1) ?? 0,
    failedPct: samples.length
      ? Math.round((failed / samples.length) * 100)
      : 0
  }
}

function fmtMs(ms) {
  return ms >= MS_PER_SECOND ? `${(ms / MS_PER_SECOND).toFixed(1)}s` : `${ms}ms`
}

function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  )
  const line = (cells) =>
    '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  return [
    line(headers),
    line(widths.map((w) => '─'.repeat(w))),
    ...rows.map((r) => line(r))
  ].join('\n')
}

function section(title) {
  return `\n${title}\n${'─'.repeat(title.length)}`
}

/** Labels grouped by the phase they belong to. */
function isProbe(label) {
  return label.startsWith('probe')
}
function isSizeRamp(label) {
  return label.startsWith('validate ') && label.endsWith('(1 user)')
}
function isConcurrency(label) {
  return label.startsWith('validate ') && label.includes('user(s)')
}
function isJourney(label) {
  return label.startsWith('journey')
}

// The order the size labels are meant to be read in. A ramp presented out of
// order is not a ramp — it has to climb down the page.
const SIZE_ORDER = ['everyday', 'busy', 'large', 'xlarge']

function sortKey(label) {
  const users = /@ (\d+) user/.exec(label)
  if (users) {
    return Number(users[1])
  }
  const size = SIZE_ORDER.findIndex((name) => label.includes(` ${name} `))
  return size === -1 ? Number.MAX_SAFE_INTEGER : size
}

function summariseGroup(samples, predicate) {
  const byLabel = new Map()
  for (const s of samples) {
    if (!predicate(s.label)) {
      continue
    }
    if (!byLabel.has(s.label)) {
      byLabel.set(s.label, [])
    }
    byLabel.get(s.label).push(s)
  }
  return new Map(
    [...byLabel.entries()].sort(([a], [b]) => sortKey(a) - sortKey(b))
  )
}

const PERCENT = 100
// Below this much of its window used, the ramp is over-provisioned enough to be
// worth saying so — the allowances it was derived from can come down, and with
// them the whole run.
const ROOMY_WINDOW_PERCENT = 60
// At or above this much of the window used, a short pass is the guard tripping.
const WINDOW_EXHAUSTED_PERCENT = 90

/**
 * Did the size ramp actually complete its weighted pass?
 *
 * The ramp is loop-count driven inside a duration guard, so its sample counts
 * are meant to be EXACT — 20 everyday, 8 busy, 3 large, 2 xlarge. When the pass
 * overruns the guard the scheduler cuts the thread group off wherever it has
 * reached, and because the pass runs smallest-first what it loses is the tail:
 * `large` and `xlarge`. Those sizes then have no rows at all, which reads
 * exactly like a size that was never configured.
 *
 * So the expectation has to be stated to be checked. entrypoint.sh passes it in
 * SIZE_RAMP_EXPECTED (`label:n` pairs, the counts it scheduled) and the window
 * it reserved in SIZE_RAMP_WINDOW_SECONDS. Without them this section is skipped.
 */
function rampCoverage(samples) {
  const spec = process.env.SIZE_RAMP_EXPECTED
  if (!spec) {
    return null
  }
  const expected = spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [size, count] = entry.split(':')
      return { size, count: Number(count) }
    })
    .filter((e) => e.size && Number.isFinite(e.count) && e.count > 0)
  if (expected.length === 0) {
    return null
  }

  const rampSamples = samples.filter((s) => isSizeRamp(s.label))
  const counts = new Map()
  for (const s of rampSamples) {
    counts.set(s.label, (counts.get(s.label) ?? 0) + 1)
  }

  const rows = []
  let short = false
  for (const { size, count } of expected) {
    // Same label shape isSizeRamp and sortKey already rely on.
    const got = counts.get(`validate ${size} file (1 user)`) ?? 0
    const complete = got >= count
    short = short || !complete
    rows.push([size, count, complete ? got : `${got}  ← CUT OFF`])
  }

  const windowSeconds = Number(process.env.SIZE_RAMP_WINDOW_SECONDS)
  let usedSeconds = null
  if (rampSamples.length > 0) {
    const from = Math.min(...rampSamples.map((s) => s.ts))
    const to = Math.max(...rampSamples.map((s) => s.ts + s.elapsed))
    usedSeconds = Math.round((to - from) / MS_PER_SECOND)
  }
  return { rows, short, windowSeconds, usedSeconds }
}

function rampCoverageNotes({ short, windowSeconds, usedSeconds }) {
  const notes = []
  let usedPercent = null
  if (usedSeconds !== null && Number.isFinite(windowSeconds) && windowSeconds > 0) {
    usedPercent = Math.round((usedSeconds / windowSeconds) * PERCENT)
    notes.push(
      `\n  The ramp used ${usedSeconds}s of its ${windowSeconds}s window (${usedPercent}%).`
    )
    if (!short && usedPercent < ROOMY_WINDOW_PERCENT) {
      notes.push(
        '  Room to spare: lower the SIZE_ALLOWANCE_* seconds and the whole run shortens.'
      )
    }
  }
  if (!short) {
    return notes
  }
  // Short AND the window is gone is truncation. Short with window left over is
  // not — the pass stopped for some other reason, and telling someone to widen
  // a window they did not fill would send them the wrong way.
  if (usedPercent === null || usedPercent >= WINDOW_EXHAUSTED_PERCENT) {
    notes.push(
      '  A size short of its count did NOT get slower — it ran out of window, and',
      '  the numbers above are whatever fitted. Raise the SIZE_ALLOWANCE_* seconds',
      '  for the sizes marked above (or SIZE_RAMP_DURATION_SECONDS directly) and',
      '  re-run before reading anything into the ramp.'
    )
  } else {
    notes.push(
      '  A size is short of its count, but the window was not used up — so this is',
      '  not the guard tripping. Check the failed column above and the JMeter log.'
    )
  }
  return notes
}

/**
 * End-to-end times for the upload-journey staircase.
 *
 * Each journey iteration is three sequential samples on one thread — initiate,
 * upload, validate+scan — so the per-leg rows understate what a user actually
 * waits. This reconstructs each iteration from the thread name: an initiate
 * opens it, the next validate+scan on the same thread closes it, and the
 * end-to-end time is last-byte minus first-byte across the triple. An
 * iteration whose initiate failed never opens (the plan skips its other legs),
 * and one cut off by the window's end never closes — both simply don't count.
 */
function journeyTotals(samples) {
  const byStep = new Map()
  for (const s of samples) {
    const m = /^journey: (.+) @ (\d+) user\(s\)$/.exec(s.label)
    if (!m) {
      continue
    }
    const users = Number(m[2])
    if (!byStep.has(users)) {
      byStep.set(users, new Map())
    }
    const byThread = byStep.get(users)
    if (!byThread.has(s.thread)) {
      byThread.set(s.thread, [])
    }
    byThread.get(s.thread).push({ ...s, leg: m[1] })
  }

  const rows = []
  for (const [users, byThread] of [...byStep.entries()].sort(([a], [b]) => a - b)) {
    const totals = []
    for (const legs of byThread.values()) {
      legs.sort((a, b) => a.ts - b.ts)
      let open = null
      for (const leg of legs) {
        if (leg.leg.startsWith('initiate')) {
          open = leg
        } else if (leg.leg.startsWith('validate') && open) {
          totals.push({
            ts: open.ts,
            elapsed: leg.ts + leg.elapsed - open.ts,
            ok: leg.ok,
            label: 'journey'
          })
          open = null
        }
      }
    }
    if (totals.length === 0) {
      continue
    }
    const s = stats(totals)
    rows.push([
      `end to end @ ${users} user(s)`,
      s.count,
      fmtMs(s.mean),
      fmtMs(s.p95),
      fmtMs(s.max),
      `${s.failedPct}%`
    ])
  }
  return rows
}

/**
 * What the background probe saw while each upload phase was running.
 *
 * This is the number that decides whether heavy uploads are merely slow for the
 * uploader or a problem for everyone: it windows the probe's samples to each
 * phase's start and end, so "ordinary page load during 20 concurrent uploads"
 * is directly comparable to the same page load when nothing else is happening.
 */
function collateralImpact(samples) {
  const probes = samples.filter(
    (s) => s.label === 'probe: project list under load (GET /projects)'
  )
  if (probes.length === 0) {
    return null
  }
  const phases = new Map()
  for (const s of samples) {
    if (isProbe(s.label)) {
      continue
    }
    // Journey legs collapse to one phase per step — three separate "during"
    // rows for one staircase step would triple-count the same window.
    const journeyStep = /^journey: .+ (@ \d+ user\(s\))$/.exec(s.label)
    let phase = s.label
    if (isSizeRamp(s.label)) {
      phase = 'size ramp'
    } else if (journeyStep) {
      phase = `upload journey ${journeyStep[1]}`
    }
    const window = phases.get(phase) ?? { from: Infinity, to: -Infinity }
    window.from = Math.min(window.from, s.ts)
    window.to = Math.max(window.to, s.ts + s.elapsed)
    phases.set(phase, window)
  }

  // The phases are scheduled back to back, so two windows only overlap when
  // the earlier phase's in-flight requests are still draining into the next
  // one's slot — a saturated step's stragglers can outlive its window by tens
  // of seconds. A probe sample caught in that overlap is slow because of the
  // DRAINING phase, so each sample is attributed to exactly one window — the
  // earliest-starting one that contains it — rather than counted against every
  // phase it happens to fall inside (which charged the saturation tail to the
  // quiet phase after it).
  const windows = [...phases.entries()]
    .map(([phase, w]) => ({ phase, ...w }))
    .sort((a, b) => a.from - b.from)
  const ownerOf = (p) => windows.find((w) => p.ts >= w.from && p.ts <= w.to)

  const rows = []
  const quiet = probes.filter((p) => !ownerOf(p))
  if (quiet.length) {
    const q = stats(quiet)
    rows.push(['(nothing else running)', q.count, fmtMs(q.mean), fmtMs(q.p95), fmtMs(q.max), `${q.failedPct}%`])
  }
  const ordered = [...phases.keys()].sort((a, b) => sortKey(a) - sortKey(b))
  for (const phase of ordered) {
    const during = probes.filter((p) => ownerOf(p)?.phase === phase)
    if (during.length === 0) {
      continue
    }
    const d = stats(during)
    rows.push([`during ${phase}`, d.count, fmtMs(d.mean), fmtMs(d.p95), fmtMs(d.max), `${d.failedPct}%`])
  }
  return rows
}

function main() {
  const path = process.argv[2]
  if (!path) {
    process.stderr.write('usage: node scripts/summarise-run.mjs <results.csv>\n')
    process.exit(1)
  }
  const samples = readSamples(path)
  if (samples.length === 0) {
    process.stderr.write(`no samples in ${path}\n`)
    process.exit(1)
  }

  const out = []
  out.push(
    '\n════════════════════ BNG upload load profile — summary ════════════════════'
  )
  out.push(
    `  ${samples.length} samples over ${((Math.max(...samples.map((s) => s.ts + s.elapsed)) - Math.min(...samples.map((s) => s.ts))) / MS_PER_SECOND / 60).toFixed(1)} minutes`
  )

  const groups = [
    ['How long does one upload take, by file size?', isSizeRamp],
    ['What happens as more people upload at once?', isConcurrency],
    ['What does the full journey cost (initiate + upload + scan + validate)?', isJourney]
  ]
  for (const [title, predicate] of groups) {
    const byLabel = summariseGroup(samples, predicate)
    if (byLabel.size === 0) {
      continue
    }
    out.push(section(title))
    const rows = [...byLabel.entries()].map(([label, group]) => {
      const s = stats(group)
      return [label, s.count, fmtMs(s.mean), fmtMs(s.p95), fmtMs(s.max), `${s.failedPct}%`]
    })
    if (predicate === isJourney) {
      rows.push(...journeyTotals(samples))
    }
    out.push(table(rows, ['', 'n', 'mean', 'p95', 'worst', 'failed']))
  }

  const coverage = rampCoverage(samples)
  if (coverage) {
    out.push(section('Did the size ramp complete its pass?'))
    out.push(table(coverage.rows, ['size', 'expected', 'got']))
    out.push(...rampCoverageNotes(coverage))
  }

  const collateral = collateralImpact(samples)
  if (collateral?.length) {
    out.push(
      section('What an ordinary user experienced at the same time (GET /projects)')
    )
    out.push(table(collateral, ['', 'n', 'mean', 'p95', 'worst', 'failed']))
    out.push(
      '\n  A page load that stays flat here means heavy uploads only slow the'
    )
    out.push(
      '  person uploading. One that climbs means they slow everybody.'
    )
  }

  out.push(
    '\n═══════════════════════════════════════════════════════════════════════════\n'
  )
  process.stdout.write(out.join('\n'))
}

main()

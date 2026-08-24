/**
 * Turn the JMeter results CSV into a plain-English summary.
 *
 * The JMeter dashboard is the detailed report, but it answers "what were the
 * numbers" rather than "is this a problem". This prints the shape a PM needs:
 * what an everyday upload costs, how that changes as files get bigger, how it
 * changes as more people upload at once, and — the one that decides whether any
 * of it matters — what an ordinary user was experiencing at the same time.
 *
 * Reads the CSV JMeter writes with -l. Usage:
 *   node scripts/summarise-run.mjs <results.csv>
 */
import { readFileSync } from 'node:fs'

const PERCENTILE_95 = 0.95
const MS_PER_SECOND = 1000

/**
 * Parse the whole CSV into records.
 *
 * Not a line-per-record split: JMeter quotes the response and failure messages,
 * and those routinely contain newlines (a stack trace, a multi-line body). A
 * naive split on newline shreds those rows and silently loses samples, so this
 * tracks quoting across the whole file.
 */
function parseCsv(text) {
  const records = []
  let record = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cell += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      record.push(cell)
      cell = ''
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') {
        i++
      }
      record.push(cell)
      cell = ''
      if (record.length > 1 || record[0] !== '') {
        records.push(record)
      }
      record = []
    } else {
      cell += ch
    }
  }
  if (cell !== '' || record.length) {
    record.push(cell)
    records.push(record)
  }
  return records
}

function readSamples(path) {
  const records = parseCsv(readFileSync(path, 'utf8'))
  if (records.length < 2) {
    return []
  }
  const header = records[0]
  const col = (name) => header.indexOf(name)
  const iTs = col('timeStamp')
  const iElapsed = col('elapsed')
  const iLabel = col('label')
  const iSuccess = col('success')
  const iCode = col('responseCode')

  return records
    .slice(1)
    .map((c) => ({
      ts: Number(c[iTs]),
      elapsed: Number(c[iElapsed]),
      label: c[iLabel],
      ok: c[iSuccess] === 'true',
      code: c[iCode]
    }))
    // A truncated final row (the task was killed mid-write) has no label; drop
    // it rather than letting it skew a phase it cannot be attributed to.
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
  return label.startsWith('probe ')
}
function isSizeRamp(label) {
  return label.startsWith('validate ') && label.endsWith('(1 user)')
}
function isConcurrency(label) {
  return label.includes('@') && label.includes('user(s)')
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

/**
 * What the background probe saw while each upload phase was running.
 *
 * This is the number that decides whether heavy uploads are merely slow for the
 * uploader or a problem for everyone: it windows the probe's samples to each
 * phase's start and end, so "ordinary page load during 20 concurrent uploads"
 * is directly comparable to the same page load when nothing else is happening.
 */
function collateralImpact(samples) {
  const probes = samples.filter((s) => s.label === 'probe GET /projects')
  if (probes.length === 0) {
    return null
  }
  const phases = new Map()
  for (const s of samples) {
    if (isProbe(s.label)) {
      continue
    }
    const phase = isSizeRamp(s.label) ? 'size ramp' : s.label
    const window = phases.get(phase) ?? { from: Infinity, to: -Infinity }
    window.from = Math.min(window.from, s.ts)
    window.to = Math.max(window.to, s.ts + s.elapsed)
    phases.set(phase, window)
  }

  const busyWindows = [...phases.values()]
  const quiet = probes.filter(
    (p) => !busyWindows.some((w) => p.ts >= w.from && p.ts <= w.to)
  )

  const rows = []
  if (quiet.length) {
    const q = stats(quiet)
    rows.push(['(nothing else running)', q.count, fmtMs(q.mean), fmtMs(q.p95), fmtMs(q.max), `${q.failedPct}%`])
  }
  const ordered = [...phases.entries()].sort(
    ([a], [b]) => sortKey(a) - sortKey(b)
  )
  for (const [phase, w] of ordered) {
    const during = probes.filter((p) => p.ts >= w.from && p.ts <= w.to)
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
    ['What happens as more people upload at once?', isConcurrency]
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
    out.push(table(rows, ['', 'n', 'mean', 'p95', 'worst', 'failed']))
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

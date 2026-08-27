/**
 * The summary is the part of a run that gets pasted into a ticket, so a group
 * that silently reports nothing is worse than one that errors — the reader has
 * no way to tell "we measured this and it was fine" from "we never measured
 * it".
 *
 * These drive the real script over a synthetic results CSV carrying every
 * label shape the plan emits, and assert that each section appears and says
 * the right thing. The label shapes are the contract between
 * scripts/gen-scenario.mjs and scripts/summarise-run.mjs; if a sampler is
 * renamed in one and not the other, this is what notices.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, before } from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const HEADERS = ['timeStamp', 'elapsed', 'label', 'responseCode', 'success', 'threadName']

/**
 * Build a results CSV covering every group.
 *
 * Timestamps advance with each sample so the phase windows the summary derives
 * (and the probe attribution that depends on them) are in run order, the same
 * as a real file.
 */
function buildResults() {
  const rows = []
  let now = 1_700_000_000_000
  const add = (label, elapsed, code, thread) => {
    rows.push([now, elapsed, label, code, code === '409' ? 'false' : 'true', thread])
    now += elapsed + 20
  }

  for (const [size, ms, n] of [
    ['normal', 400, 20],
    ['busy', 900, 8],
    ['large', 4200, 3],
    ['xlarge', 9000, 2]
  ]) {
    for (let i = 0; i < n; i++) {
      add(`validation cost vs file size: ${size} (1 user)`, ms, '200', 'Size ramp 1-1')
    }
  }

  // Journey legs, three per iteration on one thread, so the end-to-end
  // reconstruction has triples to close.
  for (const [size, base, steps] of [
    ['normal', 900, [1, 2, 10]],
    ['large', 5200, [1, 3]]
  ]) {
    for (const users of steps) {
      for (let u = 1; u <= users; u++) {
        const thread = `Upload journey ${size} @ ${users} user(s) 1-${u}`
        add(`journey (${size}) @ ${users} user(s): initiate`, 60, '200', thread)
        add(`journey (${size}) @ ${users} user(s): send file to uploader`, 200, '302', thread)
        add(`journey (${size}) @ ${users} user(s): validate incl virus scan`, base + users * 40, '200', thread)
      }
    }
  }

  for (const users of [1, 5, 20]) {
    for (let i = 0; i < 5; i++) {
      add(`validation cost vs concurrency: ${users} user(s) on one large upload`, 3800 + users * 200, '200', 'Validation vs concurrency 1-1')
    }
  }
  for (const users of [1, 5]) {
    for (let i = 0; i < 4; i++) {
      add(`post-intervention validate (normal) @ ${users} user(s)`, 1500, '200', 'PI 1-1')
    }
  }
  for (const users of [1, 5]) {
    for (let i = 0; i < 10; i++) {
      add(`habitat edit distinct projects (normal) @ ${users} user(s)`, 120, '200', 'Edit 1-1')
    }
  }
  // Contention: one in four conflicts at 2 users, half at 5.
  for (const [users, every] of [[2, 4], [5, 2]]) {
    for (let i = 0; i < 20; i++) {
      const conflict = i % every === 0
      add(
        `habitat edit same project @ ${users} user(s)`,
        conflict ? 5000 : 180,
        conflict ? '409' : '200',
        'Contention 1-1'
      )
    }
  }
  for (const [size, ms, n] of [
    ['normal', 90, 10],
    ['busy', 260, 6],
    ['large', 1400, 4],
    ['xlarge', 3600, 3]
  ]) {
    for (let i = 0; i < n; i++) {
      add(`fetch ${size} project (GET /projects/{id})`, ms, '200', 'Fetch 1-1')
    }
  }
  for (let i = 0; i < 20; i++) {
    add('mixed: list my projects (GET /projects)', 150, '200', 'Mixed 1-1')
  }

  // The probe spans the whole run, so every phase gets a "during" row.
  const start = rows[0][0]
  for (let ts = start; ts < now; ts += 1500) {
    rows.push([ts, 200, 'probe: project list under load (GET /projects)', '200', 'true', 'Probe 1-1'])
  }
  return [HEADERS, ...rows].map((r) => r.join(',')).join('\n') + '\n'
}

let output = ''

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'bng-perf-summary-'))
  const csv = join(dir, 'results.csv')
  writeFileSync(csv, buildResults())
  output = execFileSync(
    process.execPath,
    [join(ROOT, 'scripts', 'summarise-run.mjs'), csv],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        SIZE_RAMP_EXPECTED: 'normal:20,busy:8,large:3,xlarge:2',
        SIZE_RAMP_WINDOW_SECONDS: '160'
      }
    }
  )
})

describe('every group reports', () => {
  const sections = [
    ['upload journey, end to end', 'N people upload N files at once'],
    ['size ramp', 'How long does one upload take, by file size?'],
    ['journey legs', 'where does that journey time go'],
    ['validation vs concurrency', 'What does validate alone cost as concurrency climbs'],
    ['post-intervention', 'What does a post-intervention upload cost'],
    ['habitat edit', 'What does editing one habitat cost'],
    ['project fetch', 'What does fetching a whole project cost'],
    ['mixed workload', 'What does the mixed workload look like'],
    ['edit contention', 'edit the SAME project at once'],
    ['probe', 'What an ordinary user experienced at the same time']
  ]
  for (const [name, heading] of sections) {
    test(`${name} has a section`, () => {
      assert.ok(output.includes(heading), `missing section: ${heading}`)
    })
  }
})

describe('the journey ladder', () => {
  test('reconstructs an end-to-end time per step, not per leg', () => {
    assert.match(output, /end to end \(normal\) @ 1 user\(s\)/)
    assert.match(output, /end to end \(normal\) @ 10 user\(s\)/)
    assert.match(output, /end to end \(large\) @ 3 user\(s\)/)
  })

  test('keeps the sizes apart rather than averaging them together', () => {
    // A 4 MB upload and a 143 KB upload at the same concurrency are the two
    // questions the per-size ladder exists to separate.
    const normal = /end to end \(normal\) @ 1 user\(s\)\s+(\d+)/.exec(output)
    const large = /end to end \(large\) @ 1 user\(s\)\s+(\d+)/.exec(output)
    assert.ok(normal && large, 'both sizes should have their own row')
  })

  test('orders the ladder by size and then by concurrency', () => {
    const order = [...output.matchAll(/end to end \((\w+)\) @ (\d+) user/g)].map(
      (m) => `${m[1]}:${m[2]}`
    )
    assert.deepEqual(order, [
      'normal:1',
      'normal:2',
      'normal:10',
      'large:1',
      'large:3'
    ])
  })
})

describe('edit contention', () => {
  test('counts 409s as a rate rather than as failures', () => {
    const rows = [...output.matchAll(/@ (\d+) user\(s\)\s+20\s+(\d+)%/g)]
    const byUsers = Object.fromEntries(rows.map((m) => [m[1], Number(m[2])]))
    assert.equal(byUsers['2'], 25, 'one in four conflicted at 2 users')
    assert.equal(byUsers['5'], 50, 'one in two conflicted at 5 users')
  })

  test('reports the latency of accepted edits only', () => {
    // The 5s lock-timeout requests must not be averaged into the wait an
    // accepted edit actually experienced.
    const row = /@ 2 user\(s\)\s+20\s+25%\s+15\s+(\d+)ms/.exec(output)
    assert.ok(row, 'expected an accepted-only latency column')
    assert.equal(Number(row[1]), 180)
  })
})

describe('the probe timeline', () => {
  test('reads chronologically rather than by ladder', () => {
    // It is a timeline, not a staircase: ordering it by size and concurrency
    // interleaves phases that ran either side of each other.
    const sizeRamp = output.indexOf('during size ramp')
    const journey = output.indexOf('during upload journey (normal) @ 1 user(s)')
    const mixed = output.indexOf('during mixed workload')
    assert.ok(sizeRamp > 0 && journey > sizeRamp, 'size ramp ran before the journey')
    assert.ok(mixed > journey, 'the mixed workload ran last')
  })

  test('collapses a journey step to one row rather than one per leg', () => {
    const rows = output.match(/during upload journey \(normal\) @ 1 user\(s\)/g)
    assert.equal(rows.length, 1)
  })
})

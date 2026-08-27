/**
 * The schedule arithmetic, and the promise that the committed plan matches the
 * config it is generated from.
 *
 * A perf suite fails quietly: a step scheduled on top of another one does not
 * error, it just makes a concurrency figure stop meaning what its label says,
 * and nobody finds out until a number is pasted into a ticket. These are the
 * checks that would have caught that.
 *
 * node:test and node:assert only — no framework, because the container this
 * runs in is a JMeter image with Node in it, not a JS project.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, describe } from 'node:test'

import {
  LADDERS,
  PROFILES,
  SETUP_ALLOWANCE_SECONDS,
  SIZE_LABELS,
  WINDOW_BOUNDS,
  budgetCheck,
  ladderSteps,
  profilePhases,
  scheduleFrom,
  stepKey,
  windowSeconds
} from '../scenarios/ladders.config.mjs'

const ROOT = join(import.meta.dirname, '..')

describe('window derivation', () => {
  test('a step gets less wall clock the more users it has', () => {
    const ladder = LADDERS.find((l) => l.key === 'journey')
    const at = (users) =>
      windowSeconds({ ladder, size: 'normal', users })
    assert.ok(
      at(1) > at(2),
      'one user has to wait out each iteration in turn, so it needs the longest window'
    )
    assert.ok(at(2) >= at(5))
  })

  test('windows stay inside the clamp at both ends', () => {
    for (const ladder of LADDERS) {
      for (const step of ladderSteps(ladder)) {
        const window = windowSeconds(step)
        assert.ok(
          window >= WINDOW_BOUNDS.minStepSeconds,
          `${stepKey(step)} window ${window}s is below the floor`
        )
        assert.ok(
          window <= WINDOW_BOUNDS.maxStepSeconds,
          `${stepKey(step)} window ${window}s is above the ceiling`
        )
      }
    }
  })

  test('a bigger file gets a longer window at the same concurrency', () => {
    const ladder = LADDERS.find((l) => l.key === 'journey')
    assert.ok(
      windowSeconds({ ladder, size: 'large', users: 2 }) >
        windowSeconds({ ladder, size: 'normal', users: 2 })
    )
  })
})

describe('profiles', () => {
  test('every profile only names steps the plan has a thread group for', () => {
    const known = new Set(
      LADDERS.flatMap((ladder) => ladderSteps(ladder).map(stepKey))
    )
    for (const name of Object.keys(PROFILES)) {
      for (const phase of profilePhases(name)) {
        if (phase.key === 'fetchRamp' || phase.key === 'mixed') {
          continue
        }
        assert.ok(
          known.has(phase.key),
          `profile ${name} schedules ${phase.key}, which has no thread group`
        )
      }
    }
  })

  test('an unknown profile is rejected by name rather than running empty', () => {
    assert.throws(() => profilePhases('nope'), /unknown profile "nope"/)
  })

  test('the journey ladder is contiguous 1..10 at normal in standard', () => {
    const users = profilePhases('standard')
      .filter((p) => p.key.startsWith('journey_normal_'))
      .map((p) => p.users)
    assert.deepEqual(users, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  test('standard is the only profile', () => {
    // The suite deliberately has ONE profile: five step lists proved harder to
    // keep meaningful than one. A second entry here should be a conscious
    // decision to bring the profile machinery back, not an accident.
    assert.deepEqual(Object.keys(PROFILES), ['standard'])
  })
})

describe('schedule', () => {
  test('phases never overlap, and each starts a gap after the last ended', () => {
    for (const name of Object.keys(PROFILES)) {
      const scheduled = scheduleFrom(profilePhases(name), 100)
      for (let i = 1; i < scheduled.length; i++) {
        const previous = scheduled[i - 1]
        const current = scheduled[i]
        assert.equal(
          current.delay,
          previous.delay + previous.window + previous.gap,
          `${name}: ${current.key} does not start a gap after ${previous.key}`
        )
        assert.ok(
          current.delay > previous.delay + previous.window,
          `${name}: ${current.key} overlaps ${previous.key}`
        )
      }
    }
  })

  test('a ladder climbs — steps of one size are in ascending user order', () => {
    const bySize = new Map()
    for (const phase of profilePhases('standard')) {
      const match = /^(\w+?)_(\w+)_(\d+)$/.exec(phase.key)
      if (!match) {
        continue
      }
      const group = `${match[1]}_${match[2]}`
      const seen = bySize.get(group) ?? []
      seen.push(Number(match[3]))
      bySize.set(group, seen)
    }
    for (const [group, users] of bySize) {
      assert.deepEqual(
        users,
        [...users].sort((a, b) => a - b),
        `${group} does not climb`
      )
    }
  })
})

describe('time budgets', () => {
  // The reason this file exists in its current shape. A perf run that takes
  // longer than someone will wait measures nothing, because they stop running
  // it — so `standard` has a hard ceiling, and it is checked here rather than
  // rediscovered on the clock.
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (!profile.budgetMinutes) {
      continue
    }
    test(`${name} fits its ${profile.budgetMinutes}-minute budget`, () => {
      const check = budgetCheck(name)
      assert.ok(
        check.fits,
        `${name} projects ${check.projectedSeconds}s ` +
          `(plan ${check.planSeconds}s + ~${check.setupSeconds}s setup) ` +
          `against a ${check.limitSeconds}s budget — ` +
          `${-check.marginSeconds}s over. Trim a ladder or move the ceiling on purpose.`
      )
    })
  }

  test('the budget accounts for setup, not just the JMeter plan', () => {
    // runSeconds is the plan's nominal length. The task someone waits for also
    // mints a token, seeds, stages four uploads through a virus scanner and
    // publishes a report — and staging is the bulk of it. A budget checked
    // against the plan alone would pass here and overrun in practice.
    const check = budgetCheck('standard')
    assert.ok(check.projectedSeconds > check.planSeconds)
    assert.equal(check.projectedSeconds, check.planSeconds + SETUP_ALLOWANCE_SECONDS)
  })

})

describe('entrypoint.sh derives the same schedule this config does', () => {
  // The windows are computed in JS and handed to the shell; the DELAYS are
  // accumulated by the shell, so that changing a window or PHASE_GAP_SECONDS at
  // run time still slides everything after it. That split means two
  // implementations of the same arithmetic, and two implementations drift. This
  // is the check that they have not.
  for (const name of Object.keys(PROFILES)) {
    test(`${name} matches`, () => {
      const dumped = execFileSync('sh', [join(ROOT, 'entrypoint.sh')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          JM_HOME: ROOT,
          ENVIRONMENT: 'local',
          PERF_PROFILE: name,
          PERF_DUMP_SCHEDULE: 'true'
        },
        stdio: ['ignore', 'pipe', 'ignore']
      })

      // Marker-prefixed lines only — the config banner shares this stream.
      const fromShell = dumped
        .split('\n')
        .filter((line) => line.startsWith('PHASE '))
        .map((line) => line.split(' '))
        .map(([, key, users, window, delay]) => ({
          key,
          users: Number(users),
          window: Number(window),
          delay: Number(delay)
        }))

      // The shell starts the ladder after the size ramp, whose length is a
      // profile knob — so take the first phase's delay as the anchor rather
      // than assuming the .jmx default. What is being compared is the SHAPE:
      // the same phases, the same windows, the same gaps between them.
      const anchor = fromShell.length ? fromShell[0].delay : 0
      // No gap override: each phase carries its own drain time, and the point of
      // this test is that the shell honours the same ones.
      const fromConfig = scheduleFrom(profilePhases(name), anchor).map(
        ({ key, users, window, delay }) => ({
        key,
        // The mixed workload has no user count in the ladder tables; the shell
        // gives it MIXED_THREADS.
          users: users ?? fromShell.find((p) => p.key === key)?.users ?? 0,
          window,
          delay
        })
      )

      assert.deepEqual(fromShell, fromConfig)
    })
  }
})

describe('the committed plan', () => {
  test('bng-perf.jmx and ladders.sh are in step with ladders.config.mjs', () => {
    // The generated half of the plan is committed, so it can go stale the
    // moment someone edits the config without re-running the generator. This
    // is the check CI runs; it is here so it fails locally first.
    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'gen-scenario.mjs'), '--check'],
      { cwd: ROOT, stdio: 'pipe' }
    )
  })

  test('every generated thread group is one entrypoint.sh knows how to drive', () => {
    // A thread group whose property names are not in ALL_PHASE_KEYS gets no
    // -Jusers_… from entrypoint.sh, so it silently falls back to the baked-in
    // STANDARD default and runs regardless of the active profile.
    const jmx = readFileSync(join(ROOT, 'scenarios', 'bng-perf.jmx'), 'utf8')
    const generated = jmx.slice(
      jmx.indexOf('BEGIN GENERATED'),
      jmx.indexOf('END GENERATED')
    )
    const known = new Set([
      ...LADDERS.flatMap((ladder) => ladderSteps(ladder).map(stepKey)),
      'fetchRamp',
      'mixed'
    ])
    const referenced = [...generated.matchAll(/__P\(users_(\w+),/g)].map((m) => m[1])
    assert.ok(referenced.length > 0, 'expected generated thread groups')
    for (const key of referenced) {
      assert.ok(known.has(key), `${key} has a thread group but no phase key`)
    }
  })

  test('the CSVs staging writes quoted are read as quoted', () => {
    // stage-uploads.mjs quotes every field of the prepared and contention CSVs,
    // because they carry free-text habitat and condition names. A data set that
    // read them unquoted would put the quote characters inside the JSON body of
    // the PUT — a broken request that reports as a validation failure.
    const jmx = readFileSync(join(ROOT, 'scenarios', 'bng-perf.jmx'), 'utf8')
    const dataSets = [...jmx.matchAll(/<CSVDataSet[\s\S]*?<\/CSVDataSet>/g)].map(
      (m) => m[0]
    )
    const prepared = dataSets.filter((ds) => ds.includes('preparedBroadType'))
    assert.ok(prepared.length > 0, 'expected prepared-pool data sets')
    for (const dataSet of prepared) {
      assert.match(
        dataSet,
        /<boolProp name="quotedData">true<\/boolProp>/,
        'a prepared-pool CSV data set is not reading quoted data'
      )
    }
  })

  test('no generated sampler label contains a comma', () => {
    // Labels land in the results CSV. JMeter quotes them correctly, but every
    // naive consumer of that file — a spreadsheet, a grep, an awk one-liner —
    // splits the row in the wrong place and shifts every later column.
    //
    // Scoped to the GENERATED block. Two hand-written project-list samplers
    // ("list my projects, paginated (…)") predate this and are left alone:
    // renaming them would change rows people already compare runs against, and
    // that is a call for whoever owns those groups, not a side effect of this.
    const jmx = readFileSync(join(ROOT, 'scenarios', 'bng-perf.jmx'), 'utf8')
    const generated = jmx.slice(
      jmx.indexOf('BEGIN GENERATED'),
      jmx.indexOf('END GENERATED')
    )
    const offenders = [
      ...generated.matchAll(/<HTTPSamplerProxy[^>]*testname="([^"]*)"/g)
    ]
      .map((m) => m[1])
      .filter((name) => name.includes(','))
    assert.deepEqual(offenders, [])
  })

  test('every size the ladders name is a size the fixtures define', () => {
    for (const ladder of LADDERS) {
      if (!ladder.perSize) {
        continue
      }
      for (const size of Object.keys(ladder.sizes)) {
        assert.ok(
          SIZE_LABELS.includes(size),
          `ladder ${ladder.key} names size "${size}", which has no fixture`
        )
      }
    }
  })
})

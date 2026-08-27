/**
 * The pure half of staging: what it will accept as a pool spec, and which
 * features it considers safe to edit repeatedly.
 *
 * The network half is not covered here — it needs a live backend, an uploader
 * and a virus scanner. What is covered is the part that decides, silently and
 * before any of that, whether a phase gets a pool at all.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'

import { editableHabitats, parsePreparedSizes } from '../scripts/stage-uploads.mjs'

describe('parsePreparedSizes', () => {
  test('reads label:count pairs', () => {
    assert.deepEqual(parsePreparedSizes('normal:10,large:5'), [
      { label: 'normal', count: 10 },
      { label: 'large', count: 5 }
    ])
  })

  test('an empty spec asks for nothing rather than erroring', () => {
    // entrypoint.sh passes this on the command line whether or not any phase
    // needs a pool, so an empty string is the normal "no pools" case.
    assert.deepEqual(parsePreparedSizes(''), [])
    assert.deepEqual(parsePreparedSizes(undefined), [])
  })

  test('tolerates whitespace and trailing separators', () => {
    assert.deepEqual(parsePreparedSizes(' normal:2 , '), [
      { label: 'normal', count: 2 }
    ])
  })

  test('rejects a bad entry loudly instead of dropping it', () => {
    // A silently dropped entry leaves a phase with no pool and no explanation
    // anywhere — the failure mode this whole file exists to avoid.
    assert.throws(() => parsePreparedSizes('normal'), /bad count/)
    assert.throws(() => parsePreparedSizes('normal:0'), /bad count/)
    assert.throws(() => parsePreparedSizes('normal:-1'), /bad count/)
    assert.throws(() => parsePreparedSizes('normal:2.5'), /bad count/)
    assert.throws(() => parsePreparedSizes('Normal:2'), /bad label/)
    assert.throws(() => parsePreparedSizes('every day:2'), /bad label/)
  })
})

describe('editableHabitats', () => {
  const complete = {
    featureId: '11111111-1111-1111-1111-111111111111',
    ref: 'A1',
    broadType: 'Grassland',
    type: 'Other neutral grassland',
    condition: 'Moderate'
  }

  test('maps a feature to the shape the PUT sends', () => {
    // The route takes habitatType; the document stores it as `type`.
    assert.deepEqual(editableHabitats({ baseline: { habitats: [complete] } }), [
      {
        featureId: complete.featureId,
        broadType: 'Grassland',
        habitatType: 'Other neutral grassland',
        condition: 'Moderate'
      }
    ])
  })

  test('excludes a feature missing any attribute the edit writes back', () => {
    // The edit writes the feature's own values back — a missing one would send
    // a blank, which normalizeEdits turns into a null. That is a different edit
    // from the no-op this is meant to be, and it would drift the document over
    // a run rather than measuring the same write repeatedly.
    const habitats = [
      complete,
      { ...complete, featureId: 'b', condition: null },
      { ...complete, featureId: 'c', broadType: '' },
      { ...complete, featureId: 'd', type: undefined },
      { ...complete, featureId: undefined }
    ]
    const ids = editableHabitats({ baseline: { habitats } }).map((f) => f.featureId)
    assert.deepEqual(ids, [complete.featureId])
  })

  test('an empty or absent document yields nothing rather than throwing', () => {
    // A project whose baseline never validated has no habitats key at all, and
    // staging has to report "no pool" rather than crash the whole run.
    assert.deepEqual(editableHabitats(undefined), [])
    assert.deepEqual(editableHabitats({}), [])
    assert.deepEqual(editableHabitats({ baseline: {} }), [])
    assert.deepEqual(editableHabitats({ baseline: { habitats: [] } }), [])
  })

  test('only looks at the baseline, not the post-intervention document', () => {
    // The edit ladder PUTs to /projects/{id}/habitats/{featureId}, which is the
    // baseline route; a post-intervention feature would 404 there.
    const project = {
      baseline: { habitats: [complete] },
      postIntervention: { habitats: [{ ...complete, featureId: 'pi' }] }
    }
    const ids = editableHabitats(project).map((f) => f.featureId)
    assert.deepEqual(ids, [complete.featureId])
  })
})

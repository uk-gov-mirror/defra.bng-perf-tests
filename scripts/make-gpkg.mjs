/**
 * Build a valid BNG baseline GeoPackage of an arbitrary size.
 *
 * The upload scenarios need files that get all the way through validation — a
 * file rejected at the format gate exits before the expensive work and would
 * measure nothing. Rather than hand-roll one, this drives `bng-library`, the
 * same generator the harness CLI and the digital prototype use, so the fixtures
 * a perf run measures are the fixtures the team already generates by hand.
 *
 * The library also owns the scope invariant: its random draws come from
 * `IN_SCOPE_HABITATS` / `IN_SCOPE_HEDGE_TYPES` / `IN_SCOPE_RIVER_TYPES`, so a
 * generated file can never carry the High / V.High distinctiveness the service
 * rejects. Pinning a habitat here by hand would silently drift the day that
 * rule changed.
 *
 * Two calls, mirroring `bng-metric-harness`'s `gen-gpkg`:
 *   generateOne                 — writes a *synthetic* file (baseline + proposed)
 *   deriveBaselineFromSynthetic — clears the proposed columns to leave a baseline
 *
 * The default sizes are committed as fixtures/ (see gen-fixtures.mjs); this
 * remains the generator behind them, and the run-time fallback for any other
 * size asked for via UPLOAD_SIZES.
 */
import { rmSync, statSync } from 'node:fs'
import { generateOne, deriveBaselineFromSynthetic, setMode } from 'bng-library'

// The library defaults to its CLI logger, which prints a generation banner to
// *stdout*. stage-uploads.mjs emits `uploadId_<label>=<uuid>` lines on stdout
// for entrypoint.sh to parse into JMeter properties, so a banner there would
// corrupt the run. Silence it — this module is a library caller, not the CLI.
setMode('silent')

// A patch of open country near Cambridge, comfortably inside England so the
// backend's containment check passes. Metres, British National Grid.
const SITE_CENTRE = [545000, 258000]

// Individual trees are a separate layer the upload path does not exercise, and
// every one is another rejection-sampled point — cost without signal here.
const NO_TREES = 0

/**
 * Write a baseline GeoPackage with `parcels` habitat parcels to `filePath`.
 *
 * Generation is seeded so a rerun of the same size produces a byte-identical
 * file: two runs that disagree are then a change in the service, not a change
 * in the fixture. `seed` defaults to the parcel count, which keeps each step of
 * a size ramp distinct while staying reproducible.
 *
 * @param {string} filePath where to write the baseline file
 * @param {number} parcels how many habitat parcels it should contain
 * @param {{ seed?: number }} [options]
 * @returns {{ path: string, parcels: number, bytes: number, generationMs: number }}
 */
export function makeGeoPackage(filePath, parcels, options = {}) {
  const { baseline } = makeGeoPackagePair(filePath, null, parcels, options)
  return baseline
}

/**
 * Write BOTH halves of a two-stage upload: the baseline, and the
 * post-intervention file it pairs with.
 *
 * Synthetic mode emits ONE file carrying the baseline and the proposed state on
 * every row — that file IS the post-intervention half — and
 * `deriveBaselineFromSynthetic` copies it and clears the proposed columns to
 * leave the baseline half. So the pair shares a redline, a parcel partition and
 * every feature ref by construction, which is exactly what the backend needs:
 * `/post-intervention/validate` reconciles the upload against the baseline
 * already stored on the project, and a post-intervention file generated
 * independently would share no refs with it and reconcile against nothing.
 *
 * Passing `piPath` as null throws the post-intervention half away, which is
 * what {@link makeGeoPackage} does — it is scratch in that case, not an output.
 *
 * @param {string} baselinePath where to write the baseline half
 * @param {string|null} piPath where to write the post-intervention half
 * @param {number} parcels how many habitat parcels both halves should contain
 * @param {{ seed?: number }} [options]
 * @returns {{ baseline: object, postIntervention: object|null }}
 */
export function makeGeoPackagePair(baselinePath, piPath, parcels, { seed } = {}) {
  // Without a post-intervention output the synthetic file is scratch, so it is
  // written beside the baseline and removed in the `finally` below.
  const syntheticPath = piPath ?? `${baselinePath}.synthetic`
  const startedAt = process.hrtime.bigint()
  rmSync(syntheticPath, { force: true })
  rmSync(baselinePath, { force: true })
  try {
    generateOne(syntheticPath, SITE_CENTRE, {
      numParcels: parcels,
      numTrees: NO_TREES,
      seed: seed ?? parcels
    })
    deriveBaselineFromSynthetic(syntheticPath, baselinePath)
    const generationMs = Math.round(
      Number(process.hrtime.bigint() - startedAt) / 1e6
    )
    return {
      baseline: {
        path: baselinePath,
        parcels,
        bytes: statSync(baselinePath).size,
        generationMs
      },
      postIntervention: piPath
        ? { path: piPath, parcels, bytes: statSync(piPath).size, generationMs }
        : null
    }
  } finally {
    if (!piPath) {
      rmSync(syntheticPath, { force: true })
    }
  }
}

// CLI: node scripts/make-gpkg.mjs <parcels> <outFile>
if (process.argv[1]?.endsWith('make-gpkg.mjs')) {
  const parcels = Number(process.argv[2] ?? 100)
  const out = process.argv[3] ?? `baseline-${parcels}.gpkg`
  const result = makeGeoPackage(out, parcels)
  console.log(
    `${result.path}: ${result.parcels} parcels, ` +
      `${(result.bytes / 1024).toFixed(0)} KB, ${result.generationMs} ms`
  )
}

/**
 * (Re)generate the committed GeoPackage fixtures in fixtures/.
 *
 * The four upload fixtures are committed rather than generated on every run:
 * generation is super-linear in parcel count (xlarge alone costs ~30s in the
 * CDP container), and a committed file is also a stable artefact anyone can
 * grab for an ad-hoc upload test against any environment. Generation is
 * seeded (scripts/make-gpkg.mjs), so re-running this produces byte-identical
 * files for the same bng-library pin — a diff here means the generator
 * changed, not chance.
 *
 * stage-uploads.mjs matches each requested size against fixtures/manifest.json
 * by label AND parcel count, and falls back to generating at run time when
 * they differ — so UPLOAD_SIZES still works with any parcel count; only the
 * defaults below get the committed fast path.
 *
 * Run after changing a size or bumping the bng-library pin:
 *   npm run gen-fixtures
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeGeoPackage } from './make-gpkg.mjs'

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures')

/**
 * The default sizes of the run's upload profile — keep in step with
 * DEFAULT_SIZES in stage-uploads.mjs (a mismatch is safe but forfeits the
 * committed fast path for the mismatched size).
 */
const SIZES = [
  { label: 'everyday', parcels: 80 },
  { label: 'busy', parcels: 800 },
  { label: 'large', parcels: 5000 },
  { label: 'xlarge', parcels: 12000 }
]

mkdirSync(FIXTURES_DIR, { recursive: true })

const entries = []
for (const { label, parcels } of SIZES) {
  const file = `baseline-${label}.gpkg`
  const { bytes, generationMs } = makeGeoPackage(
    join(FIXTURES_DIR, file),
    parcels
  )
  entries.push({ label, parcels, file, bytes })
  process.stderr.write(
    `▸ ${label}: ${parcels} parcels → ${file}, ${(bytes / 1024).toFixed(0)} KB ` +
      `(${(generationMs / 1000).toFixed(1)}s)\n`
  )
}

writeFileSync(
  join(FIXTURES_DIR, 'manifest.json'),
  JSON.stringify({ sizes: entries }, null, 2) + '\n'
)
process.stderr.write(`▸ wrote ${join(FIXTURES_DIR, 'manifest.json')}\n`)

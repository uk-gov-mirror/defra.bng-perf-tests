/**
 * Prepare everything the upload scenarios need, before JMeter starts.
 *
 * The upload journey is four steps — initiate, POST the file to the CDP
 * Uploader, poll until it is ready, then validate. Only the last of those is
 * worth measuring under load; the first three are the uploader's work, not the
 * service's, and driving a multipart upload plus a polling loop from JMeter
 * would add noise and complexity for nothing. So this stages the uploads here,
 * in Node, and hands JMeter a set of ready `uploadId`s to hammer.
 *
 * It also creates a pool of projects. Validation only runs the full pipeline —
 * extract, size, persist — when a `projectId` is supplied; without one it stops
 * after the geometry checks and would under-measure the real cost. Concurrent
 * uploads to the *same* project serialise on a row lock and 409, so each
 * concurrent thread needs its own project.
 *
 * Output on stdout, one `key=value` per line, for entrypoint.sh to read:
 *   uploadId_<label>=<uuid>
 *   parcels_<label>=<n>
 *   bytes_<label>=<n>
 * plus a projects CSV written to disk for JMeter's CSV Data Set.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { makeGeoPackage } from './make-gpkg.mjs'

const API_BASE_URL = process.env.API_BASE_URL
const BEARER_TOKEN = process.env.BEARER_TOKEN
const CDP_UPLOADER_URL = process.env.CDP_UPLOADER_URL
const STAGE_DIR = process.env.STAGE_DIR ?? '/opt/perftest/stage'
const PROJECTS_CSV = process.env.PROJECTS_CSV ?? join(STAGE_DIR, 'projects.csv')
const S3_BUCKET = process.env.UPLOAD_S3_BUCKET ?? 'baseline-files'

const UPLOAD_READY_TIMEOUT_MS = Number(
  process.env.UPLOAD_READY_TIMEOUT_MS ?? 180_000
)
const UPLOAD_POLL_INTERVAL_MS = 1000
const PROJECT_POOL_SIZE = Number(process.env.PROJECT_POOL_SIZE ?? 40)

const HTTP_BAD_REQUEST = 400

/**
 * The file sizes the run profiles, as `label:parcels` pairs.
 *
 * The defaults bracket reality deliberately. Real BNG files in the reference
 * corpus top out around 80 parcels / 124 KB, so `everyday` is what a user
 * actually submits; the larger steps are there to find where the service stops
 * coping, not because anyone uploads them today.
 *
 * The top of the ramp is 12 000 parcels / ~9 MB. Bigger than that is not a size
 * the service will ever be asked to handle — it is already two orders of
 * magnitude past the real corpus — and it costs disproportionately to stage,
 * because bng-library's `partitionPolygon` re-sorts the whole parcel list on
 * every split: generation is roughly quadratic, so 5 000 parcels takes ~1.6 s
 * and 12 000 takes ~9 s.
 */
const DEFAULT_SIZES = 'everyday:80,busy:800,large:5000,xlarge:12000'

function parseSizes(spec) {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, parcels] = entry.split(':')
      return { label: label.trim(), parcels: Number(parcels) }
    })
    .filter((s) => s.label && Number.isFinite(s.parcels) && s.parcels > 0)
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${BEARER_TOKEN}`, ...extra }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  })
  const text = await res.text()
  if (res.status >= HTTP_BAD_REQUEST) {
    throw new Error(`POST ${url} -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : null
}

async function getJson(url) {
  const res = await fetch(url, { headers: authHeaders() })
  const text = await res.text()
  if (res.status >= HTTP_BAD_REQUEST) {
    throw new Error(`GET ${url} -> ${res.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : null
}

/** Ask the backend for an upload slot. Returns the uploader path to POST to. */
async function initiateUpload() {
  return postJson(`${API_BASE_URL}/upload/initiate`, {
    redirect: '/done',
    s3Bucket: S3_BUCKET,
    s3Path: 'baseline/'
  })
}

/**
 * POST the file to the CDP Uploader. The backend hands back only the *path*
 * (it strips the host), so the uploader's own base URL has to be supplied.
 */
async function postFileToUploader(uploadUrl, filePath, bytes) {
  const fullUrl = uploadUrl.startsWith('http')
    ? uploadUrl
    : `${CDP_UPLOADER_URL}${uploadUrl}`

  const { readFile } = await import('node:fs/promises')
  const fileBytes = await readFile(filePath)
  const form = new FormData()
  form.append(
    'file',
    new Blob([fileBytes], { type: 'application/geopackage+sqlite3' }),
    'baseline.gpkg'
  )

  const res = await fetch(fullUrl, {
    method: 'POST',
    body: form,
    redirect: 'manual'
  })
  // The uploader answers a successful upload with a 302 to the redirect target.
  if (res.status >= HTTP_BAD_REQUEST) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `upload of ${(bytes / 1024).toFixed(0)}KB to ${fullUrl} -> ${res.status}: ${body.slice(0, 300)}`
    )
  }
}

/**
 * Wait for the uploader to finish scanning. Large files take noticeably longer
 * here than small ones — this is the uploader's virus scan, not our service, so
 * it is deliberately outside what the run measures.
 */
async function waitForReady(uploadId) {
  const deadline = Date.now() + UPLOAD_READY_TIMEOUT_MS
  let last
  while (Date.now() < deadline) {
    last = await getJson(`${API_BASE_URL}/upload/${uploadId}/status`)
    if (last?.uploadStatus === 'ready') {
      if (last.numberOfRejectedFiles > 0) {
        throw new Error(
          `upload ${uploadId} was rejected by the uploader: ${JSON.stringify(last).slice(0, 300)}`
        )
      }
      return last
    }
    if (last?.uploadStatus === 'rejected') {
      throw new Error(`upload ${uploadId} rejected: ${JSON.stringify(last).slice(0, 300)}`)
    }
    await new Promise((r) => setTimeout(r, UPLOAD_POLL_INTERVAL_MS))
  }
  throw new Error(
    `upload ${uploadId} never became ready within ${UPLOAD_READY_TIMEOUT_MS}ms (last: ${JSON.stringify(last)})`
  )
}

async function stageOneSize({ label, parcels }) {
  const filePath = join(STAGE_DIR, `baseline-${label}.gpkg`)
  const { bytes, generationMs } = makeGeoPackage(filePath, parcels)
  // Generation time is logged because it is super-linear in parcel count and
  // is pure setup cost — a task that looks slow to start is usually the top of
  // the size ramp being built, not the service being slow.
  process.stderr.write(
    `▸ ${label}: ${parcels} parcels, ${(bytes / 1024).toFixed(0)} KB ` +
      `(generated in ${(generationMs / 1000).toFixed(1)}s) — uploading\n`
  )

  const { uploadId, uploadUrl } = await initiateUpload()
  await postFileToUploader(uploadUrl, filePath, bytes)
  await waitForReady(uploadId)
  // The staged file has served its purpose; the bytes now live in S3.
  rmSync(filePath, { force: true })

  process.stderr.write(`  ready: ${uploadId}\n`)
  return { label, parcels, bytes, uploadId }
}

/**
 * Top up the owner's projects to a pool big enough that concurrent threads get
 * their own. Never deletes, so re-running a task does not pile rows up beyond
 * the target.
 */
async function ensureProjectPool() {
  const existing = await getJson(`${API_BASE_URL}/projects`)
  const owned = Array.isArray(existing) ? existing : (existing?.projects ?? [])
  const ids = owned.map((p) => p.id).filter(Boolean)

  while (ids.length < PROJECT_POOL_SIZE) {
    const created = await postJson(`${API_BASE_URL}/projects/new`, {
      project: { name: `perf upload ${ids.length + 1}` }
    })
    ids.push(created.id)
  }

  mkdirSync(dirname(PROJECTS_CSV), { recursive: true })
  writeFileSync(PROJECTS_CSV, ids.slice(0, PROJECT_POOL_SIZE).join('\n') + '\n')
  process.stderr.write(
    `▸ project pool: ${ids.length} available, wrote ${PROJECT_POOL_SIZE} to ${PROJECTS_CSV}\n`
  )
}

async function main() {
  if (!API_BASE_URL || !BEARER_TOKEN) {
    throw new Error('API_BASE_URL and BEARER_TOKEN are required')
  }
  if (!CDP_UPLOADER_URL) {
    throw new Error('CDP_UPLOADER_URL is required to POST the staged files')
  }
  mkdirSync(STAGE_DIR, { recursive: true })

  const sizes = parseSizes(process.env.UPLOAD_SIZES ?? DEFAULT_SIZES)
  if (sizes.length === 0) {
    throw new Error(`no usable sizes in UPLOAD_SIZES="${process.env.UPLOAD_SIZES}"`)
  }

  await ensureProjectPool()

  // Sequential on purpose: staging is setup, not load. Uploading these in
  // parallel would put the very burst we are about to measure onto the service
  // before the measurement starts.
  for (const size of sizes) {
    const staged = await stageOneSize(size)
    process.stdout.write(`uploadId_${staged.label}=${staged.uploadId}\n`)
    process.stdout.write(`parcels_${staged.label}=${staged.parcels}\n`)
    process.stdout.write(`bytes_${staged.label}=${staged.bytes}\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`stage-uploads failed: ${err.message}\n`)
  process.exit(1)
})

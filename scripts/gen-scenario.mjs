/**
 * Generate the repetitive half of `scenarios/bng-perf.jmx`.
 *
 * A JMeter staircase is one thread group per step, and a thread group is ~95
 * lines of XML. The plan carried eight of them written out by hand — five
 * concurrency steps and three journey steps — which is why the ladder stopped
 * at 1/2/5: adding a step meant copying a block, and changing a sampler meant
 * changing every copy. This writes them instead, from `ladders.config.mjs`.
 *
 * Two outputs, both COMMITTED:
 *
 *   scenarios/bng-perf.jmx   — between the BEGIN/END GENERATED markers only.
 *                              Everything outside them is hand-written and is
 *                              never touched: the home page, project list,
 *                              probe, size ramp and project-creation groups.
 *   scenarios/ladders.sh     — the same step lists as a POSIX-sh fragment, so
 *                              entrypoint.sh derives its phase schedule from
 *                              the same source and cannot drift from the plan.
 *
 * Committing the output is the call this repo already made for the upload
 * fixtures: the .jmx stays a real file that opens in the JMeter GUI and diffs
 * in review — it just is not the place you edit a ladder.
 *
 *   npm run gen-scenario           rewrite both outputs
 *   npm run gen-scenario -- --check  fail if either is out of date (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_PHASE_GAP_SECONDS,
  DEFAULT_PROFILE,
  FETCH_RAMP,
  LADDERS,
  MIXED_THREADS,
  MIX_DEFAULTS,
  PROFILES,
  SETUP_ALLOWANCE_SECONDS,
  SIZE_LABELS,
  budgetCheck,
  generatedBlockStartSeconds,
  ladderSteps,
  profilePhases,
  runSeconds,
  scheduleFrom,
  sizeRampWindowSeconds,
  stepKey,
  stepLabel
} from '../scenarios/ladders.config.mjs'

const ROOT = join(import.meta.dirname, '..')
const JMX_PATH = join(ROOT, 'scenarios', 'bng-perf.jmx')
const LADDERS_SH_PATH = join(ROOT, 'scenarios', 'ladders.sh')

const BEGIN_MARKER = '      <!-- BEGIN GENERATED: ladders — scripts/gen-scenario.mjs, do not edit by hand -->'
const END_MARKER = '      <!-- END GENERATED: ladders -->'

/** Thread groups sit six spaces in, inside the TestPlan hashTree. */
const IND = '      '

/**
 * JMeter stores sampler and thread-group names as XML attribute values and
 * comments as element text, so both need escaping. Apostrophes are escaped too
 * because the hand-written half of the plan does (`&apos;`), and a generated
 * block that escaped differently would show up as noise in every diff.
 */
function xml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function lines(...parts) {
  return parts.flat().filter((l) => l !== null).join('\n')
}

// ── Shared fragments ────────────────────────────────────────────────────────

/**
 * A step's thread group.
 *
 * Every step reads BOTH its thread count and its start delay from properties
 * named after the step, so a profile can zero a step (costing nothing) and
 * entrypoint.sh can slide the whole timeline without this file knowing when
 * anything runs. `continue` on error because a saturated step answering 500s
 * IS the result — stopping there would lose the steps above it.
 */
function threadGroup({ name, key, comment, loops = -1, defaults }) {
  const loopBody = loops === -1
    ? `          <stringProp name="LoopController.loops">-1</stringProp>
          <boolProp name="LoopController.continue_forever">true</boolProp>`
    : `          <stringProp name="LoopController.loops">${loops}</stringProp>
          <boolProp name="LoopController.continue_forever">false</boolProp>`
  return `${IND}<ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="${xml(name)}">
${IND}  <stringProp name="TestPlan.comments">${xml(comment)}</stringProp>
${IND}  <stringProp name="ThreadGroup.num_threads">\${__P(users_${key},${defaults.usersFor(key)})}</stringProp>
${IND}  <stringProp name="ThreadGroup.ramp_time">1</stringProp>
${IND}  <boolProp name="ThreadGroup.scheduler">true</boolProp>
${IND}  <stringProp name="ThreadGroup.duration">\${__P(window_${key},${defaults.windowFor(key)})}</stringProp>
${IND}  <stringProp name="ThreadGroup.delay">\${__P(delay_${key},${defaults.delayFor(key)})}</stringProp>
${IND}  <boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>
${IND}  <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
${IND}  <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller">
${loopBody}
${IND}  </elementProp>
${IND}</ThreadGroup>`
}

/** Backend host/port defaults, as every authenticated group already sets them. */
function backendDefaults(indent) {
  return `${indent}<ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="Backend defaults">
${indent}  <stringProp name="HTTPSampler.domain">\${__P(backendDomain,bng-metric-backend.\${__P(env)}.cdp-int.defra.cloud)}</stringProp>
${indent}  <stringProp name="HTTPSampler.protocol">\${__P(protocol,https)}</stringProp>
${indent}  <stringProp name="HTTPSampler.port">\${__P(backendPort,\${__P(port,443)})}</stringProp>
${indent}  <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables">
${indent}    <collectionProp name="Arguments.arguments"/>
${indent}  </elementProp>
${indent}</ConfigTestElement>
${indent}<hashTree/>`
}

/**
 * Auth headers. `json` adds Content-Type; the journey's file leg must NOT have
 * one set here, because the multipart sampler has to write its own boundary.
 */
function authHeaders(indent, { json = true } = {}) {
  const contentType = json
    ? `${indent}    <elementProp name="" elementType="Header">
${indent}      <stringProp name="Header.name">Content-Type</stringProp>
${indent}      <stringProp name="Header.value">application/json</stringProp>
${indent}    </elementProp>\n`
    : ''
  const name = json
    ? 'Auth + JSON headers'
    : 'Auth headers (no Content-Type — the multipart sampler must set its own)'
  return `${indent}<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="${xml(name)}">
${indent}  <collectionProp name="HeaderManager.headers">
${indent}    <elementProp name="" elementType="Header">
${indent}      <stringProp name="Header.name">Authorization</stringProp>
${indent}      <stringProp name="Header.value">Bearer \${bearerToken}</stringProp>
${indent}    </elementProp>
${contentType}${indent}    <elementProp name="" elementType="Header">
${indent}      <stringProp name="Header.name">Accept</stringProp>
${indent}      <stringProp name="Header.value">application/json</stringProp>
${indent}    </elementProp>
${indent}  </collectionProp>
${indent}</HeaderManager>
${indent}<hashTree/>`
}

/**
 * A CSV Data Set.
 *
 * `shareMode.all` and `recycle` together are what give each concurrent thread a
 * different row: validation serialises on a project row lock and 409s when two
 * threads land on the same project, so sharing one cursor across the whole plan
 * is not an optimisation, it is the requirement.
 */
function csvDataSet(indent, { name, fileProp, fileDefault, variables, quoted = false }) {
  return `${indent}<CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="${xml(name)}">
${indent}  <stringProp name="filename">\${__P(${fileProp},${fileDefault})}</stringProp>
${indent}  <stringProp name="variableNames">${variables}</stringProp>
${indent}  <stringProp name="delimiter">,</stringProp>
${indent}  <boolProp name="quotedData">${quoted}</boolProp>
${indent}  <boolProp name="recycle">true</boolProp>
${indent}  <boolProp name="stopThread">false</boolProp>
${indent}  <stringProp name="shareMode">shareMode.all</stringProp>
${indent}  <boolProp name="ignoreFirstLine">false</boolProp>
${indent}  <stringProp name="fileEncoding"></stringProp>
${indent}</CSVDataSet>
${indent}<hashTree/>`
}

/**
 * The prepared and contention CSVs are written with every field quoted
 * (stage-uploads.mjs `csvField`), because they carry free-text reference data —
 * habitat and condition names — and nothing stops one of those gaining a comma.
 * JMeter has to be told, or it reads the quote characters as part of the value
 * and they end up inside the JSON body of the PUT.
 *
 * The plain project-id pool stays unquoted: it is bare UUIDs, and it is shared
 * with the hand-written half of the plan.
 */
/**
 * Socket timeouts, in milliseconds — the point past which a sample is an ERROR
 * rather than a slow success, as distinct from the Duration Assertion budgets,
 * which are red lines in the report.
 *
 * These mirror entrypoint.sh's own defaults. The two exist because the plan is
 * meant to stay runnable with a bare `jmeter -t`, and a plan whose fallbacks
 * disagreed with the runner's would quietly measure something else.
 */
const TIMEOUT_DEFAULTS = {
  validate: 120_000,
  initiate: 30_000,
  edit: 30_000
}

const PREPARED_CSV_IS_QUOTED = true

const ASSERT_RESPONSE_CODE = 8
const ASSERT_SUBSTRING = 2
const ASSERT_MATCHES = 1

const JAVA_HASH_MULTIPLIER = 31
const INT32 = 32

/**
 * Java's String.hashCode.
 *
 * JMeter names each element of a collectionProp with the hash of its value, and
 * the hand-written half of this plan is full of them (`<stringProp name="49586">200`).
 * The loader does not read those names for a CollectionProperty, so any value
 * would work — but matching the convention keeps a generated assertion
 * byte-identical in shape to a hand-written one, which matters when someone
 * opens the plan in the GUI, saves it, and diffs the result.
 */
function javaHash(value) {
  let hash = 0
  for (const ch of String(value)) {
    hash = Math.imul(JAVA_HASH_MULTIPLIER, hash) + ch.codePointAt(0)
    hash |= 0
  }
  return String(BigInt.asIntN(INT32, BigInt(hash)))
}

function responseAssertion(indent, { name, field, testType, values }) {
  const items = values
    .map(
      (v) => `${indent}    <stringProp name="${javaHash(v)}">${xml(v)}</stringProp>`
    )
    .join('\n')
  return `${indent}<ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="${xml(name)}">
${indent}  <collectionProp name="Asserion.test_strings">
${items}
${indent}  </collectionProp>
${indent}  <stringProp name="Assertion.test_field">${field}</stringProp>
${indent}  <boolProp name="Assertion.assume_success">false</boolProp>
${indent}  <intProp name="Assertion.test_type">${testType}</intProp>
${indent}</ResponseAssertion>
${indent}<hashTree/>`
}

function statusIs(indent, code = '200') {
  return responseAssertion(indent, {
    name: `Status ${code}`,
    field: 'Assertion.response_code',
    testType: ASSERT_RESPONSE_CODE,
    values: [code]
  })
}

function bodyContains(indent, name, needle) {
  return responseAssertion(indent, {
    name,
    field: 'Assertion.response_data',
    testType: ASSERT_SUBSTRING,
    values: [needle]
  })
}

function durationAssertion(indent, budgetVar) {
  return `${indent}<DurationAssertion guiclass="DurationAssertionGui" testclass="DurationAssertion" testname="Within budget">
${indent}  <stringProp name="DurationAssertion.duration">\${${budgetVar}}</stringProp>
${indent}</DurationAssertion>
${indent}<hashTree/>`
}

/** A JSON-body POST/PUT sampler. */
function jsonSampler(
  indent,
  { name, path, method, body, timeoutProp, timeoutDefault, children }
) {
  return `${indent}<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${xml(name)}">
${indent}  <stringProp name="HTTPSampler.path">${xml(path)}</stringProp>
${indent}  <stringProp name="HTTPSampler.method">${method}</stringProp>
${indent}  <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
${indent}  <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
${indent}  <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>
${indent}  <stringProp name="HTTPSampler.connect_timeout">10000</stringProp>
${indent}  <stringProp name="HTTPSampler.response_timeout">\${__P(${timeoutProp},${timeoutDefault})}</stringProp>
${indent}  <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
${indent}    <collectionProp name="Arguments.arguments">
${indent}      <elementProp name="" elementType="HTTPArgument">
${indent}        <boolProp name="HTTPArgument.always_encode">false</boolProp>
${indent}        <stringProp name="Argument.value">${xml(body)}</stringProp>
${indent}        <stringProp name="Argument.metadata">=</stringProp>
${indent}      </elementProp>
${indent}    </collectionProp>
${indent}  </elementProp>
${indent}</HTTPSamplerProxy>
${indent}<hashTree>
${children}
${indent}</hashTree>`
}

/** A plain GET sampler. */
function getSampler(indent, { name, path, children }) {
  return `${indent}<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${xml(name)}">
${indent}  <stringProp name="HTTPSampler.path">${xml(path)}</stringProp>
${indent}  <stringProp name="HTTPSampler.method">GET</stringProp>
${indent}  <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
${indent}  <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
${indent}  <stringProp name="HTTPSampler.connect_timeout">10000</stringProp>
${indent}  <stringProp name="HTTPSampler.response_timeout">\${__P(fetchResponseTimeoutMs,60000)}</stringProp>
${indent}  <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables">
${indent}    <collectionProp name="Arguments.arguments"/>
${indent}  </elementProp>
${indent}</HTTPSamplerProxy>
${indent}<hashTree>
${children}
${indent}</hashTree>`
}

// ── Ladder bodies ───────────────────────────────────────────────────────────

const BODY = IND + '  '
const CHILD = BODY + '  '

/**
 * One revalidate step: N threads replaying ONE pre-staged upload.
 *
 * The uploadId is a property rather than a CSV column because staging emits
 * exactly one per size; the projectId is a CSV column because concurrent
 * validates against the same project serialise on a row lock and 409.
 */
function revalidateStep(step, defaults) {
  const key = stepKey(step)
  // The label names the axis this ladder climbs — its sibling is the size
  // ramp's `validation cost vs file size: <size> (1 user)`. "One <size> upload"
  // is load-bearing: it is what stops the row reading as N people uploading.
  // "on", not a comma — labels land in the results CSV, where a comma splits
  // the row for every naive consumer.
  const label = `validation cost vs concurrency: ${step.users} user(s) on one ${step.size} upload`
  const budget = step.size === 'everyday' ? 'everydayBudgetMs' : 'validateBudgetMs'
  return lines(
    threadGroup({
      name: `Validation cost vs concurrency (${step.size}) @ ${step.users} user(s)`,
      key,
      defaults,
      comment:
        `${step.users} thread(s) re-validating ONE pre-staged ${step.size} upload.\n\n` +
        'This isolates the service\'s own validate cost from the uploader\'s — the\n' +
        'bytes are already in S3 and already scanned. It is NOT N people uploading\n' +
        'N files; the upload journey ladder is that, and the two sit next to each\n' +
        'other in the report so the difference between them is the uploader.'
    }),
    `${IND}<hashTree>`,
    backendDefaults(BODY),
    authHeaders(BODY),
    csvDataSet(BODY, {
      name: 'Project id pool',
      fileProp: 'projectsCsv',
      fileDefault: '/opt/perftest/stage/projects.csv',
      variables: 'projectId'
    }),
    jsonSampler(BODY, {
      name: label,
      path: `/baseline/validate/\${__P(uploadId_${step.size},)}`,
      method: 'POST',
      body: '{"projectId":"${projectId}"}',
      timeoutProp: 'validateResponseTimeoutMs',
      timeoutDefault: TIMEOUT_DEFAULTS.validate,
      children: lines(
        statusIs(CHILD),
        bodyContains(CHILD, 'Fixture actually validates', '"valid":true'),
        durationAssertion(CHILD, budget)
      )
    }),
    `${IND}</hashTree>`
  )
}

/**
 * One upload-journey step: N threads each driving a REAL upload end to end.
 *
 * Three legs on one thread — initiate, multipart POST to the uploader, validate
 * — so the uploader and its virus scan are inside the measurement. There is no
 * client-side scan poll because the backend's validate route waits for the scan
 * itself (waitForUploadReady), so the validate leg carries that wait.
 */
function journeyStep(step, defaults) {
  const key = stepKey(step)
  const suffix = stepLabel(step)
  return lines(
    threadGroup({
      name: `Upload journey ${step.size} @ ${step.users} user(s)`,
      key,
      defaults,
      comment:
        `The FULL upload journey at ${step.users} concurrent user(s), ${step.size} file —\n` +
        'initiate, multipart POST to the CDP Uploader, then validate, as one closed\n' +
        'loop per user. Every iteration is a real new upload, so the uploader and\n' +
        'its scanner are inside the number.\n\n' +
        'No client-side poll: the backend\'s validate route waits for the scan\n' +
        'itself, so the validate leg carries the same wall clock a frontend user\n' +
        'experiences, without a polling loop\'s noise in the report.'
    }),
    `${IND}<hashTree>`,
    backendDefaults(BODY),
    authHeaders(BODY, { json: false }),
    csvDataSet(BODY, {
      name: 'Project id pool',
      fileProp: 'projectsCsv',
      fileDefault: '/opt/perftest/stage/projects.csv',
      variables: 'projectId'
    }),
    jsonSampler(BODY, {
      name: `journey ${suffix}: initiate`,
      path: '/upload/initiate',
      method: 'POST',
      body: '{"redirect":"/done","s3Bucket":"${uploadS3Bucket}","s3Path":"baseline/"}',
      timeoutProp: 'initiateResponseTimeoutMs',
      timeoutDefault: TIMEOUT_DEFAULTS.initiate,
      children: lines(
        `${CHILD}<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="JSON body">
${CHILD}  <collectionProp name="HeaderManager.headers">
${CHILD}    <elementProp name="" elementType="Header">
${CHILD}      <stringProp name="Header.name">Content-Type</stringProp>
${CHILD}      <stringProp name="Header.value">application/json</stringProp>
${CHILD}    </elementProp>
${CHILD}  </collectionProp>
${CHILD}</HeaderManager>
${CHILD}<hashTree/>`,
        `${CHILD}<JSONPostProcessor guiclass="JSONPostProcessorGui" testclass="JSONPostProcessor" testname="extract uploadId + uploadUrl">
${CHILD}  <stringProp name="JSONPostProcessor.referenceNames">journeyUploadId;journeyUploadUrl</stringProp>
${CHILD}  <stringProp name="JSONPostProcessor.jsonPathExprs">$.uploadId;$.uploadUrl</stringProp>
${CHILD}  <stringProp name="JSONPostProcessor.match_numbers">1;1</stringProp>
${CHILD}  <stringProp name="JSONPostProcessor.defaultValues">FAILED;FAILED</stringProp>
${CHILD}</JSONPostProcessor>
${CHILD}<hashTree/>`,
        statusIs(CHILD)
      )
    }),
    // An initiate that failed leaves no uploadId, and the legs below would then
    // POST to a garbage path — a phase's worth of 404s reported as though the
    // service had failed them. Skip instead.
    `${BODY}<IfController guiclass="IfControllerPanel" testclass="IfController" testname="initiate succeeded?">
${BODY}  <stringProp name="IfController.condition">\${__jexl3("\${journeyUploadId}" != "FAILED")}</stringProp>
${BODY}  <boolProp name="IfController.evaluateAll">false</boolProp>
${BODY}  <boolProp name="IfController.useExpression">true</boolProp>
${BODY}</IfController>
${BODY}<hashTree>`,
    journeyUploadLeg(step, suffix),
    journeyValidateLeg(step, suffix),
    `${BODY}</hashTree>`,
    `${IND}</hashTree>`
  )
}

const UPLOAD_LEG = CHILD
const UPLOAD_CHILD = CHILD + '  '

function journeyUploadLeg(step, suffix) {
  return `${UPLOAD_LEG}<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${xml(`journey ${suffix}: send file to uploader`)}">
${UPLOAD_LEG}  <stringProp name="TestPlan.comments">The backend returns the uploader PATH only, so the full URL is assembled from
uploaderUrl. A successful upload answers 302 to the redirect target; the
redirect is NOT followed — it points at the frontend flow, not the API.</stringProp>
${UPLOAD_LEG}  <stringProp name="HTTPSampler.path">\${uploaderUrl}\${journeyUploadUrl}</stringProp>
${UPLOAD_LEG}  <stringProp name="HTTPSampler.method">POST</stringProp>
${UPLOAD_LEG}  <boolProp name="HTTPSampler.follow_redirects">false</boolProp>
${UPLOAD_LEG}  <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
${UPLOAD_LEG}  <boolProp name="HTTPSampler.DO_MULTIPART_POST">true</boolProp>
${UPLOAD_LEG}  <stringProp name="HTTPSampler.connect_timeout">10000</stringProp>
${UPLOAD_LEG}  <stringProp name="HTTPSampler.response_timeout">\${__P(uploadResponseTimeoutMs,120000)}</stringProp>
${UPLOAD_LEG}  <elementProp name="HTTPsampler.Arguments" elementType="Arguments">
${UPLOAD_LEG}    <collectionProp name="Arguments.arguments"/>
${UPLOAD_LEG}  </elementProp>
${UPLOAD_LEG}  <elementProp name="HTTPsampler.Files" elementType="HTTPFileArgs">
${UPLOAD_LEG}    <collectionProp name="HTTPFileArgs.files">
${UPLOAD_LEG}      <elementProp name="\${journeyFile_${step.size}}" elementType="HTTPFileArg">
${UPLOAD_LEG}        <stringProp name="File.path">\${journeyFile_${step.size}}</stringProp>
${UPLOAD_LEG}        <stringProp name="File.paramname">file</stringProp>
${UPLOAD_LEG}        <stringProp name="File.mimetype">application/geopackage+sqlite3</stringProp>
${UPLOAD_LEG}      </elementProp>
${UPLOAD_LEG}    </collectionProp>
${UPLOAD_LEG}  </elementProp>
${UPLOAD_LEG}</HTTPSamplerProxy>
${UPLOAD_LEG}<hashTree>
${statusIs(UPLOAD_CHILD, '302')}
${UPLOAD_LEG}</hashTree>`
}

function journeyValidateLeg(step, suffix) {
  const budget = step.size === 'everyday' ? 'journeyBudgetMs' : 'journeyLargeBudgetMs'
  return jsonSampler(UPLOAD_LEG, {
    name: `journey ${suffix}: validate incl virus scan`,
    path: '/baseline/validate/${journeyUploadId}',
    method: 'POST',
    body: '{"projectId":"${projectId}"}',
    timeoutProp: 'validateResponseTimeoutMs',
    children: lines(
      `${UPLOAD_CHILD}<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="JSON body">
${UPLOAD_CHILD}  <collectionProp name="HeaderManager.headers">
${UPLOAD_CHILD}    <elementProp name="" elementType="Header">
${UPLOAD_CHILD}      <stringProp name="Header.name">Content-Type</stringProp>
${UPLOAD_CHILD}      <stringProp name="Header.value">application/json</stringProp>
${UPLOAD_CHILD}    </elementProp>
${UPLOAD_CHILD}  </collectionProp>
${UPLOAD_CHILD}</HeaderManager>
${UPLOAD_CHILD}<hashTree/>`,
      statusIs(UPLOAD_CHILD),
      bodyContains(UPLOAD_CHILD, 'Fixture actually validates', '"valid":true'),
      durationAssertion(UPLOAD_CHILD, budget)
    )
  })
}

/**
 * One post-intervention step.
 *
 * Shaped like revalidate — one staged upload replayed by N threads across N
 * projects — but the projects come from the PREPARED pool, because a
 * post-intervention document is only meaningful against a project that already
 * holds the matching baseline. Staging builds that pool by validating the
 * baseline half of the pair into each project first; the two halves share a
 * redline and every feature ref by construction.
 */
function piStep(step, defaults) {
  const key = stepKey(step)
  const label = `post-intervention validate ${stepLabel(step)}`
  return lines(
    threadGroup({
      name: `Post-intervention validate ${step.size} @ ${step.users} user(s)`,
      key,
      defaults,
      comment:
        `${step.users} thread(s) validating ONE staged post-intervention upload into\n` +
        `${step.users} prepared project(s) — each already holding the ${step.size} baseline the\n` +
        'upload pairs with. This is the peer of /baseline/validate that no sampler\n' +
        'in the plan had ever touched, and plausibly the heavier of the two: it\n' +
        'reconciles against the stored baseline rather than starting from nothing.'
    }),
    `${IND}<hashTree>`,
    backendDefaults(BODY),
    authHeaders(BODY),
    csvDataSet(BODY, {
      name: 'Prepared project pool',
      fileProp: `preparedCsv_${step.size}`,
      fileDefault: `/opt/perftest/stage/prepared-${step.size}.csv`,
      variables:
        'preparedProjectId,preparedFeatureId,preparedBroadType,preparedHabitatType,preparedCondition',
      quoted: PREPARED_CSV_IS_QUOTED
    }),
    jsonSampler(BODY, {
      name: label,
      path: `/post-intervention/validate/\${__P(piUploadId_${step.size},)}`,
      method: 'POST',
      body: '{"projectId":"${preparedProjectId}"}',
      timeoutProp: 'validateResponseTimeoutMs',
      timeoutDefault: TIMEOUT_DEFAULTS.validate,
      children: lines(
        statusIs(CHILD),
        bodyContains(CHILD, 'Fixture actually validates', '"valid":true'),
        durationAssertion(CHILD, 'validateBudgetMs')
      )
    }),
    `${IND}</hashTree>`
  )
}

/**
 * One habitat-edit step.
 *
 * The PUT writes back the values the feature already holds. A no-op edit is
 * deliberate: it still does the whole read-modify-write — SELECT … FOR UPDATE
 * of the entire JSONB, a unit-total recalculation across it, and an audit row
 * carrying BOTH the new and previous document — while being guaranteed valid.
 * Inventing new attribute values would risk a 422 that measures the validator
 * rather than the write path.
 */
function editStep(step, { contention }, defaults) {
  const key = stepKey(step)
  const size = step.size ?? 'everyday'
  const suffix = contention
    ? `@ ${step.users} user(s)`
    : stepLabel(step)
  // No comma in a sampler label. It lands in the results CSV, and while JMeter
  // quotes it correctly, every naive consumer of that file — a spreadsheet, a
  // grep, an awk one-liner — splits the row in the wrong place and silently
  // shifts every later column.
  const label = contention
    ? `habitat edit same project ${suffix}`
    : `habitat edit distinct projects ${suffix}`
  const projectId = contention
    ? '${__P(contentionProjectId,)}'
    : '${preparedProjectId}'
  return lines(
    threadGroup({
      name: contention
        ? `Habitat edit contention @ ${step.users} user(s)`
        : `Habitat edit ${size} @ ${step.users} user(s)`,
      key,
      defaults,
      comment: contention
        ? `${step.users} thread(s) editing DIFFERENT habitats in the SAME project.\n\n` +
          'runUpdate sets lock_timeout to 5s then takes SELECT … FOR UPDATE on the\n' +
          'project row, so these serialise and eventually 409 with "Another edit for\n' +
          'this project is in progress". The number to read is the 409 RATE, not the\n' +
          'latency — 409 is a correct answer here, so it is asserted as acceptable\n' +
          'and counted separately in the summary rather than painting the report red.'
        : `${step.users} thread(s) each editing a habitat in a DIFFERENT project, so this\n` +
          'measures throughput rather than lock contention.\n\n' +
          'Every PUT is O(document size) three times over: the whole project JSONB is\n' +
          'SELECTed FOR UPDATE and pulled into Node, the unit totals are recalculated\n' +
          'across it, and the write_projects_audit_log trigger stores both the new\n' +
          'and the previous document. The write itself is a surgical jsonb_set;\n' +
          'nothing around it is.'
    }),
    `${IND}<hashTree>`,
    backendDefaults(BODY),
    authHeaders(BODY),
    csvDataSet(BODY, {
      name: contention ? 'Features of the contention project' : 'Prepared project pool',
      fileProp: contention ? 'contentionCsv' : `preparedCsv_${size}`,
      fileDefault: contention
        ? '/opt/perftest/stage/contention.csv'
        : `/opt/perftest/stage/prepared-${size}.csv`,
      variables:
        'preparedProjectId,preparedFeatureId,preparedBroadType,preparedHabitatType,preparedCondition',
      quoted: PREPARED_CSV_IS_QUOTED
    }),
    jsonSampler(BODY, {
      name: label,
      path: `/projects/${projectId}/habitats/\${preparedFeatureId}`,
      method: 'PUT',
      body: '{"broadType":"${preparedBroadType}","habitatType":"${preparedHabitatType}","condition":"${preparedCondition}"}',
      timeoutProp: 'editResponseTimeoutMs',
      timeoutDefault: TIMEOUT_DEFAULTS.edit,
      children: contention
        ? lines(
            // 200 and 409 are both correct outcomes; anything else is not.
            responseAssertion(CHILD, {
              name: 'Status 200 or 409 (409 is the lock, not a failure)',
              field: 'Assertion.response_code',
              testType: ASSERT_MATCHES,
              values: ['200|409']
            })
          )
        : lines(statusIs(CHILD), durationAssertion(CHILD, 'editBudgetMs'))
    }),
    `${IND}</hashTree>`
  )
}

/**
 * The single-project fetch ramp: GET /projects/{id} once per size, one user.
 *
 * BMD-933 bounded the LIST payloads and asserts on it. This endpoint was never
 * bounded and never sampled, yet it is what every habitat-list page load pulls
 * — the whole document, with no pagination anywhere above it. One user, so the
 * number is the cost of the payload rather than the cost of contention, and
 * loop-count driven like the size ramp so each size gets an exact sample count.
 */
function fetchRampGroup(defaults) {
  const perSize = SIZE_LABELS.map((size) =>
    lines(
      `${BODY}<LoopController guiclass="LoopControlPanel" testclass="LoopController" testname="${xml(`${size} x N`)}">
${BODY}  <boolProp name="LoopController.continue_forever">false</boolProp>
${BODY}  <stringProp name="LoopController.loops">\${__P(fetchLoops_${size},${defaults.fetchLoopsFor(size)})}</stringProp>
${BODY}</LoopController>
${BODY}<hashTree>`,
      getSampler(CHILD, {
        name: `fetch ${size} project (GET /projects/{id})`,
        path: `/projects/\${__P(sizedProjectId_${size},)}`,
        children: lines(
          statusIs(CHILD + '  '),
          durationAssertion(CHILD + '  ', 'fetchBudgetMs')
        )
      }),
      `${BODY}</hashTree>`
    )
  )
  return lines(
    threadGroup({
      name: 'Single-project fetch ramp (1 user, one size after another)',
      key: 'fetchRamp',
      loops: 1,
      defaults,
      comment:
        'GET /projects/{id} at each staged document size, one user.\n\n' +
        'The list endpoints have a bounded payload and a SizeAssertion to prove it\n' +
        '(BMD-933 AC1). This one returns the entire project document and is what\n' +
        'every habitat-list page load pulls, with no pagination above it. One user\n' +
        'so the number is the payload cost, not a contention cost.\n\n' +
        'Loop-count driven inside a duration guard, like the size ramp: each size\n' +
        'gets an exact sample count, and a size with no staged project runs zero\n' +
        'loops rather than GETting /projects/ with an empty path segment.'
    }),
    `${IND}<hashTree>`,
    backendDefaults(BODY),
    authHeaders(BODY),
    perSize,
    `${IND}</hashTree>`
  )
}

/** ThroughputController.style: 0 = total executions, 1 = percent executions. */
const THROUGHPUT_STYLE_PERCENT = 1

/**
 * A weighted slice of the mixed workload.
 *
 * ThroughputController in percent-executions mode runs its children on that
 * percentage of the parent's iterations, so the mix is a property of the config
 * rather than of how fast each endpoint happens to be — a slow endpoint does
 * not quietly become a smaller share of the load. perThread=false so the
 * percentage holds across the group rather than per user.
 */
function mixedSlice(name, percentProp, percentDefault, sampler) {
  return lines(
    `${BODY}<ThroughputController guiclass="ThroughputControllerGui" testclass="ThroughputController" testname="${xml(name)}">
${BODY}  <intProp name="ThroughputController.style">${THROUGHPUT_STYLE_PERCENT}</intProp>
${BODY}  <boolProp name="ThroughputController.perThread">false</boolProp>
${BODY}  <intProp name="ThroughputController.maxThroughput">1</intProp>
${BODY}  <stringProp name="ThroughputController.percentThroughput">\${__P(${percentProp},${percentDefault})}</stringProp>
${BODY}</ThroughputController>
${BODY}<hashTree>`,
    sampler,
    `${BODY}</hashTree>`
  )
}

/**
 * The mixed workload — every other phase runs one operation in isolation.
 *
 * A staircase proves an operation scales ALONE. Production runs reads, edits
 * and uploads against one connection pool at the same time, and pool contention
 * is invisible to a plan whose phases never overlap. This is the only group
 * that mixes them, and its two-minute window is the longest sustained load in
 * the plan — the closest thing to production traffic the suite runs.
 */
function mixedWorkloadGroup(defaults) {
  return lines(
    threadGroup({
      name: 'Mixed workload (reads + edits + uploads together)',
      key: 'mixed',
      defaults,
      comment:
        'A weighted mix of everything, run concurrently rather than in phases.\n\n' +
        'Every staircase in this plan proves an operation scales on its own. This\n' +
        'group is the one that asks whether they scale TOGETHER — the same pool,\n' +
        'the same database, at the same time. Weights are MIX_*_PERCENT and should\n' +
        'add up to 100; they are percent-of-iterations, so they do not drift with\n' +
        'how fast each endpoint happens to be.\n\n' +
        'WINDOW_mixed stretches this group on its own — long enough for a leak,\n' +
        'a growing session store or pool exhaustion to show up, none of which a\n' +
        '30-second phase can see.\n\n' +
        'The edit and revalidate slices deliberately share the prepared pool, so\n' +
        'a project is being edited while it is being re-validated. That is safe\n' +
        'to repeat: carry-forward-feature-ids.js keys featureIds by parcel ref,\n' +
        'so re-validating the same file into the same project reuses the ids the\n' +
        'edit slice is reading from the CSV rather than minting new ones. Without\n' +
        'that, every revalidate would 404 the edits behind it.'
    }),
    `${IND}<hashTree>`,
    backendDefaults(BODY),
    authHeaders(BODY),
    csvDataSet(BODY, {
      name: 'Prepared project pool',
      fileProp: 'preparedCsv_everyday',
      fileDefault: '/opt/perftest/stage/prepared-everyday.csv',
      variables:
        'preparedProjectId,preparedFeatureId,preparedBroadType,preparedHabitatType,preparedCondition',
      quoted: PREPARED_CSV_IS_QUOTED
    }),
    mixedSlice(
      'list projects',
      'mixListPercent',
      MIX_DEFAULTS.list,
      getSampler(CHILD, {
        name: 'mixed: list my projects (GET /projects)',
        path: '/projects',
        children: statusIs(CHILD + '  ')
      })
    ),
    mixedSlice(
      'fetch one project',
      'mixFetchPercent',
      MIX_DEFAULTS.fetch,
      getSampler(CHILD, {
        name: 'mixed: fetch one project (GET /projects/{id})',
        path: '/projects/${preparedProjectId}',
        children: statusIs(CHILD + '  ')
      })
    ),
    mixedSlice(
      'edit a habitat',
      'mixEditPercent',
      MIX_DEFAULTS.edit,
      jsonSampler(CHILD, {
        name: 'mixed: edit a habitat (PUT /projects/{id}/habitats/{featureId})',
        path: '/projects/${preparedProjectId}/habitats/${preparedFeatureId}',
        method: 'PUT',
        body: '{"broadType":"${preparedBroadType}","habitatType":"${preparedHabitatType}","condition":"${preparedCondition}"}',
        timeoutProp: 'editResponseTimeoutMs',
        timeoutDefault: TIMEOUT_DEFAULTS.edit,
      timeoutDefault: TIMEOUT_DEFAULTS.edit,
        children: responseAssertion(CHILD + '  ', {
          name: 'Status 200 or 409',
          field: 'Assertion.response_code',
          testType: ASSERT_MATCHES,
          values: ['200|409']
        })
      })
    ),
    mixedSlice(
      'revalidate an upload',
      'mixValidatePercent',
      MIX_DEFAULTS.validate,
      jsonSampler(CHILD, {
        name: 'mixed: revalidate an upload (POST /baseline/validate/{uploadId})',
        path: '/baseline/validate/${__P(uploadId_everyday,)}',
        method: 'POST',
        body: '{"projectId":"${preparedProjectId}"}',
        timeoutProp: 'validateResponseTimeoutMs',
        timeoutDefault: TIMEOUT_DEFAULTS.validate,
      timeoutDefault: TIMEOUT_DEFAULTS.validate,
        children: statusIs(CHILD + '  ')
      })
    ),
    `${BODY}<ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer" testname="Mixed think time">
${BODY}  <stringProp name="ConstantTimer.delay">\${__P(mixThinkMs,500)}</stringProp>
${BODY}</ConstantTimer>
${BODY}<hashTree/>`,
    `${IND}</hashTree>`
  )
}

// ── Assembly ────────────────────────────────────────────────────────────────

function ladderByKey(key) {
  const found = LADDERS.find((l) => l.key === key)
  if (!found) {
    throw new Error(`no ladder named ${key} in ladders.config.mjs`)
  }
  return found
}

function renderLadders(defaults) {
  const blocks = []
  for (const ladder of LADDERS) {
    const steps = ladderSteps(ladder)
    if (steps.length === 0) {
      continue
    }
    blocks.push(`${IND}<!-- ${ladder.title}: ${steps.length} step(s) -->`)
    for (const step of steps) {
      if (ladder.key === 'journey') {
        blocks.push(journeyStep(step, defaults))
      } else if (ladder.key === 'revalidate') {
        blocks.push(revalidateStep(step, defaults))
      } else if (ladder.key === 'pi') {
        blocks.push(piStep(step, defaults))
      } else if (ladder.key === 'edit') {
        blocks.push(editStep(step, { contention: false }, defaults))
      } else if (ladder.key === 'editContention') {
        blocks.push(editStep(step, { contention: true }, defaults))
      } else {
        throw new Error(`gen-scenario has no renderer for ladder "${ladder.key}"`)
      }
    }
  }
  blocks.push(`${IND}<!-- Single-project fetch ramp -->`)
  blocks.push(fetchRampGroup(defaults))
  blocks.push(`${IND}<!-- Mixed workload -->`)
  blocks.push(mixedWorkloadGroup(defaults))
  return blocks.join('\n')
}
/**
 * The step lists and every profile's resolved schedule, as a sourceable sh
 * fragment.
 *
 * entrypoint.sh reads its thread counts and windows straight out of this, so
 * the shell never re-derives what `windowSeconds` already decided and the two
 * cannot disagree. What the shell DOES still do is accumulate the delays, so
 * changing PHASE_GAP_SECONDS or overriding one window still slides everything
 * after it — the "set durations, not delays" contract the plan already had.
 *
 * Space-separated lists, because POSIX sh iterates those natively and this file
 * has to stay readable by `sh` with no tooling in front of it.
 */
function renderLaddersSh() {
  const out = [
    '# Generated by scripts/gen-scenario.mjs from scenarios/ladders.config.mjs.',
    '# Do not edit by hand — `npm run gen-scenario` rewrites it, and',
    '# `npm run check-scenario` fails if it is stale.',
    '#',
    '# Sourced by entrypoint.sh. For the active PERF_PROFILE it supplies, per',
    '# phase, the thread count and the window; entrypoint.sh accumulates those',
    '# into absolute start delays, which is the one piece of arithmetic that has',
    '# to stay at run time so an operator can still change a duration and have',
    '# the timeline follow.',
    '',
    `PERF_PROFILE_NAMES="${Object.keys(PROFILES).join(' ')}"`,
    `PERF_PROFILE_DEFAULT="${DEFAULT_PROFILE}"`,
    `LADDER_SIZES="${SIZE_LABELS.join(' ')}"`,
    `MIXED_THREADS_DEFAULT=${MIXED_THREADS}`,
    `PHASE_GAP_SECONDS_DEFAULT=${DEFAULT_PHASE_GAP_SECONDS}`,
    `SETUP_ALLOWANCE_SECONDS_DEFAULT=${SETUP_ALLOWANCE_SECONDS}`,
    '',
    '# Seconds allowed per fetch of each size. The fetch ramp is loop-count',
    '# driven, so entrypoint.sh re-derives its window from these after staging:',
    '# a size with no prepared project runs no loops, and the window it would',
    '# have needed is handed back to the run rather than spent on dead air.',
    ...SIZE_LABELS.map(
      (size) =>
        `FETCH_SECONDS_PER_ITERATION_${size}=${FETCH_RAMP.secondsPerIteration[size]}`
    ),
    '',
    '# Every phase key the plan has a thread group for, whether or not a given',
    '# profile runs it. entrypoint.sh zeroes the ones its profile leaves out.',
    `ALL_PHASE_KEYS="${allPhaseKeys().join(' ')}"`,
    ''
  ]

  for (const [name, profile] of Object.entries(PROFILES)) {
    const phases = profilePhases(name)
    const budget = budgetCheck(name)
    out.push(`# ── ${name} — ${profile.description}`)
    out.push(
      `#    ${phases.length} phase(s); plan ${runSeconds(name)}s` +
        (budget
          ? `, budget ${profile.budgetMinutes} min (projected ${budget.projectedSeconds}s incl. ~${SETUP_ALLOWANCE_SECONDS}s setup)`
          : ', no budget')
    )
    out.push(`PROFILE_BUDGET_SECONDS_${name}=${budget ? budget.limitSeconds : 0}`)
    out.push(`PROFILE_PLAN_SECONDS_${name}=${runSeconds(name)}`)
    out.push(`PROFILE_PHASES_${name}="${phases.map((p) => p.key).join(' ')}"`)
    for (const phase of phases) {
      out.push(`PROFILE_WINDOW_${name}_${phase.key}=${phase.window}`)
      // Per-phase, because the drain a phase needs is about one in-flight
      // request — five seconds after a one-second edit is four seconds of
      // nothing, and across a 21-phase run that adds up to real wall clock.
      out.push(`PROFILE_GAP_${name}_${phase.key}=${phase.gap}`)
      if (phase.users !== null) {
        out.push(`PROFILE_USERS_${name}_${phase.key}=${phase.users}`)
      }
    }
    if (profile.fetchRamp) {
      for (const size of SIZE_LABELS) {
        out.push(
          `PROFILE_FETCH_LOOPS_${name}_${size}=${Math.max(1, Math.round(FETCH_RAMP.loops[size] * profile.targetScale))}`
        )
      }
    }
    // The size ramp sits in front of every ladder, so its depth belongs to the
    // profile — ladders.config.mjs stays the one place run length is decided.
    for (const size of SIZE_LABELS) {
      out.push(`PROFILE_SIZE_LOOPS_${name}_${size}=${profile.sizeRampLoops[size]}`)
    }
    out.push('')
  }
  return out.join('\n')
}

const SECONDS_PER_MINUTE = 60

/** Every phase key in the plan, ladder steps first, in timeline order. */
function allPhaseKeys() {
  const keys = LADDERS.flatMap((ladder) => ladderSteps(ladder).map(stepKey))
  return [...keys, 'fetchRamp', 'mixed']
}

/**
 * The defaults baked into the committed .jmx: the standard profile, written
 * out.
 *
 * The plan already held its schedule twice over — once derived by entrypoint.sh
 * and once as the `${__P(name,default)}` fallbacks, so that driving `jmeter -t`
 * directly still produced a coherent run. Keeping that promise across 53 steps
 * means generating the fallbacks rather than typing them, which is what this
 * does. A phase the standard profile does not run defaults to zero threads:
 * present in the plan, costing nothing.
 */
function defaultsForJmx() {
  const scheduled = scheduleFrom(
    profilePhases(DEFAULT_PROFILE),
    generatedBlockStartSeconds(DEFAULT_PROFILE)
  )
  const byKey = new Map(scheduled.map((phase) => [phase.key, phase]))
  return {
    // `mixed` has no user count of its own in the ladder tables — it is a
    // workload, not a staircase step — so it takes the configured thread count
    // when the profile runs it and zero when it does not.
    usersFor: (key) =>
      key === 'mixed'
        ? (byKey.has('mixed') ? MIXED_THREADS : 0)
        : (byKey.get(key)?.users ?? 0),
    windowFor: (key) => byKey.get(key)?.window ?? 30,
    delayFor: (key) => byKey.get(key)?.delay ?? 0,
    fetchLoopsFor: (size) =>
      byKey.has('fetchRamp')
        ? Math.max(
            1,
            Math.round(
              FETCH_RAMP.loops[size] * PROFILES[DEFAULT_PROFILE].targetScale
            )
          )
        : 0,
    /** Wall clock the standard profile spends, for the header comment. */
    endsAt: runSeconds(DEFAULT_PROFILE)
  }
}
function spliceGenerated(jmx, generated) {
  const begin = jmx.indexOf(BEGIN_MARKER)
  const end = jmx.indexOf(END_MARKER)
  if (begin === -1 || end === -1) {
    throw new Error(
      `could not find the generated-section markers in ${JMX_PATH}. ` +
        'They delimit the block this script owns; restore them from git rather ' +
        'than regenerating the whole plan.'
    )
  }
  if (end < begin) {
    throw new Error('the END marker precedes the BEGIN marker — the .jmx is corrupt')
  }
  return (
    jmx.slice(0, begin) +
    BEGIN_MARKER +
    '\n' +
    generated +
    '\n' +
    jmx.slice(end)
  )
}

function main() {
  const check = process.argv.includes('--check')
  const defaults = defaultsForJmx()
  const jmx = readFileSync(JMX_PATH, 'utf8')
  const nextJmx = spliceGenerated(jmx, renderLadders(defaults))
  const nextSh = renderLaddersSh()
  const currentSh = (() => {
    try {
      return readFileSync(LADDERS_SH_PATH, 'utf8')
    } catch {
      return null
    }
  })()

  if (check) {
    const stale = []
    if (nextJmx !== jmx) {
      stale.push('scenarios/bng-perf.jmx')
    }
    if (nextSh !== currentSh) {
      stale.push('scenarios/ladders.sh')
    }
    if (stale.length > 0) {
      process.stderr.write(
        `out of date with scenarios/ladders.config.mjs: ${stale.join(', ')}\n` +
          'Run `npm run gen-scenario` and commit the result.\n'
      )
      process.exit(1)
    }
    process.stdout.write('scenario is up to date with ladders.config.mjs\n')
    return
  }

  writeFileSync(JMX_PATH, nextJmx)
  writeFileSync(LADDERS_SH_PATH, nextSh)

  const stepCount = LADDERS.reduce((n, l) => n + ladderSteps(l).length, 0)
  const minutes = (defaults.endsAt / SECONDS_PER_MINUTE).toFixed(1)
  process.stdout.write(
    `wrote ${stepCount} ladder step(s) + the fetch ramp and mixed workload into\n` +
      `  scenarios/bng-perf.jmx\n  scenarios/ladders.sh\n` +
      `defaults baked in are the '${DEFAULT_PROFILE}' profile — a direct ` +
      `\`jmeter -t\` run ends at ~${minutes} min\n`
  )
}

main()

export { renderLadders, renderLaddersSh, defaultsForJmx, ladderByKey }

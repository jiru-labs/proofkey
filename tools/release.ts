// Ship a new version to the Chrome Web Store.
//
//     npm run release -- 0.1.1          bump, verify, build, zip, upload, publish
//     npm run release -- 0.1.1 --dry    everything up to the zip; nothing leaves the machine
//     npm run release -- 0.1.1 --draft  upload but do not submit for review
//
// The store rejects a package whose version is not strictly greater than the
// published one, so the bump is the first thing checked and the first thing done.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { readEnv, requireKeys } from './env.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const MANIFEST = `${ROOT}/public/manifest.json`
const PACKAGE = `${ROOT}/package.json`

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const draft = args.includes('--draft')
const version = args.find((a) => !a.startsWith('-'))

if (!version) {
  console.error('Usage: npm run release -- <version> [--dry] [--draft]')
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`"${version}" is not a three-part version, which is what the store expects.`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const current: string = manifest.version

const rank = (v: string) => v.split('.').map(Number)
const isGreater = (a: string, b: string) => {
  const [x, y] = [rank(a), rank(b)]
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i]
  }
  return false
}
if (!isGreater(version, current)) {
  console.error(`Version must climb: ${current} is already in the manifest, ${version} is not higher.`)
  process.exit(1)
}

const step = (msg: string) => console.log(`\n\x1b[1m${msg}\x1b[0m`)
const run = (cmd: string, cmdArgs: string[]) =>
  execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' })

// test:render drives a page served over http, so verify only passes with the
// static server up. Start one if the port is bare, and take it down again after
// — a release must not leave a listener behind.
const SERVE_URL = 'http://127.0.0.1:8777'
const isServing = async () => {
  try {
    await fetch(SERVE_URL, { signal: AbortSignal.timeout(700) })
    return true
  } catch {
    return false
  }
}

let server: ChildProcess | null = null
if (await isServing()) {
  console.log(`Reusing the server already on ${SERVE_URL}`)
} else {
  step(`Starting a static server on ${SERVE_URL}`)
  server = spawn('python3', ['-m', 'http.server', '8777', '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
  })
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(100)
    up = await isServing()
  }
  if (!up) {
    server.kill()
    console.error(`Could not get a server up on ${SERVE_URL}`)
    process.exit(1)
  }
}
const stopServer = () => {
  if (server && !server.killed) {
    server.kill()
    server = null
  }
}
process.on('exit', stopServer)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopServer()
    process.exit(1)
  })
}

const originals = new Map<string, string>()
step(`Bumping ${current} -> ${version}`)
for (const file of [MANIFEST, PACKAGE]) {
  const raw = readFileSync(file, 'utf8')
  originals.set(file, raw)
  // Textual replace, not JSON.stringify — it keeps the file's own formatting.
  const next = raw.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`)
  if (next === raw) {
    console.error(`Could not find a version field to rewrite in ${file}`)
    process.exit(1)
  }
  writeFileSync(file, next)
}

// Leave the tree as we found it, so a failed release is not a half-bumped
// repo. Every exit after the bump goes through here: a rejected upload used to
// leave the manifest reading a version that had shipped nowhere, which is the
// state this whole dance exists to avoid.
const rollBack = (why: string): never => {
  for (const [file, raw] of originals) writeFileSync(file, raw)
  stopServer()
  console.error(`\n${why} — rolled the version back to ${current}.`)
  process.exit(1)
}

step('Running the full verify suite')
try {
  run('npm', ['run', 'verify'])
} catch {
  rollBack('verify failed, and nothing was sent')
}
stopServer()

step('Packaging dist/')
const zipPath = `${ROOT}/proofkey-${version}.zip`
rmSync(zipPath, { force: true })
// -r recurse, -q quiet, -X drop platform extras the store does not want.
execFileSync('zip', ['-rqX', zipPath, '.'], { cwd: `${ROOT}/dist`, stdio: 'inherit' })
const bytes = statSync(zipPath).size
console.log(`${zipPath}  (${(bytes / 1024).toFixed(1)} KiB)`)

if (dry) {
  // Put the version back: a dry run that leaves the tree bumped would make the
  // real release refuse the same number as "not higher".
  for (const [file, raw] of originals) writeFileSync(file, raw)
  step('--dry: stopping before upload. Nothing was sent to Google.')
  console.log(`The zip holds ${version}; the working tree is back at ${current}.`)
  process.exit(0)
}

const env = readEnv()
requireKeys(env, ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_ITEM_ID'])

step('Getting an access token')
const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: env.CWS_CLIENT_ID,
    client_secret: env.CWS_CLIENT_SECRET,
    refresh_token: env.CWS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }),
})
const tokenBody = (await tokenResponse.json()) as { access_token?: string }
if (!tokenResponse.ok || !tokenBody.access_token) {
  console.error('Could not refresh the access token:', JSON.stringify(tokenBody, null, 2))
  console.error('\nIf this says invalid_grant, the refresh token was revoked. Re-run: npm run token')
  process.exit(1)
}
const accessToken = tokenBody.access_token
const auth = { Authorization: `Bearer ${accessToken}`, 'x-goog-api-version': '2' }

step('Uploading the package')
const uploadResponse = await fetch(
  `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${env.CWS_ITEM_ID}`,
  { method: 'PUT', headers: auth, body: readFileSync(zipPath) },
)
const upload = (await uploadResponse.json()) as {
  uploadState?: string
  itemError?: { error_detail?: string }[]
}
if (upload.uploadState !== 'SUCCESS') {
  console.error('Upload rejected:', JSON.stringify(upload, null, 2))
  // The store refuses a package while one is already in review — the error code
  // is ITEM_NOT_UPDATABLE. Unlike a listing edit, a package does not fold into
  // the pending submission: wait for the public listing to show the version in
  // review, then run this again.
  rollBack('the store refused the upload')
}
console.log(`uploadState: ${upload.uploadState}`)

if (draft) {
  step('--draft: uploaded but not submitted. Submit from the dashboard when ready.')
  process.exit(0)
}

step('Submitting for review')
const publishResponse = await fetch(
  `https://www.googleapis.com/chromewebstore/v1.1/items/${env.CWS_ITEM_ID}/publish`,
  { method: 'POST', headers: { ...auth, 'content-length': '0' } },
)
const publish = (await publishResponse.json()) as { status?: string[]; statusDetail?: string[] }
if (!publishResponse.ok) {
  console.error('Publish rejected:', JSON.stringify(publish, null, 2))
  // The package is uploaded but unsubmitted at this point, which is exactly the
  // --draft state, so the version stays bumped and only the submit is retried.
  console.error(`\nThe ${version} package is uploaded as a draft. Submit it from the dashboard.`)
  process.exit(1)
}
console.log((publish.statusDetail ?? publish.status ?? []).join('\n'))

step(`v${version} is with the reviewers.`)
console.log('It goes live automatically once it passes. Commit the version bump and tag:')
console.log(`  git commit -am "Release v${version}" && git tag v${version}`)

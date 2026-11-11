// Ship a package to Microsoft Edge Add-ons through its Update REST API (v1.1).
//
//     npm run edge -- credentials        prompt for Client ID + API key, write .env, then check
//     npm run edge -- check              do the credentials authenticate? days until the key expires
//     npm run edge -- parity             Chrome live vs Edge live vs public/manifest.json
//     npm run edge -- publish 0.1.22     upload proofkey-0.1.22.zip, then submit it for certification
//     npm run edge -- publish 0.1.22 --draft   upload only; submit later from Partner Center
//
// The API only updates a product that already exists: it cannot create one, and
// it cannot touch listing metadata (description, screenshots), which stay in
// Partner Center. Reference:
// https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api
//
// Publishing is the maintainer's: like `npm run release`, `publish` sends a build
// to a public store and is never run by an assistant on its own.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { readEnv, writeEnvValue, requireKeys } from './env.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const API = 'https://api.addons.microsoftedge.microsoft.com'
// Partner Center product id (not secret; it is in the dashboard URL). The CRX id
// is the public one in the store URL, and Partner Center shows it under
// "Extension identity"; until the first submission is live it is unknown.
const PRODUCT_ID = 'ba61a1de-d6ad-4e45-9c65-9fdc1b3aa800'

const [command, ...rest] = process.argv.slice(2)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function headers(env: Record<string, string>): Record<string, string> {
  requireKeys(env, ['EDGE_CLIENT_ID', 'EDGE_API_KEY'])
  return { Authorization: `ApiKey ${env.EDGE_API_KEY}`, 'X-ClientID': env.EDGE_CLIENT_ID }
}

function product(env: Record<string, string>): string {
  return env.EDGE_PRODUCT_ID || PRODUCT_ID
}

/** Prompt on the terminal; with `hidden`, nothing typed is echoed or kept. */
async function ask(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('needs a terminal: run it in an interactive shell')
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (hidden) {
    // readline echoes through _writeToOutput; silence it after the prompt.
    const out = rl as unknown as { _writeToOutput: (s: string) => void }
    let prompted = false
    out._writeToOutput = (s: string) => {
      if (!prompted) {
        process.stdout.write(s)
        prompted = true
      }
    }
  }
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve))
  rl.close()
  if (hidden) process.stdout.write('\n')
  return answer.trim()
}

function daysLeft(env: Record<string, string>): number | null {
  const at = env.EDGE_API_KEY_EXPIRES
  if (!at || !/^\d{4}-\d{2}-\d{2}$/.test(at)) return null
  return Math.floor((Date.parse(`${at}T00:00:00Z`) - Date.now()) / 86_400_000)
}

/**
 * Authenticate without changing anything: ask for the status of an operation
 * that cannot exist. A key that is refused gets 401; a key that is accepted gets
 * past auth and is told the operation is not found (404, per the reference's
 * error table). That reading is from the docs; the first real run measures it.
 */
async function check(env: Record<string, string>): Promise<boolean> {
  const url = `${API}/v1/products/${product(env)}/submissions/operations/00000000-0000-0000-0000-000000000000`
  const res = await fetch(url, { headers: headers(env) })
  const body = (await res.text()).slice(0, 300)
  const left = daysLeft(env)
  console.log(`probe        : HTTP ${res.status} ${body ? `— ${body}` : ''}`)
  console.log(
    `key expires  : ${env.EDGE_API_KEY_EXPIRES ?? '(EDGE_API_KEY_EXPIRES not set)'}` +
      (left === null ? '' : ` (${left} days)`),
  )
  if (res.status === 401 || res.status === 403) {
    console.error('The API key or Client ID was refused. Renew it: Partner Center → Microsoft Edge → Publish API.')
    return false
  }
  if (left !== null && left <= 14) console.error(`The API key expires in ${left} days: renew it now.`)
  return res.status < 500
}

function chromeLive(): string | null {
  const out = execFileSync('python3', [`${ROOT}/.claude/skills/proofkey-store/scripts/live.py`], {
    encoding: 'utf8',
  })
  return out.match(/^version live : (\d+\.\d+\.\d+)/m)?.[1] ?? null
}

/** The public Edge store JSON; no credentials. Null until the CRX id is known. */
async function edgeLive(env: Record<string, string>): Promise<string | null> {
  const crx = env.EDGE_CRX_ID
  if (!crx) return null
  const res = await fetch(`https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/${crx}`)
  if (!res.ok) return null
  const body = (await res.json()) as { version?: string }
  return body.version ?? null
}

async function parity(env: Record<string, string>): Promise<boolean> {
  const manifest = JSON.parse(readFileSync(`${ROOT}/public/manifest.json`, 'utf8')).version as string
  const chrome = chromeLive()
  const edge = await edgeLive(env)
  console.log(`manifest     : ${manifest}`)
  console.log(`chrome live  : ${chrome ?? '(not read)'}`)
  console.log(`edge live    : ${edge ?? (env.EDGE_CRX_ID ? '(not listed yet)' : '(EDGE_CRX_ID not set)')}`)
  const same = chrome !== null && chrome === edge
  console.log(same ? 'parity       : OK' : 'parity       : DIFFERENT — Edge should get the version live on Chrome')
  return same
}

async function poll(url: string, h: Record<string, string>, what: string) {
  // Upload validation takes seconds; certification takes days and is not polled
  // here — this only waits for the API to accept or refuse the operation.
  for (let i = 0; i < 60; i++) {
    const res = await fetch(url, { headers: h })
    const body = (await res.json()) as { status?: string; message?: string; errorCode?: string; errors?: unknown }
    if (body.status && body.status !== 'InProgress') return body
    if (!res.ok && res.status !== 202) return { status: 'Failed', message: `HTTP ${res.status}`, ...body }
    await sleep(5000)
  }
  return { status: 'Failed', message: `${what} still InProgress after 5 minutes` }
}

async function publish(env: Record<string, string>) {
  const version = rest.find((a) => !a.startsWith('-'))
  const draft = rest.includes('--draft')
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('Usage: npm run edge -- publish <version> [--draft]')
    process.exit(1)
  }
  const zip = `${ROOT}/proofkey-${version}.zip`
  if (!existsSync(zip)) {
    console.error(`${zip} is missing. It is the zip \`npm run release\` built for Chrome; Edge gets the same bytes.`)
    process.exit(1)
  }
  const inZip = execFileSync(
    'python3',
    ['-c', 'import json,sys,zipfile; print(json.loads(zipfile.ZipFile(sys.argv[1]).read("manifest.json"))["version"])', zip],
    { encoding: 'utf8' },
  ).trim()
  if (inZip !== version) {
    console.error(`${zip} carries manifest version ${inZip}, not ${version}.`)
    process.exit(1)
  }
  // Parity rule: Edge gets what Chrome has already approved, never a build still
  // in Chrome review, so both stores describe the same package.
  const chrome = chromeLive()
  if (chrome !== version) {
    console.error(`Chrome has ${chrome ?? '(unreadable)'} live, not ${version}. Ship to Edge once Chrome approves it.`)
    process.exit(1)
  }
  const h = headers(env)
  const id = product(env)

  console.log(`Uploading ${zip}`)
  const up = await fetch(`${API}/v1/products/${id}/submissions/draft/package`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/zip' },
    body: readFileSync(zip),
  })
  const upOp = up.headers.get('location')
  if (up.status !== 202 || !upOp) {
    console.error(`Upload refused: HTTP ${up.status} ${await up.text()}`)
    process.exit(1)
  }
  const upResult = await poll(`${API}/v1/products/${id}/submissions/draft/package/operations/${upOp}`, h, 'upload')
  console.log(JSON.stringify(upResult, null, 2))
  if (upResult.status !== 'Succeeded') process.exit(1)

  if (draft) {
    console.log('--draft: the package is in the Partner Center draft; nothing was submitted.')
    return
  }

  // The guide says JSON {"notes": ...}; the reference says plain text. JSON is
  // what the guide's own sample sends, so that is what this sends.
  const notes = certificationNotes()
  console.log('Submitting for certification')
  const pub = await fetch(`${API}/v1/products/${id}/submissions`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  })
  const pubOp = pub.headers.get('location')
  if (pub.status !== 202 || !pubOp) {
    console.error(`Submit refused: HTTP ${pub.status} ${await pub.text()}`)
    console.error('The package is uploaded as a draft; submit it from Partner Center or run publish again.')
    process.exit(1)
  }
  const pubResult = await poll(`${API}/v1/products/${id}/submissions/operations/${pubOp}`, h, 'submit')
  console.log(JSON.stringify(pubResult, null, 2))
  // InProgressSubmission: a submission is already in certification. Like Chrome's
  // ITEM_NOT_UPDATABLE, wait for it to finish; releases are serial on both stores.
  if (pubResult.status !== 'Succeeded') process.exit(1)
  console.log(`v${version} is in Edge certification (up to 7 business days). Check: npm run edge -- parity`)
}

/** The "Notes for certification" paragraph kept in the store copy. */
function certificationNotes(): string {
  const copy = readFileSync(`${ROOT}/.claude/skills/proofkey-store/copy/edge-addons.md`, 'utf8')
  const m = copy.match(/- Notes for certification: "([\s\S]+?)"\n/)
  if (!m) throw new Error('No "Notes for certification" paragraph in copy/edge-addons.md')
  return m[1].replace(/\s+/g, ' ').trim()
}

async function credentials() {
  console.log('Partner Center → Microsoft Edge → Publish API. The key is not echoed and goes only to .env.')
  const clientId = await ask('Client ID: ')
  const apiKey = await ask('API key (hidden): ', true)
  const expires = await ask('API key expiry date shown on that page (YYYY-MM-DD): ')
  const crx = await ask('CRX ID from Extension identity (Enter to skip): ')
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error('that Client ID is not a GUID; nothing was written')
  if (apiKey.length < 16) throw new Error('that API key is too short; nothing was written')
  writeEnvValue('EDGE_CLIENT_ID', clientId)
  writeEnvValue('EDGE_API_KEY', apiKey)
  if (/^\d{4}-\d{2}-\d{2}$/.test(expires)) writeEnvValue('EDGE_API_KEY_EXPIRES', expires)
  if (/^[a-p]{32}$/.test(crx)) writeEnvValue('EDGE_CRX_ID', crx)
  console.log('Written to .env. Checking them:')
  process.exit((await check(readEnv())) ? 0 : 1)
}

const env = readEnv()
if (command === 'credentials') await credentials()
else if (command === 'check') process.exit((await check(env)) ? 0 : 1)
else if (command === 'parity') process.exit((await parity(env)) ? 0 : 1)
else if (command === 'publish') await publish(env)
else {
  console.error('Usage: npm run edge -- credentials | check | parity | publish <version> [--draft]')
  process.exit(1)
}

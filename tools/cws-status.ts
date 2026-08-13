// What does the store currently think of our item?
//
//     npm run status
//
// Read-only. Also the cheapest way to prove the credentials in .env still work
// without uploading anything.
import { readEnv, requireKeys } from './env.ts'

const env = readEnv()
requireKeys(env, ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_ITEM_ID'])

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
const tokenBody = (await tokenResponse.json()) as { access_token?: string; error?: string }
if (!tokenResponse.ok || !tokenBody.access_token) {
  console.error('Could not refresh the access token:', JSON.stringify(tokenBody, null, 2))
  console.error('\nIf this says invalid_grant, the token was revoked. Re-run: npm run token')
  process.exit(1)
}
console.log('credentials: ok')

const itemResponse = await fetch(
  `https://www.googleapis.com/chromewebstore/v1.1/items/${env.CWS_ITEM_ID}?projection=DRAFT`,
  {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      'x-goog-api-version': '2',
    },
  },
)
const item = (await itemResponse.json()) as {
  id?: string
  crxVersion?: string
  uploadState?: string
  itemError?: { error_detail?: string }[]
}
if (!itemResponse.ok) {
  console.error('Item lookup failed:', JSON.stringify(item, null, 2))
  process.exit(1)
}

console.log(`item:        ${item.id}`)
console.log(`draft crx:   ${item.crxVersion ?? '(none)'}`)
console.log(`uploadState: ${item.uploadState}`)
for (const err of item.itemError ?? []) {
  console.log(`  ! ${err.error_detail}`)
}

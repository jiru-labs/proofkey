// Submit the package already uploaded to the store for review.
//
//     npm run submit
//
// For when `npm run release` uploaded the package but the submit step was
// refused — a draft from `--draft`, or a publish condition the store failed on
// its side ("Privacy policy link is not reachable" on 2026-10-07, with the link
// answering 200). Uploads nothing and bumps nothing: `npm run status` shows
// which version the draft holds.
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
const tokenBody = (await tokenResponse.json()) as { access_token?: string }
if (!tokenResponse.ok || !tokenBody.access_token) {
  console.error('Could not refresh the access token:', JSON.stringify(tokenBody, null, 2))
  console.error('\nIf this says invalid_grant, the refresh token was revoked. Re-run: npm run token')
  process.exit(1)
}

const publishResponse = await fetch(
  `https://www.googleapis.com/chromewebstore/v1.1/items/${env.CWS_ITEM_ID}/publish`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      'x-goog-api-version': '2',
      'content-length': '0',
    },
  },
)
const publish = (await publishResponse.json()) as { status?: string[]; statusDetail?: string[] }
if (!publishResponse.ok) {
  console.error('Publish rejected:', JSON.stringify(publish, null, 2))
  process.exit(1)
}
console.log((publish.statusDetail ?? publish.status ?? []).join('\n'))
console.log('\nThe draft is with the reviewers.')

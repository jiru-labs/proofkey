// Mint the Chrome Web Store refresh token. Run once, by hand:
//
//     npm run token
//
// Google shut down the copy-paste "OOB" flow in 2022, so the code comes back
// over a loopback redirect. A Desktop-app OAuth client accepts any
// http://127.0.0.1:<port>, so this listens on an ephemeral port and registers
// whatever it gets. The token is written straight into .env.
//
// The consent screen is published In production, so the token does not expire
// on a timer. It dies only if it is revoked, or unused for six months.
import { createServer } from 'node:http'
import { readEnv, writeEnvValue, requireKeys } from './env.ts'

const SCOPE = 'https://www.googleapis.com/auth/chromewebstore'

const env = readEnv()
requireKeys(env, ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET'])

const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
  (resolve, reject) => {
    let redirectUri = ''
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><meta charset="utf-8">` +
          `<body style="font:16px/1.5 system-ui;max-width:32rem;margin:4rem auto">` +
          `<h1>${error ? 'Denied' : 'Authorised'}</h1>` +
          `<p>${
            error
              ? `Google returned <code>${error}</code>. Nothing was written.`
              : 'Refresh token captured. Close this tab and go back to the terminal.'
          }</p>`,
      )
      server.close()
      if (error) reject(new Error(`consent denied: ${error}`))
      else if (!code) reject(new Error('no code in the redirect'))
      else resolve({ code, redirectUri })
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('could not read the loopback port'))
        return
      }
      redirectUri = `http://127.0.0.1:${address.port}`
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.searchParams.set('client_id', env.CWS_CLIENT_ID)
      auth.searchParams.set('redirect_uri', redirectUri)
      auth.searchParams.set('response_type', 'code')
      auth.searchParams.set('scope', SCOPE)
      // Without both of these Google returns an access token and no refresh
      // token on any consent after the first.
      auth.searchParams.set('access_type', 'offline')
      auth.searchParams.set('prompt', 'consent')

      console.log('\nOpen this and approve as the account that owns the publisher:\n')
      console.log(auth.toString())
      console.log(
        '\nThe "Google hasn\'t verified this app" screen is expected — it is your own\n' +
          'app, and the scope is unverified by design. Advanced -> Go to ProofKey Release.\n',
      )
    })
  },
)

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: env.CWS_CLIENT_ID,
    client_secret: env.CWS_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }),
})

const token = (await response.json()) as { refresh_token?: string }
if (!response.ok || !token.refresh_token) {
  console.error('Token exchange failed:', JSON.stringify(token, null, 2))
  process.exit(1)
}

writeEnvValue('CWS_REFRESH_TOKEN', token.refresh_token)
console.log('CWS_REFRESH_TOKEN written to .env. You can now run: npm run release -- <version>')

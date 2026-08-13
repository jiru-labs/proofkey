// Read .env without a dependency. Values are literal to end of line; no quoting,
// no interpolation — the file only ever holds Chrome Web Store credentials.
import { readFileSync, writeFileSync } from 'node:fs'

const ENV_PATH = new URL('../.env', import.meta.url)

export function readEnv(): Record<string, string> {
  let raw: string
  try {
    raw = readFileSync(ENV_PATH, 'utf8')
  } catch {
    throw new Error('.env is missing. See the store-release section of README.md.')
  }
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/** Rewrite one key in place, keeping comments and ordering intact. */
export function writeEnvValue(key: string, value: string): void {
  const raw = readFileSync(ENV_PATH, 'utf8')
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  const line = `${key}=${value}`
  const next = pattern.test(raw)
    ? raw.replace(pattern, line)
    : `${raw.replace(/\n*$/, '')}\n${line}\n`
  writeFileSync(ENV_PATH, next)
}

/** Fail loudly and early rather than sending a half-formed request to Google. */
export function requireKeys(env: Record<string, string>, keys: string[]): void {
  const missing = keys.filter((k) => !env[k])
  if (missing.length) {
    throw new Error(`.env is missing a value for: ${missing.join(', ')}`)
  }
}

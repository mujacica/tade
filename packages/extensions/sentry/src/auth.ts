import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Where Sentry credentials already are on a machine, so using Sentry from
// Wilco needs nothing new when you already use it from a terminal.
//
// In order: what Wilco's config says; the environment sentry-cli reads
// (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_URL`); a `.sentryclirc` in a
// project or your home; and the login the newer `sentry` CLI keeps. Nothing is
// ever written back to any of them, and a token is never shown.

export interface SentryAccess {
  token: string
  org: string
  /** The Sentry to talk to: `https://sentry.io`, or your own. */
  url: string
  /** Where the token came from, as you would look for it. */
  from: string
}

interface Found {
  token?: { value: string; from: string }
  org?: string
  url?: string
}

/** An INI file's `[section] key = value` pairs, as `section.key`. */
export function readIni(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const heading = /^\[(.+)\]$/.exec(line)
    if (heading?.[1]) {
      section = heading[1].trim()
      continue
    }
    const pair = /^([^=]+)=(.*)$/.exec(line)
    if (pair?.[1]) out[`${section}.${pair[1].trim()}`] = (pair[2] ?? '').trim()
  }
  return out
}

/** `.sentryclirc` files from nearest to furthest: up from each folder, then the home directory. */
function sentryclircs(
  folders: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const out: string[] = []
  for (const folder of folders) {
    let dir = folder
    for (;;) {
      out.push(join(dir, '.sentryclirc'))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  if (env.SENTRY_CONFIG_DIR) out.push(join(env.SENTRY_CONFIG_DIR, '.sentryclirc'))
  if (env.HOME) out.push(join(env.HOME, '.sentryclirc'))
  return [...new Set(out)]
}

function fromSentryclirc(
  folders: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Found {
  const found: Found = {}
  for (const path of sentryclircs(folders, env)) {
    let values: Record<string, string>
    try {
      values = readIni(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (!found.token && values['auth.token'])
      found.token = { value: values['auth.token'], from: path }
    found.org ??= values['defaults.org']
    found.url ??= values['defaults.url']
  }
  return found
}

type Sqlite = new (
  path: string,
  options: { readonly: boolean; fileMustExist: boolean },
) => {
  prepare(sql: string): { get(): unknown }
  close(): void
}

/** The login the newer `sentry` CLI keeps, when it has one that has not expired. */
function fromSentryCli(env: Readonly<Record<string, string | undefined>>, now: number): Found {
  const dirs = [
    env.SENTRY_CONFIG_DIR,
    env.HOME ? join(env.HOME, '.sentry') : undefined,
    env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'sentry') : undefined,
    env.HOME ? join(env.HOME, '.config', 'sentry') : undefined,
  ].filter((dir): dir is string => Boolean(dir))
  let Database: Sqlite
  try {
    Database = createRequire(import.meta.url)('better-sqlite3') as Sqlite
  } catch {
    return {}
  }
  for (const dir of dirs) {
    const path = join(dir, 'cli.db')
    try {
      const db = new Database(path, { readonly: true, fileMustExist: true })
      try {
        const auth = db.prepare('SELECT token, host, expires_at FROM auth WHERE id = 1').get() as
          | { token?: string; host?: string; expires_at?: number | null }
          | undefined
        const meta = (key: string) =>
          (
            db.prepare(`SELECT value FROM metadata WHERE key = '${key}'`).get() as
              | { value?: string }
              | undefined
          )?.value
        const fresh = auth?.token && (!auth.expires_at || auth.expires_at > now + 60_000)
        const org = safely(() => meta('defaults.org'))
        const url = safely(() => meta('defaults.url')) ?? auth?.host
        return {
          ...(fresh && auth?.token
            ? { token: { value: auth.token, from: `the sentry CLI's login (${path})` } }
            : {}),
          ...(org ? { org } : {}),
          ...(url ? { url } : {}),
        }
      } finally {
        db.close()
      }
    } catch {
      // Not there, or not a database we can read.
    }
  }
  return {}
}

/**
 * Credentials to reach Sentry with, or what is missing, said so it can be
 * fixed. `folders` are the projects' own, where a `.sentryclirc` may be.
 */
export function findAccess(options: {
  settings: Readonly<Record<string, unknown>>
  env: Readonly<Record<string, string | undefined>>
  folders: readonly string[]
  now: number
}): SentryAccess | { problem: string } {
  const { settings, env } = options
  const text = (key: string) =>
    typeof settings[key] === 'string' && settings[key] !== '' ? String(settings[key]) : undefined
  const tokenVariable = text('token_env')
  const fromEnv = tokenVariable
    ? env[tokenVariable]
      ? { value: env[tokenVariable] as string, from: `$${tokenVariable}` }
      : undefined
    : env.SENTRY_AUTH_TOKEN
      ? { value: env.SENTRY_AUTH_TOKEN, from: '$SENTRY_AUTH_TOKEN' }
      : env.SENTRY_TOKEN
        ? { value: env.SENTRY_TOKEN, from: '$SENTRY_TOKEN' }
        : undefined
  const rc = fromSentryclirc(options.folders, env)
  const cli = fromSentryCli(env, options.now)
  const token = fromEnv ?? rc.token ?? cli.token
  const org = text('org') ?? env.SENTRY_ORG ?? rc.org ?? cli.org
  const url = (
    text('url') ??
    env.SENTRY_HOST ??
    env.SENTRY_URL ??
    rc.url ??
    cli.url ??
    'https://sentry.io'
  ).replace(/\/+$/, '')
  if (!token) {
    return {
      problem: `no Sentry token: set ${tokenVariable ? `$${tokenVariable}` : '$SENTRY_AUTH_TOKEN'} to a user auth token (org:read, project:read, event:read, event:write), or log in with sentry-cli`,
    }
  }
  if (!org)
    return { problem: 'which Sentry organization? set extensions.sentry.org, or $SENTRY_ORG' }
  return {
    token: token.value,
    org,
    url: url.startsWith('http') ? url : `https://${url}`,
    from: token.from,
  }
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

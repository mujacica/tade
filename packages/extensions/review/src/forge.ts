import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type ExtensionContext, type ProjectRef, Unreachable } from '@tade/extensions-core'
import type { Forge, Review, ReviewRef } from '@tade/forges-core'
import { ForgeError, hostOf, repoOf } from '@tade/forges-core'
import { forgeFor } from '@tade/status'

// Finding the forge a project's work goes to, and asking it as little as
// possible.
//
// Everything anybody asks — the sidebar, the status bar, the brief, the
// tools, the watches — reads one poll. That is the `resources` extension's
// single `ps` applied to somebody else's API: a poll every minute at the most,
// two requests in it, and every reader sharing the answer. Nothing here is on
// a draw path.

/** How often the lists may be asked again, whoever is asking. */
export const POLL_MS = 60_000

export interface Where {
  project: ProjectRef
  /** The repository as its forge names it: `owner/name`. */
  repo: string
  remote: string
  forge: Forge
}

/** What the settings say, with the defaults the design settled on. */
export interface Settings {
  hostForges: Record<string, string>
  accounts: Record<string, string>
  tokenEnv: string | undefined
  include: string[]
  exclude: string[]
  who: 'mine' | 'waiting on you' | 'both'
  draft: boolean
  fix: string[]
  attempts: number
  merge: 'never' | 'when green and approved'
  brief: boolean
  body: string | undefined
}

export function settingsOf(ctx: ExtensionContext): Settings {
  const raw = ctx.settings
  const map = (key: string): Record<string, string> => {
    const value = raw[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k.toLowerCase(),
        String(v),
      ]),
    )
  }
  const list = (key: string): string[] => {
    const value = raw[key]
    if (Array.isArray(value)) return value.map(String).filter(Boolean)
    if (typeof value === 'string' && value.trim()) {
      return value
        .split(',')
        .map((one) => one.trim())
        .filter(Boolean)
    }
    return []
  }
  const who = String(raw.who ?? 'both')
  const merge = String(raw.merge ?? 'never')
  const fix = list('fix')
  return {
    hostForges: map('hosts'),
    accounts: map('accounts'),
    tokenEnv: typeof raw.token_env === 'string' ? raw.token_env : undefined,
    include: list('include'),
    exclude: list('exclude'),
    who: who === 'mine' || who === 'waiting on you' ? who : 'both',
    draft: raw.draft !== false,
    // What may be fixed without asking. Human review comments are not in it
    // by default: a person's comment usually contains a decision, not a defect.
    fix: fix.length > 0 ? fix : ['checks', 'bots'],
    attempts: typeof raw.attempts === 'number' && raw.attempts > 0 ? raw.attempts : 2,
    merge: merge === 'when green and approved' ? merge : 'never',
    brief: raw.brief !== false,
    body: typeof raw.body === 'string' && raw.body.trim() ? raw.body.trim() : undefined,
  }
}

/** What the forge is made with, from the settings. Credentials are read, used and dropped. */
function forgeOptions(ctx: ExtensionContext, cwd?: string) {
  const settings = settingsOf(ctx)
  return {
    exec: ctx.exec,
    fetch: ctx.fetch,
    // A token pasted into Tade reaches the forge as the variable it already
    // reads, and only where the environment has not set one: the forge asks
    // for a credential exactly as it did, and the environment still wins.
    env: withPastedToken(ctx, settings),
    accounts: settings.accounts,
    hostForges: settings.hostForges,
    ...(settings.tokenEnv ? { tokenEnv: settings.tokenEnv } : {}),
    ...(cwd ? { cwd } : {}),
    now: ctx.now,
  }
}

/**
 * The environment the forge is handed: yours, with a token pasted into Tade
 * put under the variable the forge reads — never over one that is already set.
 */
function withPastedToken(
  ctx: ExtensionContext,
  settings: Settings,
): Readonly<Record<string, string | undefined>> {
  const pasted = ctx.secret('token')
  if (!pasted || pasted.from.startsWith('$')) return ctx.env
  const variable = settings.tokenEnv ?? 'GITHUB_TOKEN'
  return { ...ctx.env, [variable]: pasted.value }
}

/** A project's remote, as git has it. Empty when it has none — not an error. */
export async function remoteOf(ctx: ExtensionContext, root: string): Promise<string> {
  const got = await ctx.exec('git', ['-C', root, 'config', '--get', 'remote.origin.url'], {
    timeoutMs: 5_000,
  })
  return got.code === 0 ? got.stdout.trim() : ''
}

/**
 * The forge a project's work goes to, or why there is none. Never throws:
 * a project with no remote is a project Tade only reads git from.
 */
export async function whereOf(
  ctx: ExtensionContext,
  project: ProjectRef,
): Promise<Where | { problem: string }> {
  const remote = await remoteOf(ctx, project.root)
  if (!remote) return { problem: `${project.name} has no remote: there is nothing to push to` }
  const repo = repoOf(remote)
  const forge = forgeFor(remote, forgeOptions(ctx, project.root))
  if (!repo || !forge) return { problem: `no forge serves ${remote}` }
  return { project, repo, remote, forge }
}

/** Every project that has a forge, asked once. */
export async function everywhere(ctx: ExtensionContext): Promise<Where[]> {
  const out: Where[] = []
  for (const project of ctx.projects) {
    const found = await whereOf(ctx, project)
    if (!('problem' in found)) out.push(found)
  }
  return out
}

export interface Snapshot {
  at: number
  /** What is ours and what waits on us, together, newest first. */
  reviews: readonly (Review & { project: string })[]
  /** Why it could not be filled, said once rather than at every look. */
  problem: string | null
  /** The words of the first forge answering, for what a person reads. */
  words: Forge['words']
}

const NEUTRAL: Forge['words'] = {
  one: 'review',
  many: 'reviews',
  short: 'review',
  number: (n) => `#${n}`,
}

let held: { home: string; at: number; snapshot: Snapshot } | null = null
let asking: Promise<Snapshot> | null = null

/** Forget what was read: the next asker polls. For tests, and after a write. */
export function forget(): void {
  held = null
  asking = null
}

/**
 * What is open, from one poll shared by everybody. Two requests per forge at
 * the most — one for what is ours, one for what waits on us — and never more
 * often than `POLL_MS`, whoever asks.
 */
export async function snapshot(ctx: ExtensionContext, keepMs = POLL_MS): Promise<Snapshot> {
  const fresh = held
  if (fresh && fresh.home === ctx.home && ctx.now() - fresh.at <= keepMs) return fresh.snapshot
  if (asking) return asking
  asking = poll(ctx).finally(() => {
    asking = null
  })
  return asking
}

async function poll(ctx: ExtensionContext): Promise<Snapshot> {
  const settings = settingsOf(ctx)
  const found: (Review & { project: string })[] = []
  const problems: string[] = []
  let words: Forge['words'] = NEUTRAL
  for (const where of await everywhere(ctx)) {
    words = where.forge.words
    const repos = settings.include.length > 0 ? settings.include : [where.repo]
    try {
      const asked: Review[] = []
      if (settings.who !== 'waiting on you') {
        asked.push(...(await where.forge.reviews({ who: 'mine', repos, limit: 30 })).items)
      }
      if (settings.who !== 'mine' && where.forge.capabilities.assigned) {
        asked.push(
          ...(await where.forge.reviews({ who: 'waiting on you', repos, limit: 30 })).items,
        )
      }
      for (const review of asked) {
        if (excluded(review.ref.repo, settings.exclude)) continue
        if (found.some((one) => one.url === review.url)) continue
        found.push({ ...review, project: where.project.name })
      }
    } catch (err) {
      problems.push(
        err instanceof ForgeError
          ? `${where.repo}: ${err.message}`
          : `${where.repo}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  const snapshot: Snapshot = {
    at: ctx.now(),
    reviews: found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    problem: problems.length > 0 ? problems.join('; ') : null,
    words,
  }
  held = { home: ctx.home, at: ctx.now(), snapshot }
  return snapshot
}

function excluded(repo: string, globs: readonly string[]): boolean {
  return globs.some((glob) =>
    new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(repo),
  )
}

/**
 * A review as somebody said it: `acme/api#412`, a URL, or `#412` where there
 * is only one repository to mean. Throws with what it would have accepted.
 */
export function refFrom(said: string, only: Where | null): ReviewRef {
  const text = said.trim()
  const url = /https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(text)
  if (url?.[1] && url[2] && url[3]) {
    return { host: url[1], repo: url[2], number: Number(url[3]) }
  }
  const full = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(text)
  if (full?.[1] && full[2]) {
    return {
      host: only?.forge.serves(only.remote) ? hostOfWhere(only) : '',
      repo: full[1],
      number: Number(full[2]),
    }
  }
  const number = /^#?(\d+)$/.exec(text)
  if (number?.[1] && only) {
    return { host: hostOfWhere(only), repo: only.repo, number: Number(number[1]) }
  }
  throw new Error(
    `"${said}" is not a review: say it as owner/repo#412, as its URL${only ? ', or as #412' : ''}`,
  )
}

/**
 * A look's failure as something the scheduler's reach can read: nothing having
 * come back is `Unreachable` and names the host, and everything the forge
 * actually answered — a 401, a 404, a rate limit, a 500 — stays what it was.
 * One endpoint being down is never the machine being offline.
 */
export function asLookFailed(err: unknown, remote: string): unknown {
  return err instanceof ForgeError && err.trouble === 'network'
    ? new Unreachable(hostOf(remote) ?? '', err.message)
    : err
}

function hostOfWhere(where: Where): string {
  const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/.exec(where.remote)
  return match?.[1] ?? ''
}

/**
 * Whether this machine has anything to sign in with. Files and the
 * environment only: this runs before the window opens, and must never be a
 * request.
 */
export function credentialProblem(ctx: ExtensionContext): string | null {
  const settings = settingsOf(ctx)
  const names = settings.tokenEnv ? [settings.tokenEnv] : ['GITHUB_TOKEN', 'GH_TOKEN']
  if (names.some((name) => (ctx.env[name] ?? '').trim() !== '')) return null
  if (ctx.secret('token')) return null
  const path = ctx.env.PATH ?? ''
  const found = path
    .split(':')
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, 'gh')))
  return found
    ? null
    : `install the GitHub CLI and run \`gh auth login\`, or set $${names[0]} to a token`
}

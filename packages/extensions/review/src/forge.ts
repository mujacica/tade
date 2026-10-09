import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ExtensionContext,
  type ProjectRef,
  type ToolContext,
  Unreachable,
} from '@tade/extensions-core'
import type { Forge, Review, ReviewRef } from '@tade/forges-core'
import { ForgeError } from '@tade/forges-core'
import { type ForgePlace, forgeAt, remoteAt } from '@tade/status'

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

/**
 * A project's forge: `forgeAt`'s answer with the project on it.
 *
 * The resolution itself is `@tade/status`'s (`forgeAt`), because intake needs
 * the same two answers — where a project's work goes, and which sign-in
 * reaches it — and must not import this extension to get them. What is left
 * here is this extension's own: the settings it reads, the shared poll, the
 * filters and the tools.
 */
export type Where = ForgePlace & { project: ProjectRef }

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
  return remoteAt(ctx.exec, root)
}

/**
 * The forge a project's work goes to, or why there is none. Never throws:
 * a project with no remote is a project Tade only reads git from.
 */
export async function whereOf(
  ctx: ExtensionContext,
  project: ProjectRef,
): Promise<Where | { problem: string }> {
  const place = await forgeAt(project.root, forgeOptions(ctx, project.root))
  if ('problem' in place) {
    // The project's name rather than its path: the path is this machine's and
    // the sentence is read by somebody who thinks in project names.
    return {
      problem: place.problem.startsWith(project.root)
        ? `${project.name} has no remote: there is nothing to push to`
        : place.problem,
    }
  }
  return { project, ...place }
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
  /**
   * What is ours and what waits on us, together, newest first.
   *
   * `project` is which project's work each one *is* — read off its repository,
   * matched against the projects' own. Null where no project open here is on
   * that repository, which `include` makes an ordinary case: a review Tade
   * cannot place is placed nowhere rather than somewhere wrong.
   */
  reviews: readonly (Review & { project: string | null })[]
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
  const found: (Review & { project: string | null })[] = []
  const problems: string[] = []
  let words: Forge['words'] = NEUTRAL
  const everyone = await everywhere(ctx)
  // Which project a review is on is its **repository**, matched against the
  // projects' own — never whose turn it was to ask. With `include` set every
  // project asks about every repository in it, and the poll keeps the first
  // answer for a URL, so "whose turn it was" named whichever project happened
  // to be iterated first: every review in the account came back as that one's,
  // and the sidebar drew all of them in every project.
  // The first project on a repository keeps it, the way the dedupe below keeps
  // the first answer for a URL: two projects that are checkouts of one
  // repository are work in both, and a row says one project, so the choice is
  // made in one place and the same way every poll rather than by map order.
  const whose = new Map<string, string>()
  for (const one of everyone) if (!whose.has(one.repo)) whose.set(one.repo, one.project.name)
  for (const where of everyone) {
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
        found.push({ ...review, project: whose.get(review.ref.repo) ?? null })
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
      host: only?.host ?? '',
      repo: full[1],
      number: Number(full[2]),
    }
  }
  const number = /^#?(\d+)$/.exec(text)
  if (number?.[1] && only) {
    return { host: only.host, repo: only.repo, number: Number(number[1]) }
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
 *
 * The host is `where.host` and never the remote's own text: an SSH alias is a
 * name for this machine, and handing `github.com-ammujacic` to something that
 * is about to ask whether this machine has a network would answer no about a
 * machine that is fine.
 */
export function asLookFailed(err: unknown, where: Where): unknown {
  return err instanceof ForgeError && err.trouble === 'network'
    ? new Unreachable(where.host, err.message)
    : err
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

/**
 * Where a tool works: an agent's own project, or the one it was told.
 *
 * Here rather than beside the tools because it is the same question as
 * `whereOf` — which forge serves the work in front of us — asked from a tool's
 * input instead of from a project.
 */
export async function workingIn(input: Record<string, unknown>, ctx: ToolContext): Promise<Where> {
  const named = input.project ? String(input.project) : null
  const caller = ctx.caller
  const project: ProjectRef =
    !named && caller.kind === 'agent'
      ? (ctx.projects.find((one) => one.name === caller.project) ?? {
          name: caller.project,
          root: caller.cwd,
        })
      : ctx.project(named)
  const where = await whereOf(ctx, project)
  if ('problem' in where) throw new Error(where.problem)
  return where
}

/** The review a tool was asked about, and the forge that serves it. */
export async function located(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ where: Where; ref: ReviewRef }> {
  const said = String(input.review ?? '')
  const all = await everywhere(ctx)
  if (all.length === 0) {
    throw new Error(
      'no project here has a forge: add a remote, or say which project with `project`',
    )
  }
  const first = input.project ? await workingIn(input, ctx) : null
  const ref = refFrom(said, first ?? (all.length === 1 ? (all[0] ?? null) : null))
  const where = first ?? all.find((one) => one.repo === ref.repo) ?? all[0]
  if (!where) throw new Error(`nothing here serves ${ref.repo}`)
  return { where, ref: { ...ref, host: ref.host || hostOfRemote(where) } }
}

function hostOfRemote(where: Where): string {
  return /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/.exec(where.remote)?.[1] ?? ''
}

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CarriedFile,
  type CarryLeaf,
  type Config,
  fileNamed,
  filesToCarry,
  type HarnessId,
  HOME_HOLDS,
  keyDigest,
  leavesOf,
  textOf,
} from '@tade/core'
import { signInLasts } from '@tade/harnesses-core'
import {
  type CarryAnswer,
  type CarryBody,
  LinkError,
  type Remote,
  type RemoteLink,
  SIGNED_OUT,
} from '@tade/remotes-core'
import { parse as parseYaml } from 'yaml'
import { EventLog } from './events.ts'
import { lockHome } from './lock.ts'

// This machine's setup, carried to a remote it is an owner of
// (`@tade/core`'s `carry.ts` decides every key; `@tade/web`'s `carried.ts` is
// the far half): what this home would give, the call that gives it, and the
// checklist `tade remote add` ends with and Settings › Remotes draws.
//
// Shared by the CLI and the window, which is why it is here and not in either:
// the same setup is read, the same bodies are sent and the same checklist is
// folded out of the answer, so a remote added from a shell and one kept in
// step by a window can never be told two different things.
//
// **A key never leaves without a press.** Every carry sends the keys as their
// digests — so the remote can say whether it already has each — and only the
// call made on the person's press (`keys: true`) sends them, with
// `KEYS_TO_REMOTE` said where they pressed.

/** What this home would give another machine's Tade. */
export interface Setup {
  /** Preferences, kept in step by themselves. */
  kept: CarryLeaf[]
  /** Keys and the like, sent only on a press. */
  pressed: CarryLeaf[]
  /** This machine's own, never sent: said, so the checklist can say why. */
  here: CarryLeaf[]
  /** The personas written and the templates published. */
  files: CarriedFile[]
}

/**
 * What this home would give: the config as written — no defaults — cut into
 * what `carryOf` decides, and the files beside it. `secrets` are paths the
 * caller knows are keys whatever they are called (an extension's declared ones).
 */
export async function setupOf(
  home: string,
  configPath: string = join(home, 'config.yaml'),
  secrets: ReadonlySet<string> = new Set(),
): Promise<Setup> {
  let written: unknown = {}
  try {
    written = parseYaml(await readFile(configPath, 'utf8')) ?? {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const leaves = leavesOf(written, secrets)
  return {
    kept: leaves.filter((one) => one.carry === 'kept'),
    pressed: leaves.filter((one) => one.carry === 'pressed'),
    here: leaves.filter((one) => one.carry === 'here'),
    files: await filesToCarry(home),
  }
}

/** How big one body may be: under the away view's own bound (`BODY_MAX`, 64 KiB) with room. */
const BODY_ROOM = 48 * 1024

/**
 * The bodies of one carry: the settings in one — keys as digests unless this
 * is the press that sends them — and the files after, as many to a body as fit.
 */
export function carryBodies(
  setup: Setup,
  opts: { from: string; keys: boolean; force?: readonly string[] },
): CarryBody[] {
  // A value is whatever the file said, which the far end reads as JSON.
  const valued = (one: CarryLeaf) => ({ path: one.path, value: one.value as never })
  const settings: CarryBody['settings'] = [
    ...setup.kept.map(valued),
    ...setup.pressed.map((one) =>
      opts.keys ? valued(one) : { path: one.path, digest: keyDigest(one.value) },
    ),
  ]
  const force = [...(opts.force ?? [])]
  const bodies: CarryBody[] = []
  // Settings in bodies that fit; `complete` only where one body holds them
  // all, because it takes away there what that body does not name.
  let chunk: CarryBody['settings'] = []
  let size = 0
  const chunks: CarryBody['settings'][] = []
  for (const one of settings) {
    const weight = JSON.stringify(one).length
    if (size + weight > BODY_ROOM && chunk.length > 0) {
      chunks.push(chunk)
      chunk = []
      size = 0
    }
    chunk.push(one)
    size += weight
  }
  chunks.push(chunk)
  const complete = chunks.length === 1
  for (const one of chunks) {
    bodies.push({ from: opts.from, complete, settings: one, files: [], force })
  }
  let files: CarriedFile[] = []
  size = 0
  for (const file of setup.files) {
    const weight = file.text.length + 200
    if (size + weight > BODY_ROOM && files.length > 0) {
      bodies.push({ from: opts.from, complete: false, settings: [], files, force })
      files = []
      size = 0
    }
    files.push(file)
    size += weight
  }
  if (files.length > 0)
    bodies.push({ from: opts.from, complete: false, settings: [], files, force })
  return bodies
}

/**
 * One carry over the link: every body sent, and their answers folded into one.
 * Throws `LinkError` with a sentence somebody can act on where the remote could
 * not be reached or would not take it.
 */
export async function carryTo(
  link: RemoteLink,
  remote: Remote,
  setup: Setup,
  opts: { from: string; keys: boolean; force?: readonly string[] },
): Promise<CarryAnswer> {
  const folded: CarryAnswer = { machine: '', settings: [], files: [], signIns: [] }
  for (const body of carryBodies(setup, opts)) {
    const answer = await link.call(remote, '/api/carry', body)
    if (answer.status !== 200) throw new CarryRefused('failed', refusedSays(answer, remote.name))
    const one = answer.body as Partial<CarryAnswer> | null
    if (!Array.isArray(one?.settings) || !Array.isArray(one.files) || !Array.isArray(one.signIns)) {
      throw new CarryRefused(
        'failed',
        `${remote.name} answered with something that is not a carry's answer`,
      )
    }
    folded.machine = typeof one.machine === 'string' ? one.machine : ''
    folded.settings.push(...one.settings)
    folded.files.push(...one.files)
    folded.signIns = one.signIns
    if (typeof one.unsaid === 'string') folded.unsaid = one.unsaid
  }
  return folded
}

/**
 * A remote that answered and would not take a carry — an older Tade, a session
 * it no longer knows, an answer that is not one — as against one that could
 * not be reached, which is its link's to say.
 */
export class CarryRefused extends LinkError {}

/** A carry the remote answered and would not take, in words. */
function refusedSays(answer: { status: number; body: unknown }, name: string): string {
  if (answer.status === 404) {
    return `${name}'s Tade does not take a carry: it is older than this one, or its window is not open there — update it, or open it`
  }
  if (answer.status === 401 || answer.status === 204) return SIGNED_OUT
  const said = (answer.body as { said?: unknown } | null)?.said
  return `${name} would not take it (${answer.status})${typeof said === 'string' ? `: ${said}` : ''}`
}

/** Which harnesses this machine's agents and orchestrator run in, and the accounts beside them. */
export function harnessesInUse(config: Config): Set<string> {
  const used = new Set<string>([config.orchestrator.harness])
  for (const route of Object.values(config.workers.routes)) used.add(route.harness)
  for (const harness of Object.keys(config.workers.accounts)) used.add(harness as HarnessId)
  return used
}

/** What is left for the person, and what was done: what `tade remote add` ends with. */
export interface Checklist {
  remote: string
  /** What it calls itself, once it has answered. */
  machine: string | null
  /** Why nothing could be carried, where nothing could: the sentence to act on. */
  unreached: string | null
  /** Settings and files written there now, or already so. */
  carried: string[]
  /** How many of those this carry wrote, rather than found already so. */
  written: number
  /** What that machine changed itself, left as it is, with both values where they may be shown. */
  theirs: { what: string; theirs: string | null; ours: string | null }[]
  /** What it would not take, and why. */
  refused: { what: string; why: string }[]
  /** Keys and the like not there, each waiting on a press. */
  waiting: string[]
  /** What a press sent this time. */
  sent: string[]
  /**
   * Each harness's own sign-in there, for the harnesses this machine uses —
   * `told: false` where that machine did not say, which is "cannot tell" and
   * never "not signed in".
   */
  signIns: {
    harness: string
    account: string | null
    signedIn: boolean
    told: boolean
    lasts: string
  }[]
  /** This machine's own, never sent, and why. */
  here: { what: string; why: string }[]
  /** What else a home holds, and what becomes of each: the inventory, as said. */
  holds: typeof HOME_HOLDS
}

/**
 * The checklist out of what this home would give and what the remote said —
 * or, with no answer, what would have been carried and why it was not.
 */
export function checklistOf(req: {
  remote: string
  setup: Setup
  answer: CarryAnswer | null
  unreached: string | null
  inUse: ReadonlySet<string>
  now: number
}): Checklist {
  const { setup, answer } = req
  const ours = new Map([...setup.kept, ...setup.pressed].map((one) => [one.path, one]))
  const pressed = new Set(setup.pressed.map((one) => one.path))
  const list: Checklist = {
    remote: req.remote,
    machine: answer?.machine ?? null,
    unreached: req.unreached,
    carried: [],
    written: 0,
    theirs: [],
    refused: [],
    waiting: [],
    sent: [],
    signIns: [],
    here: setup.here.map((one) => ({ what: one.path, why: one.because })),
    holds: HOME_HOLDS,
  }
  if (answer === null) {
    list.waiting = setup.pressed.map((one) => one.path)
    return list
  }
  for (const one of [...answer.settings, ...answer.files]) {
    if (one.outcome === 'written' || one.outcome === 'replaced') list.written++
  }
  for (const one of answer.settings) {
    const isKey = pressed.has(one.path)
    if (one.outcome === 'theirs') {
      const mine = ours.get(one.path)
      list.theirs.push({
        what: one.path,
        theirs: one.theirs ?? null,
        ours: mine === undefined || isKey ? null : textOf(mine.value),
      })
    } else if (one.outcome === 'refused') list.refused.push({ what: one.path, why: one.why ?? '' })
    else if (one.outcome === 'waiting') list.waiting.push(one.path)
    else if (isKey && (one.outcome === 'written' || one.outcome === 'replaced'))
      list.sent.push(one.path)
    else list.carried.push(one.path)
  }
  for (const one of answer.files) {
    const what = fileNamed(one)
    if (one.outcome === 'theirs') list.theirs.push({ what, theirs: null, ours: null })
    else if (one.outcome === 'refused') list.refused.push({ what, why: one.why ?? '' })
    else list.carried.push(what)
  }
  list.signIns = answer.signIns
    .filter((one) => req.inUse.has(one.harness))
    .map((one) => ({
      harness: one.harness,
      account: one.account,
      signedIn: one.signedIn,
      told: true,
      lasts: one.signedIn ? signInLasts(one.until, req.now) : (one.problem ?? 'not signed in'),
    }))
  for (const harness of req.inUse) {
    if (list.signIns.some((one) => one.harness === harness)) continue
    list.signIns.push({
      harness,
      account: null,
      signedIn: false,
      told: false,
      lasts: answer.unsaid ?? 'it did not say whether it is signed in there',
    })
  }
  return list
}

/** Whether a checklist leaves the person anything to do. */
export function leftToDo(list: Checklist): boolean {
  return (
    list.unreached !== null ||
    list.waiting.length > 0 ||
    list.theirs.length > 0 ||
    list.refused.length > 0 ||
    list.signIns.some((one) => !one.signedIn)
  )
}

/** A sign-in's name, as said: `claude-code`, `claude-code · work`. */
export function signInNamed(one: { harness: string; account: string | null }): string {
  return one.account === null ? one.harness : `${one.harness} · ${one.account}`
}

/**
 * The checklist as a terminal says it: what was carried, what waits on a
 * press, what still needs the person — and how, as the command to type.
 */
export function checklistLines(list: Checklist, how: { address: string; tade: string }): string[] {
  const lines: string[] = []
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  if (list.unreached !== null) {
    lines.push(`nothing carried to ${list.remote} yet: ${list.unreached}`)
    lines.push(
      `  the window here carries it once ${list.remote} answers, or run \`tade remote carry ${list.remote}\``,
    )
  } else {
    lines.push(
      `carried to ${list.remote}: ${count(list.carried.length, 'setting or file', 'settings and files')}, kept in step from now on`,
    )
  }
  for (const one of list.theirs) {
    const values =
      one.theirs !== null && one.ours !== null ? ` (there: ${one.theirs}; here: ${one.ours})` : ''
    lines.push(`  changed there, so left as it is: ${one.what}${values}`)
  }
  if (list.theirs.length > 0) {
    lines.push(
      `  to send this machine's over theirs: \`tade remote carry ${list.remote} --ours <path>\`, or Settings › Remotes`,
    )
  }
  for (const one of list.refused)
    lines.push(`  ${list.remote} would not take ${one.what}: ${one.why}`)
  for (const one of list.sent) lines.push(`sent on your press: ${one}`)
  if (list.waiting.length > 0) {
    lines.push(`waiting on a press: ${list.waiting.join(', ')}`)
    lines.push(
      `  \`tade remote carry ${list.remote} --keys\`, or Settings › Remotes in the window — it asks first`,
    )
  }
  for (const one of list.signIns) {
    if (one.signedIn) lines.push(`${signInNamed(one)} is signed in there: ${one.lasts}`)
    else if (!one.told) {
      lines.push(
        `${signInNamed(one)}: cannot tell — ${one.lasts}; \`ssh ${how.address} ${how.tade} accounts\` asks`,
      )
    } else {
      lines.push(`${signInNamed(one)} needs you to sign in there: ${one.lasts}`)
      lines.push(
        `  \`ssh -t ${how.address} ${how.tade} accounts sign-in ${one.harness}${one.account === null ? '' : ` ${one.account}`}\`, or Settings › Remotes`,
      )
    }
  }
  if (list.here.length > 0) {
    lines.push(`each machine's own, never carried: ${list.here.map((one) => one.what).join(', ')}`)
  }
  return lines
}

/**
 * Run `work` holding this home's journal from a shell, where no window holds
 * it: what lets a press made at a terminal be written down as sent, and by
 * whom. Throws `HomeBusyError` before `work` runs where a window holds it —
 * then it is that window's to send and to write down.
 */
export async function withShellJournal(
  home: string,
  work: (
    append: (line: {
      type: 'remote_carried'
      detail: Record<string, string | number>
    }) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const lock = await lockHome(home)
  try {
    const log = await EventLog.open({ path: join(home, 'events.jsonl') })
    try {
      await work(async (line) => {
        await log.append(line)
      })
    } finally {
      await log.close()
    }
  } finally {
    await lock.release()
  }
}

/** What a carry is written down as, on this machine: counts, and the paths a press sent. */
export function carriedLine(
  remote: string,
  by: string,
  list: Checklist,
): { type: 'remote_carried'; detail: Record<string, string | number> } {
  return {
    type: 'remote_carried',
    detail: {
      remote,
      by,
      carried: list.carried.length,
      written: list.written,
      theirs: list.theirs.length,
      refused: list.refused.length,
      waiting: list.waiting.length,
      ...(list.sent.length > 0 ? { sent: list.sent.join(' ') } : {}),
    },
  }
}

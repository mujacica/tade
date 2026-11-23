import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CARRY_SCHEMA,
  type CarriedFile,
  type CarryLeaf,
  type CarryLine,
  type ChangeSeen,
  type Config,
  carryOf,
  changesIn,
  conflictSays,
  fileNamed,
  filesToCarry,
  type HandEdit,
  type HarnessId,
  HOME_HOLDS,
  handEdits,
  keyDigest,
  leavesOf,
  pinnedHere,
  pinnedIn,
  printable,
  type Register,
  registerAt,
  registersHere,
  type SettingConflict,
  settle,
  shownValue,
  stampAhead,
  stampOf,
  stampText,
  takenOnAPress,
  takenOnlyOnAPress,
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
import { EventLog, readJournal } from './events.ts'
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
// **Both ways.** Every kept setting goes with its stamp (`hlc.ts`), and the
// remote answers with every one of its own that is newer — or that this
// machine has no value for — which this machine settles the same way
// (`takeBack`) and the window writes through its own door. The CLI carries
// but does not take back: it says what is newer there, and the window takes
// it the next time one is open on this home.
//
// **A key never leaves without a press.** Every carry sends the keys as their
// digests — so the remote can say whether it already has each — and only the
// call made on the person's press (`keys: true`) sends them, with
// `KEYS_TO_REMOTE` said where they pressed.

/** What this home would give another machine's Tade. */
export interface Setup {
  /** Preferences, kept in step by themselves. */
  kept: CarryLeaf[]
  /** Every kept setting as a register — taken away ones included — which is what is sent. */
  registers: Map<string, Register>
  /** The newest line per path here, what `takeBack` settles against. */
  changes: ChangeSeen[]
  /** What this machine keeps to itself (`machine.pinned`): neither sent nor taken. */
  pinned: string[]
  /** Keys and the like, sent only on a press. */
  pressed: CarryLeaf[]
  /** This machine's own, never sent: said, so the checklist can say why. */
  here: CarryLeaf[]
  /** The personas written and the templates published. */
  files: CarriedFile[]
  /** Paths the caller knows are keys whatever they are called. */
  secrets: ReadonlySet<string>
}

/**
 * What this home would give: the config as written — no defaults — cut into
 * what `carryOf` decides, each kept setting with the newest line about it, and
 * the files beside it. `secrets` are paths the caller knows are keys whatever
 * they are called (an extension's declared ones); `lines` are the journal's
 * `config_changed` lines, oldest first — the window hands its own, and a shell
 * reads the file.
 */
export async function setupOf(
  home: string,
  configPath: string = join(home, 'config.yaml'),
  secrets: ReadonlySet<string> = new Set(),
  lines?: readonly CarryLine[],
): Promise<Setup> {
  let written: unknown = {}
  try {
    written = parseYaml(await readFile(configPath, 'utf8')) ?? {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const leaves = leavesOf(written, secrets)
  const changes = changesIn(lines ?? (await readJournal(home, { types: ['config_changed'] })))
  return {
    kept: leaves.filter((one) => one.carry === 'kept'),
    registers: registersHere(written, changes, secrets),
    changes,
    pinned: pinnedIn(written),
    pressed: leaves.filter((one) => one.carry === 'pressed'),
    here: leaves.filter((one) => one.carry === 'here'),
    files: await filesToCarry(home),
    secrets,
  }
}

/**
 * Settings edited by hand here since their newest line, which a window writes
 * down as somebody's at this machine before it carries (`by: file`), so the
 * stamp says they changed now rather than when the line was written.
 */
export async function editsOf(
  configPath: string,
  lines: readonly CarryLine[],
  secrets: ReadonlySet<string>,
): Promise<HandEdit[]> {
  let written: unknown = {}
  try {
    written = parseYaml(await readFile(configPath, 'utf8')) ?? {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return handEdits(written, changesIn(lines), secrets)
}

/** How big one body may be: under the away view's own bound (`BODY_MAX`, 64 KiB) with room. */
const BODY_ROOM = 48 * 1024

/** What one carry is asked to do beyond keeping in step: each a press of the person's. */
export interface CarryPress {
  from: string
  /** Send the keys, rather than their digests. */
  keys: boolean
  /** Paths whose value here goes over that machine's, newer or not. */
  force?: readonly string[]
  /**
   * Paths whose newer value there is taken here although it widens agents
   * (`takenOnAPress`): the person's press on this machine, never sent.
   */
  take?: readonly string[]
  /** Turn talking to Tade from another screen on there (`TALK_THERE`). */
  talk?: boolean
}

/** A register as the leaf of a carry says it. */
function leafOf(path: string, register: Register): CarryBody['settings'][number] {
  return {
    path,
    value: (register.value ?? null) as never,
    ...(register.stamp === null ? {} : { hlc: stampText(register.stamp) }),
    ...(register.over === null ? {} : { over: stampText(register.over) }),
    ...(register.by === null ? {} : { by: register.by }),
  }
}

/**
 * The bodies of one carry: the settings first — each kept one with its stamp,
 * keys as digests unless this is the press that sends them — as many to a body
 * as fit, and the files after. A press to turn talking on goes in the last,
 * because that machine builds the listener a body arrives on again for it,
 * once it has answered.
 */
export function carryBodies(setup: Setup, opts: CarryPress): CarryBody[] {
  // A value is whatever the file said, which the far end reads as JSON.
  const valued = (one: CarryLeaf) => ({ path: one.path, value: one.value as never })
  const settings: CarryBody['settings'] = [
    ...[...setup.registers].map(([path, register]) => leafOf(path, register)),
    ...setup.pressed.map((one) =>
      opts.keys ? valued(one) : { path: one.path, digest: keyDigest(one.value) },
    ),
  ]
  const force = [...(opts.force ?? [])]
  const body = (settings: CarryBody['settings'], files: CarriedFile[]): CarryBody => ({
    schema: CARRY_SCHEMA,
    from: opts.from,
    settings,
    files,
    force,
  })
  const bodies: CarryBody[] = []
  let chunk: CarryBody['settings'] = []
  let size = 0
  for (const one of settings) {
    const weight = JSON.stringify(one).length
    if (size + weight > BODY_ROOM && chunk.length > 0) {
      bodies.push(body(chunk, []))
      chunk = []
      size = 0
    }
    chunk.push(one)
    size += weight
  }
  bodies.push(body(chunk, []))
  let files: CarriedFile[] = []
  size = 0
  for (const file of setup.files) {
    const weight = file.text.length + 200
    if (size + weight > BODY_ROOM && files.length > 0) {
      bodies.push(body([], files))
      files = []
      size = 0
    }
    files.push(file)
    size += weight
  }
  if (files.length > 0) bodies.push(body([], files))
  const last = bodies.at(-1)
  if (opts.talk === true && last !== undefined) last.talk = true
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
  opts: CarryPress,
): Promise<CarryAnswer> {
  const folded: CarryAnswer = {
    schema: CARRY_SCHEMA,
    machine: '',
    settings: [],
    files: [],
    signIns: [],
  }
  for (const body of carryBodies(setup, opts)) {
    const answer = await link.call(remote, '/api/carry', body)
    if (answer.status !== 200) throw new CarryRefused('failed', refusedSays(answer, remote.name))
    // Drawn on Settings › Remotes and printed by `tade remote carry`, so every
    // word another machine wrote in it is text by the time anything reads it —
    // but a setting's value, which goes into the config and not onto a screen.
    const one = answerAsText(answer.body) as Partial<CarryAnswer> | null
    if (!Array.isArray(one?.settings) || !Array.isArray(one.files) || !Array.isArray(one.signIns)) {
      throw new CarryRefused(
        'failed',
        `${remote.name} answered with something that is not a carry's answer`,
      )
    }
    if (one.schema !== CARRY_SCHEMA) throw new CarryRefused('failed', olderSays(remote.name))
    folded.machine = typeof one.machine === 'string' ? one.machine : ''
    // Every body is answered with that machine's newer settings beside what it
    // was sent, so the same one may come back from each: kept once.
    for (const setting of one.settings) {
      const at = folded.settings.findIndex((held) => held.path === setting.path)
      if (at === -1) folded.settings.push(setting)
      else if (setting.outcome !== 'newer') folded.settings[at] = setting
    }
    folded.files.push(...one.files)
    folded.signIns = one.signIns
    if (typeof one.unsaid === 'string') folded.unsaid = one.unsaid
    if (one.talk !== undefined && TALK_SAID.has(one.talk)) folded.talk = one.talk
  }
  return folded
}

/** What a remote may say of talking from another screen there; anything else is not said. */
const TALK_SAID: ReadonlySet<string> = new Set(['on', 'off', 'turning on'])

/**
 * A remote that answered and would not take a carry — an older Tade, a session
 * it no longer knows, an answer that is not one — as against one that could
 * not be reached, which is its link's to say.
 */
export class CarryRefused extends LinkError {}

/** A remote whose Tade carries settings one way, as an older one does: nothing is sent it. */
function olderSays(name: string): string {
  return `${name}'s Tade is older than this one and keeps settings in step one way only, so nothing is carried there until it is updated: \`tade host upgrade\` there, or Upgrade on Settings › Remotes`
}

/** A carry the remote answered and would not take, in words. */
function refusedSays(answer: { status: number; body: unknown }, name: string): string {
  if (answer.status === 404) {
    return `${name}'s Tade does not take a carry: it is older than this one, or its window is not open there — update it, or open it`
  }
  if (answer.status === 401 || answer.status === 204) return SIGNED_OUT
  // An older Tade refuses a stamped carry as a body it does not know, and
  // writes nothing; a newer one says it speaks another schema.
  const error = (answer.body as { error?: unknown } | null)?.error
  if (answer.status === 400 && error === 'malformed') return olderSays(name)
  if (answer.status === 426) {
    return `${name}'s Tade is newer than this one and keeps settings in step another way, so nothing is carried there until this one is updated: \`tade update\``
  }
  const said = (answer.body as { said?: unknown } | null)?.said
  return `${name} would not take it (${answer.status})${typeof said === 'string' ? `: ${printable(said)}` : ''}`
}

/**
 * An answer with every string a person may read reduced to text — every one
 * but a setting's value, which is written into the config as it came (a rule
 * for agents has lines in it) and never drawn as it is.
 */
function answerAsText(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return asText(value)
  const answer = value as Record<string, unknown>
  const settings = Array.isArray(answer.settings)
    ? answer.settings.map((one: unknown) => {
        if (typeof one !== 'object' || one === null || !('value' in one)) return asText(one)
        const { value: kept, ...rest } = one as Record<string, unknown>
        return { ...(asText(rest) as object), value: kept }
      })
    : answer.settings
  return { ...(asText({ ...answer, settings: [] }) as object), settings }
}

/** What another machine sent, with every string in it reduced to text (`printable`). */
function asText(value: unknown): unknown {
  if (typeof value === 'string') return printable(value)
  if (Array.isArray(value)) return value.map(asText)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, asText(one)]))
}

/** Which harnesses this machine's agents and orchestrator run in, and the accounts beside them. */
export function harnessesInUse(config: Config): Set<string> {
  const used = new Set<string>([config.orchestrator.harness])
  for (const route of Object.values(config.workers.routes)) used.add(route.harness)
  for (const harness of Object.keys(config.workers.accounts)) used.add(harness as HarnessId)
  for (const project of Object.values(config.projects))
    for (const harness of Object.keys(project.accounts ?? {})) used.add(harness)
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
  /** A file that machine changed itself, left as it is. */
  theirs: { what: string; theirs: string | null; ours: string | null }[]
  /** Settings changed there later than here, written here now. */
  taken: string[]
  /**
   * Settings changed there later, not written here, and why: refused here, or
   * a shell that does not take back. `press` where a press here takes it.
   */
  newer: { what: string; why: string; press?: true }[]
  /** Settings both machines changed without seeing the other's, and whose stood. */
  conflicts: SettingConflict[]
  /** What either machine keeps to itself (`machine.pinned`), and which. */
  pinned: { what: string; where: 'here' | 'there' }[]
  /** What it would not take, and why. */
  refused: { what: string; why: string }[]
  /** Keys and the like not there, each waiting on a press. */
  waiting: string[]
  /** What a press sent this time. */
  sent: string[]
  /** What is there and not in use yet: that machine's Tade reads it when it next starts. */
  nextStart: string[]
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
  /**
   * Whether that machine takes a message from another screen — this one's tab
   * for its orchestrator among them (`TALK_THERE`, that machine's own): `off`
   * waits on a press, `turning on` is one it took. Null where it did not say,
   * as an older Tade does not, and then nothing is offered.
   */
  talk: 'on' | 'off' | 'turning on' | null
  /** This machine's own, never sent, and why. */
  here: { what: string; why: string }[]
  /** What else a home holds, and what becomes of each: the inventory, as said. */
  holds: typeof HOME_HOLDS
}

/** What a carry left there: written now, or already so. */
const LANDED: ReadonlySet<string> = new Set(['written', 'replaced', 'same'])

/** Said of what is newer there where a shell carried: the window takes it. */
export const WINDOW_TAKES = 'newer there; the window here takes it the next time one is open'

/** One setting this machine takes from the answer, with the register it came with. */
export interface TakenWrite {
  path: string
  /** Undefined is taken away there, and so here. */
  value: unknown
  stamp: { hlc?: string; over?: string; origin?: string }
}

/** What this machine does with the settings that came back newer. */
export interface TakenBack {
  writes: TakenWrite[]
  conflicts: SettingConflict[]
  /** Newer there and not taken here: what widens agents, waiting on a press here (`press`), or too far ahead. */
  refused: { what: string; why: string; press?: true }[]
  /** A change to what widens agents here, taken on the person's press: said whenever one lands. */
  landed: { path: string; now: string }[]
}

/**
 * The settings that came back newer, settled here the way that machine
 * settled what it was sent (`settle`), so the two agree: each one whose stamp
 * is later than this machine's — or that this machine has nothing for — is
 * written here with the register it came with, so it is not carried back as
 * news. A key, this machine's own and what it pinned are never taken, and a
 * change to what widens agents here, or to what every agent is told, only on
 * the person's press here (`take`, `takenOnlyOnAPress`, `takenOnAPress`) —
 * whoever that machine says made it, since nothing here can check that — and
 * then written as the press's here. Pure: what the window
 * writes is its own.
 *
 * And the conflicts of the whole carry, as this machine says them: the ones
 * that machine settled in this one's favour, and the ones settled here.
 */
export function takeBack(
  setup: Setup,
  answer: CarryAnswer,
  me: string,
  now: number = Date.now(),
  take: ReadonlySet<string> = new Set(),
): TakenBack {
  const back: TakenBack = { writes: [], conflicts: [], refused: [], landed: [] }
  const there = answer.machine || 'that machine'
  for (const one of answer.settings) {
    const mine = setup.registers.get(one.path)
    if (one.outcome === 'written' && one.conflict !== undefined && mine !== undefined) {
      back.conflicts.push({
        path: one.path,
        kept: { value: shownValue(mine.value), machine: me, at: mine.stamp },
        lost: { value: one.conflict.value, machine: there, at: stampOf(one.conflict.hlc) },
        mine: 'kept',
      })
    }
    if (one.outcome !== 'newer' || !('value' in one)) continue
    if (carryOf(one.path, setup.secrets.has(one.path)).carry !== 'kept') continue
    if (pinnedHere(one.path, setup.pinned)) continue
    const ours = mine ?? registerAt(one.path, undefined, setup.changes)
    const theirs: Register = {
      value: one.value === null ? undefined : one.value,
      stamp: stampOf(one.hlc),
      over: stampOf(one.over),
      by: one.by ?? null,
    }
    // A stamp from a clock far ahead of this one is not a later change: refused, and said.
    const ahead = stampAhead(theirs.stamp, now)
    if (ahead !== null) {
      back.refused.push({ what: one.path, why: ahead })
      continue
    }
    const settled = settle(ours, theirs)
    if (settled.keep !== 'incoming') continue
    // What widens agents, or what every agent is told: a press here, never that machine's word.
    const widens = takenOnlyOnAPress(one.path)
    if (widens && !take.has(one.path)) {
      const why = takenOnAPress(shownValue(theirs.value), theirs.by, there)
      back.refused.push({ what: one.path, why, press: true })
      continue
    }
    // Taken on a press, it is the person's here — never what that machine
    // said, which would go on to a third machine as if it were checked.
    // Taken by itself, who changed it is that machine's word, and written as
    // one (`relayedBy`): so it never reaches a third machine as the person's.
    const origin = widens ? 'window' : relayedBy(one.by, there)
    back.writes.push({
      path: one.path,
      value: theirs.value,
      stamp: {
        ...(one.hlc === undefined ? {} : { hlc: one.hlc }),
        ...(one.over === undefined ? {} : { over: one.over }),
        ...(origin === undefined ? {} : { origin }),
      },
    })
    if (settled.conflict) {
      back.conflicts.push({
        path: one.path,
        kept: { value: shownValue(theirs.value), machine: there, at: theirs.stamp },
        lost: { value: shownValue(ours.value), machine: me, at: ours.stamp },
        mine: 'lost',
      })
    }
    if (widens) {
      back.landed.push({ path: one.path, now: shownValue(theirs.value) })
    }
  }
  return back
}

/**
 * Who changed a setting, as this machine writes down another machine's word
 * for it: `window on vps`, never `window`. A `by` is a claim this machine
 * cannot check — an agent there can edit its config and be `file` — and
 * written as itself, it would be passed on to a third machine as the person
 * here (`personBy`), where a `never` path from it would land unasked. One
 * already named as another machine's word stays as it is, so a relay through
 * many machines names the first.
 */
export function relayedBy(by: string | undefined, there: string): string | undefined {
  if (by === undefined) return undefined
  if (/ on [^\s]+$/.test(by)) return by.slice(0, 200)
  return `${by} on ${there}`.slice(0, 200)
}

/**
 * The checklist out of what this home would give and what the remote said —
 * or, with no answer, what would have been carried and why it was not.
 * `took` is what the window wrote of what came back newer; without it — a
 * shell — what would be taken is said to wait for the window.
 */
export function checklistOf(req: {
  remote: string
  setup: Setup
  answer: CarryAnswer | null
  unreached: string | null
  inUse: ReadonlySet<string>
  now: number
  /** What this machine calls itself, for a conflict said here. */
  me?: string
  took?: { taken: readonly string[]; failed: readonly { what: string; why: string }[] }
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
    taken: [],
    newer: [],
    conflicts: [],
    pinned: setup.pinned.map((what) => ({ what, where: 'here' as const })),
    refused: [],
    waiting: [],
    sent: [],
    nextStart: [],
    signIns: [],
    talk: answer?.talk ?? null,
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
  const back = takeBack(setup, answer, req.me ?? 'here')
  list.conflicts = back.conflicts
  list.newer.push(...back.refused)
  if (req.took === undefined) {
    list.newer.push(...back.writes.map((one) => ({ what: one.path, why: WINDOW_TAKES })))
  } else {
    list.taken = [...req.took.taken]
    list.newer.push(...req.took.failed)
  }
  for (const one of answer.settings) {
    const isKey = pressed.has(one.path)
    if (one.outcome === 'newer') continue
    if (one.outcome === 'theirs') {
      const mine = ours.get(one.path)
      list.theirs.push({
        what: one.path,
        theirs: null,
        ours: mine === undefined || isKey ? null : textOf(mine.value),
      })
    } else if (one.outcome === 'pinned') list.pinned.push({ what: one.path, where: 'there' })
    else if (one.outcome === 'refused') list.refused.push({ what: one.path, why: one.why ?? '' })
    else if (one.outcome === 'waiting') list.waiting.push(one.path)
    else if (isKey && (one.outcome === 'written' || one.outcome === 'replaced'))
      list.sent.push(one.path)
    else list.carried.push(one.path)
    // Said only of what is there; an older Tade says nothing, and then neither does this.
    if (one.nextStart === true && LANDED.has(one.outcome)) list.nextStart.push(one.path)
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
    list.newer.some((one) => one.why !== WINDOW_TAKES) ||
    list.talk === 'off' ||
    list.signIns.some((one) => !one.signedIn)
  )
}

/** A stamp's wall time as this machine's clock face says it: `14:02`. */
export function clockOf(wall: number): string {
  const at = new Date(wall)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
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
  for (const one of list.conflicts)
    lines.push(`  changed on both: ${conflictSays(one, clockOf, list.remote)}`)
  if (list.taken.length > 0) lines.push(`  newer there, taken here: ${list.taken.join(', ')}`)
  for (const one of list.newer) lines.push(`  ${one.what}: ${one.why}`)
  for (const one of list.theirs) {
    const values =
      one.theirs !== null && one.ours !== null ? ` (there: ${one.theirs}; here: ${one.ours})` : ''
    lines.push(`  changed there, so left as it is: ${one.what}${values}`)
  }
  const pinned = (where: 'here' | 'there') =>
    list.pinned.filter((one) => one.where === where).map((one) => one.what)
  if (pinned('here').length > 0) {
    lines.push(`  kept to this machine, neither sent nor taken: ${pinned('here').join(', ')}`)
  }
  if (pinned('there').length > 0) {
    lines.push(`  kept to ${list.remote}, so not sent: ${pinned('there').join(', ')}`)
  }
  if (list.theirs.length > 0) {
    lines.push(
      `  to send this machine's over theirs: \`tade remote carry ${list.remote} --ours <path>\`, or Settings › Remotes`,
    )
  }
  for (const one of list.refused)
    lines.push(`  ${list.remote} would not take ${one.what}: ${one.why}`)
  for (const one of list.sent) lines.push(`sent on your press: ${one}`)
  if (list.nextStart.length > 0) {
    lines.push(`applies when Tade next starts on ${list.remote}: ${list.nextStart.join(', ')}`)
  }
  if (list.waiting.length > 0) {
    lines.push(`waiting on a press: ${list.waiting.join(', ')}`)
    lines.push(
      `  \`tade remote carry ${list.remote} --keys\`, or Settings › Remotes in the window — it asks first`,
    )
  }
  if (list.talk === 'off') {
    lines.push(
      `talking to Tade from here is off on ${list.remote}, so its tab here takes no message`,
    )
    lines.push(
      `  \`tade remote carry ${list.remote} --talk\`, or Settings › Remotes — it says what that means first`,
    )
  } else if (list.talk === 'turning on') {
    lines.push(
      `talking to Tade from here is turned on on ${list.remote}, on your press: its tab here takes a message once the link is back`,
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
      taken: list.taken.length,
      conflicts: list.conflicts.length,
      ...(list.sent.length > 0 ? { sent: list.sent.join(' ') } : {}),
      ...(list.talk === 'turning on' ? { talk: 'turned on' } : {}),
    },
  }
}

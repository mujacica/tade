import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import {
  CARRY_SCHEMA,
  type CarriedFile,
  type CarryLine,
  type CarryOutcome,
  type ChangeSeen,
  carryDecision,
  carryOf,
  changesIn,
  fileDecision,
  fileHash,
  fileNamed,
  fileThere,
  type HandEdit,
  handEdits,
  notThePersonSays,
  peerMayWrite,
  pinnedHere,
  pinnedIn,
  putFile,
  type Register,
  registerAt,
  registersHere,
  type SettingConflict,
  type Settled,
  type Stamp,
  settingReach,
  settle,
  shownValue,
  stampAhead,
  stampOf,
  stampText,
  textOf,
  writtenAt,
} from '@tade/core'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs } from './surface.ts'

export { type CarryLine, type ChangeSeen, changesIn, type HandEdit }

// Another machine's Tade keeping its settings in step with this one's — its
// preferences both ways, its personas and published templates, and on a press
// its keys — so a remote somebody added works like the machine they set up,
// and a preference changed on either is the preference on both
// (`@tade/core`'s `carry.ts` has the decision for every key).
//
// **An owner's, and only on this machine's own door.** Like `presence`: the
// route is `here` (`routes.ts`), so it is answered only on the loopback
// listener for a loopback `Host`, which from anywhere else is an SSH
// connection, and only an owner device may use it — a session `tade web pair
// --owner` minted through that same SSH key. **It is the one route that can
// write a key, and that is what makes it no wider than what already was**:
// whoever holds that key can already `ssh` here and edit `config.yaml`. A
// phone's session, however much it was granted, is refused it — **but the
// person's own** (`Route.theirs`, `theirsOf`: full access, a phone or an
// owner's link), on any door, which already changes every setting from Settings, keys
// included. The person decided it: their
// phone is the screen they can pull the plug on — and off this machine's door
// it is asked a trusted origin and the passkey, as acting is.
//
// **This machine decides, not the one sending.** Every path is asked of
// `carryOf` again here, so a path that is this machine's own is refused
// whatever arrived. A kept setting is a register, and the later stamp wins
// (`settle`): the one that came is written here, or this machine's is newer
// and goes back with the answer (`newer`) for the other to settle the same
// way. One this machine keeps to itself (`machine.pinned`) is neither, and a
// change to what widens agents here lands only where the person made it
// (`peerMayWrite`). A key arrives only as a digest to compare until somebody
// pressed to send it. Each write goes through the window's one write path,
// which writes the `config_changed` line with the stamp it came with, the
// device and the machine it came from, and never a key.
//
// **Two Tades that carry settings differently refuse rather than guess**: a
// carry says its `schema`, and one that is not this one's is refused before
// anything is written (`CARRY_SCHEMA`), with a sentence an older sender says.
//
// **What goes back is never a key and never a sign-in.** A setting is said
// back as its value only where it is kept, never where it was carried on a
// press; a harness's sign-in is said as whether there is one and until when,
// read off the dates the harness wrote down — never the token beside them.

/** A dotted config path, as a carry names one. */
const Path = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)

/** A stamp as a line carries it (`hlc.ts`), and who changed it as a line says it. */
const StampText = z.string().max(200)
const Who = z.string().max(200)

const Leaf = z.union([
  z.strictObject({ path: Path, digest: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({
    path: Path,
    /** `null` is a setting taken away there, which is a change like any other. */
    value: z.unknown().refine((value) => value !== undefined),
    hlc: StampText.optional(),
    over: StampText.optional(),
    by: Who.optional(),
  }),
])

const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)

const FileIn = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('persona'), name: Name, text: z.string().max(48_000) }),
  z.strictObject({
    kind: z.literal('template'),
    name: Name,
    version: z.int().positive(),
    text: z.string().max(48_000),
  }),
])

const CarryBody = z.strictObject({
  /** What the carry speaks (`CARRY_SCHEMA`): absent is a Tade from before settings went both ways. */
  schema: z.int().positive().optional(),
  /** What the machine sending calls itself, for the line written here. */
  from: z.string().min(1).max(120),
  settings: z.array(Leaf).max(1_000),
  files: z.array(FileIn).max(200).default([]),
  /** Paths the person pressed for that machine's value to go over this one's. */
  force: z.array(z.string().max(220)).max(1_000).default([]),
  /**
   * The person pressed to turn talking to Tade from another screen on here
   * (`TALK_THERE`): the one setting of this machine's own a carry may change,
   * only ever on, and only on a press.
   */
  talk: z.literal(true).optional(),
})

export type CarryBody = z.infer<typeof CarryBody>

/** One setting, as it came out. */
export interface CarriedSetting {
  path: string
  outcome: CarryOutcome
  /** Why not, where it was refused. Tade's own clause, or the config's. */
  why?: string
  /**
   * This machine's register, where it is `newer`: the value — kept, never a
   * key — its stamp, what it was made over and who changed it, for the
   * machine that asked to settle as this one did. `null` is taken away here.
   */
  value?: unknown
  hlc?: string
  over?: string
  by?: string
  /**
   * Where both machines had changed it without seeing the other's: the value
   * that lost and its stamp, as text — this machine's where the one that came
   * was written, the one that came where this machine's is `newer`.
   */
  conflict?: { value: string; hlc: string | null }
  /**
   * Here, and not in use yet: written now, or already so since the Tade running
   * here started, and read only when it next starts. Absent is not said — what
   * an older Tade says too — never "in use".
   */
  nextStart?: true
}

/** One file, as it came out. */
export interface CarriedFileOut {
  kind: CarriedFile['kind']
  name: string
  version?: number
  outcome: CarryOutcome
  why?: string
}

/** A harness's own sign-in here: whether there is one, and until when. Never the token. */
export interface SignInHere {
  harness: string
  /** An account beside the harness's own sign-in, by name; null for its own. */
  account: string | null
  signedIn: boolean
  /** When it runs out, in this machine's clock, where the harness wrote that down. */
  until: number | null
  /** Why it could not say, where it could not. */
  problem: string | null
}

/** What `POST /api/carry` answers. */
export interface CarryAnswer {
  /** What it speaks (`CARRY_SCHEMA`). Absent from an older Tade. */
  schema?: number
  /** What this machine calls itself. */
  machine: string
  settings: CarriedSetting[]
  files: CarriedFileOut[]
  signIns: SignInHere[]
  /** Why it could not say how its harnesses are signed in, where it could not. */
  unsaid?: string
  /**
   * Whether a message from another screen is taken here (`TALK_THERE`):
   * `turning on` where a press asked, which is written once this answer has
   * gone. Absent from an older Tade, which says nothing of it.
   */
  talk?: 'on' | 'off' | 'turning on'
}

/** Who a carried write is from, as its line says it. */
export interface CarriedBy {
  device: string
  /** What the machine that sent it calls itself. */
  from: string
  /**
   * The register it came with, for a kept setting: written on its line as it
   * came, so this machine's register is the one that machine had — the same
   * stamp, what it was made over, and who changed it first (`origin`).
   */
  stamp?: { hlc?: string; over?: string; origin?: string }
}

/** What a carry did here that is news on this machine, for the window to write down and say. */
export interface CarryNews {
  /** What the machine sending calls itself. */
  from: string
  /** Changes both machines made without seeing the other's, and whose stood. */
  conflicts: SettingConflict[]
  /** A peer's change to what widens agents here, made by the person, written: said whenever one lands. */
  landed: { path: string; now: string; by: string }[]
  /** One that was not the person's, refused, with why. */
  refused: { path: string; why: string }[]
}

/**
 * What the window does for this route: its config as written, its last line
 * about each path, its one write path, the files in its home, and its harnesses'
 * sign-ins. Absent, the route is the `404` of a path nobody wired.
 */
export interface WebCarrying {
  /** The config file as parsed, with no defaults: what somebody wrote here. */
  written(): Promise<unknown>
  /** The newest `config_changed` line per path. */
  changes(): Promise<readonly ChangeSeen[]>
  /** The hash each file's last carry here wrote, by `fileNamed`. */
  carriedFiles(): Promise<ReadonlyMap<string, string>>
  /**
   * Write one setting through the one write path, `undefined` taking it away,
   * with a `config_changed` line saying it was carried and by whom — and what
   * it was set to only where it was not carried on a press. Throws the reason
   * where the config would not load with it, having put the file back.
   */
  write(path: string, value: unknown, carry: 'kept' | 'pressed', by: CarriedBy): Promise<void>
  /**
   * Paths the extensions here declared as keys whatever they are called: never
   * said back as a value, and a value that came for one is a key's.
   */
  secrets(): ReadonlySet<string>
  /**
   * Write down settings edited by hand since their newest line, as somebody at
   * this machine's (`by: file`), so the stamp says they were changed now.
   */
  found(edits: readonly HandEdit[]): Promise<void>
  /** What a carry did that is news here: written down and said by the window. Never throws. */
  told(news: CarryNews): Promise<void>
  /** What is in this home under a file's name, or null. */
  file(file: Pick<CarriedFile, 'kind' | 'name'> & { version?: number }): Promise<string | null>
  /** Write one file into this home, with a line saying it was carried. Throws the reason. */
  put(file: CarriedFile, by: CarriedBy): Promise<void>
  /** Each harness's own sign-in here, as it says. Never a token. */
  signIns(): Promise<SignInHere[]>
  /** What this machine calls itself. */
  machine(): string
  /** When the Tade running here started, in this machine's clock. */
  started(): number
  /**
   * Of these paths, the ones a change to waits for Tade to start again here —
   * as this machine's Settings says of each row, and its extensions of one
   * turned on — asked after the writes, so it answers about what is written now.
   */
  waiting(paths: readonly string[]): ReadonlySet<string>
  /** Talking to Tade from another screen here (`TALK_THERE`). Absent, nothing is said of it. */
  talk?: {
    on(): boolean
    /**
     * Turn it on, through the one write path. Called once the answer that said
     * so has gone, and never throws: what went wrong is said here.
     */
    turnOn(by: CarriedBy): Promise<void>
  }
}

/** A leaf that came, as a register. */
function incomingOf(leaf: { value: unknown; hlc?: string; over?: string; by?: string }): Register {
  return {
    value: leaf.value === null ? undefined : leaf.value,
    stamp: stampOf(leaf.hlc),
    over: stampOf(leaf.over),
    by: leaf.by ?? null,
  }
}

/** What a stamp is said as on a conflict's line: its text, or nothing. */
function textOfStamp(stamp: Stamp | null): string | null {
  return stamp === null ? null : stampText(stamp)
}

/**
 * Apply one carry: every setting and file decided here, the ones to write
 * written, and the answer. Pure apart from what `carrying` does, which is the
 * window's. `answered` is when the answer has gone — where nothing waits on
 * one, at once.
 */
export async function applyCarry(
  body: CarryBody,
  device: string,
  carrying: WebCarrying,
  answered: Promise<void> = Promise.resolve(),
  now: number = Date.now(),
): Promise<CarryAnswer> {
  const by: CarriedBy = { device, from: body.from }
  const secrets = carrying.secrets()
  const written = await carrying.written()
  let changes = await carrying.changes()
  // An edit to the file since its newest line is a change somebody made here
  // now, and stamped as one before anything is compared with it.
  const edits = handEdits(written, changes, secrets)
  if (edits.length > 0) {
    await carrying.found(edits)
    changes = await carrying.changes()
  }
  const lastAt = new Map(changes.map((one) => [one.path, one]))
  const pinned = pinnedIn(written)
  const here = registersHere(written, changes, secrets)
  const forced = new Set(body.force)
  const settings: CarriedSetting[] = []
  const toWrite: Write[] = []
  const news: CarryNews = { from: body.from, conflicts: [], landed: [], refused: [] }
  const conflictOf = (path: string, kept: Side, lost: Side, mine: 'kept' | 'lost'): void => {
    news.conflicts.push({ path, kept, lost, mine })
  }
  const me = carrying.machine()
  for (const leaf of body.settings) {
    const decided = carryOf(leaf.path, secrets.has(leaf.path))
    const current = writtenAt(written, leaf.path)
    if (decided.carry === 'here') {
      settings.push({ path: leaf.path, outcome: 'refused', why: decided.because })
      continue
    }
    if (decided.carry === 'pressed' || 'digest' in leaf) {
      // A key: compared by its digest until the press that sends it.
      const outcome = carryDecision({
        carry: 'pressed',
        incoming: 'digest' in leaf ? { digest: leaf.digest } : { value: leaf.value },
        current,
      })
      if ((outcome === 'written' || outcome === 'replaced') && 'value' in leaf) {
        toWrite.push({ path: leaf.path, value: leaf.value ?? undefined, carry: 'pressed', by })
      }
      settings.push({ path: leaf.path, outcome })
      continue
    }
    if (pinnedHere(leaf.path, pinned)) {
      settings.push({ path: leaf.path, outcome: 'pinned' })
      continue
    }
    const mine = here.get(leaf.path) ?? registerAt(leaf.path, current, changes)
    const came = incomingOf(leaf)
    // A stamp from a clock far ahead of this one is refused whole, never
    // settled: winning by a wrong clock is not being later (`MAX_DRIFT_MS`).
    const ahead = stampAhead(came.stamp, now)
    if (ahead !== null) {
      settings.push({ path: leaf.path, outcome: 'refused', why: ahead })
      news.refused.push({ path: leaf.path, why: ahead })
      continue
    }
    // A press is the person choosing that machine's value over this one's.
    const settled: Settled = forced.has(leaf.path)
      ? { keep: textOf(mine.value) === textOf(came.value) ? 'same' : 'incoming', conflict: false }
      : settle(mine, came)
    if (settled.keep === 'same') {
      settings.push({ path: leaf.path, outcome: 'same' })
      continue
    }
    const theirSide: Side = { value: shownValue(came.value), machine: body.from, at: came.stamp }
    const mySide: Side = { value: shownValue(mine.value), machine: me, at: mine.stamp }
    if (settled.keep === 'here') {
      settings.push({
        ...newerOf(leaf.path, mine),
        ...(settled.conflict
          ? { conflict: { value: theirSide.value, hlc: textOfStamp(came.stamp) } }
          : {}),
      })
      if (settled.conflict) conflictOf(leaf.path, mySide, theirSide, 'kept')
      continue
    }
    if (!peerMayWrite(leaf.path, came.by)) {
      const why = notThePersonSays(came.by, body.from)
      settings.push({ path: leaf.path, outcome: 'refused', why })
      news.refused.push({ path: leaf.path, why })
      continue
    }
    toWrite.push({
      path: leaf.path,
      value: came.value,
      carry: 'kept',
      by: {
        ...by,
        stamp: {
          ...(leaf.hlc === undefined ? {} : { hlc: leaf.hlc }),
          ...(leaf.over === undefined ? {} : { over: leaf.over }),
          ...(leaf.by === undefined ? {} : { origin: leaf.by }),
        },
      },
    })
    settings.push({
      path: leaf.path,
      outcome: 'written',
      ...(settled.conflict
        ? { conflict: { value: mySide.value, hlc: textOfStamp(mine.stamp) } }
        : {}),
    })
    if (settled.conflict) conflictOf(leaf.path, theirSide, mySide, 'lost')
    if (settingReach(leaf.path).reach === 'never' && came.by !== null) {
      news.landed.push({ path: leaf.path, now: shownValue(came.value), by: came.by })
    }
  }
  // What this machine has that the carry did not name, offered back: that
  // machine settles each against its own, as this one did what came.
  const sent = new Set(body.settings.map((one) => one.path))
  for (const [path, register] of here) {
    if (sent.has(path) || register.value === undefined) continue
    settings.push(newerOf(path, register))
  }
  await writeAll(toWrite, settings, carrying)
  // What was refused at the write is not news that landed.
  news.landed = news.landed.filter((one) => outcomeOf(settings, one.path) === 'written')
  news.conflicts = news.conflicts.filter((one) => outcomeOf(settings, one.path) !== 'refused')
  if (news.conflicts.length > 0 || news.landed.length > 0 || news.refused.length > 0) {
    await carrying.told(news)
  }
  // What is here and not in use yet — written now, or already so since the Tade
  // running here started — where it is read only at a start: said back, so the
  // machine that carried it says that rather than "kept in step" alone.
  const started = carrying.started()
  const landed = settings.filter((one) => {
    if (one.outcome === 'written' || one.outcome === 'replaced') return true
    const at = lastAt.get(one.path)?.at ?? null
    return one.outcome === 'same' && at !== null && at >= started
  })
  const waiting = carrying.waiting(landed.map((one) => one.path))
  for (const one of landed) if (waiting.has(one.path)) one.nextStart = true
  const files = await carryFiles(body.files, forced, carrying, by)
  // Harnesses that could not say are "cannot tell" there, and why is said.
  const said = await carrying.signIns().then(
    (signIns) => ({ signIns }),
    (err: unknown) => ({
      signIns: [],
      unsaid: `its harnesses could not say: ${err instanceof Error ? err.message : String(err)}`,
    }),
  )
  return {
    schema: CARRY_SCHEMA,
    machine: me,
    settings,
    files,
    ...said,
    ...talkHere(body, carrying, by, answered),
  }
}

type Side = SettingConflict['kept']

interface Write {
  path: string
  value: unknown
  carry: 'kept' | 'pressed'
  by: CarriedBy
}

/** This machine's register, said back as newer. */
function newerOf(path: string, register: Register): CarriedSetting {
  return {
    path,
    outcome: 'newer',
    value: register.value ?? null,
    ...(register.stamp === null ? {} : { hlc: stampText(register.stamp) }),
    ...(register.over === null ? {} : { over: stampText(register.over) }),
    ...(register.by === null ? {} : { by: register.by }),
  }
}

function outcomeOf(settings: readonly CarriedSetting[], path: string): CarryOutcome | undefined {
  return settings.find((one) => one.path === path)?.outcome
}

/**
 * Talking from another screen, as said back — and turned on where the person
 * pressed for it, **once this answer has gone**: the listener it came in on is
 * built again for it, and built again first it would cut this answer off.
 */
function talkHere(
  body: CarryBody,
  carrying: WebCarrying,
  by: CarriedBy,
  answered: Promise<void>,
): Pick<CarryAnswer, 'talk'> {
  const talk = carrying.talk
  if (talk === undefined) return {}
  if (talk.on()) return { talk: 'on' }
  if (body.talk !== true) return { talk: 'off' }
  void answered.then(() => talk.turnOn(by))
  return { talk: 'turning on' }
}

/**
 * Write them, and where one would not load, try it once more after the rest:
 * a route's name is checked against the routes, so `workers.default` can only
 * land after the route it names has. What still will not load is refused with
 * the config's own reason.
 */
async function writeAll(
  toWrite: readonly Write[],
  settings: CarriedSetting[],
  carrying: WebCarrying,
): Promise<void> {
  let waiting = [...toWrite]
  for (const round of [0, 1]) {
    const failed: typeof waiting = []
    for (const one of waiting) {
      try {
        await carrying.write(one.path, one.value, one.carry, one.by)
      } catch (err) {
        if (round === 0) {
          failed.push(one)
          continue
        }
        const said = settings.find((row) => row.path === one.path)
        if (said !== undefined) {
          said.outcome = 'refused'
          said.why = err instanceof Error ? err.message : String(err)
        }
      }
    }
    waiting = failed
    if (waiting.length === 0) return
  }
}

async function carryFiles(
  files: readonly CarriedFile[],
  forced: ReadonlySet<string>,
  carrying: WebCarrying,
  by: CarriedBy,
): Promise<CarriedFileOut[]> {
  const hashes = await carrying.carriedFiles()
  const out: CarriedFileOut[] = []
  for (const file of files) {
    const name = fileNamed(file)
    const current = await carrying.file(file)
    const outcome = fileDecision({
      file,
      current,
      lastHash: hashes.get(name) ?? null,
      force: forced.has(name),
    })
    const row: CarriedFileOut = {
      kind: file.kind,
      name: file.name,
      ...(file.kind === 'template' ? { version: file.version } : {}),
      outcome,
    }
    if (outcome === 'refused') {
      row.why = 'a published version never changes, and a different one is published here'
    } else if (outcome === 'written') {
      try {
        await carrying.put(file, by)
      } catch (err) {
        row.outcome = 'refused'
        row.why = err instanceof Error ? err.message : String(err)
      }
    }
    out.push(row)
  }
  return out
}

/** As much of the answer's response as waiting for it to have gone needs. */
export interface Answering {
  once(event: 'close', listener: () => void): unknown
}

/**
 * What a Tade that sent a carry this one does not speak is told: an older one
 * reads it as it is, so it says what to do there.
 */
export const SCHEMA_SAID =
  'this Tade keeps settings in step both ways, and the one sending is older — update it (tade update), and it carries again by itself'

/**
 * The route: an owner's body read once, applied, answered. `carrying` absent
 * is a window that did not wire it, which is the `404` of a path nobody built.
 * `res` is the answer's, for what waits until it has gone.
 */
export async function carryHere(
  req: IncomingMessage,
  device: Device,
  carrying: WebCarrying | undefined,
  res: Answering,
): Promise<{ body: CarryAnswer } | { refusal: Refusal }> {
  if (carrying === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = CarryBody.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  // Refused before anything is written: a carry from a Tade that settles
  // settings another way would be half taken. `426` is what a newer sender
  // reads as "that one is newer", and these words are what an older one says.
  if (parsed.data.schema !== CARRY_SCHEMA) {
    return { refusal: { status: 426, error: 'malformed', said: SCHEMA_SAID } }
  }
  // Gone once it is written out, or once its connection is: either way nobody
  // is still reading it, and `close` comes for both.
  const answered = new Promise<void>((done) => res.once('close', () => done()))
  return { body: await applyCarry(parsed.data, device.id, carrying, answered) }
}

/** The hash each file's newest carry here wrote, by `fileNamed`. */
export function filesCarriedIn(lines: readonly CarryLine[]): Map<string, string> {
  const hashes = new Map<string, string>()
  for (const line of lines) {
    if (line.type !== 'carried_in') continue
    const { kind, name, version, hash } = line.detail ?? {}
    if ((kind !== 'persona' && kind !== 'template') || typeof name !== 'string') continue
    if (typeof hash !== 'string') continue
    hashes.set(fileNamed({ kind, name, ...(typeof version === 'number' ? { version } : {}) }), hash)
  }
  return hashes
}

/**
 * A `WebCarrying` over a home: the config file read as written, the journal
 * folded for what was carried before, files written into the home, and a line
 * for each. What writes a setting and what writes a line are handed in — the
 * window's one write path and its journal, or a far end's own.
 */
export function carryingAt(opts: {
  home: string
  configPath: string
  /** Every `config_changed` and `carried_in` line, oldest first. */
  lines: () => Promise<readonly CarryLine[]>
  write: WebCarrying['write']
  log: (line: { type: 'carried_in'; detail: Record<string, string | number> }) => Promise<void>
  signIns: WebCarrying['signIns']
  machine: string
  /**
   * When the Tade here started, and what waits for its next start. Absent,
   * nothing is said to wait, as an older Tade says nothing.
   */
  started?: number
  waiting?: WebCarrying['waiting']
  /** Talking from another screen here, and turning it on. Absent, nothing is said of it. */
  talk?: WebCarrying['talk']
  /** Paths the extensions here declared as keys. Absent, only a key's own name says it is one. */
  secrets?: WebCarrying['secrets']
  /**
   * The journal's door for a `config_changed` line: a hand edit found is
   * written down through it. Absent, one is compared as its old line says.
   */
  record?: (line: { type: 'config_changed'; detail: Record<string, string> }) => Promise<void>
  /** What a carry did that is news here. Absent, it is in the answer and nowhere else. */
  told?: WebCarrying['told']
}): WebCarrying {
  return {
    written: async () => {
      let text: string
      try {
        text = await readFile(opts.configPath, 'utf8')
      } catch (err) {
        // No file is a machine nobody has set up: nothing written, nothing ours.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw err
      }
      return parseYaml(text) ?? {}
    },
    changes: async () => changesIn(await opts.lines()),
    carriedFiles: async () => filesCarriedIn(await opts.lines()),
    write: opts.write,
    secrets: opts.secrets ?? (() => new Set()),
    found: async (edits) => {
      for (const one of edits) {
        await opts.record?.({ type: 'config_changed', detail: { ...one, by: 'file' } })
      }
    },
    told: opts.told ?? (async () => {}),
    file: (file) => fileThere(opts.home, file),
    put: async (file, by) => {
      await putFile(opts.home, file)
      await opts.log({
        type: 'carried_in',
        detail: {
          kind: file.kind,
          name: file.name,
          ...(file.kind === 'template' ? { version: file.version } : {}),
          hash: fileHash(file.text),
          by: `device ${by.device}`,
          from: by.from,
        },
      })
    },
    signIns: opts.signIns,
    machine: () => opts.machine,
    started: () => opts.started ?? Number.POSITIVE_INFINITY,
    waiting: opts.waiting ?? (() => new Set()),
    ...(opts.talk === undefined ? {} : { talk: opts.talk }),
  }
}

import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import {
  type CarriedFile,
  type CarryOutcome,
  carryDecision,
  carryOf,
  fileDecision,
  fileHash,
  fileNamed,
  fileThere,
  type LastChange,
  putFile,
  textOf,
  writtenAt,
} from '@tade/core'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// Another machine's Tade giving this one what it was set up with — its
// preferences, its personas and published templates, and on a press its keys —
// so a remote somebody added works like the machine they set up
// (`@tade/core`'s `carry.ts` has the decision for every key).
//
// **An owner's, and only on this machine's own door.** Like `presence`: the
// route is `here` (`routes.ts`), so it is answered only on the loopback
// listener for a loopback `Host`, which from anywhere else is an SSH
// connection, and only an owner device may use it — a session `tade web pair
// --owner` minted through that same SSH key. **It is the one route that can
// write a key, and that is what makes it no wider than what already was**:
// whoever holds that key can already `ssh` here and edit `config.yaml`. A
// phone's session, however much it was granted, is refused it.
//
// **This machine decides, not the one sending.** Every path is asked of
// `carryOf` again here, so a path that is this machine's own is refused
// whatever arrived; a value somebody here changed is left and said back
// (`theirs`) unless the person pressed for the other machine's to go over it;
// and a key arrives only as a digest to compare until somebody pressed to send
// it. Each write goes through the window's one write path, which writes the
// `config_changed` line, with the device it came from and never a key.
//
// **What goes back is never a key and never a sign-in.** A setting somebody
// changed here is said back as its value, unless it was carried on a press; a
// harness's sign-in is said as whether there is one and until when, read off
// the dates the harness wrote down — never the token beside them.

/** A dotted config path, as a carry names one. */
const Path = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)

const Leaf = z.union([
  z.strictObject({ path: Path, digest: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.strictObject({ path: Path, value: z.unknown().refine((value) => value !== undefined) }),
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
  /** What the machine sending calls itself, for the line written here. */
  from: z.string().min(1).max(120),
  /**
   * Whether `settings` is every preference that machine keeps in step, so that
   * one it no longer has is taken away here — where it is still the one it
   * carried, and nowhere else.
   */
  complete: z.boolean(),
  settings: z.array(Leaf).max(1_000),
  files: z.array(FileIn).max(200).default([]),
  /** Paths the person pressed for that machine's value to go over this one's. */
  force: z.array(z.string().max(220)).max(1_000).default([]),
})

export type CarryBody = z.infer<typeof CarryBody>

/** One setting, as it came out. */
export interface CarriedSetting {
  path: string
  outcome: CarryOutcome
  /** What it is here, where it is ours and may be shown: never for anything carried on a press. */
  theirs?: string
  /** Why not, where it was refused. Tade's own clause, or the config's. */
  why?: string
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
  /** What this machine calls itself. */
  machine: string
  settings: CarriedSetting[]
  files: CarriedFileOut[]
  signIns: SignInHere[]
  /** Why it could not say how its harnesses are signed in, where it could not. */
  unsaid?: string
}

/** The last line this machine wrote about one path, and which device's carry it was. */
export interface ChangeSeen extends LastChange {
  path: string
  /** The device whose carry wrote it, or null for anything else. */
  device: string | null
  /** When the line was written, in this machine's clock; null where it does not say. */
  at: number | null
}

/** Who a carried write is from, as its line says it. */
export interface CarriedBy {
  device: string
  /** What the machine that sent it calls itself. */
  from: string
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
}

/**
 * Apply one carry: every setting and file decided here, the ones to write
 * written, and the answer. Pure apart from what `carrying` does, which is the
 * window's.
 */
export async function applyCarry(
  body: CarryBody,
  device: string,
  carrying: WebCarrying,
): Promise<CarryAnswer> {
  const by: CarriedBy = { device, from: body.from }
  const written = await carrying.written()
  const changes = new Map((await carrying.changes()).map((one) => [one.path, one]))
  const forced = new Set(body.force)
  const settings: CarriedSetting[] = []
  const toWrite: { path: string; value: unknown; carry: 'kept' | 'pressed' }[] = []
  const sent = new Set(body.settings.map((one) => one.path))
  for (const leaf of body.settings) {
    const decided = carryOf(leaf.path)
    const current = writtenAt(written, leaf.path)
    const last = changes.get(leaf.path) ?? null
    const outcome = carryDecision({
      carry: decided.carry,
      incoming: 'digest' in leaf ? { digest: leaf.digest } : { value: leaf.value },
      current,
      last,
      force: forced.has(leaf.path),
    })
    if (outcome === 'refused') {
      settings.push({ path: leaf.path, outcome, why: decided.because })
      continue
    }
    if ((outcome === 'written' || outcome === 'replaced') && 'value' in leaf) {
      const carry = decided.carry === 'pressed' ? 'pressed' : 'kept'
      toWrite.push({ path: leaf.path, value: leaf.value ?? undefined, carry })
      settings.push({ path: leaf.path, outcome })
      continue
    }
    settings.push({
      path: leaf.path,
      outcome,
      ...(outcome === 'theirs' && decided.carry === 'kept' ? { theirs: shown(current) } : {}),
    })
  }
  // One that machine kept in step and no longer has: taken away here, where it
  // is still exactly what that device's carry wrote. Anything else is ours now.
  if (body.complete) {
    for (const change of changes.values()) {
      if (sent.has(change.path) || change.device !== device || !change.carried) continue
      if (carryOf(change.path).carry !== 'kept') continue
      const current = writtenAt(written, change.path)
      if (current === undefined || textOf(current) !== change.now) continue
      toWrite.push({ path: change.path, value: undefined, carry: 'kept' })
      settings.push({ path: change.path, outcome: 'written' })
    }
  }
  await writeAll(toWrite, settings, carrying, by)
  // What is here and not in use yet — written now, or already so since the Tade
  // running here started — where it is read only at a start: said back, so the
  // machine that carried it says that rather than "kept in step" alone.
  const started = carrying.started()
  const landed = settings.filter((one) => {
    if (one.outcome === 'written' || one.outcome === 'replaced') return true
    const at = changes.get(one.path)?.at ?? null
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
  return { machine: carrying.machine(), settings, files, ...said }
}

/**
 * Write them, and where one would not load, try it once more after the rest:
 * a route's name is checked against the routes, so `workers.default` can only
 * land after the route it names has. What still will not load is refused with
 * the config's own reason.
 */
async function writeAll(
  toWrite: readonly { path: string; value: unknown; carry: 'kept' | 'pressed' }[],
  settings: CarriedSetting[],
  carrying: WebCarrying,
  by: CarriedBy,
): Promise<void> {
  let waiting = [...toWrite]
  for (const round of [0, 1]) {
    const failed: typeof waiting = []
    for (const one of waiting) {
      try {
        await carrying.write(one.path, one.value, one.carry, by)
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

/** Somebody's value here, as it may be said back: cut, and never more than a line. */
function shown(value: unknown): string {
  const text = textOf(value).replace(/\s+/g, ' ')
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/**
 * The route: an owner's body read once, applied, answered. `carrying` absent
 * is a window that did not wire it, which is the `404` of a path nobody built.
 */
export async function carryHere(
  req: IncomingMessage,
  device: Device,
  carrying: WebCarrying | undefined,
): Promise<{ body: CarryAnswer } | { refusal: Refusal }> {
  if (carrying === undefined) return { refusal: refuse('no_such') }
  if (!device.owner) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = CarryBody.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  return { body: await applyCarry(parsed.data, device.id, carrying) }
}

/** A journal line, as much of one as the folds below read. */
export interface CarryLine {
  type: string
  /** When it was written, as the journal stamps it. */
  ts?: string
  detail?: Readonly<Record<string, unknown>>
}

/** The device a `by` names, where it names one: `device <id>`. */
function deviceIn(by: unknown): string | null {
  return typeof by === 'string' && by.startsWith('device ') ? by.slice('device '.length) : null
}

/**
 * The newest `config_changed` line per path, folded out of the journal — what
 * decides whether somebody here changed a value (`changedThere`). A carry's
 * own line says `carried`, which is what tells it from everyone else's.
 */
export function changesIn(lines: readonly CarryLine[]): ChangeSeen[] {
  const newest = new Map<string, ChangeSeen>()
  for (const line of lines) {
    if (line.type !== 'config_changed') continue
    const path = line.detail?.path
    if (typeof path !== 'string' || path === '') continue
    const carried = typeof line.detail?.carried === 'string'
    const at = line.ts === undefined ? Number.NaN : Date.parse(line.ts)
    newest.set(path, {
      path,
      now: typeof line.detail?.now === 'string' ? line.detail.now : String(line.detail?.now ?? ''),
      carried,
      device: carried ? deviceIn(line.detail?.by) : null,
      at: Number.isNaN(at) ? null : at,
    })
  }
  return [...newest.values()]
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
  }
}

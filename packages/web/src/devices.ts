import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { hostOf } from './guard.ts'
import type { Keeping } from './installable.ts'
import type { PasskeyStanding } from './passkeys.ts'
import { loopbackHost } from './surface.ts'
import { type Algorithm, CREDENTIAL_ID_MOST } from './webauthn.ts'

// The paired devices, in `<home>/web-devices.jsonl`: append-only, `0600`, a bad
// line skipped rather than thrown over.
//
// The same shape as `memory.jsonl` and for the same reasons: a file of lines is
// readable by a person, survives a crash mid-write with at most one line lost,
// and needs no migration. A device is paired, signed out or revoked by
// appending — never by rewriting — so the file is also the record of what
// happened to each one.
//
// **Every paired device is the person's own** (decided 26 Nov): a line says
// who a device is and how long its session lasts, never what it may read or
// do. Lines an older Tade wrote with `scopes`, `projects` and `granted` in
// them, and its `allowed` and `granted` lines, still parse — a file must
// still be the list of your devices — and say nothing any more.
//
// **What is in it, and what is not.** The digest of a session secret, never the
// secret: `sha256` of it and nothing else, so an agent that reads this file
// finds values it cannot mint a session from. That is the one reason hashing
// matters even though the file is readable by everything running as you, and
// `DEVICES_AND_AGENTS` (`surface.ts`) is the sentence about the rest of it.
//
// **One kind of row.** A session credential identifies a person's browser and
// nothing else may be one. A machine credential — an intake token, or anything
// like it — is its own kind, in its own file, with its own revocation. The
// schema below is strict, so a row of another kind fails the parse rather than
// becoming a device that cannot be disconnected.

/** What the file is called, under the home. */
export const DEVICES_FILE = 'web-devices.jsonl'

/** Where it is. Never inside a project: nothing Tade writes is. */
export function devicesPath(home: string): string {
  return join(home, DEVICES_FILE)
}

/**
 * What an older Tade wrote on a `paired` or `pending` line about what a device
 * might read and do. Read as any words, so a word this Tade no longer has
 * (`answer`, a grant's name) cannot make a device's line fail to parse, and
 * kept for nothing but `wasClear`.
 */
const Retired = {
  scopes: z.array(z.string().max(32)).max(32).optional(),
  projects: z.array(z.string()).nullable().optional(),
  granted: z.array(z.string().max(32)).max(32).optional(),
}

/**
 * What a `paired` or `pending` line written **outside the window** still
 * carries, for a window opened before every device was the person's own.
 *
 * `tade web pair` runs the code installed now, and a window keeps the code it
 * opened with for as long as it stays open — days, across an update. That
 * window's schema is strict and *requires* `scopes`, `projects` and `granted`,
 * so a line without them is a line it skips: the device `tade web pair` just
 * let in is refused as having no session until the window restarts, and the
 * only word of it is "1 line(s) of the paired-device list could not be read"
 * (TADE-Y, 28 Nov). So the two lines a shell writes for the window to read —
 * an owner (`mintOwner`) and a code (`writeCode`) — carry what that window's
 * `tade web pair` wrote by default: every scope and every grant it knew, and
 * every project. Nothing here reads them (`Retired`, `wasClear` does not look
 * at an owner's), and a line the window itself writes needs none of this,
 * because the window reads it with the same code that wrote it.
 *
 * Frozen: these are the older window's words, not this Tade's, and one it did
 * not know would fail its parse as surely as a missing key.
 */
export const FOR_AN_OLDER_WINDOW = {
  scopes: ['read', 'answer', 'steer', 'ask', 'draft', 'agents', 'projects', 'configure'],
  projects: null,
  granted: [
    'titles',
    'intent',
    'notes',
    'findings',
    'spend',
    'reviews',
    'accounts',
    'talk',
    'requests',
    'material',
    'workflows',
    'lanes',
    'settings',
  ],
} as const

/**
 * A device being paired.
 *
 * `label` is the phone's own suggestion and is **attacker-controlled text**:
 * stored verbatim, rendered with `textContent`, bounded here so a megabyte of
 * it cannot become a line in this file, and never put in a path, a header or a
 * log line.
 */
const PairedLine = z.strictObject({
  kind: z.literal('paired'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  label: z.string().max(120),
  /** `sha256` of the secret, hex. The secret itself is never written down. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** The exact `Host` this device paired on. A session is bound to it. */
  host: z.string().max(260),
  /** The CSRF token for this session, which is not a credential on its own. */
  csrf: z.string().max(120),
  /** When it stops being a session, as a moment. */
  until: z.string(),
  /**
   * Paired over an origin that is not trusted (`trusted`): its credential
   * crossed a network in the clear, so it reads and never acts, whatever is
   * turned on later (`Device.clear`).
   */
  clear: z.literal(true).optional(),
  ...Retired,
  /** The address it paired from, for the device list. Metadata, bounded. */
  from: z.string().max(64),
  /**
   * An owner device: minted by `tade web pair --owner` and nothing else, and an
   * owner only while its `host` is this machine's (`ownerOf`). `owner.ts` has
   * the argument.
   */
  owner: z.literal(true).optional(),
})

/**
 * A pairing code `tade web pair` wrote down: the digest of a one-time secret,
 * what the person at the terminal let it have, and the host its link names.
 *
 * Its `device` is the id the device will have once it is claimed, so the line
 * that ends it — `claimed`, or `revoked` before anybody claimed it — and the
 * device it became are one id in the list. `pending.ts` has the argument for a
 * ticket on a disk at all.
 */
const PendingLine = z.strictObject({
  kind: z.literal('pending'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  /** When the code stops being claimable, as a moment. */
  until: z.string(),
  /** `sha256` of the one-time secret. The secret is only ever in the link. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** The exact `Host` the link names. A claim made on any other is refused. */
  host: z.string().max(260),
  /** What it is called, where the person at the terminal said. Empty is the phone's word. */
  label: z.string().max(120),
  ...Retired,
})

/**
 * A written code, claimed: **the burn, on the disk**. Appended before the
 * device it becomes is, so a code that was presented is spent whatever
 * happens after — the in-memory ticket's ordering, kept across a restart.
 */
const ClaimedLine = z.strictObject({
  kind: z.literal('claimed'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  /** The address that presented it, for the list. Metadata, bounded. */
  from: z.string().max(64),
})

const RevokedLine = z.strictObject({
  kind: z.literal('revoked'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  /** Tade's own word for why, for the list and the journal. */
  why: z.enum(['signed out', 'revoked at the machine', 'everything disconnected']),
})

/**
 * A session re-issued because it was used: the sliding expiry, written down.
 *
 * A row rather than a rewrite, which is what keeps the file append-only. The
 * digest is unchanged — the credential in the phone did not move — so this is
 * only ever a later `until`.
 */
const RenewedLine = z.strictObject({
  kind: z.literal('renewed'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  until: z.string(),
})

/**
 * What an older Tade wrote when somebody at the machine ticked or unticked
 * what one device might do (`allowed`) or read (`granted`). Parsed so a file
 * with them in it is not a file with skipped lines, and folded into nothing:
 * every paired device is the person's own.
 */
const AllowedLine = z.object({
  kind: z.literal('allowed'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
})
const GrantedLine = z.object({
  kind: z.literal('granted'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
})

/**
 * A device's passkey, made on it in the minutes after it paired
 * (`passkeyed.ts`): the credential's id and its **public** key, which nothing
 * can sign with — so this line, unlike a session's digest, is worth nothing to
 * whoever reads it. One per device; a device that pairs again is a new device
 * and makes a new one.
 */
const PasskeyLine = z.strictObject({
  kind: z.literal('passkey'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  /** The credential's id, base64url, as the authenticator gave it. */
  id: z
    .string()
    .min(1)
    .max(Math.ceil((CREDENTIAL_ID_MOST * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/),
  /** Its public key, SPKI DER, base64url. */
  key: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9_-]+$/),
  alg: z.union([z.literal(-8), z.literal(-7), z.literal(-257)]),
  /** The signature counter it reported, nought for one that does not count. */
  counter: z.int().min(0).max(0xffffffff),
  /** Whether it may leave the device it was made on: a synced passkey. */
  synced: z.boolean(),
  /** How the browser said it can be reached again, as the browser said it. */
  transports: z.array(z.string().max(32)).max(8),
})

/**
 * A device used its passkey: **the moment acting from the public name is
 * measured from** (`passkey_hours`), and the counter it reported. Written on
 * the disk rather than held in memory, so a window that restarts does not ask
 * every phone again.
 */
const ProvedLine = z.strictObject({
  kind: z.literal('proved'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  counter: z.int().min(0).max(0xffffffff),
})

/**
 * What a machine that links here may call itself: what `machineLabel` makes
 * there — letters, digits, dots, dashes, underscores and spaces — bounded as a
 * label is. A grammar rather than any text, because the device's own word
 * about itself lands in every list that names it.
 */
export const DEVICE_NAME = /^[A-Za-z0-9._ -]{1,60}$/

/**
 * A device's own word for what it is called now (`seen.ts`): the label it
 * paired with, replaced — so a machine that paired under its host name, before
 * it had a name of its own, is not called by it for as long as it stays
 * paired. Only the device itself writes one, about itself; nothing else
 * about it moves.
 */
const NamedLine = z.strictObject({
  kind: z.literal('named'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  label: z.string().regex(DEVICE_NAME),
})

const Line = z.discriminatedUnion('kind', [
  PairedLine,
  RevokedLine,
  RenewedLine,
  AllowedLine,
  GrantedLine,
  PendingLine,
  ClaimedLine,
  PasskeyLine,
  ProvedLine,
  NamedLine,
])
export type DeviceLine = z.infer<typeof Line>
export type Paired = z.infer<typeof PairedLine>

/** A code written by the terminal and not yet claimed or revoked, as the fold has it. */
export interface PendingCode {
  id: string
  at: number
  /** When it stops being claimable. The fold has no clock: a reader compares. */
  until: number
  digest: string
  host: string
  label: string
}

/** A device as the rest of the program asks about one. */
export interface Device {
  id: string
  label: string
  digest: string
  host: string
  csrf: string
  /** When this session expires, as a moment. */
  until: number
  pairedAt: number
  /**
   * Paired in the clear: over an origin that was not trusted, so its
   * credential crossed a network anybody on it could read. **It reads and
   * never acts** (the guard's `locked`), whatever is trusted later — a
   * session is bound to the host it was minted on, and that host becoming an
   * `https` name the config trusts does not make the cookie a secret again.
   */
  clear: boolean
  from: string
  /** Null while it is live; Tade's own word for why once it is not. */
  revoked: string | null
  /** An owner device, bound to this machine (`ownerOf`). */
  owner: boolean
  /** The passkey it made, and when it last proved it — or null for none. */
  passkey: Passkey | null
}

/** A device's passkey, as the fold has it. */
export interface Passkey {
  id: string
  key: string
  alg: Algorithm
  counter: number
  synced: boolean
  transports: readonly string[]
  /** When it was made. */
  at: number
  /** When it was last used, which making it counts as. The fold has no clock: a reader compares. */
  proved: number
}

/**
 * The devices, folded out of the lines, newest state last.
 *
 * A fold rather than a lookup, which is the whole reason the file is a fold:
 * `renewed` moves an expiry, `revoked` ends a device, and a `paired` line for
 * an id that already exists replaces it — which is what pairing the same phone
 * twice does, and is correct, because the old credential is then unusable.
 *
 * A line that does not parse is **skipped**, with nothing thrown: a file one
 * truncated write has damaged must still be the list of your other devices,
 * and the alternative is a window that will not open because of a half-written
 * line about a phone somebody sold.
 */
export function devicesIn(text: string): {
  devices: Device[]
  skipped: number
  /** The codes the terminal wrote that nobody has claimed or revoked, expired ones too. */
  pending: PendingCode[]
} {
  const devices = new Map<string, Device>()
  const pending = new Map<string, PendingCode>()
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: DeviceLine
    try {
      parsed = Line.parse(JSON.parse(line))
    } catch {
      skipped++
      continue
    }
    if (parsed.kind === 'paired') {
      const owner = ownerOf(parsed)
      devices.set(parsed.device, {
        id: parsed.device,
        label: parsed.label,
        digest: parsed.digest,
        host: parsed.host,
        csrf: parsed.csrf,
        until: Date.parse(parsed.until),
        pairedAt: Date.parse(parsed.at),
        clear: !owner && (parsed.clear === true || wasClear(parsed)),
        from: parsed.from,
        revoked: null,
        owner,
        passkey: null,
      })
      continue
    }
    if (parsed.kind === 'pending') {
      pending.set(parsed.device, {
        id: parsed.device,
        at: Date.parse(parsed.at),
        until: Date.parse(parsed.until),
        digest: parsed.digest,
        host: parsed.host,
        label: parsed.label,
      })
      continue
    }
    // A code is ended by its claim or by a revoke, and either is the last word
    // on it: a `pending` line written again for the same id is a new code.
    if (parsed.kind === 'claimed' || parsed.kind === 'revoked') pending.delete(parsed.device)
    if (parsed.kind === 'claimed') continue
    const held = devices.get(parsed.device)
    if (held === undefined) {
      // A `revoked` or `renewed` for a device no `paired` line introduced. Not
      // a skip — the line parsed and says something true — and not a device,
      // because there is nothing to disconnect. It is counted as neither.
      continue
    }
    if (parsed.kind === 'revoked') devices.set(parsed.device, { ...held, revoked: parsed.why })
    else if (parsed.kind === 'allowed' || parsed.kind === 'granted') continue
    else if (parsed.kind === 'named') {
      devices.set(parsed.device, { ...held, label: parsed.label })
    } else if (parsed.kind === 'passkey') {
      const at = Date.parse(parsed.at)
      const { kind: _kind, device: _device, at: _at, ...kept } = parsed
      devices.set(parsed.device, { ...held, passkey: { ...kept, at, proved: at } })
    } else if (parsed.kind === 'proved') {
      // A proof of a passkey the device does not have proves nothing.
      if (held.passkey === null) continue
      const passkey = { ...held.passkey, proved: Date.parse(parsed.at), counter: parsed.counter }
      devices.set(parsed.device, { ...held, passkey })
    } else devices.set(parsed.device, { ...held, until: Date.parse(parsed.until) })
  }
  return { devices: [...devices.values()], skipped, pending: [...pending.values()] }
}

/**
 * Whether a `paired` line is an owner device: it says so, **and** the host it
 * is bound to is this machine's.
 *
 * The second half is the fold refusing a line that could only have been made
 * by hand: `tade web pair --owner` binds every owner to `localhost`, and an
 * owner bound to a public name would be the local arm reachable from the
 * internet. A line like that is still a device — the record says somebody let
 * it in — and an ordinary one.
 */
export function ownerOf(line: { owner?: true | undefined; host: string }): boolean {
  const name = hostOf(line.host)
  return line.owner === true && name !== null && loopbackHost(name)
}

/**
 * Whether a line an older Tade wrote says its device paired in the clear.
 *
 * That Tade wrote no `clear`: it wrote the scopes pairing minted, which the
 * origin's ceiling cut to `read` alone off a trusted origin. So a line with
 * scopes and none of them an act, for a host that is not this machine's, is
 * read as paired in the clear — the direction that takes authority away, since
 * a device narrowed to reading at the machine that way is one paired again in
 * a minute, and one whose cookie crossed a network must never act.
 */
function wasClear(line: Paired): boolean {
  if (line.scopes === undefined) return false
  const name = hostOf(line.host)
  if (name !== null && loopbackHost(name)) return false
  return line.scopes.every((scope) => scope === 'read')
}

/** The devices in the file, or none at all where there is no file yet. */
export async function readDevices(
  home: string,
): Promise<{ devices: Device[]; skipped: number; pending: PendingCode[] }> {
  let text: string
  try {
    text = await readFile(devicesPath(home), 'utf8')
  } catch {
    return { devices: [], skipped: 0, pending: [] }
  }
  return devicesIn(text)
}

/**
 * Append one line, with the mode narrowed on every write.
 *
 * Narrowed every time and not only at creation, which is the rule
 * `config.yaml` already follows: a file whose mode somebody widened once stays
 * wide for ever otherwise, and nothing would say so.
 */
export async function appendDevice(home: string, line: DeviceLine): Promise<void> {
  const path = devicesPath(home)
  await mkdir(dirname(path), { recursive: true })
  // Created with the mode it needs rather than created and then narrowed: the
  // gap between the two is a window in which the digests are world-readable.
  await appendFile(path, `${JSON.stringify(Line.parse(line))}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
}

/**
 * A device said what it is called now (`seen.ts`): written down where that is
 * not what the list already calls it. Whether one was written.
 */
export async function nameDevice(
  home: string,
  device: Pick<Device, 'id' | 'label'>,
  label: string,
  at: Date,
): Promise<boolean> {
  if (label === device.label) return false
  await appendDevice(home, { kind: 'named', device: device.id, at: at.toISOString(), label })
  return true
}

/**
 * Disconnect everything, which means exactly one thing.
 *
 * Every live device gets a `revoked` line. Nothing else is touched, no file is
 * deleted, and it needs no network — a phone that is off, lost or on another
 * continent is disconnected by this, because what it holds is checked here on
 * every request.
 */
export async function revokeAll(home: string, at: Date): Promise<string[]> {
  const { devices, pending } = await readDevices(home)
  const live = devices.filter((device) => device.revoked === null)
  // **And every code the terminal wrote that nobody claimed**, expired or not:
  // one is a credential nobody has used yet, and "everything" that left it
  // claimable would be one phone short of what it says. Not counted among the
  // devices, because none of them is one.
  for (const one of [...live.map((device) => device.id), ...pending.map((code) => code.id)]) {
    await appendDevice(home, {
      kind: 'revoked',
      device: one,
      at: at.toISOString(),
      why: 'everything disconnected',
    })
  }
  return live.map((device) => device.id)
}

/**
 * Write the file afresh from a set of lines. Tests, and nothing else.
 *
 * Here rather than in a test helper so that the mode is the one `appendDevice`
 * uses — a fixture that wrote `0644` would be a fixture kinder than reality
 * about the one property this file has.
 */
export async function writeDevices(home: string, lines: readonly DeviceLine[]): Promise<void> {
  const path = devicesPath(home)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), { mode: 0o600 })
  await chmod(path, 0o600)
}

/**
 * The device list as a device is told it: this one, and the others by label
 * and when they were last paired.
 *
 * No digest, no token but this device's own, no host and no address: what
 * another device is, from here, is a name and a date. **The whole list is
 * here** because seeing every device there is, is the real mitigation against
 * one having been minted by something on this machine (`DEVICES_AND_AGENTS`).
 *
 * `clear` is on `you` and on nothing else: a device paired in the clear reads
 * and never acts, so its page draws no control rather than a refusal. What it
 * may *actually* do is still decided at the act — the setting, the origin and
 * the state are all re-asked there — so this is a drawing hint and never an
 * authority.
 *
 * `shell` is beside the two rather than inside `you`, because it is a fact
 * about the machine and not about this device: whether it offers an installed
 * shell at all, and whether a page may keep a few counts on its own disk. Two
 * booleans and no cache names — those are spelt in the page's own files, since
 * the two moments they matter are a cold open with no answer and a session
 * that has just been refused.
 */
export function listing(
  me: Device,
  devices: readonly Device[],
  shell: Keeping,
  passkey: PasskeyStanding,
): Record<string, unknown> {
  return {
    shell,
    you: {
      device: me.id,
      label: me.label,
      clear: me.clear,
      csrf: me.csrf,
      until: new Date(me.until).toISOString(),
      // Whether acting from here asks for this device's passkey, and where it
      // stands: a drawing hint like `clear`, decided again at every act.
      passkey,
    },
    devices: devices
      .filter((one) => one.revoked === null)
      .map((one) => ({
        device: one.id,
        label: one.label,
        pairedAt: new Date(one.pairedAt).toISOString(),
        you: one.id === me.id,
      })),
  }
}

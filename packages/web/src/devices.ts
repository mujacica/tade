import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { GRANTS, readsOf } from './reach.ts'
import { reachOf, SCOPES } from './surface.ts'

// The paired devices, in `<home>/web-devices.jsonl`: append-only, `0600`, a bad
// line skipped rather than thrown over.
//
// The same shape as `memory.jsonl` and for the same reasons: a file of lines is
// readable by a person, survives a crash mid-write with at most one line lost,
// and needs no migration. A device is granted, signed out or revoked by
// appending — never by rewriting — so the file is also the record of what
// happened to each one.
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

const Granted = z.array(z.enum(GRANTS))

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
  /** What it may do. Narrowed by the origin it paired on and never widened. */
  scopes: z.array(z.enum(SCOPES)),
  /** Which projects it may read, or null for every one of them. */
  projects: z.array(z.string()).nullable(),
  /** What content it was granted beyond names and counts. */
  granted: Granted,
  /** The address it paired from, for the device list. Metadata, bounded. */
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
 * What a person at the machine granted this device beyond reading.
 *
 * **A line of its own, and the only way a scope widens.** Pairing mints
 * `read`, because a keypress with one question on it cannot honestly grant
 * more than that; letting a device *act* is a second decision, made at the
 * machine, about one device, and this is the record of it. A request can never
 * write one: nothing in `routes.ts` grants anything, which is DESIGN.md
 * §9.1's *pairing and scopes are never remote* — the thing that grants
 * authority is never reachable from inside the authority it granted.
 *
 * It is **not** a config key either, for the reason the read grants are not:
 * a setting would be one answer for every phone, and this is a sentence about
 * one. `surfaces.web.acting` is the different question of whether any of them
 * may, and both have to be true.
 *
 * Narrower is written the same way, so taking it back is a line rather than a
 * rewrite — the file stays append-only and stays the record of what happened.
 */
const AllowedLine = z.strictObject({
  kind: z.literal('allowed'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  /** What it may do now, in full. Never a delta: a list read back is the grant. */
  scopes: z.array(z.enum(SCOPES)),
})

const Line = z.discriminatedUnion('kind', [PairedLine, RevokedLine, RenewedLine, AllowedLine])
export type DeviceLine = z.infer<typeof Line>
export type Paired = z.infer<typeof PairedLine>

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
  scopes: readonly string[]
  projects: readonly string[] | null
  granted: readonly string[]
  from: string
  /** Null while it is live; Tade's own word for why once it is not. */
  revoked: string | null
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
export function devicesIn(text: string): { devices: Device[]; skipped: number } {
  const devices = new Map<string, Device>()
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
      devices.set(parsed.device, {
        id: parsed.device,
        label: parsed.label,
        digest: parsed.digest,
        host: parsed.host,
        csrf: parsed.csrf,
        until: Date.parse(parsed.until),
        pairedAt: Date.parse(parsed.at),
        scopes: parsed.scopes,
        projects: parsed.projects,
        granted: parsed.granted,
        from: parsed.from,
        revoked: null,
      })
      continue
    }
    const held = devices.get(parsed.device)
    if (held === undefined) {
      // A `revoked` or `renewed` for a device no `paired` line introduced. Not
      // a skip — the line parsed and says something true — and not a device,
      // because there is nothing to disconnect. It is counted as neither.
      continue
    }
    if (parsed.kind === 'revoked') devices.set(parsed.device, { ...held, revoked: parsed.why })
    else if (parsed.kind === 'allowed') {
      // **`read` is kept whatever the line says**, so a grant written without
      // it cannot take reading away by accident — widening what one device may
      // do and signing it out are different acts, and only one of them has a
      // control. Taking a grant back is an `allowed` line with less in it.
      const scopes = parsed.scopes.includes('read') ? parsed.scopes : ['read', ...parsed.scopes]
      devices.set(parsed.device, { ...held, scopes })
    } else devices.set(parsed.device, { ...held, until: Date.parse(parsed.until) })
  }
  return { devices: [...devices.values()], skipped }
}

/** The devices in the file, or none at all where there is no file yet. */
export async function readDevices(home: string): Promise<{ devices: Device[]; skipped: number }> {
  let text: string
  try {
    text = await readFile(devicesPath(home), 'utf8')
  } catch {
    return { devices: [], skipped: 0 }
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
 * Let one device act, or take it back. **A person at the machine, only.**
 *
 * Here beside the file rather than in the window, so that the one rule about a
 * grant — that `read` survives it — is in the same place as the fold that
 * reads one. The scopes are written in full: a list read back out of the file
 * is the whole of what that device may do, so there is no pair of lines whose
 * order decides the answer.
 */
export async function allowDevice(
  home: string,
  device: string,
  scopes: readonly string[],
  at: Date,
): Promise<void> {
  await appendDevice(home, {
    kind: 'allowed',
    device,
    at: at.toISOString(),
    scopes: z.array(z.enum(SCOPES)).parse(scopes),
  })
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
  const { devices } = await readDevices(home)
  const live = devices.filter((device) => device.revoked === null)
  for (const device of live) {
    await appendDevice(home, {
      kind: 'revoked',
      device: device.id,
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
 * `scopes` is on `you` and on nothing else, and it is what the page reads to
 * know whether to draw a control at all: a device that was granted `read` and
 * nothing else is one whose buttons are absent rather than refused. What it
 * may *actually* do is still decided at the act — the setting, the origin and
 * the state are all re-asked there — so this is a drawing hint and never an
 * authority.
 */
export function listing(me: Device, devices: readonly Device[]): Record<string, unknown> {
  return {
    you: {
      device: me.id,
      label: me.label,
      reads: readsOf(reachOf(me)),
      scopes: me.scopes,
      csrf: me.csrf,
      until: new Date(me.until).toISOString(),
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

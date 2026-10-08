import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { GRANTS } from './reach.ts'
import { SCOPES } from './surface.ts'

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

const Line = z.discriminatedUnion('kind', [PairedLine, RevokedLine, RenewedLine])
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
    else devices.set(parsed.device, { ...held, until: Date.parse(parsed.until) })
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

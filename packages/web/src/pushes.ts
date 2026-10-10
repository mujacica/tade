import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { ENDPOINT_BOUND } from './endpoint.ts'

// Which paired devices asked to be told, in `<home>/web-pushes.jsonl`:
// append-only, `0600`, a bad line skipped rather than thrown over.
//
// `devices.ts`'s file, shape and reasons, for a different kind of row — which
// is why it is a **second file and not a second line kind in the first**. A
// device record is a credential's digest and what a person granted; this is a
// third party's URL and two of the browser's own public keys. They are revoked
// by different acts, written at different moments, and the one rule this file
// has that the other does not is that a row here is only ever as good as the
// device row it names.
//
// **A subscription is bound to a paired device and is nothing on its own.**
// The id in every row is a device out of `web-devices.jsonl`, and `pushesFor`
// refuses to hand back a subscription whose device is gone or revoked — so
// signing a phone out stops its notifications with no network, no push service
// to ask and nothing to clean up, exactly as it stops its reading. There is no
// shape here in which a notification is sent to an endpoint nobody paired: the
// store is keyed by device, one row replaces the device's last one, and a row
// for a device that never paired is dropped by the fold.
//
// **What is in it, and what is not.** The endpoint, the two public keys the
// browser generated (`p256dh` and `auth`, which is what RFC 8291 encrypts to),
// and when. No payload, no title, nothing of the work, and nothing Tade
// signed with: the key notifications are signed with is one key for this
// machine and lives in `config.yaml` with every other key.
//
// **`auth` is called a key and is a secret of the browser's**, not of Tade's:
// it is the 16-byte authentication secret from the subscription, and anything
// holding it and the endpoint can send that phone a notification. So this file
// is `0600` like the device list and for the same reason, with the same
// sentence about what that does and does not cover (`DEVICES_AND_AGENTS`).

/** What the file is called, under the home. */
export const PUSHES_FILE = 'web-pushes.jsonl'

/** Where it is. Never inside a project: nothing Tade writes is. */
export function pushesPath(home: string): string {
  return join(home, PUSHES_FILE)
}

/**
 * A device asking to be told.
 *
 * Every string is bounded here as well as validated where it arrives, so a
 * megabyte of anything cannot become a line in this file. `endpoint` is
 * **attacker-shaped** — it decides what this machine connects to — and is held
 * to `endpointAllowed` at the moment it arrives *and* at the moment it is sent
 * to, because a file an agent on this machine can append to is not a file
 * whose contents are an authority (`DEVICES_AND_AGENTS`).
 */
const SubscribedLine = z.strictObject({
  kind: z.literal('subscribed'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  /** Where the push service wants the POST. Re-checked on every send. */
  endpoint: z.string().min(1).max(ENDPOINT_BOUND),
  /** The browser's own P-256 public key, base64url. 65 bytes decoded. */
  p256dh: z.string().min(1).max(200),
  /** The browser's own authentication secret, base64url. 16 bytes decoded. */
  auth: z.string().min(1).max(60),
})

/**
 * A subscription that is no longer one, and Tade's own word for why.
 *
 * Five reasons and not one, because they are five different things to read
 * back: the person said no on the phone, the push service said the
 * subscription is gone, the device was signed out here, the setting went off,
 * or the key was rotated. The one that matters most is `gone at the push
 * service`, which is a `404` or `410` written down rather than retried for
 * ever.
 */
const ForgotLine = z.strictObject({
  kind: z.literal('forgot'),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  at: z.string(),
  why: z.enum([
    'taken back on the device',
    'gone at the push service',
    'signed out',
    'turned off here',
    'the signing key changed',
  ]),
})

const Line = z.discriminatedUnion('kind', [SubscribedLine, ForgotLine])
export type PushLine = z.infer<typeof Line>

/** Tade's own words for why a subscription stopped being one. */
export type Forgetting = z.infer<typeof ForgotLine>['why']

/** One device's subscription, as the rest of the program asks about one. */
export interface Push {
  device: string
  endpoint: string
  p256dh: string
  auth: string
  at: number
  /** Null while it is live; Tade's own word for why once it is not. */
  forgotten: Forgetting | null
}

/**
 * The subscriptions, folded out of the lines, newest state last.
 *
 * One per device, and a later `subscribed` replaces the one before it — which
 * is what a browser does when it renews a subscription, and is correct,
 * because the old endpoint stops working the moment it does.
 *
 * A line that does not parse is **skipped**, with nothing thrown, for
 * `devicesIn`'s reason: a file one truncated write has damaged must still be
 * the list of your other subscriptions.
 */
export function pushesIn(text: string): { pushes: Push[]; skipped: number } {
  const pushes = new Map<string, Push>()
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: PushLine
    try {
      parsed = Line.parse(JSON.parse(line))
    } catch {
      skipped++
      continue
    }
    if (parsed.kind === 'subscribed') {
      pushes.set(parsed.device, {
        device: parsed.device,
        endpoint: parsed.endpoint,
        p256dh: parsed.p256dh,
        auth: parsed.auth,
        at: Date.parse(parsed.at),
        forgotten: null,
      })
      continue
    }
    const held = pushes.get(parsed.device)
    // A `forgot` for a device nothing subscribed. Not a skip — the line parsed
    // and says something true — and not a subscription, because there is
    // nothing to forget. Counted as neither, exactly as `devicesIn` does.
    if (held === undefined) continue
    pushes.set(parsed.device, { ...held, forgotten: parsed.why })
  }
  return { pushes: [...pushes.values()], skipped }
}

/** The subscriptions in the file, or none at all where there is no file yet. */
export async function readPushes(home: string): Promise<{ pushes: Push[]; skipped: number }> {
  let text: string
  try {
    text = await readFile(pushesPath(home), 'utf8')
  } catch {
    return { pushes: [], skipped: 0 }
  }
  return pushesIn(text)
}

/**
 * Append one line, with the mode narrowed on every write.
 *
 * `appendDevice`'s rule and its reason: created with the mode it needs rather
 * than created and then narrowed, because the gap between the two is a window
 * in which a phone's `auth` secret is world-readable.
 */
export async function appendPush(home: string, line: PushLine): Promise<void> {
  const path = pushesPath(home)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(Line.parse(line))}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
}

/**
 * Write the file afresh from a set of lines. Tests, and nothing else.
 *
 * Here rather than in a test helper so the mode is the one `appendPush` uses —
 * a fixture that wrote `0644` would be a fixture kinder than reality about the
 * one property this file has.
 */
export async function writePushes(home: string, lines: readonly PushLine[]): Promise<void> {
  const path = pushesPath(home)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), { mode: 0o600 })
  await chmod(path, 0o600)
}

/** What a device has to be for its subscription to count: paired, and still. */
export interface Pairing {
  id: string
  revoked: string | null
}

/**
 * The subscriptions that may be sent to: live, and belonging to a device that
 * is still paired.
 *
 * **The binding, in one function, so nothing else has to remember it.** A
 * subscription is not an address Tade may notify; it is a thing one paired
 * device asked for. So a row whose device was signed out, revoked or never
 * existed is not a subscription here — which is what makes "signing a device
 * out stops its notifications" true with no network and no push service to
 * ask, and is why `sendable` is the only way the sender ever gets a list.
 */
export function sendable(
  pushes: readonly Push[],
  devices: readonly Pairing[],
): { pushes: Push[]; orphaned: string[] } {
  const live = new Set(devices.filter((one) => one.revoked === null).map((one) => one.id))
  const out: Push[] = []
  const orphaned: string[] = []
  for (const push of pushes) {
    if (push.forgotten !== null) continue
    if (!live.has(push.device)) {
      // **Named rather than passed over.** A subscription whose device is gone
      // is the one case where the file and the device list disagree, and the
      // window writes a `forgot` for it — so a phone somebody sold does not
      // leave a row the next reader has to work out the meaning of.
      orphaned.push(push.device)
      continue
    }
    out.push(push)
  }
  return { pushes: out, orphaned }
}

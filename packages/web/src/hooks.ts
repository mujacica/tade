import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { HookAddress, HookSource } from '@tade/core'

// What one webhook delivery is, checked before anything in it is believed: the
// signature over its raw bytes, the window its source allows, and the address
// it is about (REMOTE-TADE.md §6.1, §6.2).
//
// **Pure, so every way a delivery can be wrong is a row** in
// `test/hooks.test.ts` rather than a request somebody remembered to make —
// bytes, headers, a secret and a moment in, an answer out. The door that reads
// a delivery off a socket and answers it is `hooked.ts`.
//
// Per source, because each signs differently:
//
// - **GitHub**: `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the raw
//   body; no timestamp at all (GitHub never retries, so a replay is the only
//   old delivery there is, and the ring of ids in `hooked.ts` is what meets
//   it); `X-GitHub-Delivery` names it.
// - **Slack**: `X-Slack-Signature: v0=<hex>`, an HMAC-SHA256 of
//   `v0:<timestamp>:<body>`, refused five minutes either side of now, as
//   Slack's own verification guide says; `event_id` names it.
// - **Linear**: `Linear-Signature: <hex>`, an HMAC-SHA256 of the raw body,
//   with the body's `webhookTimestamp` refused past a minute, as Linear's own
//   guide says; `Linear-Delivery` names it.
//
// **Nothing is parsed until the signature has verified.** A body nobody signed
// is bytes: parsing a stranger's megabytes is the one thing worth not doing for
// them, and nothing a forged body says can then reach anything. Each signature
// is compared with `timingSafeEqual`, so how much of a guess was right does not
// leak through how long the refusal took.
//
// **The address is the whole of what is read out of a delivery** — which
// repository, channel or team, and what kind of thing happened — and it only
// ever picks which schedule looks now. The look reads the real thing.

/**
 * The largest delivery read. The events a doorbell needs are small — the
 * largest is a pull request, whose body GitHub caps at 65,536 characters —
 * and GitHub's own cap is 25 MB, so a larger one is answered `200` and left
 * unread rather than refused: the source would only send it again, and the
 * poll finds whatever it was about.
 */
export const HOOK_BODY_MAX = 2 * 1024 * 1024

/** How far a Slack request's timestamp may be from now, either way. */
export const SLACK_WINDOW_MS = 5 * 60_000

/** How old a Linear delivery's `webhookTimestamp` may be. */
export const LINEAR_WINDOW_MS = 60_000

/** One delivery as the checks see it: its headers, its raw bytes, the secret and the moment. */
export interface HookDelivery {
  /** One header's value, or null — a repeated header is null, as everywhere here. */
  header: (name: string) => string | null
  raw: Buffer
  secret: string
  now: number
}

/** What a delivery came to. */
export type HookChecked =
  | {
      ok: true
      /** The source's own id for it, or '' where it sent none: what the ring is kept by. */
      delivery: string
      /** What kind of thing happened, as a bounded word. */
      event: string
      /** What it rings, or null where it is about nothing a watch reads: Slack's URL check. */
      address: HookAddress | null
      /** What the source is answered with: `{}`, or Slack's challenge back. */
      answer: Record<string, unknown>
    }
  | {
      ok: false
      /** Why, in a word for the journal: never shown to the sender. */
      why: 'unsigned' | 'signature' | 'stale' | 'unreadable'
      /** Whether the signature verified all the same — only ever for an unreadable body. */
      verified: boolean
    }

/** Check one delivery from one source. Never throws: a body is somebody else's. */
export function checkDelivery(source: HookSource, delivery: HookDelivery): HookChecked {
  return CHECKS[source](delivery)
}

/**
 * Sixteen hex digits of a digest of a delivery's id, for the journal and the
 * ring: enough to tell two apart, and nothing of the source's handle on it.
 */
export function deliveryDigest(id: string): string {
  return id === '' ? '' : createHash('sha256').update(id).digest('hex').slice(0, 16)
}

const CHECKS: Readonly<Record<HookSource, (delivery: HookDelivery) => HookChecked>> = {
  github(delivery) {
    const sent = delivery.header('x-hub-signature-256')
    if (sent === null || !sent.startsWith('sha256=')) return no('unsigned')
    if (!same(sent.slice('sha256='.length), signed(delivery.secret, delivery.raw))) {
      return no('signature')
    }
    const body = githubBody(delivery.raw, delivery.header('content-type'))
    if (body === null) return no('unreadable', true)
    const event = wordOf(delivery.header('x-github-event'))
    return {
      ok: true,
      delivery: delivery.header('x-github-delivery') ?? '',
      event,
      address: { source: 'github', event, where: repositoryOf(body.repository) },
      answer: {},
    }
  },

  slack(delivery) {
    const sent = delivery.header('x-slack-signature')
    const stamp = delivery.header('x-slack-request-timestamp')
    if (sent === null || stamp === null || !sent.startsWith('v0=') || !/^\d{1,12}$/.test(stamp)) {
      return no('unsigned')
    }
    const base = Buffer.concat([Buffer.from(`v0:${stamp}:`, 'utf8'), delivery.raw])
    if (!same(sent.slice('v0='.length), signed(delivery.secret, base))) return no('signature')
    if (Math.abs(delivery.now - Number(stamp) * 1000) > SLACK_WINDOW_MS) return no('stale')
    const body = objectOf(jsonOf(delivery.raw))
    if (body === null) return no('unreadable', true)
    // Answered only once the signature verified, so the signing secret is in
    // before anybody presses Verify in Slack — and it rings nothing.
    if (body.type === 'url_verification') {
      const challenge = typeof body.challenge === 'string' ? body.challenge.slice(0, 200) : ''
      return {
        ok: true,
        delivery: '',
        event: 'url_verification',
        address: null,
        answer: { challenge },
      }
    }
    const inner = objectOf(body.event) ?? {}
    const event = wordOf(body.type === 'event_callback' ? inner.type : body.type)
    const channel = typeof inner.channel === 'string' ? inner.channel.trim().toUpperCase() : ''
    return {
      ok: true,
      delivery: typeof body.event_id === 'string' ? body.event_id : '',
      event,
      address: {
        source: 'slack',
        event,
        where: /^[CGD][A-Z0-9]{2,40}$/.test(channel) ? channel : null,
      },
      answer: {},
    }
  },

  linear(delivery) {
    const sent = delivery.header('linear-signature')
    if (sent === null) return no('unsigned')
    if (!same(sent, signed(delivery.secret, delivery.raw))) return no('signature')
    const body = objectOf(jsonOf(delivery.raw))
    if (body === null) return no('unreadable', true)
    const at = body.webhookTimestamp
    // Old, and from the future too: a clock that far out is not a delivery to
    // trust the moment of, and a replay stamped ahead would otherwise pass.
    if (typeof at !== 'number' || Math.abs(delivery.now - at) > LINEAR_WINDOW_MS) {
      return no('stale')
    }
    const event = wordOf(body.type)
    return {
      ok: true,
      delivery: delivery.header('linear-delivery') ?? '',
      event,
      address: { source: 'linear', event, where: teamOf(objectOf(body.data)) },
      answer: {},
    }
  },
}

function no(why: 'unsigned' | 'signature' | 'stale' | 'unreadable', verified = false): HookChecked {
  return { ok: false, why, verified }
}

/** The HMAC-SHA256 of some bytes under a secret, as lower-case hex. */
function signed(secret: string, bytes: Buffer): string {
  return createHmac('sha256', secret).update(bytes).digest('hex')
}

/** Whether a hex signature that was sent is the one that was made, in constant time. */
function same(sent: string, made: string): boolean {
  const got = Buffer.from(sent.trim().toLowerCase(), 'utf8')
  const want = Buffer.from(made, 'utf8')
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * GitHub's body: JSON, or the form a repository webhook sends by default
 * (`payload=<json>`), because whichever content type somebody picked in the
 * repository's settings is one GitHub signed.
 */
function githubBody(raw: Buffer, type: string | null): Record<string, unknown> | null {
  const form =
    (type ?? '').split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded'
  if (!form) return objectOf(jsonOf(raw))
  const payload = new URLSearchParams(raw.toString('utf8')).get('payload')
  return payload === null ? null : objectOf(jsonOf(Buffer.from(payload, 'utf8')))
}

/**
 * Which repository a GitHub delivery is about, spelt as `repositoryNamed`
 * spells one — `github.com/owner/name`, lower-cased — out of its web address,
 * which names the host for GitHub Enterprise too; null where it names none.
 */
function repositoryOf(value: unknown): string | null {
  const repository = objectOf(value)
  if (repository === null) return null
  // Not an address falls back to the name below.
  if (typeof repository.html_url === 'string' && URL.canParse(repository.html_url)) {
    const url = new URL(repository.html_url)
    const parts = url.pathname
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean)
    if (url.protocol === 'https:' && parts.length === 2) {
      return `${url.hostname}/${parts.join('/')}`.toLowerCase()
    }
  }
  const named = typeof repository.full_name === 'string' ? repository.full_name : ''
  return /^[\w.-]+\/[\w.-]+$/.test(named) ? `github.com/${named}`.toLowerCase() : null
}

/**
 * Which team a Linear delivery is about, as its key — `ENG` — out of the
 * team it carries, or the identifier of the issue it is or is about
 * (`ENG-412`); null where it carries neither.
 */
function teamOf(data: Record<string, unknown> | null): string | null {
  if (data === null) return null
  const issue = objectOf(data.issue)
  const said = [
    objectOf(data.team)?.key,
    keyOf(data.identifier),
    objectOf(issue?.team)?.key,
    keyOf(issue?.identifier),
  ].find(
    (one): one is string => typeof one === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(one),
  )
  return said === undefined ? null : said.toUpperCase()
}

/** The team key out of an issue's identifier, `ENG-412` → `ENG`. */
function keyOf(value: unknown): string | null {
  return typeof value === 'string' ? (/^([A-Za-z0-9_]+)-\d+$/.exec(value)?.[1] ?? null) : null
}

/** A bounded word for the journal, or `other`: a delivery's kind, never a sentence of anybody's. */
function wordOf(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : 'other'
}

/** A body's JSON, or null for one that is not, which its caller answers as `unreadable`. */
function jsonOf(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch (problem) {
    if (problem instanceof SyntaxError) return null
    throw problem
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

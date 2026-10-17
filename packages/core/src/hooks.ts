import type { TadeEvent } from './events.ts'
import type { IntakeSource } from './intake.ts'
import { type Due, dueNow, intervalOf, type When } from './schedule.ts'

// Webhooks as a doorbell (REMOTE-TADE.md §6.1, §6.2): what a delivery from a
// source outside this machine is, which watch it may wake, the line it leaves,
// and how the poll beside it slows once deliveries are known to arrive.
//
// **A delivery never becomes work by itself. It makes the matching watch look
// now.** The watch's `check` stays the only thing that reads a request — with
// Tade's own credentials, through the grant, deduplicated by the key Tade
// already keeps, and `propose` parking it — so no intake rule changes. Four
// facts make that the right shape rather than a cautious one: a delivery Tade
// missed is lost (GitHub never retries one, Linear gives up after six hours),
// so the poll has to stay; a payload is a claim and not the record (GitHub
// works `mergeable` out lazily, Linear's comments are editable); a forged
// delivery can then only make Tade look sooner, with its own credentials and
// at its own pace; and who asked is read from the source, never from a
// stranger's body.
//
// **What a delivery carries here is an address** — which repository, channel
// or team it is about, and what kind of thing happened there. That is enough
// to pick the schedule to wake, and it is never written down or handed on: the
// look reads the real thing.
//
// Pure: no I/O and no clock. The door that reads a delivery is `@tade/web`'s
// `hooked.ts`, over the checks in `hooks.ts` beside it; the window's half that
// wakes a schedule is `wire/doorbell.ts`.

/**
 * The sources a delivery may come from: the intake sources that live off this
 * machine. The local door has nothing to ring — a file in the spool is found by
 * the next look, which is five minutes away and costs nothing.
 */
export const HOOK_SOURCES = ['github', 'slack', 'linear'] as const satisfies readonly IntakeSource[]
export type HookSource = (typeof HOOK_SOURCES)[number]

/**
 * The secret each source signs its deliveries with: a key of the intake
 * extension's own (`extensions.intake.<key>`), its environment variable winning
 * as every key's does (`findSecret`).
 *
 * **A source with no secret has no doorbell**, and that is the switch: its
 * route answers the `404` of a path nobody built. There is no setting that
 * turns deliveries on beside it, because one would only ever be on with a
 * secret and off without one — and a delivery nobody can verify is one nobody
 * may act on, however much a setting said yes.
 *
 * One table, read by the extension that declares the keys and the window that
 * reads them, so the two can never name a different variable.
 */
export const HOOK_SECRETS: Readonly<
  Record<HookSource, { key: string; env: string; means: string }>
> = {
  github: {
    key: 'github_webhook_secret',
    env: 'GITHUB_WEBHOOK_SECRET',
    means:
      'the secret a GitHub webhook signs its deliveries with, where this machine has a public name: a delivery to /hooks/github only makes the GitHub watch look now',
  },
  slack: {
    key: 'slack_signing_secret',
    env: 'SLACK_SIGNING_SECRET',
    means:
      'the Slack app’s signing secret (Basic Information), where this machine has a public name: an event at /hooks/slack only makes the Slack watch look now',
  },
  linear: {
    key: 'linear_webhook_secret',
    env: 'LINEAR_WEBHOOK_SECRET',
    means:
      'the signing secret of a Linear webhook, where this machine has a public name: a delivery to /hooks/linear only makes the Linear watch look now',
  },
}

/** What one delivery that verified is about: never more than it takes to pick a schedule. */
export interface HookAddress {
  source: HookSource
  /**
   * What happened there, as the source names it — `issues`, `app_mention`,
   * `Issue` — and `ping` for a hook saying it is there.
   */
  event: string
  /**
   * Where: `github.com/owner/repo` as `repositoryNamed` spells a repository, a
   * Slack channel id, a Linear team key — or null where the delivery named none
   * that could be read out of it.
   */
  where: string | null
}

/**
 * What rings a watch: declared on it (`ExtensionWatch.doorbell`), never worked
 * out from what it looks at.
 */
export interface WatchDoorbell {
  source: HookSource
  /**
   * The kinds of delivery that can change what its look finds. Anything else
   * from that source wakes nothing, because a look it cannot change is a
   * request spent on nothing. `ping` always rings: it is the source saying the
   * hook is there, and a look on it is how a person sees it work.
   */
  events: readonly string[]
  /**
   * The input a delivery's `where` is compared with — `channel`, `team` — and
   * unsaid, the project's own repository, which is what a watch with no
   * repository input reads.
   */
  input?: string
}

/**
 * Whether one delivery is about what one schedule watches.
 *
 * **A delivery that named nowhere rings every schedule of its kind.** Waking
 * one too many is a look that finds nothing new; waking one too few is the
 * delivery lost, which is the one thing a doorbell must not do. Case does not
 * count: a Slack channel id, a Linear team key and a repository are each one
 * thing however they are spelt.
 */
export function doorbellRings(
  bell: WatchDoorbell,
  address: HookAddress,
  about: { input: Readonly<Record<string, unknown>>; repository: string | null },
): boolean {
  if (bell.source !== address.source) return false
  if (address.event !== 'ping' && !bell.events.includes(address.event)) return false
  if (address.where === null) return true
  const here =
    bell.input === undefined ? about.repository : String(about.input[bell.input] ?? '').trim()
  return here !== null && here !== '' && here.toLowerCase() === address.where.toLowerCase()
}

/**
 * The line one delivery leaves: `hook_rung`.
 *
 * **Never the payload**: it is a stranger's text, and the look reads the real
 * thing anyway. Never the delivery's own id either, which is the source's
 * handle on it — a digest is enough to tell two apart and says nothing else.
 */
export type HookRung = {
  source: HookSource
  /** Sixteen hex digits of a digest of the source's delivery id, or '' where there is none to name. */
  delivery: string
  /** Whether its signature verified, inside its source's window: the only thing a delivery proves. */
  verified: boolean
  /** What the source said it was about, where it verified. Bounded, and a word, never a sentence. */
  event?: string
  /** The schedules it woke, by id. Empty is a delivery about nothing watched here. */
  woke?: readonly string[]
  /** Why it woke nothing though it verified (`duplicate`), or why it did not verify. */
  why?: string
  /** How many deliveries this line stands for, where refusals were counted rather than each written. */
  found?: number
}

/** A `hook_rung` line read back, or null for a line that is not one. A line is a line somebody wrote. */
export function rungFrom(event: Pick<TadeEvent, 'type' | 'detail'>): HookRung | null {
  if (event.type !== 'hook_rung') return null
  const { source, verified, woke } = event.detail
  if (!(HOOK_SOURCES as readonly unknown[]).includes(source) || typeof verified !== 'boolean') {
    return null
  }
  return {
    source: source as HookSource,
    delivery: typeof event.detail.delivery === 'string' ? event.detail.delivery : '',
    verified,
    woke: Array.isArray(woke) ? woke.filter((one): one is string => typeof one === 'string') : [],
  }
}

/**
 * What the journal says of one schedule's doorbell, once one has rung for it.
 *
 * Three moments, because "it works" is a fact about the newest of them: a
 * delivery that verified woke it; its source sent one that did not verify
 * (a secret rotated at one end, or somebody guessing); or a look the doorbell
 * did not ring for found something new — the poll finding what no delivery
 * said, which is the hook broken (REMOTE-TADE §6.4).
 */
export interface Bell {
  source: HookSource
  /** When a delivery that verified last woke it. */
  woke: number
  /** When its source last sent one that did not verify; null for never. */
  refused: number | null
  /** When a look nothing rang for last found something new; null for never. */
  missed: number | null
}

/** Whether deliveries are known to arrive for it: the newest of the three moments is a wake. */
export function bellStands(bell: Bell | undefined): boolean {
  if (bell === undefined) return false
  return (
    bell.woke > (bell.refused ?? Number.NEGATIVE_INFINITY) &&
    bell.woke > (bell.missed ?? Number.NEGATIVE_INFINITY)
  )
}

/**
 * How often a watch whose doorbell stands polls: once an hour, the safety
 * net, because a delivery missed is lost and the poll is what finds it.
 * REMOTE-TADE §14 decision 13.
 */
export const BELL_EVERY = '1h'
const BELL_MS = 3_600_000

/**
 * The rule a watch polls by now: hourly while its doorbell stands, where it
 * would otherwise poll oftener — and its own in every other case, so a watch
 * that already looks once a day is never made to look oftener.
 */
export function bellWhen(when: When, bell: Bell | undefined): When {
  if (!bellStands(bell) || when.every === undefined) return when
  const interval = intervalOf(when.every)
  return interval !== null && interval < BELL_MS ? { ...when, every: BELL_EVERY } : when
}

/**
 * Whether a watch's poll is due, for a watch a doorbell has rung for.
 *
 * `dueNow` itself where none ever has, so nothing changes for a watch with no
 * doorbell. Where one has: the hourly rule while it stands; and **nothing a
 * doorbell made unnecessary is counted as missed** — not the moments before
 * the newest look of any kind (a delivery's look is a look), and not the ones
 * that passed while it stood and before it fell, which were left out on
 * purpose rather than while Tade was closed.
 */
export function bellDue(
  schedule: { when: When; missed: 'once' | 'skip'; created: string },
  last: number | null,
  ran: number,
  now: number,
  watched?: { bell?: Bell; looks: readonly { at: number }[] },
): Due | null {
  const bell = watched?.bell
  if (bell === undefined) return dueNow(schedule, last, ran, now)
  const fell = bellStands(bell)
    ? Number.NEGATIVE_INFINITY
    : Math.max(bell.refused ?? Number.NEGATIVE_INFINITY, bell.missed ?? Number.NEGATIVE_INFINITY)
  const after = Math.max(
    last ?? Number.NEGATIVE_INFINITY,
    watched?.looks[0]?.at ?? Number.NEGATIVE_INFINITY,
    fell,
  )
  const when = bellWhen(schedule.when, bell)
  return dueNow({ ...schedule, when }, Number.isFinite(after) ? after : null, ran, now)
}

/**
 * What a schedule's row says about its doorbell, after when it runs: a clause,
 * or nothing where none has rung. The clause says which way it went and why,
 * because "polls as it says" with no reason is a hook somebody cannot fix.
 */
export function bellSaid(bell: Bell | undefined): string {
  if (bell === undefined) return ''
  if (bellStands(bell)) return ` — ${bell.source} rings it, so it polls hourly`
  const refused =
    (bell.refused ?? Number.NEGATIVE_INFINITY) >= (bell.missed ?? Number.NEGATIVE_INFINITY)
  return refused
    ? ` — ${bell.source} sent a delivery that did not verify, so it polls as it says`
    : ' — a poll found what no delivery rang for, so it polls as it says'
}

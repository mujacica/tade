import type { Step } from './readiness.ts'
import type { WatchOffered } from './schedule.ts'

// Which watches to suggest, and what each one costs to say yes to.
//
// Nothing is watched until somebody turns it on, and nothing suggests them —
// so a person has to find out that watches exist before they can want one.
// That is what setting up is for, and it is the one moment where asking is
// not a nag: the question is asked once, on a machine nobody has decided
// anything on yet.
//
// A wizard with fifteen questions is one people skip, so this is a rule rather
// than a screen: every watch comes back with what it does, how often it looks,
// what being on costs, and whether it is ticked when the question appears.
// The cost is the whole of the honesty here — a watch that starts agents on
// what it finds says that, because work queued by a clock nobody agreed to is
// the surprise at three in the morning.
//
// Pure: offers in, choices out. Nothing here writes a schedule or asks
// anybody anything.

/**
 * Whether the first minute should offer the watches at all.
 *
 * Only where it is deciding the extensions, which is the whole of how this
 * avoids becoming the step people learn to skip: the extensions step is
 * finished for good once every extension has been decided about, so the
 * question is asked on a machine where nothing has been decided and never
 * again. A wizard that asks every time about something you said no to last
 * week is one people press through without reading.
 *
 * It is not a step of its own for the same reason: a step has to know when it
 * is done, and nothing records "I was offered the watches and said no" — the
 * one thing that does record a decision about a watch is its schedule, and
 * writing a paused schedule for every watch somebody declined would fill the
 * queue with rows nobody asked for.
 */
export function askAboutWatches(steps: readonly Step[]): boolean {
  return steps.some((step) => step.id === 'extensions' && !step.done)
}

/** What being on costs, for a watch that puts work in the queue by itself. */
export const STARTS_AGENTS = 'starts an agent on each thing it finds'

/** And for one that only ever tells somebody. */
export const ONLY_TELLS = 'tells you what it finds, and starts nothing'

/**
 * What a watch that has to be told something needs first, said where it is
 * offered rather than left as a blank tick.
 *
 * **Not a readiness problem and not its extension's**: the extension is fine
 * and the watch works, it just has no answer until somebody says which
 * repository, which label, which board. It matters here because this is the
 * one place that offers watches in bulk and has nothing to give them — a
 * schedule written with no input is a watch that fails at every look, under a
 * name somebody then has to find and remove.
 *
 * It is also what keeps a connector from being turned on by a person pressing
 * enter. A source that must be told its label cannot be switched on by a
 * wizard at all, which is a stronger guarantee than a watch that is merely
 * never ticked: `ticked` is about what a default agrees to, and this is about
 * there being nothing to agree to yet.
 */
export function mustBeTold(needs: readonly string[]): string {
  return `has to be told ${needs.join(' and ')} first — Settings › Extensions`
}

/** A watch as the first minute offers it. */
export interface WatchChoice {
  /** `<extension>.<watch>`. */
  id: string
  title: string
  /** What it looks for and what it does about it, in the watch's own sentence. */
  means: string
  /** How often it looks, as a schedule says it: `10m`, `1h`, `1d`. */
  every: string
  /**
   * `on` — already watching, or it stands and its extension can look, so it
   * will be the moment a window opens. Said, never asked: turning one of those
   * off is the queue's, and a tick that changed nothing would be a lie.
   * `offered` — nothing watches it and it can look now.
   * `cannot` — its extension cannot look yet, and `costs` says what it needs.
   */
  state: 'on' | 'offered' | 'cannot'
  /**
   * Whether it is ticked when the question appears.
   *
   * A watch that only tells somebody what it found is ticked; one that starts
   * agents is offered and never ticked, however useful it is. The difference
   * is not how much either is worth — it is that a person who presses enter
   * without reading has agreed to being told something, and has not agreed to
   * finding four agents in four lanes in the morning.
   */
  ticked: boolean
  /** What saying yes costs, or what it needs first. Never empty. */
  costs: string
}

/**
 * Every watch there is, as something to decide about.
 *
 * `watched` is asked of each so that one already on is said rather than
 * offered. It is the caller's, because what counts as on is a schedule in a
 * project and this file knows about neither.
 */
export function watchesToOffer(
  watches: readonly WatchOffered[],
  watched: (id: string) => boolean = () => false,
): WatchChoice[] {
  return watches.map((watch) => {
    // A watch that has to be told something is `cannot` here for the same
    // reason one whose extension has no key is: there is nothing to answer yet.
    // Offering it would write a schedule with no input, which fails at every
    // look — and for a watch that reaches somebody else's service, it would be
    // a connector switched on by a person pressing enter.
    const told = watch.needs ?? []
    const state: WatchChoice['state'] =
      watched(watch.id) || (watch.standing && watch.problem === null && told.length === 0)
        ? 'on'
        : watch.problem !== null || told.length > 0
          ? 'cannot'
          : 'offered'
    return {
      id: watch.id,
      title: watch.title,
      means: watch.means ?? '',
      every: watch.every,
      state,
      ticked: state === 'offered' && watch.offers === 'ask',
      costs:
        state === 'cannot'
          ? (watch.problem ?? (told.length > 0 ? mustBeTold(told) : ''))
          : watch.offers === 'agent'
            ? STARTS_AGENTS
            : ONLY_TELLS,
    }
  })
}

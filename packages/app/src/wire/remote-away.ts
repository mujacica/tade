import {
  DEVICES_SEEN_BY_AGENTS,
  LAN_IS_PLAINTEXT_SHORT,
  PUBLIC_IS_THE_INTERNET_SHORT,
  printable,
} from '@tade/core'
import type { RemoteLink } from '@tade/remotes-core'
import {
  AWAY_ITSELF,
  type AwayAnswer,
  AwayAnswerSchema,
  type AwayAsk,
  blocksFor,
  codeFor,
} from '@tade/web'
import type { Machine } from '../machines.ts'
import { AWAY_CONTROLS, type AwayPanel } from '../panels/away/state.ts'
import type { AwayTab, AwayView } from '../panels/away/view.ts'
import type { Panel } from '../panels.ts'
import type { Submits, Wiring } from './context.ts'
import { carryPairingLink, isLink } from './web-link.ts'

// Every other machine's away view, on a tab of this window's AWAY VIEW panel
// (`@tade/web`'s `away-there.ts` is the far side, and carries the argument).
//
// **That machine does all of it.** A look is its panel's own facts, a code is
// the one its `tade web pair` writes, a sign-out is its own `revokeOne` — each
// one owner's ask over the held link (`RemoteLink.request`), as every other
// owner's route is asked. This window only draws what came back, through the
// panel's own drawing, so the two can never say different things about one
// machine; and the panel is marked `there` (`AwayPanel.there`), so a press on
// that tab is carried out here and never by this machine's own away view.
//
// **Asked only while somebody looks**: the tab in front, every `LOOK_MS`
// while it stays in front, and at once when a press there answers. Nobody
// else reads it, and the strip's count is `/api/machine`'s (`Machine.detail`),
// asked on the beat already.
//
// **The link a code carries is a credential**: it is held here in memory for
// the minutes that machine said it is good for, drawn as the code and the
// link, and opened or copied only on a press — never journaled, never said in
// the strip, never handed to the orchestrator. It goes as soon as that
// machine says the code is claimed or gone, or its minutes run out.

/** How often the tab in front is asked again while it stays in front. */
export const LOOK_MS = 3_000

/** The far side's door. */
const AWAY_DOOR = '/api/away'

export interface RemoteAwaysDeps {
  /** The link that holds a remote and whether it is up, or null where none is held. */
  reach: (name: string) => { link: RemoteLink; live: boolean } | null
  /** Put a pairing link on the clipboard and say nothing of what it is: false where it would not go. */
  copy?: (text: string) => Promise<boolean>
}

/** What is held of one machine's away view. */
interface Held {
  answer: AwayAnswer | null
  /** When it answered, in this machine's clock. */
  at: number | null
  /** Why there is no answer, or why the last press did nothing. */
  said: string | null
  busy: boolean
  asked: number
  /** The code a press there wrote: its link, the device it becomes, and until when here. */
  code: { url: string; device: string; until: number } | null
}

export class RemoteAways {
  private readonly wire: Wiring
  private readonly deps: RemoteAwaysDeps
  private readonly held = new Map<string, Held>()

  constructor(wire: Wiring, deps: RemoteAwaysDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * The tab in front is another machine's: ask it, unless an ask is under way
   * or it was asked less than `LOOK_MS` ago. Called on the beat and as the
   * panel is drawn, so a tab pressed is asked at once. Returns at once.
   */
  looking(name: string): void {
    const one = this.held.get(name)
    if (one?.busy === true) return
    if (one !== undefined && this.wire.now() - one.asked < LOOK_MS) return
    if (this.deps.reach(name)?.live !== true) return
    void this.ask(name, {})
  }

  /** A remote no longer in the config: what it said goes with it, its code too. */
  forget(name: string): void {
    this.held.delete(name)
  }

  /**
   * The tabs along the top: every other machine, whether its away view is up
   * — what the tab last answered while it was looked at, else what it said it
   * is on the beat (`Machine.detail.about.away`), and never up over a link
   * that is down.
   */
  tabs(machines: readonly Machine[]): AwayTab[] {
    return machines.map((one) => {
      if (one.link !== 'live') return { name: one.name, on: false }
      const answer = this.held.get(one.name)?.answer
      if (answer !== undefined && answer !== null) return { name: one.name, on: answer.listening }
      const about = one.detail.about
      return { name: one.name, on: about?.away?.on ?? about?.public?.up ?? null }
    })
  }

  /** What one machine's tab draws: the panel's own view, made of what that machine last answered. */
  view(name: string, machine: Machine | null): AwayView {
    const now = this.wire.now()
    const one = this.held.get(name) ?? null
    const reach = this.deps.reach(name)
    const linked = machine !== null && reach !== null
    const up = linked && machine.link === 'live' && reach.live
    const answer = one?.answer ?? null
    const code = liveCode(one, now)
    const answered = one?.at !== null && one?.at !== undefined
    return {
      listening: answer?.listening ?? false,
      bind: answer?.bind ?? 'loopback',
      bound: (answer?.bound ?? []).map((part) => printable(part)),
      reachable: (answer?.reachable ?? []).map((part) => printable(part)),
      machine: printable(name),
      ticket:
        code === null
          ? null
          : { url: code.url, secondsLeft: Math.max(0, Math.ceil((code.until - now) / 1000)) },
      code: code === null ? [] : codeBlocks(code.url),
      // A device at that machine's own door is answered there, by whoever is at it.
      asking: null,
      devices: (answer?.devices ?? []).map(({ from, ...device }) => ({
        ...device,
        from: from === AWAY_ITSELF ? printable(name) : printable(from),
      })),
      streams: answer?.streams ?? 0,
      lan: LAN_IS_PLAINTEXT_SHORT,
      internet: PUBLIC_IS_THE_INTERNET_SHORT,
      public:
        answer?.public == null
          ? null
          : {
              name: printable(answer.public.name),
              up: answer.public.up,
              lines: answer.public.lines.map((line) => ({
                said: printable(line.said),
                loud: line.loud,
              })),
            },
      agents: DEVICES_SEEN_BY_AGENTS.replace('this machine', printable(name)),
      // A press that did nothing is said where the press was, above that machine's own trouble.
      problem:
        up && answered && one?.said
          ? one.said
          : answer?.problem == null
            ? null
            : printable(answer.problem),
      there: {
        name: printable(name),
        linked,
        up,
        asOf: one?.at ?? null,
        asking: one?.busy === true,
        said: one?.said ?? null,
      },
    }
  }

  /** The panels that are another machine's: a press on its tab, carried out there. */
  submitsThere(): Submits {
    return {
      away: (panel: Panel, choice: string | undefined) => {
        const there = (panel as AwayPanel).there
        return there === undefined ? undefined : this.press(there, choice ?? '')
      },
    }
  }

  /** One press on a machine's tab, done by that machine. What came of it is said on the tab. */
  async press(name: string, control: string): Promise<void> {
    const one = this.heldFor(name)
    one.said = null
    if (isLink(control)) {
      // The link the code carries, read from where it is held at the press —
      // never out of anything drawn — and opened or copied as this machine's own is.
      const code = liveCode(one, this.wire.now())
      try {
        await carryPairingLink(this.wire, control, code?.url, {
          copy: async (text) => (await this.deps.copy?.(text)) ?? false,
        })
      } catch (err) {
        one.said = why(err)
      }
      this.wire.draw()
      return
    }
    const asked = askOf(control)
    if (asked === null) {
      // The window's own yes and no are this machine's; anything else is not a press of the tab's.
      one.said =
        control === AWAY_CONTROLS.allow || control === AWAY_CONTROLS.deny
          ? `A device at ${name}'s door is answered at ${name}.`
          : null
      this.wire.draw()
      return
    }
    if ('press' in asked && asked.press !== 'code') {
      // Signed out there: a code that device would have become goes with it.
      if (asked.press === 'revoke all' || asked.device === one.code?.device) one.code = null
    }
    await this.ask(name, asked)
  }

  /** One ask of that machine's away view, held. Never throws: what went wrong is said on the tab. */
  private async ask(name: string, asked: AwayAsk): Promise<void> {
    const one = this.heldFor(name)
    const reach = this.deps.reach(name)
    if (reach === null || !reach.live) {
      if ('press' in asked) one.said = `${name} is not linked now, so nothing was done there`
      this.wire.draw()
      return
    }
    one.busy = true
    one.asked = this.wire.now()
    this.wire.draw()
    try {
      const answer = await reach.link.request(name, AWAY_DOOR, asked)
      if (answer.status === 404) {
        one.said = `${name} runs a Tade that does not show its away view to another machine yet: update it there`
        return
      }
      if (answer.status !== 200) {
        one.said = `${name} answered ${answer.status} when asked about its away view`
        return
      }
      const read = AwayAnswerSchema.safeParse(answer.body)
      if (!read.success) {
        one.said = `${name} said how its away view stands in a shape this Tade does not read`
        return
      }
      const now = this.wire.now()
      one.answer = read.data
      one.at = now
      if (read.data.code !== null) {
        one.code = {
          url: read.data.code.url,
          device: read.data.code.device,
          until: now + read.data.code.secondsLeft * 1000,
        }
      }
      // Gone there — claimed, signed out, or run out — is gone here too.
      if (one.code !== null && !read.data.codes.some((code) => code.device === one.code?.device)) {
        one.code = null
      }
      if (read.data.cannot !== null) one.said = `${name}: ${printable(read.data.cannot)}`
      // What that answer itself holds is never kept in it: only the code above, in memory.
      one.answer = { ...read.data, code: null }
    } catch (err) {
      // A link that went down is the link's news; what was held stands, as of then.
      if (this.deps.reach(name)?.live === true) one.said = `${name} could not be asked: ${why(err)}`
    } finally {
      one.busy = false
      this.wire.draw()
    }
  }

  private heldFor(name: string): Held {
    const was = this.held.get(name)
    if (was !== undefined) return was
    const fresh: Held = { answer: null, at: null, said: null, busy: false, asked: 0, code: null }
    this.held.set(name, fresh)
    return fresh
  }
}

/** The ask a control on a machine's tab is, or null for one that asks nothing there. */
export function askOf(control: string): AwayAsk | null {
  if (control === AWAY_CONTROLS.code) return { press: 'code' }
  if (control === AWAY_CONTROLS.all) return { press: 'revoke all' }
  if (control.startsWith(AWAY_CONTROLS.revoke)) {
    const device = control.slice(AWAY_CONTROLS.revoke.length)
    return /^[A-Za-z0-9_-]{1,64}$/.test(device) ? { press: 'revoke', device } : null
  }
  return null
}

/** The code a press there wrote, while it is still good: null once its minutes are up. */
function liveCode(one: Held | null, now: number): Held['code'] {
  const code = one?.code ?? null
  return code !== null && code.until > now ? code : null
}

/** The code's rows, as the panel draws this machine's. */
function codeBlocks(url: string): string[] {
  const code = codeFor(url)
  return code === null ? [] : blocksFor(code)
}

function why(err: unknown): string {
  return printable(err instanceof Error ? err.message : String(err))
}

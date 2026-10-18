import { randomBytes } from 'node:crypto'
import {
  LINES_LOOKED_BACK,
  machineLabel,
  printable,
  REMOTE_TELL_REACH,
  remoteNamedBy,
} from '@tade/core'
import type { Answer, Held, Remote, RemoteLink } from '@tade/remotes-core'
import type { Frame } from '../frame.ts'
import { type Machine, type Machines, type Missed, missedOf } from '../machines.ts'
import { ORCHESTRATOR_TAB } from '../model.ts'
import { type TalkShown, talkingTo, talkSays, talkTabsOf, talkTranscript } from '../talk-tab.ts'
import type { Entry } from '../transcript.ts'
import { notify, saidLately, type Wiring, why } from './context.ts'

// Another machine's orchestrator, talked to from this window (REMOTE-TADE.md
// §5.4, §9.4): what is typed on its tab, sent to it as this machine's owner;
// escape on its tab, its turn stopped; and when its link comes back, what it
// says happened while the person was away, asked once and drawn on its tab.
//
// **Every message is that machine's own door** (`/api/ask/ask`, `/api/ask/stop`)
// over the link already held (`link.request`), never one of its own: as an
// owner, so the turn there reaches what its keyboard does — the owner channel
// exists to let this machine start work there — and with what this window last
// saw of the conversation (`was`, `rev`), so a message sent while it started
// answering somebody else is that machine's to refuse. What it answers is said
// on the tab as text, and **nothing typed on a machine's tab ever reaches this
// machine's orchestrator** — not when the machine is down, not when it refuses.
//
// **The card is asked for on every link coming back, and only then**
// (`/api/since`): how long ago it came back is the one thing sent, as an age,
// and that machine folds its own journal from the last moment it counted the
// person present (`@tade/core`'s `since.ts`). Read like everything it wrote
// (`missedOf`), kept on its tab until a message is sent there or the link
// comes back again, and said once in the strip.

/** What this window answers the orchestrator's `tade_remote_tell` with (`host-remotes.ts`). */
export interface RemoteTalkTools {
  tell(req: { machine: string; said: string; asked: string }): Promise<string>
}

/** What talking to another machine's orchestrator needs of the links. */
export interface RemoteTalkDeps {
  reach(machine: string): { link: RemoteLink; remote: Remote; live: boolean } | null
  machines(): Machines
  skew(machine: string): number
}

/** The longest ago a link may say it came back and still be told what was missed (`SINCE_BACK_MOST_MS`). */
const BACK_MOST_MS = 10 * 60_000

/**
 * How long a link must have heard nothing before its coming back is a return
 * worth a card: a network that dropped for a breath while somebody typed is
 * not one, and a lid closed over lunch is.
 */
export const AWAY_MS = 5 * 60_000

export class RemoteTalks {
  private readonly wire: Wiring
  private readonly deps: RemoteTalkDeps
  /** What this window said about each machine's conversation: a refusal, a machine not reached. */
  private readonly notes = new Map<string, readonly Entry[]>()
  /** The newest line of each conversation that was in front where it could be read. */
  private readonly seen = new Map<string, string>()
  /** Machines with something in their conversation nobody here has looked at yet. */
  private readonly unread = new Set<string>()
  /** A message on its way, by machine. */
  private readonly sending = new Set<string>()
  /** What each machine said happened while the person was away, as its link last came back. */
  private readonly missed = new Map<string, Missed>()
  /** Each link's last live stretch and when it was last heard from, to tell a return from a blip. */
  private readonly links = new Map<string, { live: number | null; heardAt: number | null }>()
  /** The tab in front as last folded, so a frame that moved nothing is handed the same one. */
  private shown: { of: readonly unknown[]; talk: TalkShown } | null = null

  constructor(wire: Wiring, deps: RemoteTalkDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** A tab per machine, and the conversation of the one in front. */
  facts(): Partial<Frame> {
    const machines = this.deps.machines()
    const front = talkingTo(this.wire.state)
    const machine = machines.remotes.find((one) => one.name === front)
    // A machine taken out of the config takes its tab with it, and the line
    // goes back to this machine's orchestrator — never words sent nowhere.
    if (front !== null && machine === undefined) {
      this.wire.put({ ...this.wire.state, bottom: ORCHESTRATOR_TAB })
    }
    if (machines.remotes.length === 0) return {}
    const reading = this.wire.state.bottomMode !== 'min'
    for (const one of machines.remotes) {
      const newest = one.talk?.lines.at(-1)?.id ?? ''
      // What was there when its conversation was first heard is not news.
      if (!this.seen.has(one.name)) {
        if (one.talk !== null) this.seen.set(one.name, newest)
      } else if (front === one.name && reading) {
        this.seen.set(one.name, newest)
        this.unread.delete(one.name)
      } else if (newest !== this.seen.get(one.name)) this.unread.add(one.name)
    }
    const tabs = talkTabsOf(machines, [...this.unread], this.wire.now())
    if (machine === undefined) return { talkTabs: tabs }
    return { talkTabs: tabs, talk: this.talkOf(machine) }
  }

  /**
   * What a link holds moved: which machines' orchestrators are on a turn, into
   * the state, where escape and the spinner read it — and a link live again
   * after `AWAY_MS` or more of hearing nothing from it, or for the first time
   * in this window, asks what was missed there.
   *
   * **Not on its journal word**, which is the obvious place and the wrong
   * one: a link a wake redials goes live → dialling → live, and the journal
   * hears nothing (`wordOf`), which is exactly the laptop opening after a
   * night that the card is for.
   */
  moved(name: string, held: Held): void {
    const was = this.links.get(name)
    const live = held.link.kind === 'live' ? held.link.since : null
    if (live !== null && live !== was?.live) {
      const quiet = was?.heardAt == null ? Number.POSITIVE_INFINITY : live - was.heardAt
      if (quiet >= AWAY_MS) {
        void this.ask(name, Math.min(BACK_MOST_MS, Math.max(0, this.wire.now() - live)))
      }
    }
    this.links.set(name, { live: live ?? was?.live ?? null, heardAt: held.heardAt })
    this.busyNow()
  }

  /** Which machines' orchestrators are on a turn, as the state has it for escape and the spinner. */
  private busyNow(): void {
    const busy = this.deps
      .machines()
      .remotes.filter((one) => one.link === 'live' && one.talk?.busy === true)
      .map((one) => one.name)
    const was = this.wire.state.talkBusy
    if (busy.length === was.length && busy.every((name, at) => name === was[at])) return
    this.wire.put({ ...this.wire.state, talkBusy: busy })
  }

  /**
   * What was typed, sent to the machine whose orchestrator's tab is in front.
   * False where none is, which leaves it to this machine's own; true however
   * it went there — what is typed on a machine's tab is never answered here.
   */
  say(said: string): boolean {
    const name = talkingTo(this.wire.state)
    if (name === null || !this.deps.machines().remotes.some((one) => one.name === name)) {
      return false
    }
    // Only words cross: a picture on the line stays here, for this machine's orchestrator.
    if (said !== '' && this.wire.state.attached.length > 0) {
      this.note(
        name,
        `only words go to ${name}: what is attached stays here, for the next thing said to this machine's orchestrator`,
      )
    }
    void this.send(name, said)
    return true
  }

  /** Escape on a machine's tab: its turn stopped there. False where no machine's tab is in front. */
  interrupt(): boolean {
    const name = talkingTo(this.wire.state)
    if (name === null) return false
    void this.stop(name)
    return true
  }

  /** A machine no longer configured: nothing kept about it. */
  forget(name: string): void {
    for (const kept of [this.notes, this.seen, this.missed, this.links]) kept.delete(name)
    this.unread.delete(name)
    this.sending.delete(name)
  }

  private talkOf(machine: Machine): TalkShown {
    const name = machine.name
    const own = this.ownOf(name)
    const notes = this.notes.get(name) ?? NONE
    const missed = this.missed.get(name) ?? null
    const sending = this.sending.has(name)
    const of = [machine, notes, missed, sending, own]
    const kept = this.shown
    if (kept?.of.every((one, at) => one === of[at])) return kept.talk
    const talk: TalkShown = {
      machine: name,
      transcript: talkTranscript(machine.talk, own, notes),
      missed,
      says: talkSays(machine, own, sending),
    }
    this.shown = { of, talk }
    return talk
  }

  /** This machine there, as that machine's conversation names who asked. */
  private ownOf(name: string): string | null {
    const device = this.deps.reach(name)?.remote.session.device
    return device === undefined ? null : `device ${device}`
  }

  /** One message to that machine's orchestrator, said on its tab however it went. */
  private async send(name: string, said: string): Promise<void> {
    if (said === '') return
    try {
      await this.carry(name, said, true)
    } catch (err) {
      this.note(name, `${why(err)}. What was typed: ${said}`)
    }
  }

  /**
   * Passed on by this machine's orchestrator (`tade_remote_tell`): refused
   * unless a line of the person's names that machine (`REMOTE_TELL_REACH`),
   * checked here against the journal and never in the tool, and said there as
   * this machine's orchestrator's words rather than as the person's.
   */
  async tell(req: { machine: string; said: string; asked: string }): Promise<string> {
    const machines = this.deps.machines().remotes
    const machine = machines.find((one) => one.name === req.machine)
    if (machine === undefined) {
      const names = machines.map((one) => one.name).join(', ')
      throw new Error(
        `No machine here is called ${req.machine}: ${names === '' ? 'none is linked (tade remote add)' : `the ones linked are ${names}`}.`,
      )
    }
    if (req.asked.trim() === '') {
      throw new Error(
        'Something is passed to another machine only when they ask for it: pass what they said, word for word, in `asked`.',
      )
    }
    if (!remoteNamedBy(machine.name, await saidLately(this.wire, LINES_LOOKED_BACK))) {
      throw new Error(
        `Nothing they have said names ${machine.name}, so I will not: ${REMOTE_TELL_REACH.because}.`,
      )
    }
    if (req.said.trim() === '') throw new Error(`Say what to pass on to ${machine.name}.`)
    await this.carry(
      machine.name,
      `The orchestrator on ${machineLabel()} passes this on:\n\n${req.said}`,
    )
    return `Passed on to the orchestrator on ${machine.name}. It answers in its own conversation, which they read on ${machine.name}'s tab in this window; you are not given its answer.`
  }

  /**
   * One message to that machine's orchestrator, as this machine's owner there.
   * Throws what to say where it did not go.
   *
   * `typed` is this machine's word that the person typed it at this keyboard
   * (`AskCall.typed`), which makes it their words there too: only what is
   * typed on a machine's tab, never what this orchestrator passes on.
   */
  private async carry(name: string, said: string, typed = false): Promise<void> {
    const machine = this.deps.machines().remotes.find((one) => one.name === name)
    const reach = this.deps.reach(name)
    const talk = machine?.talk ?? null
    if (machine === undefined || reach === null || !reach.live) {
      throw new Error(`${name} is not linked, so nothing was sent`)
    }
    if (talk === null || talk.rev === null || machine.rev === null) {
      throw new Error(`${talkSays(machine, this.ownOf(name), false).said}, so nothing was sent`)
    }
    if (talk.busy) {
      throw new Error(
        `${name}'s orchestrator is answering ${talk.whose === this.ownOf(name) ? 'you' : (talk.whose ?? 'something')}: wait for it, or stop it with esc on its tab`,
      )
    }
    // A message sent clears what was missed: the person is here, and talking.
    this.missed.delete(name)
    this.sending.add(name)
    this.wire.draw()
    const body = { was: talk.rev, rev: machine.rev, said }
    const ask = (more: { typed?: true }) =>
      reach.link.request(name, '/api/ask/ask', {
        ...body,
        key: randomBytes(12).toString('base64url'),
        ...more,
      })
    let answer: Answer
    try {
      answer = await ask(typed ? { typed: true } : {})
      // An older Tade there reads the body strictly and has no `typed`: its
      // refusal acted on nothing, so the words go again as a device's.
      if (typed && answer.status === 400 && errorOf(answer) === 'malformed') answer = await ask({})
    } catch (err) {
      throw new Error(`${name}: ${printable(why(err))} — it may not have been sent`)
    } finally {
      this.sending.delete(name)
      this.wire.draw()
    }
    if (answer.status !== 200) throw new Error(`${refusedSaid(answer, name)}, so nothing was sent`)
  }

  /** Stop that machine's turn, where one is in flight there. */
  private async stop(name: string): Promise<void> {
    const machine = this.deps.machines().remotes.find((one) => one.name === name)
    const reach = this.deps.reach(name)
    const talk = machine?.talk ?? null
    if (reach === null || !reach.live || talk === null || talk.rev === null || !talk.busy) return
    try {
      const answer = await reach.link.request(name, '/api/ask/stop', {
        was: talk.rev,
        key: randomBytes(12).toString('base64url'),
        rev: machine?.rev ?? 0,
      })
      if (answer.status !== 200) this.note(name, refusedSaid(answer, name))
    } catch (err) {
      this.note(name, `${name}: ${printable(why(err))}`)
    }
    this.wire.draw()
  }

  /** What was missed there, asked once as its link came back, and said once in the strip. */
  private async ask(name: string, back: number): Promise<void> {
    const reach = this.deps.reach(name)
    if (reach === null || !reach.live) return
    let answer: Answer
    try {
      answer = await reach.link.request(name, '/api/since', { back })
    } catch (err) {
      // Said on its tab, and asked again the next time it comes back.
      return this.note(name, `what was missed on ${name} could not be asked: ${why(err)}`)
    }
    // An older Tade there has no card to give, and that is not worth a word;
    // anything else it answered is said on its tab.
    if (answer.status === 404) return
    if (answer.status !== 200) {
      return this.note(
        name,
        `what was missed on ${name} could not be asked: ${refusedSaid(answer, name)}`,
      )
    }
    const missed = missedOf(name, answer.body, this.deps.skew(name))
    if (missed === null) {
      this.missed.delete(name)
      return
    }
    this.missed.set(name, missed)
    if (talkingTo(this.wire.state) !== name) this.unread.add(name)
    const waiting = missed.waiting.rows.length + missed.waiting.more
    const finished = missed.finished.rows.length + missed.finished.more
    const parts = [
      ...(waiting > 0 ? [`${waiting} waiting on you`] : []),
      ...(finished > 0 ? [`${finished} finished`] : []),
    ]
    notify(
      this.wire,
      `${name}, since you were here: ${parts.join(', ') || 'what happened is on its tab'} — its orchestrator’s tab has the rest`,
    )
    this.wire.draw()
  }

  /** Something this window says about a machine's conversation, on its tab. */
  private note(name: string, text: string): void {
    const notes = this.notes.get(name) ?? NONE
    this.notes.set(name, [
      ...notes.slice(-19),
      { kind: 'problem', text: printable(text), at: this.wire.now() },
    ])
    this.wire.draw()
  }
}

const NONE: readonly Entry[] = []

/** Why a message or a stop was not taken there, in that machine's words as text. */
/** The error word an answer's body carries, or null. */
function errorOf(answer: Answer): unknown {
  const body = typeof answer.body === 'object' && answer.body !== null ? answer.body : {}
  return 'error' in body ? body.error : null
}

function refusedSaid(answer: Answer, name: string): string {
  const body = typeof answer.body === 'object' && answer.body !== null ? answer.body : {}
  const error = 'error' in body ? body.error : null
  const said = 'said' in body && typeof body.said === 'string' ? printable(body.said) : ''
  // No route by that name: the routes that talk are built only where talking
  // from another screen is on there.
  if (answer.status === 404 && error === 'no_such') {
    return `${name} takes no message from another screen: talking to Tade from away is off there (surfaces.web.orchestrator) — Settings › Remotes turns it on`
  }
  if (error === 'gone') return `${name}'s orchestrator started on something else first`
  return `${name}: ${said || `it answered ${answer.status}`}`
}

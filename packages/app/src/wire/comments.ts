import { BOUNDS } from '@tade/web'
import {
  byDestination,
  forAgent,
  forTade,
  hunkFor,
  hunkWithin,
  type LineComment,
  packed,
  saidOf,
  withComment,
} from '../comments.ts'
import type { ParsedDiff } from '../diff.ts'
import type { Frame } from '../frame.ts'
import { shownName, withTranscript } from '../model.ts'
import type { CommentChoice, Composing } from '../panels/comment.ts'
import type { DiffPanel } from '../panels/diff/state.ts'
import type { FilePanel } from '../panels/file/state.ts'
import type { PanelInputs } from '../panels.ts'
import { youSaid } from '../transcript.ts'
import { flash, notify, type Subject, type Wiring, why } from './context.ts'

// Comments on lines of a diff: kept here, by the review they are on, until
// they are sent — together, however many files they are spread over.
//
// Where each goes was chosen on the comment itself: Tade by default, as a turn
// of the person's own, or straight to an agent over `steer`. What each is told
// is `comments.ts`'s, and the one rule that matters is kept there: only the
// words are the person's, so only the words go under their heading and into
// `said`.
//
// Kept in memory and nowhere else, like what is half-written on the line:
// Tade owns no state, and a comment nobody sent is a draft.
//
// On another machine's change (`DiffPanel.there`) they go to the agent there
// whose change it is, and nowhere else — the orchestrator here did not ask for
// that work, and the agents here never saw it — carried as that machine's own
// `steer` (`RemoteAgents.steerThere`), which takes `BOUNDS.said` a message:
// so each comment's hunk is narrowed to fit at the moment it is kept, and a
// review's are sent as the fewest messages that fit.

/**
 * The change a diff panel is showing, for a comment on it: whose it is — a
 * task, or `''` for the checkout's own — the file as git names it there, and
 * git's answer (`Files.shown`).
 */
export interface Shown {
  task: string
  path: string
  diff: ParsedDiff | null
  /** The machine whose change it is, where it is another's. */
  there?: string
}

/** What this subject needs of the rest of the window. */
export interface CommentsDeps {
  /** The change the open diff panel shows: whose, which file, and what git said about it. */
  shown(): Shown | null
  /** The orchestrator asked as a turn of the person's: their words, and Tade's paragraph above them. */
  ask(words: string, about: string): Promise<string>
  /** Whether there is an orchestrator to ask yet: comments for it wait, kept, until there is. */
  listening(): boolean
  /** Their words, written down as they said them (`said`). */
  remember(words: string): void
  /** Said to an agent on another machine, as that machine's `steer`: what it answered, or thrown. */
  steerThere?(machine: string, agent: string, said: string): Promise<string>
}

/** A review's comments as a panel is handed them, kept by identity between frames. */
interface Handed {
  kept: readonly LineComment[]
  path: string
  here: readonly LineComment[]
}

export class Comments implements Subject {
  private readonly wire: Wiring
  private readonly deps: CommentsDeps
  /** What has been written and not sent, by the review it is on (`reviewOf`). */
  private readonly kept = new Map<string, readonly LineComment[]>()
  /** The last answer each fact was, so a frame that changed nothing hands over the same objects. */
  private handed: Handed | null = null
  private chosen: { panes: unknown; review: string; choices: CommentChoice[] } | null = null

  constructor(wire: Wiring, deps: CommentsDeps) {
    this.wire = wire
    this.deps = deps
  }

  panel(): Frame['panel'] {
    const shown = this.open() ? this.deps.shown() : null
    if (!shown) return {}
    const all = this.kept.get(reviewOf(shown)) ?? NONE
    return {
      comments: { here: this.here(all, shown.path), total: all.length },
      commentTo: this.choices(shown),
    }
  }

  inputs(): PanelInputs {
    const shown = this.open() ? this.deps.shown() : null
    if (!shown) return {}
    const all = this.kept.get(reviewOf(shown)) ?? NONE
    return {
      comments: this.here(all, shown.path),
      drafted: all.length,
      commentTo: this.choices(shown),
    }
  }

  /** How many are kept on a review (`reviewOf`): what its Send would send. */
  count(review: string): number {
    return this.kept.get(review)?.length ?? 0
  }

  /** What a press in a diff panel asked of the comments: keep the one written, or send them all. */
  async submit(panel: FilePanel | DiffPanel, choice: string): Promise<void> {
    const shown = this.deps.shown()
    if (!shown) return
    const review = reviewOf(shown)
    if (choice === 'send') {
      const there = shown.there
      return there === undefined ? this.send(review) : this.sendThere({ ...shown, there })
    }
    const box = panel.kind === 'file' ? boxOf(panel) : panel.composing
    if (choice !== 'comment' || !box) return
    const written = {
      task: shown.task,
      path: shown.path,
      line: box.line,
      side: box.side,
      // Exactly as typed: nothing here trims, tidies or rewords it.
      words: box.words,
      to: box.to,
    }
    const hunk =
      shown.there === undefined
        ? hunkFor(shown.diff, box, box.text)
        : hunkWithin(shown.diff, box, box.text, written, BOUNDS.said)
    const comment: LineComment = { ...written, hunk }
    this.kept.set(review, withComment(this.kept.get(review) ?? NONE, comment))
    const open = this.wire.state.panel
    if (open?.kind === 'file')
      this.wire.put({ ...this.wire.state, panel: { ...open, asking: null } })
    if (open?.kind === 'diff')
      this.wire.put({ ...this.wire.state, panel: { ...open, composing: null } })
    const count = this.count(review)
    flash(
      this.wire,
      box.words.trim() === ''
        ? `comment on line ${box.line} taken back`
        : `comment kept · ${count} to send`,
    )
  }

  /**
   * Every comment on a review, sent: those to Tade as one turn of the person's,
   * and those to each agent as one message to it. What could not be delivered
   * is kept and said, so nothing typed is lost to an agent that had stopped.
   */
  async send(task: string): Promise<void> {
    const all = this.kept.get(task) ?? NONE
    if (all.length === 0) return
    const left: LineComment[] = []
    const told: string[] = []
    for (const group of byDestination(all)) {
      const count = `${group.comments.length} comment${group.comments.length === 1 ? '' : 's'}`
      if (group.to === 'tade') {
        if (!this.deps.listening()) {
          left.push(...group.comments)
          notify(this.wire, `the orchestrator is not listening yet — ${count} for Tade kept`)
          continue
        }
        // Their words alone are what they said: never the hunk, which an agent wrote.
        for (const comment of group.comments) this.deps.remember(comment.words)
        this.wire.put(
          withTranscript(
            this.wire.state,
            youSaid(this.wire.state.transcript, saidOf(group.comments), this.wire.now()),
          ),
        )
        const { about, words } = forTade(group.comments)
        // The turn is the orchestrator's to answer, in the conversation, like
        // anything typed on the line: nothing here waits for it.
        void this.deps.ask(words, about)
        told.push(`${count} to Tade`)
        continue
      }
      const agent = group.to.agent
      try {
        await this.wire.opts.client.steerAgent(agent, forAgent(group.comments, agent))
        told.push(`${count} to ${this.nameOf(agent)}`)
      } catch (err) {
        left.push(...group.comments)
        notify(this.wire, `${this.nameOf(agent)} was not told ${count}: ${why(err)}`)
      }
    }
    if (left.length > 0) this.kept.set(task, left)
    else this.kept.delete(task)
    if (told.length > 0) flash(this.wire, `sent ${told.join(', ')}`)
    this.wire.draw()
  }

  /**
   * Every comment on a change on another machine, sent to its agent there as
   * that machine's own `steer`, in as few messages as fit — and what that
   * machine refused, or could not be reached for, kept and said in its words.
   */
  private async sendThere(shown: Shown & { there: string }): Promise<void> {
    const review = reviewOf(shown)
    const all = this.kept.get(review) ?? NONE
    if (all.length === 0) return
    const steer = this.deps.steerThere
    const name = thereName(shown.task, shown.there)
    if (!steer) {
      notify(this.wire, `this window cannot tell ${name} anything`)
      this.wire.draw()
      return
    }
    const left: LineComment[] = []
    let sent = 0
    for (const message of packed(all, shown.task, BOUNDS.said)) {
      const count = `${message.length} comment${message.length === 1 ? '' : 's'}`
      try {
        await steer(shown.there, shown.task, forAgent(message, shown.task))
        sent += message.length
      } catch (err) {
        left.push(...message)
        notify(this.wire, `${name} was not told ${count}: ${why(err)}`)
      }
    }
    if (left.length > 0) this.kept.set(review, left)
    else this.kept.delete(review)
    if (sent > 0) flash(this.wire, `sent ${sent} comment${sent === 1 ? '' : 's'} to ${name}`)
    this.wire.draw()
  }

  /** Whether a diff panel is what is open: nothing is said about comments anywhere else. */
  private open(): boolean {
    const kind = this.wire.state.panel?.kind
    return kind === 'file' || kind === 'diff'
  }

  /** The comments on the file in front of you, the same array while nothing about them moved. */
  private here(kept: readonly LineComment[], path: string): readonly LineComment[] {
    const last = this.handed
    if (last && last.kept === kept && last.path === path) return last.here
    const here = kept.filter((one) => one.path === path)
    this.handed = { kept, path, here }
    return here
  }

  /**
   * Who a comment can go to: Tade, then the agent whose change it is — which is
   * where tab goes first, running or not — then every other agent running in
   * the project.
   */
  private choices(shown: Shown): CommentChoice[] {
    const task = shown.task
    const panes = this.wire.state.panes
    const review = reviewOf(shown)
    const last = this.chosen
    if (last && last.panes === panes && last.review === review) return last.choices
    // A change there goes to its own agent there: nobody here did that work.
    if (shown.there !== undefined) {
      const choices = [{ to: { agent: task }, label: thereName(task, shown.there) }]
      this.chosen = { panes, review, choices }
      return choices
    }
    const project = task ? task.split('/')[0] : this.wire.state.project
    // The change's own agent whether or not it is running: it is the one the
    // person means, and one that has stopped says so when it is sent to.
    const own = panes.filter((pane) => pane.task === task)
    const rest = panes.filter(
      (pane) => pane.task !== task && pane.lane !== null && pane.project === project,
    )
    const choices: CommentChoice[] = [
      { to: 'tade', label: 'Tade' },
      ...[...own, ...rest].map((pane) => ({ to: { agent: pane.task }, label: shownName(pane) })),
    ]
    this.chosen = { panes, review, choices }
    return choices
  }

  private nameOf(task: string): string {
    const pane = this.wire.state.panes.find((one) => one.task === task)
    return pane ? shownName(pane) : task
  }
}

const NONE: readonly LineComment[] = []

/**
 * Which review comments are kept on: the task whose change it is — `''` for
 * the checkout's own — and, on another machine's, that machine too, so a task
 * of the same name here and there is two reviews.
 */
function reviewOf(shown: Pick<Shown, 'task' | 'there'>): string {
  return shown.there === undefined ? shown.task : `${shown.there}\0${shown.task}`
}

/** An agent on another machine, as the box and the strip call it. */
function thereName(task: string, machine: string): string {
  return `${task.split('/').at(-1) ?? task} on ${machine}`
}

function boxOf(panel: FilePanel): Composing | null {
  return panel.asking?.kind === 'comment' ? panel.asking.box : null
}

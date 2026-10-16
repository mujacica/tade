import {
  byDestination,
  forAgent,
  forTade,
  hunkFor,
  type LineComment,
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
import { unlessSame } from './kept.ts'

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

/** What this subject needs of the rest of the window. */
export interface CommentsDeps {
  /** The change the open diff panel shows: whose, which file, and what git said about it. */
  shown(): { task: string; path: string; diff: ParsedDiff | null } | null
  /** The orchestrator asked as a turn of the person's: their words, and Tade's paragraph above them. */
  ask(words: string, about: string): Promise<string>
  /** Whether there is an orchestrator to ask yet: comments for it wait, kept, until there is. */
  listening(): boolean
  /** Their words, written down as they said them (`said`). */
  remember(words: string): void
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
  /** What has been written and not sent, by the task whose change it is on. */
  private readonly kept = new Map<string, readonly LineComment[]>()
  /** The last answer each fact was, so a frame that changed nothing hands over the same objects. */
  private handed: Handed | null = null
  private chosen: { panes: unknown; task: string; choices: CommentChoice[] } | null = null
  private counts: Readonly<Record<string, number>> = {}

  constructor(wire: Wiring, deps: CommentsDeps) {
    this.wire = wire
    this.deps = deps
  }

  panel(): Frame['panel'] {
    // The landing desk says, beside each piece of work, what is written on it and not sent.
    if (this.wire.state.panel?.kind === 'landing') return { kept: this.counted() }
    const shown = this.open() ? this.deps.shown() : null
    if (!shown) return {}
    const all = this.kept.get(shown.task) ?? NONE
    return {
      comments: { here: this.here(all, shown.path), total: all.length },
      commentTo: this.choices(shown.task),
    }
  }

  inputs(): PanelInputs {
    const shown = this.open() ? this.deps.shown() : null
    if (!shown) return {}
    const all = this.kept.get(shown.task) ?? NONE
    return {
      comments: this.here(all, shown.path),
      drafted: all.length,
      commentTo: this.choices(shown.task),
    }
  }

  /** How many are kept on every review, by its task: the same object while none changed. */
  private counted(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {}
    for (const [task, kept] of this.kept) counts[task] = kept.length
    this.counts = unlessSame(this.counts, counts)
    return this.counts
  }

  /** How many are kept on a review: what its Send would send. */
  count(task: string): number {
    return this.kept.get(task)?.length ?? 0
  }

  /** What a press in a diff panel asked of the comments: keep the one written, or send them all. */
  async submit(panel: FilePanel | DiffPanel, choice: string): Promise<void> {
    const shown = this.deps.shown()
    if (!shown) return
    if (choice === 'send') return this.send(shown.task)
    const box = panel.kind === 'file' ? boxOf(panel) : panel.composing
    if (choice !== 'comment' || !box) return
    const comment: LineComment = {
      task: shown.task,
      path: shown.path,
      line: box.line,
      side: box.side,
      hunk: hunkFor(shown.diff, box, box.text),
      // Exactly as typed: nothing here trims, tidies or rewords it.
      words: box.words,
      to: box.to,
    }
    this.kept.set(shown.task, withComment(this.kept.get(shown.task) ?? NONE, comment))
    const open = this.wire.state.panel
    if (open?.kind === 'file')
      this.wire.put({ ...this.wire.state, panel: { ...open, asking: null } })
    if (open?.kind === 'diff')
      this.wire.put({ ...this.wire.state, panel: { ...open, composing: null } })
    const count = this.count(shown.task)
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
  private choices(task: string): CommentChoice[] {
    const panes = this.wire.state.panes
    const last = this.chosen
    if (last && last.panes === panes && last.task === task) return last.choices
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
    this.chosen = { panes, task, choices }
    return choices
  }

  private nameOf(task: string): string {
    const pane = this.wire.state.panes.find((one) => one.task === task)
    return pane ? shownName(pane) : task
  }
}

const NONE: readonly LineComment[] = []

function boxOf(panel: FilePanel): Composing | null {
  return panel.asking?.kind === 'comment' ? panel.asking.box : null
}

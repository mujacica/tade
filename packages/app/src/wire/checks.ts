import { checksFor } from '@tade/core'
import type { ListSection } from '@tade/extensions-core'
import type { ActionsView } from '../frame.ts'
import type { Live } from '../live.ts'
import { notice, ORCHESTRATOR_TAB } from '../model.ts'
import { problem, ran, said } from '../transcript.ts'
import { type Wiring, why } from './context.ts'

// A check that nobody ran is not a check that passed, and this is the window's
// end of that: the button that adopts what CI already does, the button that
// runs a task's own checks, and the tail of what one printed.
//
// Nothing here decides anything about a check. The run goes through the same
// `checks_run` the orchestrator and `tade check` use, so the worktree's lock,
// the record and the row come free — four agents in one checkout must never
// start four suites.

/** What this subject needs from the rest of the window. */
export interface ChecksDeps {
  /** The sections extensions keep in the sidebar, as they last answered. */
  sections(): readonly ListSection[]
  /** The id the next extension call runs under: each action gets its own line. */
  callId(): string
}

export class Checks {
  private readonly wire: Wiring
  private readonly deps: ChecksDeps
  /**
   * Tasks whose checks the window is running now, and when it asked, so a
   * second press waits and the page says it is going before the run has had
   * time to write anything down.
   */
  private readonly running = new Map<string, number>()

  constructor(wire: Wiring, deps: ChecksDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * The ACTIONS tab for a task: what was seen, with a run this window started
   * folded in.
   *
   * A run writes down what it is doing as it does it; between the press and
   * the first check starting there is nothing written, and a button that does
   * nothing for a second is a button people press twice.
   */
  actionsFor(live: Live, task: string): ActionsView | null {
    const seen = live.actions(task, this.review(task))
    if (!seen) return null
    const asked = this.running.get(seen.task)
    if (seen.running || asked === undefined) return seen
    return {
      ...seen,
      running: { since: asked, by: 'you', done: 0, total: seen.checks.length },
    }
  }

  /**
   * The review a task is out for, as the extension that keeps that list last
   * saw it. Read from its cache: the window never asks a forge anything.
   */
  review(task: string): ActionsView['review'] {
    // `checks.ci` is what asks for the other half of the row: with it off,
    // the ACTIONS tab is the local run and says nothing about anybody's CI.
    if (!checksFor(this.wire.opts.config, task.split('/')[0] ?? null).ci) return null
    for (const section of this.deps.sections()) {
      const row = section.rows.find((one) => one.task === task)
      if (!row) continue
      const link = row.links?.[0]
      return {
        number: row.title.split(' ')[0] ?? '',
        title:
          row.title
            .split(/\s{2,}/)
            .slice(1)
            .join(' ') || row.title,
        url: link?.url ?? '',
        marks: row.marks ?? [],
      }
    }
    return null
  }

  /**
   * Write a project's checks down from what its CI already does — which is
   * what turns a reading into checks Tade may run.
   *
   * It goes through `checks_propose` rather than writing the file here: the
   * orchestrator, the CLI and this button must all write the same file the
   * same way, and what the tool says about what it could not take is worth
   * putting in the conversation, where there is room for it — a notice is one
   * line and the next notice eats it.
   */
  async adopt(task: string): Promise<void> {
    const host = this.wire.opts.extensions
    if (!host) {
      this.wire.put(
        notice(this.wire.state, 'no extensions are loaded, so nothing can write them here'),
      )
      this.wire.draw()
      return
    }
    const project = task.split('/')[0] ?? task
    const id = this.deps.callId()
    this.wire.put({
      ...this.wire.state,
      bottom: ORCHESTRATOR_TAB,
      transcript: ran(
        this.wire.state.transcript,
        { id, tool: 'checks_propose', input: { project, adopt: true } },
        this.wire.now(),
      ),
    })
    this.wire.draw()
    try {
      const answer = await host.call(
        'checks_propose',
        { project, adopt: true },
        // A person pressing a button is not an agent: the tool is the
        // orchestrator's, and `you` is neither, so no audience gate applies.
        { caller: { kind: 'you' }, id, tade: this.wire.opts.extensionWorkbench ?? null },
      )
      this.wire.put({
        ...this.wire.state,
        transcript: said(this.wire.state.transcript, answer.text, this.wire.now()),
      })
    } catch (err) {
      this.wire.put({
        ...this.wire.state,
        transcript: problem(this.wire.state.transcript, why(err), this.wire.now()),
      })
    } finally {
      this.wire.draw()
    }
  }

  /**
   * Run a task's checks, in its own worktree, through the same path
   * everything else uses: one run at a time per checkout, written down
   * against the commit, and shown here as it goes.
   */
  async run(task: string): Promise<void> {
    if (this.running.has(task)) {
      /* the same press twice: the first one is still going */
      this.wire.put(notice(this.wire.state, `${task} is already running its checks`))
      this.wire.draw()
      return
    }
    const host = this.wire.opts.extensions
    const project = task.split('/')[0] ?? task
    if (!host) {
      this.wire.put(
        notice(this.wire.state, 'no extensions are loaded, so nothing can run them here'),
      )
      this.wire.draw()
      return
    }
    this.running.set(task, this.wire.now())
    // Look often while it goes, so the page shows which check is running
    // rather than nothing for ten seconds.
    this.wire.live?.hurryUp(task)
    this.wire.draw()
    try {
      const worktree = this.wire.live?.worktreeOf(task) ?? null
      await host.call(
        'checks_run',
        { project },
        {
          caller: worktree ? { kind: 'agent', task, project, cwd: worktree } : { kind: 'you' },
          id: this.deps.callId(),
          tade: this.wire.opts.extensionWorkbench ?? null,
        },
      )
    } catch (err) {
      this.wire.note(err)
    } finally {
      this.running.delete(task)
      this.wire.draw()
    }
  }

  /** What one check printed the last time it ran here, in the conversation. */
  async show(task: string, check: string): Promise<void> {
    const host = this.wire.opts.extensions
    const worktree = this.wire.live?.worktreeOf(task) ?? null
    const project = task.split('/')[0] ?? task
    if (!host) return
    this.wire.put({
      ...this.wire.state,
      bottom: ORCHESTRATOR_TAB,
      bottomMode: this.wire.state.bottomMode === 'min' ? 'open' : this.wire.state.bottomMode,
    })
    this.wire.draw()
    await host
      .call(
        'checks_log',
        { check, project },
        {
          caller: worktree ? { kind: 'agent', task, project, cwd: worktree } : { kind: 'you' },
          id: this.deps.callId(),
          tade: this.wire.opts.extensionWorkbench ?? null,
        },
      )
      .catch((err: unknown) => {
        this.wire.note(err)
        this.wire.draw()
      })
  }
}

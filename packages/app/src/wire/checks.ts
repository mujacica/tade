import { chosenAfter } from '@tade/checks-core'
import { checksFor } from '@tade/core'
import type { ListSection } from '@tade/extensions-core'
import type { ActionsView, Frame } from '../frame.ts'
import type { Live } from '../live.ts'
import { notice, ORCHESTRATOR_TAB } from '../model.ts'
import type { Actions, Subject, Wiring } from './context.ts'

// A check that nobody ran is not a check that passed, and this is the window's
// end of that: the button that runs a task's own checks, and the tail of what
// one printed.
//
// There is no button that writes checks down any more, because there is
// nothing to write: what a project checks is read from its own CI workflows
// and its own commit hook, so a project either says what it checks or it does
// not, and a button could not change which.
//
// Nothing here decides anything about a check. The run goes through the same
// `checks_run` the orchestrator and `tade check` use, so the worktree's lock,
// the record and the row come free — four agents in one checkout must never
// start four suites.
//
// What this does decide is nothing about a check either: which of them Tade
// runs on *this machine* is a person's answer over the reading's, and it is
// kept where every other preference is — Tade's own config, under the project.
// Never a file in the repository, which is the duplication that taking
// `.tade/checks.yaml` away was for.

/** What this subject needs from the rest of the window. */
export interface ChecksDeps {
  /** The sections extensions keep in the sidebar, as they last answered. */
  sections(): readonly ListSection[]
  /** The id the next extension call runs under: each action gets its own line. */
  callId(): string
  /**
   * Write one config key and hand the loaded config to everywhere that holds
   * one. The Settings page's own door, because a second way of writing the
   * config is a second thing to keep in step with the schema — and it is what
   * leaves the `config_changed` line that makes a change undoable.
   */
  writeKey(key: string, value: boolean | undefined, was: string): Promise<void>
}

export class Checks implements Subject {
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

  /** What the agent in front of you has done, for the ACTIONS tab beside its screen. */
  facts(): Partial<Frame> {
    const live = this.wire.live
    const task = this.wire.state.focused
    return { actions: live && task ? this.actionsFor(live, task) : null }
  }

  actions(): Actions {
    return {
      'checks-run:': (task) => this.run(task),
      'check-log:': async (rest) => {
        const [task, check] = rest.split('\u0000')
        if (task && check) await this.show(task, check)
      },
      'check-here:': async (rest) => {
        const [task, check] = rest.split('\u0000')
        if (task && check) await this.here(task, check)
      },
    }
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
      // The row as the extension keeps it. It used to be taken apart here —
      // the number off the front of the drawn title, the title off a run of
      // two spaces — which is a parser of somebody else's formatting, and a
      // title with two spaces in it lost its own first word.
      if (row) return { ...row, section: section.id }
    }
    return null
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

  /**
   * Turn one check on or off on this machine.
   *
   * One key — `projects.<project>.checks.run_here.<id>` — so the line the
   * journal keeps names exactly what changed, and pressing it again takes the
   * key away rather than writing an answer that merely agrees with the
   * reading. Nothing in the project is touched: its CI and its hook go on
   * saying what they say, and this is Tade's answer about here.
   */
  async here(task: string, check: string): Promise<void> {
    const project = task.split('/')[0] ?? task
    const live = this.wire.live
    const seen = live ? this.actionsFor(live, task) : null
    const found = seen?.checks.find((one) => one.id === check)
    if (!found) return
    // A check id is a step's own name put through `slug`, so it is always one
    // segment — but it came out of somebody's CI file and this is about to be a
    // dotted path, and a key written somewhere nobody meant is worse than a
    // button that does nothing. The project is the same shape every other
    // `projects.<name>.…` setting is written with.
    if (!/^[a-z0-9-]+$/.test(check)) return
    const chosen = checksFor(this.wire.opts.config, project).run_here
    const runs = found.skip === null
    const next = chosenAfter(chosen, check, runs)
    try {
      await this.deps.writeKey(
        `projects.${project}.checks.run_here.${check}`,
        next,
        chosen[check] === undefined ? '' : String(chosen[check]),
      )
      this.wire.put(
        notice(
          this.wire.state,
          runs ? `${check} will not run here` : `${check} will run here from now on`,
        ),
      )
      // The page is a query, so it says the new answer on its next look — and
      // a page somebody is watching has to move within the second.
      live?.hurryUp(task)
    } catch (err) {
      this.wire.note(err)
    }
    this.wire.draw()
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

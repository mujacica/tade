import { resolve } from 'node:path'
import { devServerPorts, expandHome } from '@tade/core'
import type { Frame } from '../frame.ts'
import { sectionOpen } from '../model.ts'
import { tilde, type Wiring } from './context.ts'

// What the side shows of the checkout here: the FILES tree and git's marks on
// it, CHANGES, and where the work is. Read in every frame, and remembered
// between them in one respect: how much room CHANGES and FILES last took, so a
// section that has not looked at what is in front of you yet holds it under
// its `…` (`roomHeld`) — and NOTES, under both, stays where it was instead of
// jumping up when you switch agents and back down when git answers.
//
// Beside `files.ts`, whose subject this is a part of: that one is everything a
// click does with a file, this is what the side reads.

export class Here {
  private readonly wire: Wiring
  /** The rows CHANGES and FILES drew when they last had an answer. */
  private room = { changes: 1, files: 1 }

  constructor(wire: Wiring) {
    this.wire = wire
  }

  /**
   * What is on disk here: the tree beside the agent, what git says about it,
   * and where the work is. The worktree when an agent is in front of you and
   * the project's own checkout otherwise, which is the same rule `hereOnDisk`
   * follows — one answer to "here", read two ways.
   *
   * `files` and `changes` are `null` until they have been looked at: no `Live`
   * yet is not looked at either, and never an empty checkout.
   */
  facts(): Partial<Frame> {
    const live = this.wire.live
    const state = this.wire.state
    const focused = state.panes.find((pane) => pane.task === state.focused)
    const configured = state.project ? this.wire.opts.config.projects[state.project] : null
    const repo = configured ? expandHome(configured.root) : null
    const worktree = focused ? (live?.worktreeOf(focused.task) ?? null) : null
    const facts = focused ? live?.factsOf(focused.task) : null
    // What the changes are measured from: where the agent branched when one is
    // in front of you, and nowhere — so, `git status` — when none is.
    const base = live?.baseOf(state.focused) ?? null
    // Asked again on every beat, frame or none (`keepAsking`); the tree only while FILES is open.
    live?.keepAsking('files', () => this.facts())
    const tree = sectionOpen(state, 'files', false) ? (worktree ?? repo) : null
    const files = live ? live.files(tree, state.expanded) : null
    // The same "here" the tree and the marks are read at, rather than the
    // focused task: a change in this checkout is a change whoever made it, and
    // with no agent in front of you there is still a checkout to ask about.
    const changes = live ? live.changesAt(worktree ?? repo, base) : null
    // Replaced, never written into: nothing handed to a frame changes in place.
    this.room = {
      changes: changes === null ? this.room.changes : Math.max(1, changes.length),
      files: files === null ? this.room.files : Math.max(1, files.length),
    }
    return {
      files,
      fileMarks: live?.marksAt(tree) ?? {},
      where: repo
        ? {
            repo: tilde(repo),
            branch: facts?.branch ?? live?.branchAt(repo) ?? null,
            base: focused ? (live?.baseOf(focused.task) ?? null) : null,
            // Only a worktree of its own is worth a line: one sharing the
            // checkout works in `repo`.
            worktree: worktree && resolve(worktree) !== resolve(repo) ? tilde(worktree) : null,
            path: worktree ?? repo,
            shownPath: tilde(worktree ?? repo),
            links: facts?.links ?? [],
            // Its agent's dev servers, or with none in front of you every one in the project.
            servers: focused
              ? (focused.servers ?? [])
              : devServerPorts(
                  state.panes
                    .filter((pane) => pane.project === state.project)
                    .flatMap((pane) => pane.servers ?? []),
                ),
          }
        : null,
      changes,
      base,
      roomHeld: this.room,
    }
  }
}

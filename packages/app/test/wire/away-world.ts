import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type GitSnapshot, type Task, taskDir, type Workspace } from '@tade/core'
import { parse } from 'yaml'

// The world the away harness hands the window as status's last look: every
// task read back off its **real** task file, with whatever git and lanes a
// test said it has.
//
// **Its own file for the reason `away-intake.ts` is**: a different subject,
// and the harness at the length a file is allowed to be.

/**
 * The world, with each task's **real** park read back off its **real** file.
 *
 * Read every time rather than captured, which is what makes "somebody parked
 * it at the keyboard since" a thing a test can do with the workbench and have
 * the projection see.
 */
export function worldOf(
  home: string,
  root: string,
  tasks: readonly string[],
  agents: ReadonlyMap<string, string>,
  git: ReadonlyMap<string, GitSnapshot> = new Map(),
  lanes: ReadonlyMap<string, boolean> = new Map(),
): Workspace {
  return {
    generatedAt: new Date().toISOString(),
    projects: [
      {
        name: 'app',
        root,
        brief: null,
        untracked: [],
        tasks: tasks.map((id) =>
          taskOf(home, root, id, agents.has(id), git.get(id) ?? null, lanes.get(id)),
        ),
      },
    ],
    elsewhere: [],
    toolServers: { looked: true, alive: 0 },
    warnings: [],
  }
}

function taskOf(
  home: string,
  root: string,
  id: string,
  running: boolean,
  git: GitSnapshot | null = null,
  lane: boolean | undefined = undefined,
): Task {
  // **Read out of the real task file, including the two the runs fold needs.**
  // `effort` and `start` are what group tasks into a run and what the graph's
  // edges are, and a fixture that ignored them would make every run of one
  // task with no waits — which is the one shape the fold cannot get wrong.
  const file = parse(readFileSync(join(taskDir(home, id), 'task.yaml'), 'utf8')) as {
    parked?: boolean
    by?: string
    done?: Task['done']
    effort?: string
    start?: Task['start']
  }
  return {
    id,
    project: 'app',
    branch: `tade/${id.split('/')[1] ?? id}`,
    worktree: root,
    created: new Date().toISOString(),
    state: file.parked === true ? 'parked' : 'queued',
    reason: 'no agent has started',
    stalled: false,
    ...(file.effort === undefined ? {} : { effort: file.effort }),
    ...(file.start === undefined ? {} : { start: file.start }),
    git,
    agents: running
      ? [
          {
            provider: 'pi',
            session: 'one',
            cwd: root,
            lastActivityAt: Date.now(),
            messages: 1,
            pid: null,
          },
        ]
      : [],
    lanes: lane === undefined ? [] : [{ id: `${id}/agent`, kind: 'agent', alive: lane, pid: null }],
    ...(file.parked === undefined ? {} : { parked: file.parked }),
    ...(file.by === undefined ? {} : { by: file.by }),
    ...(file.done === undefined ? {} : { done: file.done }),
  } as unknown as Task
}

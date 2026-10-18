import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { setTitle, taskFilePath } from './tasks.ts'

// What a task's file says, as the window and an agent's prompt need it: read
// loosely, field by field, because a hand-edited file must never be the reason
// an agent cannot start. Out of `workbench.ts`, which is held to its budget.

/** What a task's file says, as the window and the agent's prompt need it. */
export interface TaskSaid {
  intent: string
  chosen: string | null
  produces: string
  workspace: 'checkout' | 'worktree'
  /** It is a replay's entrant, a measurement: nothing of it is pushed. */
  replay: boolean
}

const NONE: TaskSaid = {
  intent: '',
  chosen: null,
  produces: '',
  workspace: 'worktree',
  replay: false,
}

/** What a task's file says: what was asked, and the name a person chose, if any. */
export async function taskSaid(home: string, task?: string): Promise<TaskSaid> {
  if (!task) return NONE
  try {
    const file = parseYaml(await readFile(taskFilePath(home, task), 'utf8')) as {
      intent_spoken?: unknown
      title?: unknown
      title_named?: unknown
      produces?: unknown
      workspace?: unknown
      replay?: unknown
    } | null
    return {
      intent: typeof file?.intent_spoken === 'string' ? file.intent_spoken : '',
      chosen: file?.title_named === true && typeof file.title === 'string' ? file.title : null,
      produces: typeof file?.produces === 'string' ? file.produces : '',
      workspace: file?.workspace === 'checkout' ? 'checkout' : 'worktree',
      replay: typeof file?.replay === 'string',
    }
  } catch {
    // No task file: an agent opened on a worktree Tade did not make.
    return NONE
  }
}

/**
 * What the work is called, from the task and nothing it was told: its name in
 * words — `agents-are-titled-by-their-work` is "Agents are titled by their
 * work". Not the opening instruction, whose first words are as often "Read
 * your context file first…" as anything about the work, and not the context
 * file's first line, which is as often a heading like "What's wrong". Null for
 * an agent started without words (`agent`, `agent-2`): there, the first thing
 * a person asks it is the best name there is, and its harness takes that.
 */
export function workTitle(task: string): string | null {
  const slug = task.split('/').at(-1) ?? ''
  if (slug === '' || /^agent(-\d+)?$/.test(slug)) return null
  // A slug has lost its apostrophes: `the-orchestrator-s-account`.
  const words = slug
    .replace(/-s(?=-|$)/g, "'s")
    .replace(/-+/g, ' ')
    .trim()
  return words === '' ? null : words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Write the work's name into its task as it starts, unless a person named it:
 * whatever an earlier start took from its opening instruction is replaced. What
 * was written, for its harness's session to carry, or null where nothing was.
 */
export async function titleForWork(
  home: string,
  task: string,
  chosen: string | null,
): Promise<string | null> {
  const called = chosen ? null : workTitle(task)
  if (called) {
    await setTitle(home, task, called, false).catch((err: unknown) => {
      // No task file: an agent opened on a worktree Tade did not make, with nowhere to write it.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    })
  }
  return called
}

/**
 * A title its harness reported, kept or not: one a person gave always is; one
 * the harness took from what it was asked only where the work has no name of
 * its own (`workTitle`), because what it was asked first is the opening
 * instruction.
 */
export async function takeTitle(
  home: string,
  task: string,
  title: string,
  named: boolean,
): Promise<void> {
  if (!named && workTitle(task)) return
  await setTitle(home, task, title, named)
}

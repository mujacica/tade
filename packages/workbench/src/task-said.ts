import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { taskFilePath } from './tasks.ts'

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

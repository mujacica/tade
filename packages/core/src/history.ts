import type { WilcoEvent } from './events.ts'
import type { TaskState } from './model.ts'

// What we have been working on, rolled up from the journal.
//
// The event log is the only thing that remembers; this turns it into the
// handful of facts that answer "which one did you mean": what moved recently,
// what you touched yourself, what is waiting on you.
//
// Pure: events in, facts out, `now` passed.

/** Events that mean *you* did something, as opposed to an agent moving. */
const YOUR_DOING = new Set([
  'task_created',
  'task_removed',
  'run_started',
  'permission_granted',
  'permission_denied',
])

export interface TaskActivity {
  task: string
  project: string
  /** Anything at all happened. */
  lastEventAt: number
  /** You did something: started it, answered it, set it aside. */
  lastInteractionAt: number | null
  /** Latest state anything recorded, when it was recorded. */
  state: TaskState | null
  /** Waiting on a human right now. */
  waiting: boolean
  events: number
}

export interface ProjectActivity {
  project: string
  lastEventAt: number
  tasks: number
  waiting: number
}

export interface WorkHistory {
  /** Most recently active first: what "it" most likely refers to. */
  tasks: TaskActivity[]
  projects: ProjectActivity[]
}

export function historyFrom(events: readonly WilcoEvent[], now: number): WorkHistory {
  const byTask = new Map<string, TaskActivity>()
  const pending = new Map<string, Set<string>>()

  for (const event of events) {
    if (!event.task) continue
    const at = Date.parse(event.ts)
    const when = Number.isNaN(at) ? now : at
    const existing = byTask.get(event.task) ?? {
      task: event.task,
      project: event.task.split('/')[0] ?? event.task,
      lastEventAt: when,
      lastInteractionAt: null,
      state: null,
      waiting: false,
      events: 0,
    }

    existing.events += 1
    existing.lastEventAt = Math.max(existing.lastEventAt, when)
    if (YOUR_DOING.has(event.type) || event.detail.by === 'you') {
      existing.lastInteractionAt = Math.max(existing.lastInteractionAt ?? 0, when)
    }
    if (event.type === 'state_change' && typeof event.detail.state === 'string') {
      existing.state = event.detail.state as TaskState
    }

    // Waiting is a balance, not a flag: a request opens it, an answer closes it.
    const open = pending.get(event.task) ?? new Set<string>()
    const requestId = String(event.detail.requestId ?? '')
    if (event.type === 'permission_request' && requestId) open.add(requestId)
    if ((event.type === 'permission_granted' || event.type === 'permission_denied') && requestId) {
      open.delete(requestId)
    }
    if (event.type === 'run_exited') open.clear()
    pending.set(event.task, open)

    byTask.set(event.task, existing)
  }

  const tasks = [...byTask.values()]
    .map((task) => ({ ...task, waiting: (pending.get(task.task)?.size ?? 0) > 0 }))
    .sort((a, b) => b.lastEventAt - a.lastEventAt)

  const byProject = new Map<string, ProjectActivity>()
  for (const task of tasks) {
    const existing = byProject.get(task.project) ?? {
      project: task.project,
      lastEventAt: 0,
      tasks: 0,
      waiting: 0,
    }
    existing.lastEventAt = Math.max(existing.lastEventAt, task.lastEventAt)
    existing.tasks += 1
    if (task.waiting) existing.waiting += 1
    byProject.set(task.project, existing)
  }

  return {
    tasks,
    projects: [...byProject.values()].sort((a, b) => b.lastEventAt - a.lastEventAt),
  }
}

/** A short spoken account of a task's recent life. */
export function describeActivity(activity: TaskActivity, now: number): string {
  const parts = [activity.task.split('/').at(-1) ?? activity.task]
  if (activity.state) parts.push(`is ${activity.state}`)
  if (activity.waiting) parts.push('and is waiting on you')
  parts.push(`— last moved ${ago(now - activity.lastEventAt)}`)
  return parts.join(' ')
}

export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

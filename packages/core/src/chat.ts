import type { TadeEvent } from './events.ts'

// Chats: agents that belong to no project.
//
// Somebody wants an agent to talk to about this machine, or about something
// that is nothing to do with any repository they have open. That is not a
// task — there is no work to merge, nothing to check and nobody to attribute
// a commit to — so it is not one: no task file, no branch, no worktree, and
// none of the instructions a task's agent is given about committing, checking
// and pushing. It is a conversation in the lower pane, beside the terminals,
// and it is an agent in every other way: a lane with a harness in it, through
// the same supervision channel, so what it costs, how long it ran, which
// account it ran as and whether that account was a subscription all land in
// the same folds as every other agent's (`spendFrom`, `runtimeFrom`).
//
// The whole of what makes one a chat is its id. `chats` is the first segment
// of the task, which is where every fold in Tade reads a project from, so a
// chat's spend and runtime file themselves under `chats` without a word from
// anybody — and `chats` is a name no project may have (`CHATS`, checked where
// a project is opened), so the bucket can never be some repository's.

/**
 * The first segment of every chat's task id, and a project name nothing may
 * use. A reserved word rather than a flag on a record, because the folds that
 * have to tell a chat from a task — spend, runtime, the registry, the window's
 * tabs — all have the id and nothing else.
 */
export const CHATS = 'chats'

/** `chats/3` → 3; `chats/3/agent` → 3. Null for anything that is not a chat's. */
export function chatNumberOf(id: string): number | null {
  const parts = id.split('/')
  if (parts[0] !== CHATS) return null
  const said = parts[1] ?? ''
  if (!/^\d+$/.test(said)) return null
  // Two segments is the task, three is its lane, and `chats/3/agent/x` is
  // nobody's: a prefix match would read a lane Tade never made as a chat.
  if (parts.length > 3 || (parts.length === 3 && parts[2] !== 'agent')) return null
  return Number(said)
}

/** Whether this is a chat's task id — `chats/3` — rather than a task's. */
export function isChatTask(id: string): boolean {
  return id.split('/').length === 2 && chatNumberOf(id) !== null
}

/** Whether this is a chat's lane — `chats/3/agent`. */
export function isChatLane(id: string): boolean {
  return id.split('/').length === 3 && chatNumberOf(id) !== null
}

/** The task a chat's lane belongs to: `chats/3/agent` → `chats/3`. */
export function chatTaskOf(lane: string): string {
  return lane.split('/').slice(0, 2).join('/')
}

/**
 * The task id the next chat gets: one past the highest number the journal has
 * ever carried.
 *
 * A fold over what happened rather than a counter anybody keeps, like every
 * other statistic here — and unlike the lowest free number, which is how a
 * terminal is named. A terminal is a shell and reusing its name costs nothing;
 * a chat is a conversation, and a harness names its session after the task, so
 * a second `chats/3` would not be a new chat at all. It would be the one
 * somebody closed this morning, carrying on mid-sentence.
 *
 * The journal is the only thing that remembers a chat that is over: the lane
 * registry forgets a dead lane whose task has no file, and a chat never has
 * one.
 */
export function nextChatTask(events: readonly TadeEvent[]): string {
  let highest = 0
  for (const event of events) {
    for (const said of [event.task, event.lane]) {
      const number = said ? chatNumberOf(said) : null
      if (number !== null && number > highest) highest = number
    }
  }
  return `${CHATS}/${highest + 1}`
}

/**
 * What a chat is called on its tab: the harness it runs in and its number —
 * `pi 1`, `codex 2`.
 *
 * The harness, because the whole reason to open one of these rather than type
 * into a terminal is to talk to a particular agent, and two tabs both saying
 * `chat` would be the one thing the name has to answer. Its number, because
 * that is its id, and the id is what the orchestrator is told to steer and
 * stop it by.
 */
export function chatName(task: string, harness: string): string {
  const number = chatNumberOf(task)
  return `${harness || CHATS} ${number ?? ''}`.trim()
}

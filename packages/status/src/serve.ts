import type { StatusAnswer, StatusAsk, StatusCollector } from './collector.ts'
import { lookHere } from './collector.ts'

// What goes down the pipe between the window and the process that looks at
// status for it, and the child's half of it.
//
// Three messages and no others. The child says it is ready once it can hear,
// because anything sent before then is lost — Node reads the channel from the
// moment the process starts, and drops a message nobody is listening for. Then
// one answer per ask, matched by id, so an answer that arrives after the
// window stopped waiting for it is still known for what it is.
//
// Everything that comes off the pipe is checked before it is believed, both
// ways: a message that is not one of these is garbage, and garbage never
// becomes a workspace.

/** The child is listening. */
export interface Ready {
  ready: true
}

/** The window wants a look. */
export interface Asked {
  id: number
  ask: StatusAsk
}

/** The child's answer to one ask. */
export interface Answered {
  id: number
  answer: StatusAnswer
}

/** The half of a channel the child uses: `process` itself, or a test's stand-in. */
export interface Channel {
  on(event: 'message', listener: (message: unknown) => void): unknown
  send?: ((message: unknown) => boolean) | undefined
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const id = (value: unknown): value is number => Number.isSafeInteger(value)

/** An ask, if this is one. Its config is the window's own and is not parsed again. */
export function askOf(message: unknown): Asked | null {
  if (!object(message) || !id(message.id) || !object(message.ask)) return null
  const ask = message.ask
  if (!object(ask.config) || !object(ask.lanes)) return null
  if (typeof ask.now !== 'number' || typeof ask.pr !== 'boolean') return null
  if (typeof ask.home !== 'string' || typeof ask.tadeHome !== 'string') return null
  if (ask.cwd !== undefined && typeof ask.cwd !== 'string') return null
  return message as unknown as Asked
}

/** Whether the child said it is listening. */
export function isReady(message: unknown): message is Ready {
  return object(message) && message.ready === true
}

/**
 * An answer, if this is one.
 *
 * Checked as far as the window reads without looking first — the top of the
 * workspace, each project and each task's id and state — and no further: the
 * point of the child is that the window does not walk the whole look, and a
 * schema parse every two seconds is a walk and a copy of it.
 */
export function answeredOf(message: unknown): Answered | null {
  if (!object(message) || !id(message.id) || !object(message.answer)) return null
  const answer = message.answer
  if (answer.known === false) {
    return typeof answer.why === 'string' ? (message as unknown as Answered) : null
  }
  if (answer.known !== true || !object(answer.spent) || !isWorkspace(answer.workspace)) return null
  const spent = answer.spent
  if (typeof spent.spawns !== 'number' || typeof spent.rss !== 'number') return null
  if (typeof spent.pid !== 'number') return null
  return message as unknown as Answered
}

function isWorkspace(value: unknown): boolean {
  if (!object(value) || typeof value.generatedAt !== 'string') return false
  if (!object(value.toolServers) || typeof value.toolServers.looked !== 'boolean') return false
  if (!Array.isArray(value.elsewhere) || !Array.isArray(value.warnings)) return false
  if (!value.warnings.every((one) => typeof one === 'string')) return false
  if (!Array.isArray(value.projects)) return false
  return value.projects.every(
    (project) =>
      object(project) &&
      typeof project.name === 'string' &&
      typeof project.root === 'string' &&
      Array.isArray(project.untracked) &&
      Array.isArray(project.tasks) &&
      project.tasks.every(
        (task) => object(task) && typeof task.id === 'string' && typeof task.state === 'string',
      ),
  )
}

/**
 * Answer every ask that arrives, with one collector for the life of the
 * process — and so one gate, which is what makes a beat where nothing moved
 * cost a `stat` rather than four forks a worktree.
 *
 * Says it is ready once it is listening. An ask it cannot read is answered
 * `unknown` when it carries an id to answer to, and otherwise has nobody to
 * answer.
 */
export function serveStatus(channel: Channel, collector: StatusCollector = lookHere()): void {
  const send = (message: Ready | Answered) => {
    try {
      channel.send?.(message)
    } catch {
      // The window has gone, and the child is about to go with it.
    }
  }
  channel.on('message', (message) => {
    const asked = askOf(message)
    if (!asked) {
      if (object(message) && id(message.id)) {
        send({
          id: message.id,
          answer: { known: false, why: 'status was asked something it cannot read' },
        })
      }
      return
    }
    // `collect` never throws; this is for the day one does, which would
    // otherwise end the child and every look it was answering with it.
    void collector.collect(asked.ask).then(
      (answer) => send({ id: asked.id, answer }),
      (err: unknown) =>
        send({ id: asked.id, answer: { known: false, why: `status: ${String(err)}` } }),
    )
  })
  send({ ready: true })
}

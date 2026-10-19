import { CURSOR, type EarlierIn, type MomentsIn, momentsBefore, turnsBefore } from './agent.ts'
import { turnsAway } from './cleaning.ts'
import type { Places } from './command.ts'
import { BUDGET } from './page.ts'
import type { ChatPage, MomentsPage, TurnsPage } from './protocol.ts'
import { has, type Reach } from './reach.ts'
import { inTime } from './request.ts'
import type { ServerOptions } from './serving.ts'

// The three routes that read further back than a page holds: the
// conversation with Tade (`GET /api/chat?before=`), one agent's
// (`GET /api/agent/:project/:task/earlier?before=`) and one agent's timeline
// (`GET /api/agent/:project/:task/moments?before=`). **Everything said and
// done can be read on the phone**, so a page scrolled to the end of what it
// holds asks for what came before, and nothing is only in the window.
//
// **The conversation's own reach, asked again at the request**, before the
// window is asked to read anything: Tade's needs the `talk` grant, as the
// snapshot's lines do, and an agent's a task this device reads and `lanes`, as
// its conversation does — so a device that may not read it makes the window
// read nothing. A cursor is only ever compared or handed back to the harness
// that made it, and one that does not look like one is answered as nothing.

/**
 * How long reading a conversation's record further back may take before the
 * page is told it could not be read now. A page of a record is milliseconds;
 * this is for a disk that has stopped answering.
 */
export const EARLIER_MS = 5_000

/**
 * How long reading an agent's moments further back may take: out of the
 * journal's index it is milliseconds, but a machine with no index reads the
 * journal through on a thread of its own, about a second a hundred megabytes.
 */
export const MOMENTS_MS = 30_000

/**
 * What a line's id may look like to be compared: the window's are the moment
 * it was said and its place in it (`chatLines`), and only ever compared.
 */
const LINE_ID = /^[\w:.#-]{1,64}$/

/** The window's half: reading a conversation's record further back than it holds. */
export interface WebEarlier {
  /**
   * Hold at least `want` lines of the conversation with Tade from before the
   * line `before` names, reading the orchestrator's record further back where
   * the window does not hold that many — the window's own scrollback
   * (`Earlier`), so what is read is the window's too. `false` is a record that
   * could not be read; the window says where it happened.
   */
  talk(before: string, want: number): Promise<boolean>
  /** A page of one agent's record before a cursor its newest page gave, or why not. */
  agent(task: string, before: string): Promise<EarlierIn>
  /**
   * One agent's moments out of the journal before a cursor the window gave,
   * newest first — read off the window's thread — or why not.
   */
  moments(task: string, before: string): Promise<MomentsIn>
  /** Every value the window knows to be a key, which a turn is cleaned of. */
  known(): readonly string[]
  /** Where a path in one agent's call briefs is shortened to. */
  places(task: string): Places
}

/** The lines before `before`, after the window was asked to hold them. */
export async function chatHere(
  before: string | null,
  reach: Reach,
  opts: Pick<ServerOptions, 'readingFor' | 'earlier'>,
): Promise<ChatPage> {
  const reading = opts.readingFor(reach)
  const at = before ?? ''
  // Never echoed back as it came: a name that is not a line's is answered as
  // the beginning, which asks the window for nothing.
  if (!LINE_ID.test(at)) return { ...reading.chat(''), earlier: false }
  if (!has(reach, 'talk') || opts.earlier === undefined) return reading.chat(at)
  const read = await inTime(opts.earlier.talk(at, BUDGET.chat), EARLIER_MS, false)
  const page = reading.chat(at)
  // What was held is answered all the same, and the page asks again.
  return read || page.why !== null ? page : { ...page, why: 'unread', earlier: true }
}

/** One agent's turns before a cursor its page holds. */
export async function turnsHere(
  params: Readonly<Record<string, string>>,
  before: string | null,
  reach: Reach,
  opts: Pick<ServerOptions, 'readingFor' | 'earlier'>,
): Promise<TurnsPage> {
  const task = `${params.project ?? ''}/${params.task ?? ''}`
  const here = opts.readingFor(reach).agent(task).here
  const allowed = here && has(reach, 'lanes')
  // A cursor that is not a record's is the beginning: nothing before it.
  const asked = before !== null && CURSOR.test(before) ? before : null
  if (!allowed) return turnsBefore(task, here, reach, null, [])
  if (asked === null) return turnsBefore(task, here, reach, { turns: [], before: null }, [])
  if (opts.earlier === undefined) return turnsBefore(task, here, reach, 'unread', [])
  const earlier = opts.earlier
  const read = await inTime<EarlierIn>(earlier.agent(task, asked), EARLIER_MS, 'unread')
  if (read === 'unread') return turnsBefore(task, here, reach, read, [], earlier.places(task))
  const known = earlier.known()
  const places = earlier.places(task)
  // A long turn is cleaned off the window's thread first (`turnsAway`), and one
  // that could not be throws: the server says it at the machine.
  await turnsAway(read.turns, known, places)
  return turnsBefore(task, here, reach, read, known, places)
}

/** One agent's moments before a cursor its page holds: within reach, on no grant. */
export async function momentsHere(
  params: Readonly<Record<string, string>>,
  before: string | null,
  reach: Reach,
  opts: Pick<ServerOptions, 'readingFor' | 'earlier'>,
): Promise<MomentsPage> {
  const task = `${params.project ?? ''}/${params.task ?? ''}`
  const here = opts.readingFor(reach).agent(task).here
  // A cursor that is not one the window gives is the beginning: nothing before it.
  const asked = before !== null && CURSOR.test(before) ? before : null
  if (!here || asked === null) return momentsBefore(task, here, null)
  if (opts.earlier === undefined) return momentsBefore(task, here, 'unread')
  const read = await inTime<MomentsIn>(opts.earlier.moments(task, asked), MOMENTS_MS, 'unread')
  return momentsBefore(task, here, read)
}

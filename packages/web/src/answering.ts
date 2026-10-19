import { type AnswerIn, answerOut, type CallAnswer, callAsked } from './answered.ts'
import { cleanAway } from './cleaning.ts'
import { has, type Reach } from './reach.ts'
import { inTime } from './request.ts'
import type { ServerOptions } from './serving.ts'

// The two routes that hand over one call's whole answer (`answered.ts`): who
// may be told it, and asking the window for it.
//
// **The conversation's own reach, asked again at the request**: an agent's
// call is answered where its task is one this device reads (`agent`'s own
// `here`) and the device was granted an agent's bytes (`lanes`); a call of the
// conversation with Tade where it was granted that conversation (`talk`) and
// `lanes`, as `withCalls` sends the call at all. A call is asked for by the key
// its row carried (`callKey`): the id itself, or its spelling, and anything
// else is answered as a call that is not there.

/** How long reading one answer out of a record may take before it is said to be unreadable. */
export const ANSWER_MS = 5_000

export async function answerHere(
  route: 'agent answer' | 'talk answer',
  params: Readonly<Record<string, string>>,
  reach: Reach,
  opts: Pick<ServerOptions, 'readingFor' | 'answers'>,
): Promise<CallAnswer> {
  const call = params.call ?? ''
  // Never echoed back as it came: a name that is not a call's is answered as none.
  const id = callAsked(call)
  if (id === null) return answerOut('', 'not here')
  const task = `${params.project ?? ''}/${params.task ?? ''}`
  if (route === 'agent answer') {
    if (!opts.readingFor(reach).agent(task).here) return answerOut(call, 'not here')
    if (!has(reach, 'lanes')) return answerOut(call, 'not granted')
  } else if (!has(reach, 'talk') || !has(reach, 'lanes')) {
    return answerOut(call, 'not granted')
  }
  const answers = opts.answers
  if (answers === undefined) return answerOut(call, 'unread')
  const read = await inTime<AnswerIn>(
    // The window's half says what it could not read, where it happened, and
    // answers `unread`: nothing is caught here to be passed off as anything.
    route === 'agent answer' ? answers.agent(task, id) : answers.talk(id),
    ANSWER_MS,
    'unread',
  )
  if (read === null || read === 'unread') return answerOut(call, read)
  if (read.result === '') return answerOut(call, 'nothing')
  // Cleaned off the window's thread when it is long (`cleaning.ts`), and a
  // cleaning that broke throws: the server says it at the machine, never a
  // word of the answer uncleaned.
  return answerOut(call, await cleanAway(read.result, answers.known()))
}

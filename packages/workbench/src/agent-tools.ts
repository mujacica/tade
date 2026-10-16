import type { EventInput } from '@tade/core'
import { LEFTOVERS, reportLeftovers } from './leftovers.ts'
import { producedDetail } from './tasks.ts'
import type { Workbench } from './workbench.ts'
import type { ExtensionCall } from './workers.ts'

// The tools an agent calls that run in this process: Tade's own first, then
// whichever extension's the name is. Tade's own are answered here and never
// handed on, so no extension can be the one that answers `tade_document_ready`.
//
// Two so far: an agent handing over the document its task produces before it
// has finished, and an agent reporting what it found and did not fix
// (`tade_leftovers`, `leftovers.ts`), which `tade_done` sends here too.
//
// What the person asked for, in their words: an agent that writes a plan or an
// analysis "informs the orchestrator and requests the user's intervention on
// what to do next". Until this, the only moment a document reached anybody was
// `task_done`, and a planner with a question — which of these, is this right —
// had no way to say so that did not also start everything waiting on it.
//
// One of Tade's own tools rather than an extension's: every harness that
// gives its agent `tade_done` gives it this too, and lends it over the same
// request-and-answer channel extension tools use, so a refusal reaches the
// agent as a failed call it can read (`answerExtensionCall`). The window hears
// the `document_ready` line and tells the orchestrator at once (`eventTell`).
//
// It decides nothing and starts nothing. What follows a document is the
// person's, put to them by the orchestrator; the only thing this line changes
// is that the document is on the list of what is waiting, with its question.

/** The tool's name, as every harness's own side registers it. */
export const DOCUMENT_READY = 'tade_document_ready'

/** What handing a document over needs: where tasks live, and the journal. */
export interface ReadyDeps {
  home: string
  log: { append(input: EventInput): Promise<unknown> }
}

/** Run a tool an agent called: one of Tade's own, or the extension's it names. */
export async function answerAgentTool(
  deps: ReadyDeps & {
    extensions?: { call(call: ExtensionCall & { project: string }): Promise<string> } | undefined
    /** The workbench, once it is made: what makes a leftover into parked work. */
    tasks?: () => Pick<Workbench, 'createTask' | 'parkTask' | 'log'>
  },
  call: ExtensionCall,
): Promise<string> {
  if (call.tool === DOCUMENT_READY) return documentReady(deps, call)
  if (call.tool === LEFTOVERS) {
    if (!deps.tasks) throw new Error('Tade cannot make work here, so it cannot take a report')
    return reportLeftovers(deps.tasks(), call)
  }
  if (!deps.extensions) throw new Error('Tade has no extensions loaded')
  return deps.extensions.call({ ...call, project: call.task.split('/')[0] ?? '' })
}

/** One agent's call, as the supervisor hands it on. */
export interface ReadyCall {
  run: string
  task: string
  input: Record<string, unknown>
}

/**
 * Write down that a task's document is ready for the person, with what its
 * agent needs them to decide, and say back what happens next.
 *
 * Refused — thrown, so the agent reads why — where there is nothing to hand
 * over: a task that names no document, a name Tade would not join onto a path,
 * or a file that is not there yet. The last is the one that matters: the
 * orchestrator is about to be sent to read it, and a path to nothing is a
 * summary of nothing.
 */
export async function documentReady(deps: ReadyDeps, call: ReadyCall): Promise<string> {
  const asked = typeof call.input.ask === 'string' ? call.input.ask.trim() : ''
  // Waiting is what it is for, so only a plain no carries on.
  const waits = call.input.wait !== false
  const made = await producedDetail(deps.home, call.task)
  if (!made.produces) {
    throw new Error(
      'this task names no document it produces, so there is nothing to hand over: say what you need in your reply, and the person reads it there',
    )
  }
  if (made.missing || made.bytes === 0) {
    throw new Error(
      `nothing readable is at ${made.produces} yet: write the document there first, then call this again`,
    )
  }
  await deps.log.append({
    type: 'document_ready',
    task: call.task,
    run: call.run,
    // Blocking only while somebody is being waited on: a draft handed over
    // by an agent that carries on is worth knowing, not worth a voice.
    urgency: waits ? 'blocking' : 'notable',
    detail: {
      produces: made.produces,
      ...(made.bytes === undefined ? {} : { bytes: made.bytes }),
      ...(asked ? { asked } : {}),
      waits,
    },
  })
  return waits
    ? `Tade has it: the orchestrator is reading ${made.produces} now and will put ${asked ? 'your question' : 'it'} to the person. Stop here and wait — their answer comes to you as a message. Do not call tade_done until the work is finished.`
    : `Tade has it: the orchestrator is told ${made.produces} is ready to read. Carry on.`
}

import { describeLeftovers, leftoversIn, relatedWork, type TadeEvent } from '@tade/core'
import { withTranscript } from '../model.ts'
import { tadeDid } from '../transcript.ts'
import type { Wiring } from './context.ts'
import type { Tellable } from './handed.ts'
import { putToOrchestrator, workNow } from './proposals.ts'

// What an agent found and did not fix, put to the orchestrator the moment the
// report is written down (`leftovers_reported`). The rule and the words are
// core's (`leftovers.ts`, `describeLeftovers`); the work was made parked by
// the workbench (`workbench/src/leftovers.ts`); this is the window telling the
// orchestrator, with what may already be on each one, the way it tells it
// about a watch's proposal (`putToOrchestrator`) — now, or kept as news and
// said on screen where it cannot be, and never started and never dropped.

/**
 * Tell the orchestrator what one report left, if `event` is one, and draw a
 * line saying so. The agent that left them is never offered as already on
 * them: it said it was not.
 */
export function offerLeftovers(wire: Wiring, orchestrator: Tellable, event: TadeEvent): void {
  const from = event.task
  const items = leftoversIn(event)
  if (!from || items.length === 0) return
  const proposals = items.map((item) => ({
    task: item.task,
    schedule: null,
    key: null,
    title: item.title,
    links: [],
    from,
    where: item.where,
  }))
  const work = workNow(wire, proposals).filter((one) => one.task !== from)
  const text = describeLeftovers({
    from,
    finishing: event.detail.finishing === true,
    told: items.map((item, at) => ({ item, related: relatedWork(proposals[at]!, work) })),
    now: wire.now(),
  })
  const tasks = items.map((item) => item.task)
  const where = putToOrchestrator(wire, orchestrator, text, tasks)
  const things = items.length === 1 ? 'something' : `${items.length} things`
  const said = `The agent on ${from} left ${things} it found and did not fix: ${where}.`
  wire.put(withTranscript(wire.state, tadeDid(wire.state.transcript, said, wire.now())))
  wire.draw()
}

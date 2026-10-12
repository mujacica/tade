import type { OrchestratorTool } from './tools-extension.ts'

// What is waiting to start, and changing it once it is queued: what it waits
// on, what it is told, when it goes, and taking it away.
//
// Beside `tools-extension.ts` rather than in it, for the reason every sibling
// here gives — that file is at its budget, and a budget only goes down — and
// because these two say one thing that reads better in one place than among
// forty descriptions: a plan is changed by writing on the work it made
// (`after`, `retell`), never by removing it and planning it again, which uses
// its names up for good and holds everything that waited on it. The rules are
// core's (`checkWaits`, `QUEUE_CHANGES`) and the words of each answer are the
// window's (`nowSays`); what is here is the half a model reads.
//
// Like everything pi loads, this file imports nothing from the Tade workspace:
// `rpc` is handed in.

/** JSON Schema, as `tools-extension.ts` builds one. */
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const string = (description: string) => ({ type: 'string', description })

const stringList = (description: string) => ({
  type: 'array',
  description,
  items: { type: 'string' },
})

/**
 * What queued work says it will change, said once for `tade_plan` and for
 * `retell`. In a shared checkout the start-time look holds work while any file
 * it lists is uncommitted (`collidesNow`), so a whole folder, or a file nearly
 * every change here ends by touching, held work for as long as the checkout
 * was busy — on 2026-10-11, a README and a file-size budget listed for a
 * one-sentence change.
 */
export const TOUCHES =
  'the files it will change, by path, as you read the code: not whole folders, and not files nearly every change in this project ends up touching (its README pictures, a file-size budget) unless the work is about them. Where agents share one checkout, any listed file somebody has left uncommitted, or any file in a listed folder, holds its start'

export function queueTools(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): OrchestratorTool[] {
  const tools: OrchestratorTool[] = []
  const tool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (params: Record<string, unknown>) => Promise<unknown>,
  ): void => {
    tools.push({
      name,
      label: name.replace(/^tade_/, 'tade: ').replace(/_/g, ' '),
      description,
      parameters,
      run,
    })
  }

  tool(
    'tade_queue',
    'What is waiting to start, and why: after what, until when, held by what, or paused. Work held because agents at work have already changed the files it was planned around says so, and says which files and whose. Answer questions about queued work with this, not from memory.',
    object({}),
    () => rpc('queue/list', {}),
  )

  tool(
    'tade_queue_change',
    'Change queued work or a schedule, as the human asked or as you decide when it is yours to. For queued work: start it now whatever it waits on; pause or resume it; wait, which looks again from now past what held it and is not "wait for the files" — work held on files being changed is held again at once, and starts by itself once they settle; after, which makes it wait on other tasks Tade has, as well as what it waits on or, with replace: true, instead (none, with replace, waits on nothing); retell, which changes what its agent is told (prompt) or what it says it will change (touches) before it starts; remove it; or order (order: the tasks first to last), which is only a preference among work already ready and never jumps a wait, unholds a hold or starts anything. To change when existing queued work starts, write the wait with after: never remove it and plan it again, which uses its name up for good and holds everything waiting on it. Every change answers with where the work stands now. Name no task to pause or resume a whole project\'s queue. For a schedule: start runs it now, and it can be paused, resumed, renamed or removed.',
    object(
      {
        change: {
          type: 'string',
          enum: [
            'start',
            'pause',
            'resume',
            'wait',
            'after',
            'retell',
            'order',
            'rename',
            'remove',
          ],
          description: 'what to do',
        },
        task: string(
          'the queued task, like checkout/add-refunds; start, wait, after, retell and remove need it',
        ),
        schedule: string('the schedule, by the id tade_queue lists it with'),
        name: string('the new name, when renaming a schedule'),
        project: string('the project, when pausing or resuming all of its queue'),
        order: stringList(
          'for order: the queued tasks, first to last; what is left out keeps its place behind',
        ),
        after: {
          type: 'array',
          description: 'for after: what it waits on, each a task tade_queue or tade_status lists',
          items: object(
            {
              task: string('a bare name in its project, or project/task'),
              why: string('why it has to wait, in a few words'),
            },
            ['task', 'why'],
          ),
        },
        replace: { type: 'boolean', description: 'for after: instead of what it waits on now' },
        prompt: string('for retell: what its agent is told when it starts, instead'),
        touches: stringList(`for retell, instead of what it says now: ${TOUCHES}`),
      },
      ['change'],
    ),
    (p) => rpc('queue/change', p),
  )

  return tools
}

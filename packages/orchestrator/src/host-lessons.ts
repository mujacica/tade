import { checkProposal, seenTwiceProblem } from '@tade/core'
import type { Workbench } from '@tade/workbench'

// The `ToolHost` method behind `tade_propose_check` (`tools-lessons.ts`): a
// mistake the orchestrator saw made twice, made into a proposed check.
//
// Its own file because `tool-host.ts` is near its budget, and because what it
// may do is a boundary worth reading in one place: it counts what the model
// named, in code (`seenTwiceProblem`), makes one task and parks it. Nothing
// here starts anything, and approving it is the person picking it up — the
// same act, in the same places, as approving an intake under `propose`.

type Handler = (params: Record<string, unknown>) => Promise<string>

export function lessonMethods(tade: Workbench): Record<string, Handler> {
  return {
    'check/propose': async (p) => {
      const project = String(p.project ?? '').trim()
      if (!tade.config.projects[project]) {
        throw new Error(`there is no project called ${project || '(none named)'}`)
      }
      const name = String(p.name ?? '').trim()
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
        throw new Error(`${name} is not a usable name: lowercase letters, digits and dashes`)
      }
      const what = String(p.mistake ?? '').trim()
      if (!what) throw new Error('say what the mistake is, in a sentence of your own')
      const tasks = [
        ...new Set((Array.isArray(p.tasks) ? p.tasks : []).map((one) => String(one).trim())),
      ].filter(Boolean)
      // Whether each was ever a task is the journal's to say: one that has
      // since been removed still had the mistake made in it.
      const created = await tade.log.read({ types: ['task_created'] })
      const made = new Set(created.map((event) => event.task).filter(Boolean))
      const problem = seenTwiceProblem(project, tasks, (task) => made.has(task))
      if (problem) throw new Error(problem)
      const proposal = checkProposal({
        project,
        name,
        what,
        seen: tasks.map((task) => ({ task })),
        by: 'reflection',
        ...(typeof p.seen === 'string' && p.seen.trim() ? { account: p.seen } : {}),
      })
      const task = await tade.createTask({
        project,
        slug: `check-${name}`,
        intent: proposal.prompt,
        by: 'orchestrator',
        context: proposal.context,
        start: { after: [], prompt: proposal.prompt, touches: [] },
      })
      // Through the one door that writes a park, straight after it is made:
      // starting reads the task file again (`startQueued`), so a queue that
      // saw it in between still finds it parked.
      await tade.parkTask(task.id, true, { by: 'orchestrator' })
      return `Proposed ${task.id}, parked: nothing starts until the person picks it up, which is approving it. Tell them it is there and what it would catch.`
    },
  }
}

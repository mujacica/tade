import type { AgentLane, TaskFacts, WebActing } from '@tade/web'
import { byOf, Moved, NotThere, type Outcome } from '@tade/web'
import { agentLaneOf } from '../away-lifecycle.ts'
import type { AgentMenuDoors } from './agent-doors.ts'
import { type ActingDeps, after, onTask } from './web-acting.ts'

// The window's end of the rest of an agent's menu from away: start, remove,
// rename, model and account — five verbs, the ones another machine's window
// presses there (`remote-agent.ts`), each through the door a press on the
// window's row goes through.
//
// **The same two checks as every verb.** `onTask` first: the revision the
// device echoed is the one the projection would put on that row now, so a
// press from a screen that has moved is a `409` that redraws the truth. Then,
// at the moment of the act, what the verb assumes is read again from the
// thing that is the truth — the registry's own lane, the journal's count of
// starts — and one act per task runs at a time (`busy`), because each door
// awaits between its own check and its write.
//
// | verb | read at the act | the door |
// |---|---|---|
// | `start` | the lane is not running, and the count of starts is the screen's | `Agents.reopenExactly`: `reopenAgent`, nothing said to it |
// | `remove` | nothing past `was`: removing what is already gone is a `404` | `Agents.removeExactly`: stopped on purpose, then `removeTask` |
// | `rename` | nothing past `was`: the same name twice is one name | `renameAgent`, its `task_named` line by the device |
// | `model` | the lane is running | `setAgentModel`, which asks its harness |
// | `account` | nothing past `was`: the door compares with where it is | `setAgentAccount` |
//
// **Who may ask is the gate's**: every paired device is the person's own and
// may ask for all five, under the origin and the passkey. Nothing here
// widens that.

/** The five verbs this file carries out, as `WebActing` declares them. */
export type AgentActing = Pick<WebActing, 'start' | 'remove' | 'rename' | 'model' | 'account'>

/** What the five need beyond `ActingDeps`: the window's doors for its agent menu. */
export interface AgentActingDeps extends ActingDeps {
  menus: () => AgentMenuDoors
}

/** The five verbs over one window's doors, one act per task at a time. */
export function agentActing(deps: AgentActingDeps): AgentActing {
  const busy = new Set<string>()
  // `async`, so a refusal from `onTask` is always a rejection and never a throw
  // before the promise exists.
  const alone = async (
    call: { task: string; was: string },
    work: (facts: TaskFacts) => Promise<Outcome>,
  ): Promise<Outcome> =>
    onTask(deps, call, async (facts) => {
      if (busy.has(call.task)) {
        throw new Moved(`${call.task} is being changed by another request`, after(facts))
      }
      busy.add(call.task)
      try {
        return await work(facts)
      } finally {
        busy.delete(call.task)
      }
    })
  const menus = () => deps.menus()
  return {
    start: (call, from) =>
      alone(call, async (facts) => {
        const starts = await startsNow(deps, call.task)
        if (starts !== facts.starts) {
          throw new Moved(
            `${call.task}'s agent was started again since that screen was drawn`,
            after(facts, { starts }),
          )
        }
        const lane = laneNow(deps, call.task)
        if (lane === 'running') {
          throw new Moved(`${call.task}'s agent is running`, after(facts, { lane }))
        }
        const came = await deps.lifecycle.agents().reopenExactly(call.task, byOf(from))
        if (came === 'nowhere')
          throw new NotThere(`the window does not know where ${call.task} works`)
        if (came === 'busy')
          throw new Moved(`${call.task}'s agent is being opened already`, after(facts))
        return {
          did: true,
          rev: after(facts, {
            lane: laneNow(deps, call.task),
            starts: await startsNow(deps, call.task),
          }),
          said:
            lane === 'stopped'
              ? 'started its agent where it left off, with nothing said to it'
              : 'started its agent on what its task says, with nothing said to it',
        }
      }),
    remove: (call, from) =>
      alone(call, async (facts) => {
        await menus().remove(call.task, byOf(from))
        return {
          did: true,
          rev: after(facts, { lane: 'none' }),
          said:
            'closed its agent for good: stopped, off the list, and its worktree and branch ' +
            'removed — anything it pushed or merged is where it was',
        }
      }),
    rename: (call, from) =>
      alone(call, async (facts) => {
        const named = await menus().rename(call.task, call.title, byOf(from))
        return { did: true, rev: after(facts), said: `it is called ${named} now` }
      }),
    model: (call, from) =>
      alone(call, async (facts) => {
        running(deps, call.task, facts)
        const id = await menus().model(call.task, call.model, byOf(from))
        return {
          did: true,
          rev: after(facts),
          said: `switching to ${id}; new agents keep the default`,
        }
      }),
    account: (call, from) =>
      alone(call, async (facts) => {
        const said = await menus().account(call.task, call.account, byOf(from))
        return { did: true, rev: afterNow(deps, call.task, facts), said: `it ${said}` }
      }),
  }
}

/** That its agent is running now, or a `409` saying it is not. */
function running(deps: ActingDeps, task: string, facts: TaskFacts): void {
  const lane = laneNow(deps, task)
  if (lane !== 'running') throw new Moved(`${task} has no agent running`, after(facts, { lane }))
}

/** The revision after an act that may have started its agent again: the lane as it is now. */
function afterNow(deps: ActingDeps, task: string, facts: TaskFacts): string {
  return after(facts, { lane: laneNow(deps, task) })
}

/** The task's own agent lane as the registry holds it **now**. */
function laneNow(deps: ActingDeps, task: string): AgentLane {
  return agentLaneOf({ id: task, lanes: deps.tade.lanes(task) })
}

/** How many agents were ever started on it, from the whole journal, now. */
async function startsNow(deps: ActingDeps, task: string): Promise<number> {
  return (await deps.tade.events({ types: ['run_started'], task })).length
}

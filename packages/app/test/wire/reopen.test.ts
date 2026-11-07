import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { type AppState, focusTask, initialState, withTasks } from '../../src/model.ts'
import { Agents, type AgentsDeps } from '../../src/wire/agents.ts'
import type { Wiring } from '../../src/wire/context.ts'

// The window opening an agent again by itself — `reopenStopped`, for the agent
// in front of you that stopped — and the promise beside it: an agent stopped
// on purpose is never started again behind your back.
//
// Closing an agent is stopping one on purpose, and it broke that promise
// (TADE-2): the window stopped the agent, git took its worktree away, and a
// look taken while git was still at it listed the task one more time — failed,
// "worktree missing", in front of you, with no lane. That is exactly an agent
// that stopped, so the window opened it again, in a folder that was gone.
//
// Over a stubbed workbench rather than a real one, because what is under test
// is which of the window's own rules fires on a look it was handed — and a look
// that lands after the worktree is gone is a race a real window cannot be made
// to lose on cue.

const TASK = 'app/refunds'

/** One task, in front of you, as a look taken mid-removal saw it: failed, with no lane. */
function windowWith(opts: { limit?: number; running?: string[]; lost?: boolean } = {}) {
  let state: AppState = focusTask(
    withTasks(initialState(), [
      {
        task: TASK,
        state: 'failed',
        reason: 'worktree missing',
        branch: 'tade/refunds',
        lane: null,
      },
    ]),
    TASK,
  )
  const asked: string[] = []
  const client = {
    stopAgent: async (task: string) => {
      asked.push(`stop ${task}`)
    },
    removeTask: async (req: { task: string }) => {
      asked.push(`remove ${req.task}`)
      return { removed: true, branchDeleted: true }
    },
    reopenAgent: async (req: { task: string; cwd: string; pastLimit?: boolean }) => {
      asked.push(`reopen ${req.task} in ${req.cwd}`)
      if (req.pastLimit !== true) throw new Error('refused')
      if (reopenFails) throw new Error('the harness would not start')
      return {}
    },
    runs: () => (opts.running ?? []).map((task) => ({ task })),
    lane: () => (opts.lost ? { lost: true } : null),
    resumeOf: () => ({ shown: true }),
    lanes: () =>
      opts.lost
        ? [{ id: `${TASK}/agent`, task: TASK, kind: 'agent', alive: false, lost: true }]
        : [],
  }
  let reopenFails = false
  const live = {
    factsOf: () => ({
      project: 'app',
      branch: 'tade/refunds',
      ahead: 0,
      workspace: 'worktree',
      links: [],
    }),
    worktreeOf: () => '/worktrees/app-refunds',
    changes: () => [],
    events: [],
    queueFacts: () => ({ finished: new Map() }),
    // The look this hands back is the one already taken: the task still on it.
    refresh: async () => {},
  }
  const wire = {
    opts: {
      client,
      config: ConfigSchema.parse({
        projects: {
          app: {
            root: '/repos/app',
            ...(opts.limit ? { max_parallel: opts.limit } : {}),
          },
        },
      }),
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live,
    now: () => 0,
    openedAt: 0,
    draw: () => {},
    note: () => {},
  } as unknown as Wiring
  const agents = new Agents(wire, {} as AgentsDeps)
  return {
    agents,
    asked,
    notice: () => state.notice,
    failing: () => {
      reopenFails = true
    },
  }
}

/** Whatever `reopenStopped` set going, finished. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('opening an agent again by itself', () => {
  it('opens the agent in front of you that stopped', async () => {
    // The rule itself, so the one below is about closing and not about a
    // window that never reopens anything.
    const { agents, asked } = windowWith()
    agents.reopenStopped()
    await settled()
    expect(asked).toEqual([`reopen ${TASK} in /worktrees/app-refunds`])
  })

  it('never opens one it closed, though a look taken mid-removal still lists it', async () => {
    const { agents, asked } = windowWith()
    await agents.closeAgent(TASK)
    agents.reopenStopped()
    await settled()
    expect(asked).toEqual([`stop ${TASK}`, `remove ${TASK}`])
  })

  it('leaves a stopped one shut in a project at its limit, saying so once', async () => {
    // Looking at an agent is not asking for it, and the refusal would be about
    // a start nobody made.
    const { agents, asked, notice } = windowWith({ limit: 1, running: ['app/search'] })
    agents.reopenStopped()
    agents.reopenStopped()
    await settled()
    expect(asked).toEqual([])
    expect(notice()).toContain('app is at its limit')
    expect(notice()).not.toContain('already has')
  })

  it('opens one the closure stopped whatever the limit, and a press whatever the limit', async () => {
    const lost = windowWith({ limit: 1, running: ['app/search'], lost: true })
    lost.agents.reopenStopped()
    await settled()
    expect(lost.asked).toEqual([`reopen ${TASK} in /worktrees/app-refunds`])

    const pressed = windowWith({ limit: 1, running: ['app/search'] })
    await pressed.agents.openAgent(TASK)
    expect(pressed.asked).toEqual([`reopen ${TASK} in /worktrees/app-refunds`])
    expect(pressed.notice()).toContain('opened app/refunds where it left off')
  })

  it('counts a lost agent as coming from before it is sent for until it has come or failed', async () => {
    const { agents, failing } = windowWith({ limit: 1, lost: true })
    expect(agents.comingBack()).toEqual([TASK])
    failing()
    agents.reopenLost()
    // On its way, and only in the one list.
    expect(agents.comingBack()).toEqual([TASK])
    await settled()
    await settled()
    // It did not come back, so it is not holding the room any more.
    expect(agents.comingBack()).toEqual([])
  })
})

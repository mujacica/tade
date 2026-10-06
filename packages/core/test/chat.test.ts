import { describe, expect, it } from 'vitest'
import type { AgentPromptInput, TadeEvent } from '../src/index.ts'
import {
  CHATS,
  chatName,
  chatNumberOf,
  chatTaskOf,
  composeAgentPrompt,
  decideApproval,
  isChatLane,
  isChatTask,
  nextChatTask,
  summarise,
} from '../src/index.ts'

// Chats: an agent that belongs to no project. What makes one is its id, so
// what is tested here is reading one — and the prompt, whose whole value is
// the things it does not say.

/** A journal line, as thin as the folds here read one. */
function event(at: Partial<TadeEvent>): TadeEvent {
  return {
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    type: 'lane_opened',
    urgency: 'routine',
    task: null,
    lane: null,
    run: null,
    detail: {},
    ...at,
  } as TadeEvent
}

describe('reading a chat out of an id', () => {
  it('tells a chat from a task, and a chat task from its lane', () => {
    expect(isChatTask(`${CHATS}/3`)).toBe(true)
    expect(isChatLane(`${CHATS}/3`)).toBe(false)
    expect(isChatLane(`${CHATS}/3/agent`)).toBe(true)
    expect(isChatTask(`${CHATS}/3/agent`)).toBe(false)
    expect(chatTaskOf(`${CHATS}/3/agent`)).toBe(`${CHATS}/3`)
  })

  it('reads nothing of a project that merely looks like one', () => {
    // A project really called `chats` is refused where one is opened, and the
    // numbering is what makes these unambiguous anyway: a task is a slug.
    expect(chatNumberOf('chats/refunds')).toBeNull()
    expect(chatNumberOf('app/3')).toBeNull()
    expect(chatNumberOf('chats')).toBeNull()
    // A lane of a chat's that Tade never makes is nobody's.
    expect(chatNumberOf(`${CHATS}/3/tests`)).toBeNull()
    expect(chatNumberOf(`${CHATS}/3/agent/extra`)).toBeNull()
  })

  it('says what one is called on its tab: its harness, and its number', () => {
    expect(chatName(`${CHATS}/2`, 'claude-code')).toBe('claude-code 2')
    // A lane written before harnesses were recorded still has a name.
    expect(chatName(`${CHATS}/2`, '')).toBe('chats 2')
  })
})

describe('the number the next chat gets', () => {
  it('starts at one on a journal that has never had one', () => {
    expect(nextChatTask([])).toBe(`${CHATS}/1`)
    expect(nextChatTask([event({ task: 'app/refunds' })])).toBe(`${CHATS}/1`)
  })

  it('never gives back a number a chat has already had', () => {
    // The lane registry forgets a dead chat — it has no task file to keep it —
    // so the journal is the only thing that remembers. A reused number would
    // not be a new chat: the harness names its session after the task, so
    // `chats/3` twice is one conversation carried on mid-sentence.
    const journal = [
      event({ task: `${CHATS}/1`, lane: `${CHATS}/1/agent` }),
      event({ task: `${CHATS}/3`, lane: `${CHATS}/3/agent`, type: 'lane_exited' }),
    ]
    expect(nextChatTask(journal)).toBe(`${CHATS}/4`)
  })

  it('reads the lane as well as the task, so an event with only one still counts', () => {
    expect(nextChatTask([event({ task: null, lane: `${CHATS}/7/agent` })])).toBe(`${CHATS}/8`)
  })
})

describe('what a chat is told', () => {
  // Everything a task's agent would be given, so what is absent below is
  // absent because this is a chat and not because nothing was passed.
  const input = {
    worktree: '/Users/someone',
    root: null,
    intent: '',
    branch: 'main',
    context: null,
    canSayDone: true,
    commit: 'as-you-go',
    push: 'branch-and-review',
    workspace: 'checkout',
    instructions: 'always say which file you are about to change',
    notes: [
      { at: '2026-01-01T00:00:00.000Z', text: 'the staging key rotated', scope: null, by: 'you' },
    ],
    checks: {
      ids: ['tests'],
      rule: {
        before: 'push',
        on_red: 'hold',
        only: [],
        run_here: {},
        parallel: 1,
        keep: 20,
        ci: true,
      },
      hold: true,
    },
  } satisfies Partial<AgentPromptInput>
  const told = composeAgentPrompt({ ...input, task: `${CHATS}/1`, project: CHATS })

  it('says it runs in Tade, which is the one fact every agent is told', () => {
    expect(told).toContain('You are running inside Tade')
    expect(told).toContain(`You are ${CHATS}/1`)
    expect(told).toContain('/Users/someone')
  })

  it('says it has no task and no project, in those words', () => {
    expect(told).toContain('You have no task and no project.')
  })

  it('is told not one of the things a task’s agent is told to do', () => {
    // Asserted against the other prompt rather than against a list of words,
    // because the chat's own sentences say *that none of this is happening* —
    // "nothing you do is committed for you" has `commit` in it — and because a
    // list of words goes stale the first time somebody rewrites a sentence.
    const task = composeAgentPrompt({ ...input, task: 'app/refunds', project: 'app' })
    const said = task.split('\n').filter((line) => line.startsWith('- '))
    expect(said.length).toBeGreaterThan(5)
    for (const line of said) expect(told, line).not.toContain(line)
  })

  it('has no commit trailer and no way to call itself finished', () => {
    // The two that would be acted on rather than merely read: a chat has
    // nothing to put a trailer on, and no task for `tade_done` to finish.
    expect(told).not.toContain('Tade-Task:')
    expect(told).not.toContain('tade_done')
  })

  it('carries the person’s own rules for every agent, and none of their notes', () => {
    expect(told).toContain('always say which file you are about to change')
    // A note is something told Tade about work. This is not work.
    expect(told).not.toContain('the staging key rotated')
  })
})

describe('what a chat is called out loud', () => {
  it('is said as a chat and its number, never as the number alone', () => {
    const held = [
      event({ task: `${CHATS}/1`, type: 'turn_done', urgency: 'notable' }),
      event({ task: 'app/refunds', type: 'turn_done', urgency: 'notable' }),
    ]
    const said = summarise(held)
    expect(said).toContain('chats 1 finished')
    // A task is still known by its own slug, which is the name somebody gave it.
    expect(said).toContain('refunds finished')
  })
})

describe('what a chat may do unasked', () => {
  // The decision `openChat` makes by giving one no worktree: nothing a chat
  // writes is its own work, because a chat stands in your home directory and
  // every checkout, key and file you have is under it.
  const asked = (worktree: string | null, path: string) =>
    decideApproval(
      { tool: 'write', input: { path }, worktree },
      { mode: 'policy', autoAllow: [], rules: [] },
    )

  it('is asked before changing any file, because it owns none', () => {
    expect(asked('', '/Users/someone/notes.md').decision).toBe('ask')
    expect(asked('', '/Users/someone/.ssh/config').decision).toBe('ask')
    expect(asked('', '/Users/someone/work/app/src/index.ts').decision).toBe('ask')
  })

  it('is the one thing a task’s agent is not asked about, inside its own worktree', () => {
    expect(asked('/Users/someone/work/app', '/Users/someone/work/app/src/index.ts').decision).toBe(
      'allow',
    )
  })
})

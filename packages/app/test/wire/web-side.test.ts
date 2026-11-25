import { ConfigSchema } from '@tade/core'
import { SideAnswerSchema } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { type AgentPane, type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { sideFrom } from '../../src/wire/web-side.ts'

// This machine's half of `/api/side` (`web-side.ts`): one project as its own
// window draws it, out of what the window holds — its panes, `hereOf` over
// `Live` for the checkout, the notes, the schedules and the requests the
// heart's subjects say, and the header of the agent another screen has in
// front of it as `Routes` says it here.

const pane = (task: string, over: Partial<AgentPane> = {}): AgentPane => ({
  task,
  project: task.split('/')[0] ?? '',
  name: task.split('/')[1] ?? task,
  title: null,
  branch: `tade/${task.split('/')[1]}`,
  lane: `${task}/agent`,
  state: 'working',
  waiting: false,
  approval: null,
  lanes: [{ id: `${task}/agent`, kind: 'agent' }],
  ...over,
})

function window(asked: string[]) {
  const state: AppState = {
    ...initialState(),
    panes: [pane('tade/fix-it'), pane('tade/later', { state: 'queued' }), pane('other/thing')],
  }
  const live = {
    hasLooked: true,
    worktreeOf: (task: string) => (task === 'tade/fix-it' ? '/srv/tade' : null),
    factsOf: () => ({
      project: 'tade',
      branch: 'tade/fix-it',
      ahead: 1,
      workspace: 'checkout',
      links: [],
    }),
    baseOf: (task: string | null) => (task ? 'main' : null),
    files: (root: string | null) => {
      asked.push(`files ${root}`)
      return root === null
        ? null
        : [{ path: 'a.ts', name: 'a.ts', depth: 0, folder: false, open: false }]
    },
    marksAt: () => ({ 'a.ts': 'M' }),
    branchAt: () => 'main',
    changesAt: () => [{ path: 'a.ts', mark: 'M', added: 3, removed: 1 }],
    notes: (project: string) => [{ text: `about ${project}`, at: '2026-11-25T10:00:00.000Z' }],
    retiredNotes: () => [],
    vitals: () => ({ model: 'claude-opus-5', thinking: 'high', contextPercent: 14 }),
    spendToday: () => ({ byTask: { 'tade/fix-it': { tokens: 5_200_000, usd: 0 } } }),
  }
  const wire = {
    state,
    now: () => 0,
    live,
    opts: {
      config: ConfigSchema.parse({ projects: { tade: { root: '/srv/tade' } } }),
      client: {
        agentHarness: async () => ({
          harness: 'claude-code',
          capabilities: {
            steer: 'live',
            model: 'restart',
            thinking: 'restart',
            rename: 'live',
            accounts: true,
            thinkingLevels: ['low', 'medium', 'high'],
            why: {},
          },
        }),
      },
    },
  } as unknown as Wiring
  return sideFrom(wire, {
    schedules: () => [],
    intake: () => ({ intake: [], intakeEmpty: { short: 'off', long: 'off' } }),
  })
}

describe('one project as this window draws it, for another machine', () => {
  it('answers its own panes, checkout, notes and the header of the agent asked about', async () => {
    const asked: string[] = []
    const answer = await window(asked)({
      project: 'tade',
      agent: 'tade/fix-it',
      expanded: [],
      files: true,
    })
    expect(answer).not.toBeNull()
    const read = SideAnswerSchema.parse(answer)
    expect(read.panes.map((one) => one.task)).toEqual(['tade/fix-it', 'tade/later'])
    expect(read.spent).toEqual([{ task: 'tade/fix-it', tokens: 5_200_000, usd: 0 }])
    expect(read.changes).toEqual([{ path: 'a.ts', mark: 'M', added: 3, removed: 1 }])
    expect(read.files?.map((one) => one.path)).toEqual(['a.ts'])
    expect(read.where).toMatchObject({ branch: 'tade/fix-it', base: 'main', path: '/srv/tade' })
    expect(read.notes.map((one) => one.text)).toEqual(['about tade'])
    expect(read.agent).toMatchObject({
      task: 'tade/fix-it',
      route: { harness: 'claude-code' },
      vitals: { model: 'claude-opus-5', thinking: 'high', contextPercent: 14 },
    })
    expect(asked).toEqual(['files /srv/tade'])
  })

  it('reads no tree nobody has open, and no header for an agent of another project', async () => {
    const asked: string[] = []
    const answer = await window(asked)({
      project: 'tade',
      agent: 'other/thing',
      expanded: [],
      files: false,
    })
    expect(answer?.files).toBeNull()
    expect(answer?.agent).toBeNull()
    expect(asked).toEqual(['files null'])
  })

  it('answers nothing about a project that is not open here', async () => {
    expect(
      await window([])({ project: 'elsewhere', agent: null, expanded: [], files: true }),
    ).toBeNull()
  })
})

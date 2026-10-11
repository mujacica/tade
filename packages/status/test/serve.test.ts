import { ConfigSchema, type Workspace } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { StatusAnswer, StatusAsk, StatusCollector } from '../src/collector.ts'
import { answeredOf, askOf, type Channel, isReady, serveStatus } from '../src/serve.ts'

// The child's half, in this process: what `child.ts` does with its channel,
// over a channel a test holds both ends of. Everything off the pipe is checked
// before it is believed, both ways.

const ask: StatusAsk = {
  config: ConfigSchema.parse({ workspace: { adopt: false } }),
  now: 0,
  home: '/nowhere',
  tadeHome: '/nowhere',
  pr: false,
  lanes: {},
}

const workspace = {
  generatedAt: '2026-10-11T12:00:00.000Z',
  projects: [
    {
      name: 'app',
      root: '/src/app',
      brief: null,
      untracked: [],
      tasks: [{ id: 'app/one', state: 'working' }],
    },
  ],
  elsewhere: [],
  toolServers: { looked: true, alive: 0 },
  warnings: [],
} as unknown as Workspace

const spent = { spawns: 3, rss: 1, pid: 2 }

/** A channel the test holds the other end of. */
function channel() {
  const sent: unknown[] = []
  let listener: (message: unknown) => void = () => {}
  const end: Channel = {
    on: (_event, heard) => {
      listener = heard
    },
    send: (message) => {
      sent.push(message)
      return true
    },
  }
  return { end, sent, say: (message: unknown) => listener(message) }
}

const answering = (answer: (ask: StatusAsk) => Promise<StatusAnswer>): StatusCollector => ({
  id: 'here',
  collect: answer,
  close: async () => {},
})

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('serveStatus', () => {
  it('says it is ready once it is listening, then answers each ask by its id', async () => {
    const { end, sent, say } = channel()
    serveStatus(
      end,
      answering(async () => ({ known: true, workspace, spent })),
    )
    expect(sent).toEqual([{ ready: true }])
    say({ id: 7, ask })
    say({ id: 8, ask })
    await settle()
    expect(sent.slice(1)).toEqual([
      { id: 7, answer: { known: true, workspace, spent } },
      { id: 8, answer: { known: true, workspace, spent } },
    ])
  })

  it('answers an ask it cannot read unknown, and garbage with no id not at all', async () => {
    const { end, sent, say } = channel()
    serveStatus(
      end,
      answering(async () => ({ known: true, workspace, spent })),
    )
    say({ id: 3, ask: { ...ask, now: 'soon' } })
    say('hello')
    say({ ask })
    await settle()
    expect(sent.slice(1)).toEqual([
      { id: 3, answer: { known: false, why: 'status was asked something it cannot read' } },
    ])
  })

  it('answers a look that threw unknown, rather than leaving the window waiting', async () => {
    const { end, sent, say } = channel()
    serveStatus(
      end,
      answering(async () => {
        throw new Error('no')
      }),
    )
    say({ id: 1, ask })
    await settle()
    expect(sent[1]).toEqual({ id: 1, answer: { known: false, why: 'status: Error: no' } })
  })

  it('says nothing, and does not throw, once the window has gone', async () => {
    let listener: (message: unknown) => void = () => {}
    let tried = 0
    const gone: Channel = {
      on: (_event, heard) => {
        listener = heard
      },
      send: () => {
        tried += 1
        throw new Error('channel closed')
      },
    }
    let looked = 0
    const collector = answering(async () => {
      looked += 1
      return { known: false, why: 'x' }
    })
    expect(() => serveStatus(gone, collector)).not.toThrow()
    listener({ id: 1, ask })
    await settle()
    // It looked, and tried to answer — the ready and the answer — and neither
    // throw reached anybody: a child whose window has gone is about to go too.
    expect(looked).toBe(1)
    expect(tried).toBe(2)
  })
})

describe('what comes off the pipe', () => {
  it('takes an ask that has everything a look needs, and nothing that lacks any of it', () => {
    expect(askOf({ id: 1, ask })).toEqual({ id: 1, ask })
    expect(askOf({ id: 1, ask: { ...ask, cwd: '/src/app' } })).not.toBeNull()
    for (const bad of [
      null,
      'ask',
      [],
      { id: 1.5, ask },
      { id: 1 },
      { id: 1, ask: { ...ask, config: null } },
      { id: 1, ask: { ...ask, lanes: [] } },
      { id: 1, ask: { ...ask, pr: 'no' } },
      { id: 1, ask: { ...ask, home: 4 } },
      { id: 1, ask: { ...ask, cwd: 4 } },
    ]) {
      expect(askOf(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('takes an answer that is a workspace or unknown, and nothing else', () => {
    expect(answeredOf({ id: 1, answer: { known: true, workspace, spent } })).not.toBeNull()
    expect(answeredOf({ id: 1, answer: { known: false, why: 'busy' } })).not.toBeNull()
    const project = workspace.projects[0]
    for (const bad of [
      { id: 1, answer: { known: false } },
      { id: 1, answer: { known: 'yes', workspace, spent } },
      { id: 1, answer: { known: true, workspace } },
      { id: 1, answer: { known: true, workspace, spent: { ...spent, rss: '1' } } },
      { id: 1, answer: { known: true, workspace, spent: { ...spent, pid: null } } },
      { id: 1, answer: { known: true, workspace: 'nothing', spent } },
      { id: 1, answer: { known: true, workspace: { ...workspace, warnings: [3] }, spent } },
      { id: 1, answer: { known: true, workspace: { ...workspace, elsewhere: {} }, spent } },
      { id: 1, answer: { known: true, workspace: { ...workspace, projects: {} }, spent } },
      {
        id: 1,
        answer: { known: true, workspace: { ...workspace, toolServers: { alive: 0 } }, spent },
      },
      {
        id: 1,
        answer: {
          known: true,
          workspace: { ...workspace, projects: [{ ...project, tasks: [{ id: 'app/one' }] }] },
          spent,
        },
      },
      {
        id: 1,
        answer: {
          known: true,
          workspace: { ...workspace, projects: [{ ...project, untracked: null }] },
          spent,
        },
      },
      { answer: { known: false, why: 'busy' } },
      'hello',
    ]) {
      expect(answeredOf(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('knows a child that says it is ready, and nothing else as that', () => {
    expect(isReady({ ready: true })).toBe(true)
    expect(isReady({ ready: 'yes' })).toBe(false)
    expect(isReady(null)).toBe(false)
  })
})

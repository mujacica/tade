import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type RemoteHost, remoteMethods } from '../src/host-remotes.ts'
import { listedTools } from '../src/tools-listed.ts'
import { remoteTools } from '../src/tools-remotes.ts'

/** A window's reads of another machine that write down what each was asked. */
function reading(asked: unknown[]): Omit<RemoteHost, 'tell'> {
  return {
    move: async (req) => {
      asked.push({ move: req })
      return 'moved'
    },
    status: async (machine) => {
      asked.push({ status: machine })
      return '{}'
    },
    documents: async (req) => {
      asked.push({ documents: req })
      return 'listed'
    },
    intake: async (req) => {
      asked.push({ intake: req })
      return 'requests'
    },
    tool: async (req) => {
      asked.push({ tool: req })
      return 'answered there'
    },
  }
}

// Passing a sentence to another machine's orchestrator: the tool a model
// reads, and the method behind it. What may reach it is `origin.ts`'s
// (`origin.test.ts`), and the person's line naming the machine is the
// window's; what is here is that both halves carry exactly the three things
// and that no window is said as no window.

describe('passing a sentence to another machine', () => {
  it('carries the machine, the sentence and their line, and nothing else', async () => {
    const asked: { method: string; params: Record<string, unknown> }[] = []
    const [tool] = remoteTools(async (method, params) => {
      asked.push({ method, params })
      return 'passed on'
    })
    expect(tool?.name).toBe('tade_remote_tell')
    expect(tool?.parameters).toMatchObject({ required: ['machine', 'said', 'asked'] })
    const answer = await tool?.run(
      {
        machine: 'vps',
        said: 'start the release',
        asked: 'ask vps to start the release',
        extra: 1,
      },
      'call-1',
      {} as never,
    )
    expect(answer).toBe('passed on')
    expect(asked).toEqual([
      {
        method: 'remote/tell',
        params: {
          machine: 'vps',
          said: 'start the release',
          asked: 'ask vps to start the release',
        },
      },
    ])
  })

  it('is the window’s, and says so where no window is open', async () => {
    const told: unknown[] = []
    const methods = remoteMethods(() => ({
      ...reading([]),
      tell: async (req) => {
        told.push(req)
        return 'passed on'
      },
    }))
    await expect(methods['remote/tell']?.({ machine: 'vps', said: 'x' })).resolves.toBe('passed on')
    expect(told).toEqual([{ machine: 'vps', said: 'x', asked: '' }])
    await expect(remoteMethods(() => undefined)['remote/tell']?.({})).rejects.toThrow(
      'no window is open',
    )
  })
})

describe('moving work to another machine', () => {
  it('carries the task, the machine and their line, and nothing else', async () => {
    const asked: { method: string; params: Record<string, unknown> }[] = []
    const tool = remoteTools(async (method, params) => {
      asked.push({ method, params })
      return 'moved'
    }).find((one) => one.name === 'tade_task_move')
    expect(tool?.parameters).toMatchObject({ required: ['task', 'machine', 'asked'] })
    // What a model reads says the conversation does not go with it.
    expect(tool?.description).toContain('Nothing of the conversation moves')
    const answer = await tool?.run(
      { task: 'docs/landing', machine: 'vps', asked: 'start the landing page on the vps', x: 1 },
      'call-1',
      {} as never,
    )
    expect(answer).toBe('moved')
    expect(asked).toEqual([
      {
        method: 'remote/move',
        params: {
          task: 'docs/landing',
          machine: 'vps',
          asked: 'start the landing page on the vps',
        },
      },
    ])
    const moved: unknown[] = []
    const methods = remoteMethods(() => ({ ...reading(moved), tell: async () => '' }))
    await methods['remote/move']?.({ task: 'docs/landing', machine: 'vps' })
    expect(moved).toEqual([{ move: { task: 'docs/landing', machine: 'vps', asked: '' } }])
    await expect(remoteMethods(() => undefined)['remote/move']?.({})).rejects.toThrow(
      'no window is open',
    )
  })
})

describe('reading another machine', () => {
  it('carries the machine and what was asked of it, and nothing that was not given', async () => {
    const asked: unknown[] = []
    const methods = remoteMethods(() => ({ ...reading(asked), tell: async () => '' }))
    await methods['remote/status']?.({ machine: 'vps', extra: 1 })
    await methods['remote/documents']?.({ machine: 'vps' })
    await methods['remote/documents']?.({ machine: 'vps', task: 'tade/plan', name: 'PLAN.md' })
    await methods['remote/intake']?.({ machine: 'vps', waiting: 'yes', project: '' })
    await methods['remote/intake']?.({ machine: 'vps', waiting: true, item: 'github:1' })
    await methods['remote/tool']?.({ machine: 'vps', tool: 'sentry_issues', input: [1] })
    expect(asked).toEqual([
      { status: 'vps' },
      { documents: { machine: 'vps' } },
      { documents: { machine: 'vps', task: 'tade/plan', name: 'PLAN.md' } },
      { intake: { machine: 'vps' } },
      { intake: { machine: 'vps', waiting: true, item: 'github:1' } },
      { tool: { machine: 'vps', tool: 'sentry_issues', input: {} } },
    ])
    await expect(remoteMethods(() => undefined)['remote/status']?.({})).rejects.toThrow(
      'no window is open',
    )
  })
})

describe('an extension’s tools, as the orchestrator is given them', () => {
  const was = process.env.TADE_EXTENSION_TOOLS
  afterEach(() => {
    if (was === undefined) delete process.env.TADE_EXTENSION_TOOLS
    else process.env.TADE_EXTENSION_TOOLS = was
  })

  it('lets a tool that only reads name another machine, and runs one that does not only here', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tade-listed-')), 'tools.json')
    const parameters = { type: 'object', properties: { project: { type: 'string' } }, required: [] }
    writeFileSync(
      path,
      JSON.stringify([
        {
          name: 'sentry_issues',
          label: 'Sentry: issues',
          description: 'Issues.',
          parameters,
          reads: true,
        },
        {
          name: 'sentry_update_issue',
          label: 'Sentry: update',
          description: 'Update.',
          parameters,
        },
      ]),
    )
    process.env.TADE_EXTENSION_TOOLS = path
    const asked: { method: string; params: Record<string, unknown> }[] = []
    const [reads, changes] = listedTools(async (method, params) => {
      asked.push({ method, params })
      return 'ok'
    })
    expect(Object.keys((reads?.parameters.properties ?? {}) as object)).toEqual([
      'project',
      'machine',
    ])
    expect(reads?.description).toContain('Pass `machine` to ask another machine')
    expect(Object.keys((changes?.parameters.properties ?? {}) as object)).toEqual(['project'])
    await reads?.run({ project: 'tade', machine: 'vps' }, 'c1', {} as never)
    await reads?.run({ project: 'tade' }, 'c2', {} as never)
    await changes?.run({ project: 'tade', machine: 'vps' }, 'c3', {} as never)
    expect(asked).toEqual([
      {
        method: 'remote/tool',
        params: { machine: 'vps', tool: 'sentry_issues', input: { project: 'tade' } },
      },
      {
        method: 'extension/call',
        params: { tool: 'sentry_issues', input: { project: 'tade' }, callId: 'c2' },
      },
      {
        method: 'extension/call',
        params: {
          tool: 'sentry_update_issue',
          input: { project: 'tade', machine: 'vps' },
          callId: 'c3',
        },
      },
    ])
  })
})

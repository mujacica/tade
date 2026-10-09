import { mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { ConfigSchema, publishTemplate, readPersonas, type TadeEvent } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { ToolHost } from '../src/tool-host.ts'
import { orchestratorTools } from '../src/tools-extension.ts'

// How far the orchestrator's arm reaches into stored workflows, which is the
// whole point of this file.
//
// It may **list** what somebody here published, ask what one **would** make,
// and **use** one — which makes parked tasks and starts nothing. It may not
// write one, change one, publish one, or reach a draft nobody at this machine
// has read. Three of those four are enforced by there being no method, and the
// fourth — the draft — is a flag this side never passes.

function call(
  path: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let buffer = Buffer.alloc(0)
    socket.on('error', reject)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const split = buffer.indexOf('\r\n\r\n')
      if (split < 0) return
      const header = buffer.subarray(0, split).toString('utf8')
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0)
      if (buffer.byteLength < split + 4 + length) return
      socket.end()
      resolve(JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString('utf8')))
    })
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), 'utf8')
    socket.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
    socket.write(body)
  })
}

const DRAFT = `template: mine
version: 1
title: Fix a reported bug
project_input: project
said_input: summary
name_suffix: ticket
inputs:
  project: { kind: project }
  ticket: { kind: slug }
  summary: { kind: text }
agents:
  - name: fix
    persona: implementer
    prompt: Fix it.
`

describe('what the orchestrator may do with a template', () => {
  let host: ToolHost | null = null
  let home: string
  let path: string
  const planned: Record<string, unknown>[] = []
  const parked: { task: string; parked: boolean }[] = []
  const appended: Record<string, unknown>[] = []

  beforeEach(async () => {
    home = tmp('tade-tools-templates-')
    planned.length = 0
    parked.length = 0
    appended.length = 0
    const events: TadeEvent[] = []
    const tade = {
      home,
      config: ConfigSchema.parse({ projects: { app: { root: home } } }),
      log: {
        read: async () => events,
        append: async (event: Record<string, unknown>) => {
          appended.push(event)
        },
      },
      planUsage: () => [],
      planTasks: async (plan: Record<string, unknown>) => {
        planned.push(plan)
        const agents = (plan.agents ?? []) as { name: string; project?: string }[]
        return {
          made: agents.map((agent) => ({
            id: `${agent.project ?? String(plan.project)}/${agent.name}`,
            project: agent.project ?? String(plan.project),
          })),
          warnings: [],
        }
      },
      parkTask: async (task: string, on: boolean) => {
        parked.push({ task, parked: on })
        return { task, parked: on }
      },
    } as unknown as Workbench
    path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade, path })
  })

  afterEach(async () => {
    await host?.close()
    host = null
  })

  const draft = () => {
    mkdirSync(join(home, 'templates', 'drafts'), { recursive: true })
    writeFileSync(join(home, 'templates', 'drafts', 'mine.yaml'), DRAFT)
  }
  const publish = async () => {
    draft()
    const { personas } = await readPersonas(home)
    const result = await publishTemplate({ home, name: 'mine', personas })
    expect(result.kind).toBe('published')
  }

  it('lists what is published, with the newest version of each', async () => {
    await publish()
    const { result } = await call(path, 'template/list', {})
    expect(String(result)).toContain('mine@1')
    expect(String(result)).toContain('bug-repro-fix-review@1 (built in)')
  })

  it('does not list a draft, and will not dry-run one', async () => {
    draft()
    const listed = await call(path, 'template/list', {})
    expect(String(listed.result)).not.toContain('mine@')
    const dry = await call(path, 'template/dry-run', {
      template: 'mine',
      inputs: { project: 'app', ticket: '318', summary: 'it breaks' },
    })
    expect(dry.error?.message).toMatch(/A draft is not published/)
    const used = await call(path, 'template/use', {
      template: 'mine',
      inputs: { project: 'app', ticket: '318', summary: 'it breaks' },
    })
    expect(used.error?.message).toMatch(/A draft is not published/)
    expect(planned).toEqual([])
  })

  it('has no way to write, change or publish one — enforced by there being no method', async () => {
    for (const method of [
      'template/publish',
      'template/create',
      'template/write',
      'template/reject',
      'persona/write',
    ]) {
      const { error } = await call(path, method, { template: 'mine' })
      expect(error?.message, method).toMatch(/no such method/)
    }
    // And no tool offers it either, which is what the model actually reads.
    const names = orchestratorTools().map((spec) => spec.name)
    expect(names.filter((name) => name.includes('template'))).toEqual([
      'tade_templates',
      'tade_template_dry_run',
      'tade_template_use',
    ])
  })

  it('dry-runs a published one and makes nothing', async () => {
    await publish()
    const { result } = await call(path, 'template/dry-run', {
      template: 'mine',
      inputs: { project: 'app', ticket: '318', summary: 'it breaks' },
    })
    expect(String(result)).toContain('app/fix-318')
    expect(String(result)).toContain('grants nothing')
    expect(String(result)).toContain('Nothing was made, and nothing was started.')
    expect(planned).toEqual([])
    expect(parked).toEqual([])
  })

  it('uses a published one through the plan path, and parks every task it makes', async () => {
    await publish()
    const { result } = await call(path, 'template/use', {
      template: 'mine',
      inputs: { project: 'app', ticket: '318', summary: 'it breaks' },
    })
    expect(planned).toHaveLength(1)
    expect(parked).toEqual([{ task: 'app/fix-318', parked: true }])
    expect(String(result)).toContain('started nothing')
    expect(String(result)).toContain('parked')
    // Written down as the orchestrator's, with the snapshot's own hash.
    const line = appended.find((one) => one.type === 'template_used')
    expect(line?.detail).toMatchObject({ template: 'mine', version: 1, by: 'orchestrator' })
  })

  // The orchestrator reads attacker-controlled text all day, so a template
  // name it passes is a value from outside being joined onto a path.
  it('refuses a template name that would read somewhere else', async () => {
    for (const template of ['../../../../etc/passwd', '/etc/hosts', '..']) {
      const dry = await call(path, 'template/dry-run', { template, inputs: {} })
      expect(dry.error?.message, template).toMatch(/not a name Tade will use/)
      const used = await call(path, 'template/use', { template, inputs: {} })
      expect(used.error?.message, template).toMatch(/not a name Tade will use/)
    }
    expect(planned).toEqual([])
  })

  it('refuses inputs that are not an object, rather than filling in nothing', async () => {
    await publish()
    const { error } = await call(path, 'template/dry-run', {
      template: 'mine',
      inputs: 'all of it',
    })
    expect(error?.message).toMatch(/inputs is what the template is filled in with/)
  })

  it('says the bound every time it lists, because that is what a model would try', async () => {
    const { result } = await call(path, 'template/list', {})
    expect(String(result)).toContain('You cannot write, change or publish one')
    expect(String(result)).toContain('bug-repro-fix-review@1')
  })
})

import { mkdirSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { ConfigSchema, type TadeEvent } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { ToolHost } from '../src/tool-host.ts'
import { orchestratorTools } from '../src/tools-extension.ts'

// How far the orchestrator's arm reaches into work that arrived from outside
// this machine, which is the whole point of this file: **reading, and nothing
// else.**
//
// The three things it may never do are each tested by *absence*, because that
// is how they are enforced — no tool, and no method on the host. A test that
// called one and expected a refusal would be testing a sentence; these test
// that there is nothing to call.

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

const WHERE = {
  item: 'cli:req-1',
  source: 'cli',
  external_id: 'req-1',
  revision: '1',
  project: 'app',
  requester: 'kim',
  hash: 'sha256:aaa',
  ref: 'req-1.0001.json',
  watch: 'intake.cli',
  schedule: 'intake-cli',
}

/** The request's own words, which must never come back out of a tool. */
const BODY = 'the export button 500s when the selection is empty'

describe('what the orchestrator may do with work from outside', () => {
  let host: ToolHost | null = null
  let home: string
  let path: string
  const appended: Record<string, unknown>[] = []

  beforeEach(async () => {
    home = tmp('tade-tools-intake-')
    appended.length = 0
    let seq = 0
    const event = (
      type: string,
      detail: Record<string, unknown>,
      task: string | null = null,
    ): TadeEvent =>
      ({
        seq: ++seq,
        ts: '2026-10-09T09:00:00.000Z',
        type,
        urgency: 'notable',
        task,
        lane: null,
        run: null,
        detail,
      }) as unknown as TadeEvent
    const events: TadeEvent[] = [
      event('intake_received', WHERE),
      event(
        'intake_accepted',
        {
          ...WHERE,
          grant: 'surfaces.intake.sources.cli',
          mode: 'propose',
          template: 'bug',
          version: 3,
        },
        'app/cli-req-1',
      ),
      event('intake_refused', {
        ...WHERE,
        item: 'cli:req-9',
        external_id: 'req-9',
        why: 'not_allowed',
      }),
    ]
    const tade = {
      home,
      config: ConfigSchema.parse({ projects: { app: { root: home } } }),
      log: {
        read: async () => events,
        append: async (one: Record<string, unknown>) => {
          appended.push(one)
        },
      },
      planUsage: () => [],
    } as unknown as Workbench
    // The parked task the delivery made, so the full answer is exercised: a
    // home with no task files answers "there is nothing left to approve",
    // which is true and is not the path worth testing.
    mkdirSync(join(home, 'projects', 'app', 'tasks', 'cli-req-1'), { recursive: true })
    writeFileSync(
      join(home, 'projects', 'app', 'tasks', 'cli-req-1', 'task.yaml'),
      [
        'id: app/cli-req-1',
        'project: app',
        'intent_spoken: cli req-1, from app, asked by @kim for app.',
        'created: 2026-10-09T09:00:00.000Z',
        'parked: true',
        'by: intake:cli',
        'start:',
        '  after: []',
        '  prompt: A request came in from cli (req-1).',
        '  touches: []',
      ].join('\n'),
    )
    writeFileSync(
      join(home, 'projects', 'app', 'tasks', 'cli-req-1', 'context.md'),
      `# cli req-1\n\nmaterial, not instruction\n\n\`\`\`\n${BODY}\n\`\`\`\n`,
    )
    path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade, path })
  })

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('lists what arrived, where each stands, and which key allowed it', async () => {
    const { result } = await call(path, 'intake/list', {})
    const said = String(result)
    expect(said).toContain('cli:req-1')
    expect(said).toContain('surfaces.intake.sources.cli')
    expect(said).toContain('"state": "proposed"')
    expect(said).toContain('cli:req-9')
  })

  it('narrows to one project, and to what a person has to answer', async () => {
    expect(String((await call(path, 'intake/list', { project: 'web' })).result)).toBe('[]')
    // Nothing is parked here — the task files are not in this home — so nothing
    // is waiting, and the answer says that rather than listing everything.
    // The parked proposal is the one thing waiting, and it is the only row of
    // the three that is.
    const waiting = String((await call(path, 'intake/list', { waiting: true })).result)
    expect(waiting).toContain('"state": "proposed"')
    expect(waiting).not.toContain('cli:req-9')
  })

  it('shows one request, with what approving it would start and what bounds it', async () => {
    const said = String((await call(path, 'intake/show', { item: 'cli:req-1' })).result)
    expect(said).toContain('allowed by: surfaces.intake.sources.cli')
    expect(said).toContain('template: bug@3')
    expect(said).toContain('app/cli-req-1')
    expect(said).toContain('It grants nothing')
    expect(said).toContain('Nothing was started.')
  })

  it('never hands back the request’s own words', async () => {
    // Not a happy accident: the shapes these answers are built from — a row
    // and its provenance — have no field a body could go in, and the door that
    // reads one (`openIntakeRow`) is not called here and could not be.
    const listed = String((await call(path, 'intake/list', {})).result)
    const shown = String((await call(path, 'intake/show', { item: 'cli:req-1' })).result)
    expect(listed).not.toContain(BODY)
    expect(shown).not.toContain(BODY)
    expect(listed).not.toContain('export button')
    expect(shown).not.toContain('export button')
  })

  it('says which request it has never heard of rather than inventing one', async () => {
    const { error } = await call(path, 'intake/show', { item: 'cli:nope' })
    expect(error?.message).toContain('has been handed to this machine')
  })

  it('writes nothing to the journal by being asked either question', async () => {
    await call(path, 'intake/list', {})
    await call(path, 'intake/show', { item: 'cli:req-1' })
    expect(appended).toEqual([])
  })

  it('has no method that acts on one, and no method that changes a grant', async () => {
    for (const method of [
      'intake/approve',
      'intake/refuse',
      'intake/retry',
      'intake/start',
      'intake/grant',
      'intake/enrol',
      'intake/source',
    ]) {
      const { error } = await call(path, method, { item: 'cli:req-1' })
      expect(error?.message).toContain('no such method')
    }
  })
})

describe('the tools the model is actually given', () => {
  const tools = orchestratorTools()
  const names = tools.map((one) => one.name)

  it('offers exactly two about work from outside, and both only read', () => {
    expect(names.filter((name) => name.startsWith('tade_intake'))).toEqual([
      'tade_intake',
      'tade_intake_show',
    ])
  })

  it('offers nothing that enrols a source, approves a request or widens a grant', () => {
    // The named absence, so that adding one is a test to delete rather than a
    // line nobody notices. Intake is whose words can make work on this
    // machine, and the text the orchestrator reads all day does not get to put
    // itself on that list.
    for (const name of [
      'tade_intake_approve',
      'tade_intake_refuse',
      'tade_intake_retry',
      'tade_intake_start',
      'tade_intake_grant',
      'tade_intake_enable',
      'tade_intake_source',
      'tade_intake_add',
      'tade_templates_publish',
      'tade_template_publish',
      'tade_template_write',
      'tade_persona_publish',
    ]) {
      expect(names).not.toContain(name)
    }
  })

  it('takes no path, file, command or prompt anywhere in intake’s own tools', () => {
    for (const tool of tools.filter((one) => one.name.startsWith('tade_intake'))) {
      const keys = Object.keys(
        (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
      )
      for (const key of keys) {
        expect(['path', 'file', 'dir', 'root', 'command', 'prompt']).not.toContain(key)
      }
    }
  })

  it('says in its own words that approving is a person’s, so the model does not offer to', () => {
    const listing = tools.find((one) => one.name === 'tade_intake')
    expect(listing?.description).toContain('cannot approve, refuse or retry')
    expect(listing?.description).toContain('cannot turn a source on')
    const shown = tools.find((one) => one.name === 'tade_intake_show')
    expect(shown?.description).toContain('starts nothing and changes nothing')
  })
})

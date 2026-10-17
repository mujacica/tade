import { afterEach, describe, expect, it } from 'vitest'
import { DOCUMENT_MOST, DocumentAnswerSchema, documentReadable } from '../src/document.ts'
import { type MachineAnswer, MachineAnswerSchema, machineFor } from '../src/machine.ts'
import { mintOwner } from '../src/owner.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { OWNED } from '../src/routes.ts'
import type { ServerOptions } from '../src/serving.ts'
import { reachOf } from '../src/surface.ts'
import { ToolAnswerSchema } from '../src/tool-read.ts'
import { ask, closeAll, pair, type Running, start } from './harness.ts'

// What this machine is, one of its documents, and one of its tools that only
// reads, for another machine of the person's (`machine.ts`, `document.ts`,
// `tool-read.ts`): an owner's three reads, at this machine's own door, never a
// phone's, each within what the device reads and bounded for the machine that
// reads it.

afterEach(closeAll)

const AT = '2026-10-17T12:00:00.000Z'

const MACHINE: MachineAnswer = {
  at: AT,
  version: '0.2.3',
  newer: 'Tade 0.2.4 is out',
  public: {
    name: 'tade.example.com',
    up: true,
    health: [{ said: 'certificate: good until 3 December', loud: false }],
  },
  problems: [{ from: 'extension', at: null, said: 'Sentry needs setting up: no token' }],
  schedules: [
    {
      id: 'new-sentry-errors',
      name: 'New Sentry errors',
      project: 'tade',
      kind: 'watch',
      when: 'every hour',
      paused: false,
      next: AT,
      watch: {
        id: 'sentry.new-errors',
        looks: [{ at: AT, found: 2, fresh: 1, left: 0, problem: null, said: null, on: null }],
        found: [{ at: AT, key: 'TADE-1', title: 'TypeError in the beat', task: 'tade/fix-beat' }],
      },
    },
    {
      id: 'deps',
      name: 'Dependencies',
      project: 'other',
      kind: 'watch',
      when: 'every day',
      paused: true,
      next: null,
      watch: null,
    },
  ],
  documents: [
    {
      task: 'tade/research',
      project: 'tade',
      name: 'PLAN.md',
      state: 'written',
      at: AT,
      bytes: 12,
      triaged: false,
    },
    {
      task: 'other/notes',
      project: 'other',
      name: 'NOTES.md',
      state: 'written',
      at: AT,
      bytes: 3,
      triaged: true,
    },
  ],
}

async function machine(owned: Pick<ServerOptions, 'machine' | 'document' | 'tool'>) {
  return start({}, { owned })
}

async function owner(one: Running) {
  const port = Number(one.host.split(':')[1])
  return mintOwner(one.home, { port, label: 'mac', from: '' }, Date.now())
}

function asOwner(
  one: Running,
  made: Awaited<ReturnType<typeof owner>>,
  path: string,
  body: unknown,
) {
  return ask(one, path, {
    method: 'POST',
    headers: {
      host: made.host,
      origin: `http://${made.host}`,
      cookie: `tade_away=${made.cookie}`,
      'content-type': 'application/json',
      [CSRF_HEADER]: made.csrf,
    },
    body: JSON.stringify(body),
  })
}

async function asPhone(one: Running, path: string, body: unknown) {
  const phone = await pair(one)
  return ask(one, path, {
    method: 'POST',
    headers: {
      origin: one.origin,
      cookie: phone.cookie,
      'content-type': 'application/json',
      [CSRF_HEADER]: phone.csrf,
    },
    body: JSON.stringify(body),
  })
}

describe('what this machine is', () => {
  it('answers an owner, in the shape another machine reads', async () => {
    const one = await machine({ machine: async () => MACHINE })
    const said = await asOwner(one, await owner(one), '/api/machine', {})
    expect(said.status, said.text).toBe(200)
    expect(MachineAnswerSchema.parse(JSON.parse(said.text))).toEqual(MACHINE)
  })

  it('refuses a phone however much it was granted, takes an empty body only, and is the 404 of a path nobody wired', async () => {
    let asked = 0
    const one = await machine({
      machine: async () => {
        asked++
        return MACHINE
      },
    })
    expect((await asPhone(one, '/api/machine', {})).status).toBe(403)
    const made = await owner(one)
    for (const body of [{ project: 'tade' }, null, []]) {
      expect((await asOwner(one, made, '/api/machine', body)).status).toBe(400)
    }
    expect(asked).toBe(0)
    const none = await start()
    expect((await asOwner(none, await owner(none), '/api/machine', {})).status).toBe(404)
  })

  it('answers only on this machine’s own door, all three', () => {
    for (const [name, path] of [
      ['machine', '/api/machine'],
      ['document', '/api/document'],
      ['tool', '/api/tool'],
    ]) {
      expect(OWNED.find((route) => route.name === name)).toMatchObject({
        method: 'POST',
        path,
        here: true,
      })
    }
  })

  it('leaves out what the device does not read, and a finding’s title without `requests`', () => {
    const answer = machineFor(MACHINE, reachOf({ id: 'd', projects: ['tade'], granted: [] }))
    expect(answer.schedules.map((one) => one.id)).toEqual(['new-sentry-errors'])
    expect(answer.documents.map((one) => one.task)).toEqual(['tade/research'])
    expect(answer.schedules[0]?.watch?.found[0]?.title).toBeNull()
    const granted = machineFor(MACHINE, reachOf({ id: 'd', projects: null, granted: ['requests'] }))
    expect(granted.schedules[0]?.watch?.found[0]?.title).toBe('TypeError in the beat')
    expect(granted.documents).toHaveLength(2)
  })

  it('cuts what is too long rather than sending what the other machine would refuse whole', () => {
    const long = 'x'.repeat(5000)
    const answer = machineFor(
      {
        ...MACHINE,
        version: long,
        problems: Array.from({ length: 90 }, () => ({
          from: 'journal' as const,
          at: AT,
          said: long,
        })),
        schedules: [
          {
            ...MACHINE.schedules[0]!,
            name: long,
            watch: {
              id: 'sentry.new-errors',
              looks: Array.from({ length: 9 }, () => ({
                ...MACHINE.schedules[0]!.watch!.looks[0]!,
                problem: long,
              })),
              found: [{ at: AT, key: long, title: long, task: null }],
            },
          },
        ],
      },
      reachOf({ id: 'd', projects: null, granted: ['requests'] }),
    )
    expect(MachineAnswerSchema.safeParse(answer).success).toBe(true)
    expect(answer.problems).toHaveLength(40)
    expect(answer.schedules[0]?.watch?.looks).toHaveLength(5)
    expect(answer.schedules[0]?.name.endsWith('…')).toBe(true)
  })

  it('reads another machine’s answer for its shape: a newer field is let be, a wrong one refused', () => {
    expect(MachineAnswerSchema.safeParse({ ...MACHINE, uptime: 3 }).success).toBe(true)
    const wrong = { ...MACHINE, problems: [{ from: 'telepathy', at: null, said: 'x' }] }
    expect(MachineAnswerSchema.safeParse(wrong).success).toBe(false)
  })
})

describe('one of its documents', () => {
  const documents = new Map([['tade/research/PLAN.md', '# The plan\n']])
  const document: ServerOptions['document'] = async ({ task, name }) => {
    const text = documents.get(`${task}/${name}`)
    return text === undefined ? null : { at: AT, text, bytes: text.length }
  }

  it('reads an owner the one its journal names, as text', async () => {
    const one = await machine({ document })
    const said = await asOwner(one, await owner(one), '/api/document', {
      task: 'tade/research',
      name: 'PLAN.md',
    })
    expect(said.status, said.text).toBe(200)
    expect(DocumentAnswerSchema.parse(JSON.parse(said.text))).toEqual({
      task: 'tade/research',
      name: 'PLAN.md',
      at: AT,
      text: '# The plan\n',
      bytes: 11,
      cut: false,
    })
  })

  it('takes a task and a file’s name and nothing that walks, and is a 404 for what is not there', async () => {
    const one = await machine({ document })
    const made = await owner(one)
    for (const body of [
      { task: 'tade/research', name: '../config.yaml' },
      { task: 'tade/research', name: 'a/b' },
      { task: 'tade/research', name: '..' },
      { task: '../../etc', name: 'passwd' },
      { task: 'tade/research' },
    ]) {
      const said = await asOwner(one, made, '/api/document', body)
      expect(said.status, JSON.stringify(body)).toBe(400)
    }
    const missing = { task: 'tade/research', name: 'GONE.md' }
    expect((await asOwner(one, made, '/api/document', missing)).status).toBe(404)
    expect(
      (await asPhone(one, '/api/document', { task: 'tade/research', name: 'PLAN.md' })).status,
    ).toBe(403)
  })

  it('is within what the device reads, and says where it was cut', async () => {
    const reach = reachOf({ id: 'd', projects: ['other'], granted: [] })
    expect(documentReadable({ task: 'tade/research', name: 'PLAN.md' }, reach)).toBe(false)
    expect(documentReadable({ task: 'other/notes', name: 'NOTES.md' }, reach)).toBe(true)
    const long = 'y'.repeat(DOCUMENT_MOST + 10)
    const one = await machine({
      document: async () => ({ at: AT, text: long, bytes: long.length }),
    })
    const said = await asOwner(one, await owner(one), '/api/document', {
      task: 'tade/research',
      name: 'PLAN.md',
    })
    const body = DocumentAnswerSchema.parse(JSON.parse(said.text))
    expect(body.cut).toBe(true)
    expect(body.text).toHaveLength(DOCUMENT_MOST)
    expect(body.bytes).toBe(DOCUMENT_MOST + 10)
  })
})

describe('one of its tools that only reads', () => {
  const tool: ServerOptions['tool'] = async ({ tool: name, input }) =>
    name === 'sentry_issues'
      ? { text: `issues in ${String(input.project)}`, failed: false }
      : name === 'sentry_broken'
        ? { text: 'no Sentry token', failed: true }
        : null

  it('runs one for an owner and hands back its answer, or what it said when it failed', async () => {
    const one = await machine({ tool })
    const made = await owner(one)
    const said = await asOwner(one, made, '/api/tool', {
      tool: 'sentry_issues',
      input: { project: 'tade' },
    })
    expect(said.status, said.text).toBe(200)
    expect(ToolAnswerSchema.parse(JSON.parse(said.text))).toEqual({
      text: 'issues in tade',
      failed: false,
    })
    const failed = await asOwner(one, made, '/api/tool', { tool: 'sentry_broken', input: {} })
    expect(JSON.parse(failed.text)).toEqual({ text: 'no Sentry token', failed: true })
  })

  it('answers a tool that is not here, or does not only read, as one that is not here', async () => {
    const one = await machine({ tool })
    const made = await owner(one)
    const said = await asOwner(one, made, '/api/tool', { tool: 'sentry_update_issue', input: {} })
    expect(said.status).toBe(404)
    for (const body of [
      { tool: 'Sentry Issues', input: {} },
      { tool: 'sentry_issues' },
      { tool: 'x', input: [] },
    ]) {
      expect((await asOwner(one, made, '/api/tool', body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await asPhone(one, '/api/tool', { tool: 'sentry_issues', input: {} })).status).toBe(403)
  })
})

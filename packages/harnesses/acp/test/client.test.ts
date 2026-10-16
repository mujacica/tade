import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { AcpClient, type ClientOptions, type Drawn, type Said } from '../src/client.ts'
import { recordedIn, spendOf } from '../src/record.ts'

// Tade's side of ACP, against an agent that speaks it with no model behind it
// (`scripted-agent.ts`): what each thing the agent does becomes, as signals
// for the window and as lines in the record — and what Tade answers back.

const SCRIPT = join(import.meta.dirname, 'scripted-agent.ts')

interface Harness {
  client: AcpClient
  said: Said[]
  drawn: Drawn[]
  log: string
  record: string
  asked: { requestId: string; tool: string; input: unknown; summary: string }[]
}

const made: AcpClient[] = []
afterEach(() => {
  for (const one of made.splice(0)) one.stop()
})

function client(over: Partial<ClientOptions> = {}, caps = ''): Harness {
  const dir = tmp('tade-acp-client-')
  const said: Said[] = []
  const drawn: Drawn[] = []
  const asked: Harness['asked'] = []
  const log = join(dir, 'agent.log')
  const record = join(dir, 'record.jsonl')
  const one = new AcpClient({
    command: process.execPath,
    args: [SCRIPT],
    cwd: dir,
    env: { ...process.env, ACP_SCRIPT_LOG: log, ACP_SCRIPT_CAPS: caps },
    agent: 'scripted',
    record,
    resume: null,
    model: null,
    instructions: '',
    mcpServers: [],
    signal: (s) => said.push(s),
    draw: (d) => drawn.push(d),
    gate: async (ask) => {
      asked.push(ask)
      return { allow: true, reason: '' }
    },
    ...over,
  })
  made.push(one)
  return { client: one, said, drawn, log, record, asked }
}

/** Resolves once the run has said this, or fails the test after a while. */
async function until(h: Harness, test: (said: Said[]) => boolean, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!test(h.said)) {
    if (Date.now() - start > ms)
      throw new Error(`never: ${JSON.stringify(h.said.map((s) => s.type))}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const idles = (said: Said[]) => said.filter((s) => s.type === 'idle').length
const sent = (h: Harness) =>
  readFileSync(h.log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })

describe('an ACP agent driven by Tade', () => {
  it('starts, opens a session, and says it is ready', async () => {
    const h = client()
    await h.client.start()
    expect(h.said.map((s) => s.type)).toEqual(['started', 'idle'])
    expect(h.said[0]).toMatchObject({ sessionId: 'sess-1', model: 'scripted/default' })
    const [hello] = sent(h)
    expect(hello).toMatchObject({
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
    })
    expect((await recordedIn(h.record)).sessionId).toBe('sess-1')
  })

  it('streams what it says, then says it whole, then ends the turn and goes idle', async () => {
    const h = client({ instructions: 'You run in Tade.' })
    await h.client.start()
    h.client.send('say hello there')
    await until(h, (s) => idles(s) === 2)
    const turn = h.said.slice(2).map((s) => s.type)
    expect(turn).toEqual([
      'turn_started',
      'message_delta',
      'message_delta',
      'context',
      'message',
      'turn_done',
      'idle',
    ])
    expect(h.said.find((s) => s.type === 'message')).toMatchObject({ text: 'hello there' })
    expect(h.said.find((s) => s.type === 'context')).toMatchObject({ tokens: 1200, percent: 12 })
    expect(h.said.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'ok' })
    // What Tade tells every agent goes ahead of the first thing it is sent, once.
    const prompt = sent(h).find((m) => m.method === 'session/prompt')
    expect(prompt?.params?.prompt).toEqual([
      { type: 'text', text: 'You run in Tade.' },
      { type: 'text', text: 'say hello there' },
    ])
    h.client.send('say again')
    await until(h, (s) => idles(s) === 3)
    const second = sent(h).filter((m) => m.method === 'session/prompt')[1]
    expect(second?.params?.prompt).toEqual([{ type: 'text', text: 'say again' }])
  })

  it('holds what arrives mid-turn and sends it the moment the turn ends', async () => {
    const h = client()
    await h.client.start()
    h.client.send('slow')
    h.client.send('say next')
    expect(h.drawn).toContainEqual({ kind: 'note', text: 'held until this turn ends' })
    await until(h, (s) => s.some((one) => one.type === 'message'))
    // One idle at the end of both, never between them: the person is not waiting yet.
    await until(h, (s) => idles(s) === 2)
    expect(h.said.filter((s) => s.type === 'turn_started')).toHaveLength(2)
  })

  it('asks its gate before a command runs, with the command itself to read back', async () => {
    const h = client()
    await h.client.start()
    h.client.send('run rm -rf build')
    await until(h, (s) => idles(s) === 2)
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]).toMatchObject({
      tool: 'execute',
      summary: 'rm -rf build',
      input: { command: 'rm -rf build', title: 'Run rm -rf build' },
    })
    expect(h.said.find((s) => s.type === 'tool_call')).toMatchObject({
      callId: 'call-1',
      tool: 'execute',
    })
    expect(h.said.find((s) => s.type === 'tool_result')).toMatchObject({
      ok: true,
      summary: 'ran it',
    })
    // Allowed once, never for always: what the gate decided is about this call.
    const answer = readFileSync(h.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((m) => m.result?.outcome)
    expect(answer.result.outcome).toEqual({ outcome: 'selected', optionId: 'yes' })
  })

  it('refuses what its gate refuses, and the agent carries on', async () => {
    const h = client({ gate: async () => ({ allow: false, reason: 'not today' }) })
    await h.client.start()
    h.client.send('run git push --force')
    await until(h, (s) => idles(s) === 2)
    expect(h.said.find((s) => s.type === 'tool_result')).toMatchObject({ ok: false })
    expect(h.said.find((s) => s.type === 'message')).toMatchObject({ text: 'it was refused' })
    expect(h.drawn.some((d) => d.kind === 'note' && d.text.includes('not today'))).toBe(true)
  })

  it('says the files a call writes, as the agent said them', async () => {
    const h = client()
    await h.client.start()
    h.client.send('edit src/app.ts')
    await until(h, (s) => idles(s) === 2)
    expect(h.said.find((s) => s.type === 'tool_call')).toMatchObject({
      tool: 'edit',
      writes: ['src/app.ts'],
    })
    expect(h.asked).toEqual([])
  })

  it('stops a turn that is running and leaves the agent there', async () => {
    const h = client()
    await h.client.start()
    h.client.send('slow')
    await until(h, (s) => s.some((one) => one.type === 'turn_started'))
    h.client.cancel()
    await until(h, (s) => idles(s) === 2)
    expect(h.said.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'aborted' })
    h.client.send('say still here')
    await until(h, (s) => idles(s) === 3)
  })

  it('says why a turn ended in error, in words', async () => {
    const h = client()
    await h.client.start()
    h.client.send('refuse')
    await until(h, (s) => idles(s) === 2)
    expect(h.said.find((s) => s.type === 'turn_done')).toMatchObject({
      status: 'error',
      reason: 'the agent refused to go on',
    })
    expect(h.drawn).toContainEqual({ kind: 'problem', text: 'the agent refused to go on' })
  })

  it('says it exited, and why, when the agent dies mid-turn', async () => {
    const h = client()
    await h.client.start()
    h.client.send('die')
    await until(h, (s) => s.some((one) => one.type === 'exited'))
    await until(h, (s) => s.some((one) => one.type === 'turn_done'))
    expect(h.said.find((s) => s.type === 'exited')).toMatchObject({ code: 3 })
    expect(h.said.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'error' })
  })

  it('says why when the agent cannot be started at all, rather than leaving anyone waiting', async () => {
    const h = client({ command: '/nonexistent/acp-agent' })
    await expect(h.client.start()).rejects.toThrow(/could not be started/)
    expect(h.said.find((s) => s.type === 'failed')).toBeDefined()
  })

  it('counts what the session cost as the agent priced it, once per change', async () => {
    const h = client()
    await h.client.start()
    h.client.send('cost 0.25')
    await until(h, (s) => idles(s) === 2)
    h.client.send('cost 0.75')
    await until(h, (s) => idles(s) === 3)
    const usage = h.said.filter((s) => s.type === 'usage')
    expect(usage.map((s) => (s.type === 'usage' ? s.usd : 0))).toEqual([0.25, 0.5])
    expect(spendOf(await recordedIn(h.record)).usd).toBe(0.75)
  })

  it('puts the session on the model chosen for it, where the agent offers that choice', async () => {
    const h = client({ model: 'large' }, 'models')
    await h.client.start()
    expect(h.client.modelName).toBe('scripted/large')
    h.client.send('cost 0.1')
    await until(h, (s) => idles(s) === 2)
    expect(h.said.find((s) => s.type === 'message')).toMatchObject({ text: 'on large' })
    expect((await recordedIn(h.record)).model).toBe('large')
  })

  it('says so, and carries on, when the agent has no such model', async () => {
    const h = client({ model: 'huge' }, 'models')
    await h.client.start()
    expect(h.said.find((s) => s.type === 'problem')).toMatchObject({
      text: expect.stringContaining('offers no model called huge'),
    })
    expect(h.client.modelName).toBe('scripted/small')
  })

  it('comes back to the conversation it was having, where the agent can', async () => {
    const h = client({ resume: 'sess-7' }, 'resume')
    await h.client.start()
    expect(h.client.sessionId).toBe('sess-7')
    expect(sent(h).map((m) => m.method)).toContain('session/resume')
    expect(h.drawn.some((d) => d.kind === 'note' && d.text.includes('carried on'))).toBe(true)
  })

  it('takes nothing the agent replays as it loads a session for news', async () => {
    const h = client({ resume: 'sess-7' }, 'load')
    await h.client.start()
    expect(sent(h).map((m) => m.method)).toContain('session/load')
    expect(h.said.some((s) => s.type === 'message_delta')).toBe(false)
  })

  it('starts a new conversation, and says so, where the agent cannot come back to one', async () => {
    const h = client({ resume: 'sess-7' })
    await h.client.start()
    expect(h.client.sessionId).toBe('sess-1')
    expect(h.drawn.some((d) => d.kind === 'problem' && d.text.includes('starts a new one'))).toBe(
      true,
    )
  })

  it('signs in the agent’s own way when it asks to be, and opens the session after', async () => {
    const h = client({}, 'auth')
    await h.client.start()
    expect(sent(h).map((m) => m.method)).toEqual([
      'initialize',
      'session/new',
      'authenticate',
      'session/new',
    ])
    expect(h.client.sessionId).toBe('sess-1')
  })
})

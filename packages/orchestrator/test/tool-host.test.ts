import { connect } from 'node:net'
import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { ToolHost, type ToolHostOptions } from '../src/tool-host.ts'

// An agent the orchestrator starts, against a workbench that only records.
//
// What is under test is what is settled before anything starts — the model it
// was asked to run on — and what goes with it: the files attached to what the
// orchestrator is answering, and nothing with a start that says nothing.

/** One call over the socket, framed the way the orchestrator's tools frame it. */
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

describe('starting an agent for the orchestrator', () => {
  let host: ToolHost | null = null
  const started: Array<Record<string, unknown>> = []
  let handedOff = 0

  const tade = {
    async resolveModel(said: string) {
      if (said === 'opus') return { provider: 'openrouter', id: 'anthropic/claude-opus-5' }
      throw new Error(`"${said}" could be gpt-4o, gpt-5: say which`)
    },
    async startAgent(request: Record<string, unknown>) {
      started.push(request)
      return { id: `${String(request.task)}/agent`, alive: true }
    },
  } as unknown as Workbench

  async function listen(over: Partial<ToolHostOptions> = {}): Promise<string> {
    started.length = 0
    handedOff = 0
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({
      tade,
      path,
      handOff: async (cwd) => {
        handedOff++
        return {
          note: `An attachment is in ${cwd}/.tade/attachments/shot.png.`,
          images: [{ data: 'iVBORw0K', mimeType: 'image/png' }],
        }
      },
      ...over,
    })
    return path
  }

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('starts it on the model that was named', async () => {
    const path = await listen({ handOff: undefined })
    const answer = await call(path, 'worker/start', {
      task: 'app/refunds',
      cwd: '/src/app',
      prompt: 'fix the double charge',
      model: 'opus',
    })
    expect(answer.error).toBeUndefined()
    expect(started).toEqual([
      {
        task: 'app/refunds',
        cwd: '/src/app',
        prompt: 'fix the double charge',
        model: { provider: 'openrouter', id: 'anthropic/claude-opus-5' },
      },
    ])
  })

  it('starts nothing when it cannot tell which model was meant, and says what to ask', async () => {
    const path = await listen()
    const answer = await call(path, 'worker/start', {
      task: 'app/refunds',
      cwd: '/src/app',
      prompt: 'fix the double charge',
      model: 'gpt',
    })
    expect(answer.error?.message).toMatch(/say which/)
    // Not on some other model, and not with the files either: nothing at all.
    expect(started).toEqual([])
    expect(handedOff).toBe(0)
  })

  it('hands what was attached to the agent, after what it is told', async () => {
    const path = await listen()
    await call(path, 'worker/start', {
      task: 'app/refunds',
      cwd: '/src/app',
      prompt: 'look at this',
    })
    expect(started[0]).toMatchObject({
      prompt: 'look at this\n\nAn attachment is in /src/app/.tade/attachments/shot.png.',
      images: [{ mimeType: 'image/png' }],
    })
  })

  it('sends nothing with a start that says nothing, which only opens the agent', async () => {
    const path = await listen()
    await call(path, 'worker/start', { task: 'app/refunds', cwd: '/src/app', prompt: '' })
    expect(handedOff).toBe(0)
    expect(started).toEqual([{ task: 'app/refunds', cwd: '/src/app', prompt: '' }])
  })
})

describe('where everything stands', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('is the window’s answer, and says so when there is no window to ask', async () => {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    const seen = { projects: [{ name: 'app', tasks: [{ id: 'app/refunds', state: 'blocked' }] }] }
    host = await ToolHost.listen({
      tade: {} as Workbench,
      path,
      status: async () => seen,
    })
    expect((await call(path, 'status/read', {})).result).toEqual(seen)
    await host.close()

    const bare = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade: {} as Workbench, path: bare })
    expect((await call(bare, 'status/read', {})).error?.message).toMatch(/no window to ask/)
  })
})

describe('putting work on a clock', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('hands the window a watch as asked, looking as often as the watch says when no rule is given', async () => {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    const asked: Record<string, unknown>[] = []
    host = await ToolHost.listen({
      tade: {} as Workbench,
      path,
      queue: {
        describe: async () => '',
        change: async () => '',
        plan: async () => '',
        schedule: async (req) => {
          asked.push(req as unknown as Record<string, unknown>)
          return 'scheduled'
        },
      },
    })
    const base = { name: 'New errors', project: 'app', said: 'fix new errors as they come' }
    // An empty rule is no rule: the watch's own.
    expect(
      (
        await call(path, 'queue/schedule', {
          ...base,
          when: {},
          watch: 'sentry.new-errors',
          input: { query: 'level:error' },
          found: 'ask',
          most: 3,
        })
      ).result,
    ).toBe('scheduled')
    expect(asked[0]).toEqual({
      ...base,
      watch: 'sentry.new-errors',
      input: { query: 'level:error' },
      found: 'ask',
      most: 3,
    })
    expect(
      (await call(path, 'queue/schedule', { ...base, watch: 'sentry.new-errors', input: 'all' }))
        .error?.message,
    ).toMatch(/input is what the watch is turned on with/)
    expect(
      (await call(path, 'queue/schedule', { ...base, when: { every: 3 }, agent: 'x' })).error
        ?.message,
    ).toMatch(/when is not a rule/)
  })
})

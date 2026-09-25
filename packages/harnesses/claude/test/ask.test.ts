import { rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'

// The one line every piece that runs inside a Claude Code agent says to Tade.
//
// `ask.ts` is loaded by the hooks, the status line and the MCP server, each of
// them a process Claude Code starts — so nothing here can be reached from the
// window, and until now nothing had ever run it. What it gets wrong is not a
// stack trace anybody sees: a hook that hangs is an agent that has stopped,
// and a hook that throws is Claude Code reporting Tade as broken. So every way
// the other end can misbehave gets a case, over a real unix socket rather than
// a stand-in for one: nothing answering, nothing listening, an answer that is
// not JSON, an answer in pieces, and a window that goes away mid-question.
//
// `SOCKET` is read once when the module loads, because that is when Claude
// Code starts these processes and the environment is already set. That is why
// each case loads the module again with the environment it means.

interface Ask {
  SOCKET: string | undefined
  ask: (request: unknown, wait?: number) => Promise<unknown>
  readInput: () => Promise<Record<string, unknown> | null>
}

const dirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.TADE_RUN_SOCKET
  vi.resetModules()
})

/** The module as one of Claude Code's processes would load it. */
async function launchedWith(socket: string | undefined): Promise<Ask> {
  vi.resetModules()
  if (socket === undefined) delete process.env.TADE_RUN_SOCKET
  else process.env.TADE_RUN_SOCKET = socket
  return (await import('../src/ask.ts')) as Ask
}

/** What the window's end of the socket did, and what it heard while doing it. */
interface Listening {
  path: string
  heard: string[]
  /** Connections the far end has closed — a question that leaves one open leaks. */
  closed: number
}

/** A real unix socket, answering each line the way `answer` says. */
async function listening(
  answer: (line: string, say: (text: string) => void, hangUp: () => void) => void,
): Promise<Listening> {
  const dir = tmp('tade-ask-')
  dirs.push(dir)
  const at: Listening = { path: join(dir, 's'), heard: [], closed: 0 }
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.on('close', () => {
      at.closed += 1
    })
    socket.on('error', () => {})
    socket.on('data', (text: string) => {
      at.heard.push(text)
      answer(
        text,
        (out) => socket.write(out),
        () => socket.end(),
      )
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(at.path, done))
  return at
}

/** Somewhere nothing is listening, which is what a closed window leaves behind. */
function nowhere(): string {
  const dir = tmp('tade-ask-')
  dirs.push(dir)
  return join(dir, 'gone')
}

describe('asking Tade', () => {
  it('says one JSON line, and gives back the one it is answered with', async () => {
    const at = await listening((_line, say) => say(`${JSON.stringify({ output: { ok: 1 } })}\n`))
    const { ask } = await launchedWith(at.path)

    expect(await ask({ kind: 'hook', event: { hook_event_name: 'PreToolUse' } })).toEqual({
      output: { ok: 1 },
    })
    // Exactly one line, terminated — the far end reads by newline, so a
    // question sent without one is a question nobody ever answers.
    expect(at.heard).toEqual(['{"kind":"hook","event":{"hook_event_name":"PreToolUse"}}\n'])
  })

  it('lets go of the socket once it has its answer', async () => {
    const at = await listening((_line, say) => say('{"output":{}}\n'))
    const { ask } = await launchedWith(at.path)
    await ask({ kind: 'status' })
    // Each hook is its own process, but the status line runs after every reply
    // and the MCP server lives for the whole session: a question that keeps its
    // socket is a window holding one handle per tool call.
    await vi.waitFor(() => expect(at.closed).toBe(1))
  })

  it('is null where Tade never launched this agent', async () => {
    const { SOCKET, ask } = await launchedWith(undefined)
    expect(SOCKET).toBeUndefined()
    expect(await ask({ kind: 'hook' })).toBeNull()
  })

  it('is null where the window has gone and nothing is listening', async () => {
    const { ask } = await launchedWith(nowhere())
    // Not a throw: a hook that throws is Claude Code telling somebody Tade
    // broke their agent, when all that happened is that Tade was closed.
    expect(await ask({ kind: 'hook' })).toBeNull()
  })

  it('is null where the answer is not JSON', async () => {
    const at = await listening((_line, say) => say('not json at all\n'))
    const { ask } = await launchedWith(at.path)
    expect(await ask({ kind: 'hook' })).toBeNull()
  })

  it('is null where the window hangs up without answering', async () => {
    const at = await listening((_line, _say, hangUp) => hangUp())
    const { ask } = await launchedWith(at.path)
    expect(await ask({ kind: 'hook' })).toBeNull()
  })

  it('is null where no answer comes, rather than waiting for ever', async () => {
    const at = await listening(() => {})
    const { ask } = await launchedWith(at.path)
    // A hook is a process Claude Code waits on, so "no answer" has to become
    // an answer: without the deadline the agent stops until somebody kills it.
    expect(await ask({ kind: 'hook' }, 60)).toBeNull()
  })

  it('waits for the whole answer when it arrives in pieces', async () => {
    const at = await listening((_line, say) => {
      say('{"output":{"permissionDec')
      setTimeout(() => say('ision":"allow"}}\n'), 10)
    })
    const { ask } = await launchedWith(at.path)
    expect(await ask({ kind: 'hook' })).toEqual({ output: { permissionDecision: 'allow' } })
  })

  it('takes the first line when the window says more than one', async () => {
    const at = await listening((_line, say) => say('{"output":{"first":true}}\n{"second":true}\n'))
    const { ask } = await launchedWith(at.path)
    expect(await ask({ kind: 'hook' })).toEqual({ output: { first: true } })
  })

  it('answers each question on its own connection', async () => {
    const at = await listening((line, say) =>
      say(`${JSON.stringify({ heard: JSON.parse(line) })}\n`),
    )
    const { ask } = await launchedWith(at.path)
    expect(await ask({ one: 1 })).toEqual({ heard: { one: 1 } })
    expect(await ask({ two: 2 })).toEqual({ heard: { two: 2 } })
    await vi.waitFor(() => expect(at.closed).toBe(2))
  })
})

describe('reading what the harness put on standard input', () => {
  /** Stand `process.stdin` in for the pipe Claude Code writes the hook's JSON to. */
  async function onStdin(text: string): Promise<Record<string, unknown> | null> {
    const real = Object.getOwnPropertyDescriptor(process, 'stdin')
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([Buffer.from(text, 'utf8')]),
      configurable: true,
    })
    try {
      const { readInput } = await launchedWith(undefined)
      return await readInput()
    } finally {
      if (real) Object.defineProperty(process, 'stdin', real)
    }
  }

  it('reads the hook event the harness wrote', async () => {
    expect(await onStdin('{"hook_event_name":"PreToolUse","tool_name":"Bash"}')).toEqual({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    })
  })

  it('puts an event back together out of however many chunks it arrived in', async () => {
    const real = Object.getOwnPropertyDescriptor(process, 'stdin')
    Object.defineProperty(process, 'stdin', {
      value: Readable.from(['{"hook_event', '_name":"Stop"}'].map((s) => Buffer.from(s))),
      configurable: true,
    })
    try {
      const { readInput } = await launchedWith(undefined)
      expect(await readInput()).toEqual({ hook_event_name: 'Stop' })
    } finally {
      if (real) Object.defineProperty(process, 'stdin', real)
    }
  })

  it('is null where nothing, or nothing readable, was written', async () => {
    expect(await onStdin('')).toBeNull()
    expect(await onStdin('{"half":')).toBeNull()
    expect(await onStdin('not json')).toBeNull()
  })

  it('is null for JSON that is not an event', async () => {
    // The whole reason for the check: everything downstream reads `event.x`,
    // so anything that has no `x` to read has to be refused here. `null` is
    // the one that would have got through `typeof … === 'object'` alone, and
    // an array is the one that got through it for real.
    expect(await onStdin('null')).toBeNull()
    expect(await onStdin('42')).toBeNull()
    expect(await onStdin('"PreToolUse"')).toBeNull()
    expect(await onStdin('[{"hook_event_name":"Stop"}]')).toBeNull()
  })
})

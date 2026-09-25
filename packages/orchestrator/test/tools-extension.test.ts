import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

// Tade's own tools, run.
//
// `tools.test.ts` proves the surface works against a real pi and a real
// workbench, which is the question a fake cannot answer — and it reaches four
// of the sixty tools. The rest of the file is the *bodies*: what each tool asks
// Tade for, what it refuses before asking, and the JSON-RPC client every one of
// them goes through, which was written here rather than imported because pi
// loads this file inside the orchestrator's own process.
//
// So both ends are real and only Tade is scripted: a unix socket speaking the
// framing the `ToolHost` speaks, and a `tade` on disk that prints what a real
// one would. Nothing here mocks a module.

const servers: Server[] = []
const open: Socket[] = []

afterEach(async () => {
  for (const socket of open.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done))
  for (const key of [
    'TADE_SOCKET',
    'TADE_CLI',
    'TADE_CLI_ARGS',
    'TADE_EXTENSIONS',
    'TADE_SKILLS',
    'TADE_EXTENSION_TOOLS',
    'TADE_HOME',
  ])
    delete process.env[key]
  vi.resetModules()
})

/** One call that reached Tade. */
interface Call {
  method: string
  params: Record<string, unknown>
}

interface Host {
  path: string
  calls: Call[]
}

/**
 * The window's end: `Content-Length` framed JSON-RPC over a unix socket, which
 * is what `ToolHost` speaks and what this file implements its own client for.
 */
async function hostListening(
  answer: (call: Call) => unknown | { error: string } = () => ({ ok: true }),
): Promise<Host> {
  const host: Host = { path: join(tmp('tade-tools-'), 's'), calls: [] }
  const server = createServer((socket) => {
    open.push(socket)
    let buffer = Buffer.alloc(0)
    socket.on('error', () => {})
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const split = buffer.indexOf('\r\n\r\n')
      if (split < 0) return
      const length = Number(
        /content-length:\s*(\d+)/i.exec(buffer.subarray(0, split).toString('utf8'))?.[1] ?? 0,
      )
      const start = split + 4
      if (buffer.byteLength < start + length) return
      const request = JSON.parse(buffer.subarray(start, start + length).toString('utf8')) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      buffer = buffer.subarray(start + length)
      const call = { method: request.method, params: request.params }
      host.calls.push(call)
      const said = answer(call)
      const body = Buffer.from(
        JSON.stringify(
          said && typeof said === 'object' && 'error' in said
            ? {
                jsonrpc: '2.0',
                id: request.id,
                error: { message: (said as { error: string }).error },
              }
            : { jsonrpc: '2.0', id: request.id, result: said },
        ),
        'utf8',
      )
      socket.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
      socket.write(body)
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(host.path, done))
  return host
}

/** A `tade` on the PATH that prints this and exits with that. */
function fakeCli(prints: string, code = 0): { path: string; argv: string } {
  const dir = tmp('tade-cli-')
  const argv = join(dir, 'argv')
  const path = join(dir, 'tade')
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${argv}\n${code === 0 ? `cat <<'JSON'\n${prints}\nJSON` : `echo '${prints}' >&2`}\nexit ${code}\n`,
  )
  chmodSync(path, 0o755)
  return { path, argv }
}

const ranWith = (argv: string): string[] =>
  readFileSync(argv, 'utf8')
    .split('\n')
    .filter((line) => line !== '')

interface Tool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  run(params: Record<string, unknown>, callId: string, ctx: unknown): Promise<unknown>
}

/** The tool list, with the world the orchestrator's process was launched into. */
async function tools(env: Record<string, string> = {}, opts: Record<string, unknown> = {}) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  const loaded = (await import('../src/tools-extension.ts')) as {
    orchestratorTools(o?: unknown): Tool[]
    default(pi: unknown): void
  }
  return {
    list: loaded.orchestratorTools(opts),
    register: loaded.default,
    by: (name: string): Tool => {
      const found = loaded.orchestratorTools(opts).find((tool) => tool.name === name)
      if (!found) throw new Error(`no tool called ${name}`)
      return found
    },
  }
}

describe('the way back to Tade', () => {
  it('asks over the socket and gives back what the window answered', async () => {
    const host = await hostListening(() => ({ opened: 'shop/refunds' }))
    const { by } = await tools({ TADE_SOCKET: host.path })

    expect(await by('tade_terminal_list').run({ project: 'shop' }, 'c1', {})).toEqual({
      opened: 'shop/refunds',
    })
    expect(host.calls).toEqual([{ method: 'terminal/list', params: { project: 'shop' } }])
  })

  it('fails with what Tade said, not with a number', async () => {
    const host = await hostListening(() => ({ error: 'there is no project called shop' }))
    const { by } = await tools({ TADE_SOCKET: host.path })
    // A tool fails by throwing, and the model picks its next move from the
    // words: "rejected" tells it nothing it can act on.
    await expect(by('tade_terminal_list').run({}, 'c1', {})).rejects.toThrow(
      'there is no project called shop',
    )
  })

  it('says there is no way back rather than hanging, with no socket at all', async () => {
    const { by } = await tools({})
    await expect(by('tade_terminal_list').run({}, 'c1', {})).rejects.toThrow(
      'TADE_SOCKET is not set',
    )
  })

  it('takes an answer that reads as nothing as having worked', async () => {
    const host = await hostListening(() => undefined)
    const { by } = await tools({ TADE_SOCKET: host.path })
    expect(await by('tade_terminal_list').run({}, 'c1', {})).toEqual({ ok: true })
  })
})

describe('where everything stands', () => {
  it('asks the window first, because only it knows who is between turns', async () => {
    const host = await hostListening(() => ({ projects: [] }))
    const cli = fakeCli('{"projects":[]}')
    const { by } = await tools({ TADE_SOCKET: host.path, TADE_CLI: cli.path })

    await by('tade_status').run({}, 'c1', {})
    expect(host.calls.map((call) => call.method)).toEqual(['status/read'])
    // The CLI would call every agent between turns "working", because it has
    // no way to know otherwise.
    expect(() => ranWith(cli.argv)).toThrow()
  })

  it('falls back to the CLI when there is no window to ask', async () => {
    const cli = fakeCli('{"projects":[{"name":"shop","tasks":[]}]}')
    const { by } = await tools({ TADE_CLI: cli.path })
    const said = await by('tade_status').run({}, 'c1', {})
    expect(String(said)).toContain('shop')
    expect(ranWith(cli.argv)).toEqual(['status --json --no-pr'])
  })

  it('runs the CLI the way a source checkout needs it run', async () => {
    const cli = fakeCli('{}')
    // `node path/to/bin.ts status` — the arguments in front of the command.
    const { by } = await tools({ TADE_CLI: cli.path, TADE_CLI_ARGS: '--safe -x' })
    await by('tade_status').run({}, 'c1', {})
    expect(ranWith(cli.argv)).toEqual(['--safe -x status --json --no-pr'])
  })

  it('carries what the CLI complained about, rather than its exit code', async () => {
    const cli = fakeCli('config.yaml: invalid config', 2)
    const { by } = await tools({ TADE_CLI: cli.path })
    await expect(by('tade_status').run({}, 'c1', {})).rejects.toThrow('invalid config')
  })
})

describe('a tool that needs to know where a task works', () => {
  const status = JSON.stringify({
    projects: [{ tasks: [{ id: 'shop/refunds', worktree: '/tmp/wt/refunds' }] }],
  })

  it('starts an agent in the worktree it found, with the model that was named', async () => {
    const host = await hostListening()
    const cli = fakeCli(status)
    const { by } = await tools({ TADE_SOCKET: host.path, TADE_CLI: cli.path })

    await by('tade_run_start').run(
      { task: 'shop/refunds', prompt: 'cover the wire', model: 'opus' },
      'c1',
      {},
    )
    expect(host.calls[0]).toEqual({
      method: 'worker/start',
      params: {
        task: 'shop/refunds',
        cwd: '/tmp/wt/refunds',
        prompt: 'cover the wire',
        model: 'opus',
      },
    })
  })

  it('leaves the model out where nobody named one', async () => {
    const host = await hostListening()
    const { by } = await tools({ TADE_SOCKET: host.path, TADE_CLI: fakeCli(status).path })
    await by('tade_run_start').run({ task: 'shop/refunds' }, 'c1', {})
    // Not `model: ''`, which is a model nobody can find.
    expect(host.calls[0]?.params).not.toHaveProperty('model')
    expect(host.calls[0]?.params).toMatchObject({ prompt: '' })
  })

  it('refuses a task nothing knows about, naming it', async () => {
    const host = await hostListening()
    const { by } = await tools({ TADE_SOCKET: host.path, TADE_CLI: fakeCli(status).path })
    await expect(by('tade_run_start').run({ task: 'shop/vat' }, 'c1', {})).rejects.toThrow(
      'no such task: shop/vat',
    )
    // Refused before anything started, rather than started somewhere wrong.
    expect(host.calls).toEqual([])
  })
})

describe('writing something down for a person to read', () => {
  it('saves an extension turned off, saying why it was written', async () => {
    const where = tmp('tade-ext-')
    const { by } = await tools({ TADE_EXTENSIONS: where })

    const said = await by('tade_write_extension').run(
      { name: 'weather', source: 'export default () => {}', why: 'the forecast, for standups' },
      'c1',
      {},
    )
    const written = readFileSync(join(where, 'weather.ts'), 'utf8')
    // The reason goes in the file: it is the first line the panel shows of
    // something nobody has read, and a tool with no stated purpose never gets
    // turned on.
    expect(written).toContain('// the forecast, for standups')
    expect(written).toContain('export default () => {}')
    // And the answer says it is not running, so nothing assumes it is.
    expect(String(said)).toContain('turned off')
    expect(String(said)).toContain('tade extensions enable weather')
  })

  it('refuses a name that would not be a filename', async () => {
    const { by } = await tools({ TADE_EXTENSIONS: tmp('tade-ext-') })
    for (const name of ['../escape', 'Weather', 'with spaces', '']) {
      await expect(
        by('tade_write_extension').run({ name, source: 'x', why: 'y' }, 'c1', {}),
      ).rejects.toThrow('not a usable name')
    }
  })

  it('writes a lesson with the thing it is about on its own line', async () => {
    const where = tmp('tade-skills-')
    const { by } = await tools({ TADE_SKILLS: where })

    await by('tade_propose_skill').run(
      { name: 'run-alone', text: '  The suite needs the machine to itself.  ', about: '  Shop  ' },
      'c1',
      {},
    )
    // Read back from that line, and read by a person: a lesson scoped to
    // something stops being mentioned once that thing goes quiet.
    expect(readFileSync(join(where, 'proposed', 'run-alone.md'), 'utf8')).toBe(
      'about: shop\n\nThe suite needs the machine to itself.\n',
    )
  })

  it('leaves the subject line off a lesson about working here in general', async () => {
    const where = tmp('tade-skills-')
    const { by } = await tools({ TADE_SKILLS: where })
    await by('tade_propose_skill').run(
      { name: 'general', text: 'Commit your own files.' },
      'c1',
      {},
    )
    expect(readFileSync(join(where, 'proposed', 'general.md'), 'utf8')).toBe(
      'Commit your own files.\n',
    )
  })
})

describe('the extension tools Tade listed for this orchestrator', () => {
  it('offers each one, and calls it back through Tade', async () => {
    const list = join(tmp('tade-extlist-'), 'tools.json')
    writeFileSync(
      list,
      JSON.stringify([
        { name: 'deps_check', label: 'Deps', description: 'what is behind', parameters: {} },
      ]),
    )
    const host = await hostListening(() => ({ text: 'two are behind' }))
    const { by } = await tools({ TADE_SOCKET: host.path, TADE_EXTENSION_TOOLS: list })

    await by('deps_check').run({ project: 'shop' }, 'call-7', {})
    // Run in the window, where the extension's settings and credentials are.
    expect(host.calls[0]).toEqual({
      method: 'extension/call',
      params: { tool: 'deps_check', input: { project: 'shop' }, callId: 'call-7' },
    })
  })

  it('offers none where the list is missing, unreadable, or not a list', async () => {
    const bad = join(tmp('tade-extlist-'), 'tools.json')
    writeFileSync(bad, 'not json')
    const names = async (env: Record<string, string>) =>
      (await tools(env)).list.map((tool) => tool.name)

    expect(await names({})).not.toContain('deps_check')
    expect(await names({ TADE_EXTENSION_TOOLS: bad })).not.toContain('deps_check')
    expect(await names({ TADE_EXTENSION_TOOLS: join(tmp('x-'), 'gone.json') })).not.toContain(
      'deps_check',
    )
  })
})

describe('handing the list to pi', () => {
  /** A `pi` that keeps what was registered. */
  function fakePi() {
    const registered = new Map<string, { execute(...args: unknown[]): Promise<unknown> }>()
    const switched: unknown[] = []
    return {
      registered,
      switched,
      api: {
        registerTool(tool: { name: string; execute(...args: unknown[]): Promise<unknown> }) {
          registered.set(tool.name, tool)
        },
        async setModel(model: unknown) {
          switched.push(model)
          return true
        },
      },
    }
  }

  it('answers in `content`, which is the only field pi reads', async () => {
    const host = await hostListening(() => ({ opened: 1 }))
    const { register } = await tools({ TADE_SOCKET: host.path })
    const pi = fakePi()
    register(pi.api)

    const answer = (await pi.registered
      .get('tade_terminal_list')
      ?.execute('c1', {}, undefined, undefined, {})) as { content: { text: string }[] }
    // Returning `output` instead — as these tools once did — gave the model an
    // empty answer from every one of them, which reads as success.
    expect(JSON.parse(answer.content[0]?.text ?? '')).toEqual({ opened: 1 })
  })

  it('lets a failure through as a throw, so pi marks the call failed', async () => {
    const host = await hostListening(() => ({ error: 'no such terminal' }))
    const { register } = await tools({ TADE_SOCKET: host.path })
    const pi = fakePi()
    register(pi.api)

    await expect(
      pi.registered.get('tade_terminal_list')?.execute('c1', {}, undefined, undefined, {}),
    ).rejects.toThrow('no such terminal')
  })

  it('registers every tool the list has, under its own name', async () => {
    const { list, register } = await tools({})
    const pi = fakePi()
    register(pi.api)
    expect([...pi.registered.keys()].sort()).toEqual(list.map((tool) => tool.name).sort())
    expect(pi.registered.size).toBeGreaterThan(20)
  })
})

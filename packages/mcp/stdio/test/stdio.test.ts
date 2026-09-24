import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpError, type ServerDeclaration, type TransportContext } from '@tade/mcp-core'
import { testTransport } from '@tade/mcp-core/conformance'
import { afterAll, describe, expect, it } from 'vitest'
import { found, makeStdioTransport, withProject } from '../src/index.ts'

// Real child processes, on purpose: this is the transport whose whole job is
// starting somebody else's program, and a fake one would prove nothing about
// a pipe, an exit or a process group. They live here rather than in the smoke
// tests for the same reason the PTY and tmux tests do.

const SERVER = fileURLToPath(new URL('./fixtures/server.ts', import.meta.url))
// biome-ignore lint/suspicious/noTemplateCurlyInString: what a declaration writes to mean the project's root.
const PLACE = '${project}'
const homes: string[] = []

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tade-mcp-'))
  homes.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

function declare(mode: string, over: Partial<ServerDeclaration> = {}): ServerDeclaration {
  return {
    name: mode,
    transport: 'stdio',
    enabled: true,
    about: '',
    command: process.execPath,
    args: [SERVER, mode],
    url: null,
    env: {},
    header: {},
    auth: 'none',
    authName: null,
    variables: [],
    tools: [],
    scope: 'window',
    sandbox: 'none',
    install: null,
    ...over,
  }
}

const HOME = home()

function context(over: Partial<TransportContext> = {}): TransportContext {
  return {
    home: HOME,
    credential: null,
    env: { PATH: process.env.PATH ?? '' },
    fetch: (async () => {
      throw new Error('the stdio transport reached the network')
    }) as typeof fetch,
    now: () => 0,
    deadlineMs: 5_000,
    ...over,
  }
}

testTransport('stdio', () => makeStdioTransport(), {
  works: declare('works'),
  fails: 'fails',
  lingers: 'lingers',
  hangs: declare('hangs'),
  noisy: declare('noisy'),
  missing: declare('missing', { command: 'tade-no-such-program', install: 'npm i -g nothing' }),
  dies: { server: declare('works', { name: 'dying' }), tool: 'quits' },
  deadlineMs: 5_000,
  context: () => context(),
})

/** What the fixture says it was started with: where, with what, knowing what. */
async function told(
  server: ServerDeclaration,
  ctx: TransportContext = context(),
): Promise<{ pid: number; cwd: string; args: string[]; env: Record<string, string> }> {
  const session = await makeStdioTransport().open(server, ctx)
  try {
    const outcome = await session.callTool(
      'told',
      {},
      { signal: new AbortController().signal, progress: () => {} },
    )
    return JSON.parse(outcome.text) as never
  } finally {
    await session.close()
  }
}

/** Which process group a process is in, or null where nothing can be asked. */
function groupOf(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

describe('a server that is a program on this machine', () => {
  it('runs in a process group of its own, so a signal to Tade’s never sweeps it up', async () => {
    const said = await told(declare('works'))
    const theirs = groupOf(said.pid)
    const mine = groupOf(process.pid)
    // A machine with no `ps` cannot be asked, and a test that cannot ask is
    // not a test that fails.
    if (theirs === null || mine === null || theirs === '') return
    expect(theirs).not.toBe(mine)
  })

  it('is given what the declaration names and nothing the window inherited', async () => {
    const said = await told(
      declare('works', { env: { DATABASE: 'dev' } }),
      context({ env: { PATH: process.env.PATH ?? '', DATABASE: 'dev' } }),
    )
    expect(said.env.DATABASE).toBe('dev')
    // The window's own environment holds everybody's tokens; the broker
    // scrubs it and this is what arrives.
    expect(said.env.TADE_HOME).toBeUndefined()
    expect(said.env.HOME).toBeUndefined()
  })

  it('puts the credential exactly where `auth` says, and nowhere else', async () => {
    const said = await told(
      declare('works', { auth: 'env', authName: 'DATABASE_URL' }),
      context({ credential: 'postgres://secret' }),
    )
    expect(said.env.DATABASE_URL).toBe('postgres://secret')
    expect(
      Object.entries(said.env).filter(([, value]) => value === 'postgres://secret'),
    ).toHaveLength(1)
  })

  it('works in a scratch directory of its own, never in a project it was not given', async () => {
    const said = await told(declare('works'))
    expect(said.cwd).toContain(join('mcp', 'works'))
  })

  it('starts a project-scoped one in that project, with the project put in', async () => {
    const project = home()
    const said = await told(
      declare('works', { scope: 'project', args: [SERVER, 'works', PLACE] }),
      context({ cwd: project }),
    )
    // Its own idea of where it is: on macOS a temp directory is reached
    // through a symlink, and the program reports the real one.
    expect(said.cwd).toBe(realpathSync(project))
    expect(said.args).toEqual([project])
  })

  it('says what to do about a program that is not here, without dialling anything', async () => {
    const transport = makeStdioTransport()
    const said = await transport.ready(
      declare('missing', { command: 'tade-no-such-program', install: 'npm i -g the-thing' }),
      context(),
    )
    expect(said).toContain('not on this machine')
    expect(said).toContain('npm i -g the-thing')
  })

  it('refuses a sandbox it cannot apply here rather than starting the program loose', async () => {
    const transport = makeStdioTransport({ platform: 'linux' })
    const said = await transport.ready(declare('works', { sandbox: 'seatbelt' }), context())
    expect(said).toContain('seatbelt')
    await expect(
      transport.open(declare('works', { sandbox: 'seatbelt' }), context()),
    ).rejects.toMatchObject({ trouble: 'unavailable' })
  })

  it('says why a program that will not start would not, in its own words', async () => {
    await expect(makeStdioTransport().open(declare('dies'), context())).rejects.toMatchObject({
      said: expect.stringContaining('no database url'),
    })
  })

  it('offers what a server that also writes rubbish offered, and leaves the rubbish out', async () => {
    const session = await makeStdioTransport().open(declare('noisy'), context())
    try {
      const tools = await session.listTools()
      expect(tools.map((tool) => tool.name)).toContain('echo')
      // A tool with no name and one whose parameters are not an object are
      // left out here; what Tade would call the rest is `namesFor`'s to say.
      expect(tools.map((tool) => tool.name)).not.toContain('stringy')
      expect(tools.some((tool) => tool.name === '')).toBe(false)
    } finally {
      await session.close()
    }
  })

  it('says how a call is going while it is going, in the server’s own words', async () => {
    const session = await makeStdioTransport().open(declare('works'), context())
    const heard: string[] = []
    try {
      await session.callTool(
        'lingers',
        {},
        { signal: new AbortController().signal, progress: (text) => heard.push(text) },
      )
      expect(heard).toContain('working')
    } finally {
      await session.close()
    }
  })

  it('comes back with why once the program has gone, rather than waiting on it', async () => {
    const session = await makeStdioTransport().open(declare('works'), context())
    await session.close()
    await expect(
      session.callTool('echo', {}, { signal: new AbortController().signal, progress: () => {} }),
    ).rejects.toBeInstanceOf(McpError)
  })
})

describe('what is read off the machine, and what is put in the line', () => {
  it('finds a program the way `which` does, and says no to one that is nowhere', () => {
    expect(found(process.execPath, {})).toBe(true)
    expect(found('tade-no-such-program', { PATH: '/nonexistent' })).toBe(false)
    expect(found('sh', { PATH: '/usr/bin:/bin' })).toBe(true)
  })

  it('puts the project in where the declaration asked for it, and leaves the rest alone', () => {
    expect(withProject(['--root', PLACE, '--json'], '/src/shop')).toEqual([
      '--root',
      '/src/shop',
      '--json',
    ])
    expect(withProject([`${PLACE}/db.sqlite`], '/src/shop')).toEqual(['/src/shop/db.sqlite'])
    // Nothing to put in is the declaration left as it was written.
    expect(withProject([PLACE], undefined)).toEqual([PLACE])
  })
})

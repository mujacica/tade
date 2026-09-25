import type { ProgramLook } from '@tade/workbench/programs'
import { describe, expect, it } from 'vitest'
import { askWhatIsCurrent } from '../src/programs.ts'

// Asking the world what is current — the half of Updates that reaches the
// network, and the half nothing had run.
//
// `programs.test.ts` holds the npm path: what is behind, what is not, and what
// happens where nobody answers. What is here is everything else that can come
// back — a registry that answers with a number rather than a package, a
// Homebrew that will not say, a cask's version with a build stuck on the end —
// because each of those was a `cannotTell` nobody had ever seen, and the rule
// they all keep is the one worth a test: **nothing is invented**. Where
// somebody cannot be asked, or answers in a shape Tade does not know, the
// answer is that Tade cannot tell — never a version guessed out of half a
// string, which on this page looks exactly like a real one.
//
// Everything reaches the world through a seam the caller passes in, so nothing
// here opens a socket.

const look = (over: Partial<ProgramLook> = {}): ProgramLook =>
  ({
    need: {
      command: 'claude',
      title: 'Claude Code',
      versionArgs: ['--version'],
      optional: false,
      needed: [{ what: 'claude-code', why: 'being the agent', inUse: true }],
      inUse: true,
    },
    install: {
      manager: 'npm',
      name: '@anthropic-ai/claude-code',
      where: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      said: 'a global npm package',
    },
    version: '2.0.5',
    latest: null,
    cannotTell: 'nobody has been asked what is current',
    update: { command: 'npm install --global @anthropic-ai/claude-code@latest' },
    behind: false,
    ...over,
  }) as ProgramLook

/** A registry that answers with this body and status. */
const registry = (status: number, body: unknown) =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

/** A `brew` that prints this and exits with that, recording what it was asked. */
function brew(stdout: string, code = 0, stderr = '') {
  const asked: string[][] = []
  return {
    asked,
    exec: async (_command: string, args: string[]) => {
      asked.push(args)
      return { code, stdout, stderr }
    },
  }
}

const homebrew = (name: string, kind?: 'formula' | 'cask'): Partial<ProgramLook> => ({
  install: {
    manager: 'homebrew',
    name,
    where: `/opt/homebrew/bin/${name}`,
    said: `a Homebrew ${kind ?? 'package'}`,
    ...(kind ? { brew: kind } : {}),
  } as ProgramLook['install'],
})

describe('what a registry says', () => {
  it('says which registry refused, and what it said, rather than a bare failure', async () => {
    const [asked] = await askWhatIsCurrent([look()], {
      fetch: registry(404, { error: 'Not found' }),
      npmRegistry: 'https://registry.example.com',
    })
    expect(asked?.latest).toBeNull()
    expect(asked?.cannotTell).toBe(
      'https://registry.example.com answered 404 for @anthropic-ai/claude-code',
    )
  })

  it('says nothing was said, where the answer holds no version', async () => {
    const [asked] = await askWhatIsCurrent([look()], { fetch: registry(200, { dist: {} }) })
    expect(asked?.latest).toBeNull()
    expect(asked?.cannotTell).toContain('said nothing about @anthropic-ai/claude-code')
  })

  it('treats a version that is not a string as nothing said', async () => {
    // A number is what a registry answers when it is not the registry: a proxy
    // or a login page. Read as a version it would draw as `2` and look true.
    const [asked] = await askWhatIsCurrent([look()], { fetch: registry(200, { version: 2 }) })
    expect(asked?.latest).toBeNull()
    expect(asked?.cannotTell).toContain('said nothing')
  })

  it('asks a scoped package under the name it is published as', async () => {
    let url = ''
    await askWhatIsCurrent([look()], {
      fetch: (async (at: string) => {
        url = at
        return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    // The slash in `@scope/name` is a path separator to every HTTP client
    // there is, so it has to be escaped or the registry is asked about `latest`
    // inside a package that does not exist.
    expect(url).toBe('https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest')
  })

  it('does not care whether the registry it was given ended in a slash', async () => {
    let url = ''
    await askWhatIsCurrent([look()], {
      npmRegistry: 'https://registry.example.com///',
      fetch: (async (at: string) => {
        url = at
        return new Response(JSON.stringify({ version: '1' }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(url).toBe('https://registry.example.com/@anthropic-ai%2Fclaude-code/latest')
  })
})

describe('what Homebrew says', () => {
  it("reads a formula's stable version", async () => {
    const said = brew(JSON.stringify({ formulae: [{ versions: { stable: '3.4.0' } }], casks: [] }))
    const [asked] = await askWhatIsCurrent([look({ version: '3.3.0', ...homebrew('tmux') })], {
      exec: said.exec as never,
    })
    expect(asked?.latest).toBe('3.4.0')
    expect(asked?.behind).toBe(true)
  })

  it("reads a cask's version, without the build it was cut from", async () => {
    // `2.1.236,c38127e2…` is the version and then the build. Compared whole it
    // is never equal to anything, so an up-to-date cask reads as behind for ever.
    const said = brew(JSON.stringify({ casks: [{ version: '2.1.236,c38127e2f0' }] }))
    const [asked] = await askWhatIsCurrent(
      [look({ version: '2.1.236', ...homebrew('claude', 'cask') })],
      { exec: said.exec as never },
    )
    expect(asked?.latest).toBe('2.1.236')
    expect(asked?.behind).toBe(false)
  })

  it('says which namespace it means, because two of them hold the same name', async () => {
    // The cask `claude` is the desktop app and the formula `claude-code` is
    // the agent; brew answers about whichever it finds first.
    const cask = brew(JSON.stringify({ casks: [{ version: '1.0' }] }))
    await askWhatIsCurrent([look(homebrew('claude', 'cask'))], { exec: cask.exec as never })
    expect(cask.asked[0]).toEqual(['info', '--json=v2', '--cask', 'claude'])

    const formula = brew(JSON.stringify({ formulae: [{ versions: { stable: '1.0' } }] }))
    await askWhatIsCurrent([look(homebrew('tmux', 'formula'))], { exec: formula.exec as never })
    expect(formula.asked[0]).toEqual(['info', '--json=v2', '--formula', 'tmux'])

    const either = brew(JSON.stringify({ formulae: [{ versions: { stable: '1.0' } }] }))
    await askWhatIsCurrent([look(homebrew('gh'))], { exec: either.exec as never })
    expect(either.asked[0]).toEqual(['info', '--json=v2', 'gh'])
  })

  it("carries brew's own first line when it will not say", async () => {
    const said = brew('', 1, 'Error: No available formula with the name "nope"\nSearching...')
    const [asked] = await askWhatIsCurrent([look(homebrew('nope'))], { exec: said.exec as never })
    expect(asked?.latest).toBeNull()
    // The first line, because the rest is brew searching for what you meant.
    expect(asked?.cannotTell).toBe(
      'brew would not say what is current: Error: No available formula with the name "nope"',
    )
  })

  it('says it cannot tell where brew answers in a shape it does not know', async () => {
    const unknown = brew('{"formulae":[],"casks":[]}')
    const [asked] = await askWhatIsCurrent([look(homebrew('tmux'))], {
      exec: unknown.exec as never,
    })
    expect(asked?.cannotTell).toContain('did not say a version')

    const garbage = brew('not json at all')
    const [second] = await askWhatIsCurrent([look(homebrew('tmux'))], {
      exec: garbage.exec as never,
    })
    expect(second?.cannotTell).toContain('a shape Tade does not recognise')
  })
})

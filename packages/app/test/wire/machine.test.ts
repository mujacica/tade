import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Machine } from '../../src/wire/machine.ts'

// What Tade needs of the machine, and who it runs as.
//
// The rule this subject exists to keep is one sentence: **nothing here
// installs anything**. The exact command is on the page before it runs, and
// running it types that command into a terminal you are looking at — so what
// is asserted here is the *order*: the terminal is in front before a key of it
// is typed, and with nowhere to open one the command is said back rather than
// run somewhere nobody can see it.
//
// Built by hand rather than through the harness, like `checks.test.ts` beside
// it: what these methods do is ask the client for a terminal and ask the deps
// to show it, and a real window would answer that with a real PTY.
//
// `lookAtWhatIsInstalled` is deliberately not here: it runs a `--version` per
// program against this machine, so what it answers is a fact about the laptop
// it runs on. It is `programs.test.ts`'s, where the machine is the thing being
// read and every seam is handed in.

interface Did {
  what: string
  with: unknown[]
}

/** A window for this subject, and everything it asked of the world. */
function wiring(
  over: {
    project?: string | null
    terminal?: { id: string } | Error
    credentials?: Record<string, 'signed-in' | 'api-key' | 'env-key'>
    fails?: string
  } = {},
) {
  const did: Did[] = []
  let state: AppState = initialState()
  const client = {
    terminal(name: string, project: string) {
      did.push({ what: 'terminal', with: [name, project] })
      if (over.terminal instanceof Error) throw over.terminal
      if (!over.terminal) throw new Error('none open under that name')
      return over.terminal
    },
    async openTerminal(spec: Record<string, unknown>) {
      did.push({ what: 'openTerminal', with: [spec] })
      if (over.fails) throw new Error(over.fails)
      return { id: 'term-1' }
    },
    async runInTerminal(id: string, command: string) {
      did.push({ what: 'runInTerminal', with: [id, command] })
    },
    async accounts() {
      did.push({ what: 'accounts', with: [] })
      if (over.fails) throw new Error(over.fails)
      return [{ harness: 'pi', name: null }]
    },
    async signOut(harness: string, name: string | null) {
      did.push({ what: 'signOut', with: [harness, name] })
    },
    async useAccount(harness: string, name: string | null) {
      did.push({ what: 'useAccount', with: [harness, name] })
    },
    async removeAccount(name: string) {
      did.push({ what: 'removeAccount', with: [name] })
    },
  }
  const wire = {
    opts: {
      config: ConfigSchema.parse({ projects: { shop: { root: '/tmp/shop' } } }),
      home: '/tmp/home',
      client,
      credentials: over.credentials ? async () => over.credentials : undefined,
    },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live: null,
    now: () => 1_000,
    openedAt: 0,
    draw: () => {},
    note: (err: unknown) => {
      state = { ...state, notice: err instanceof Error ? err.message : String(err) } as AppState
    },
  } as unknown as Wiring
  if (over.project !== undefined) state = { ...state, project: over.project } as AppState
  return { wire, did, at: () => state }
}

const deps = (did: Did[]) => ({
  reload: () => did.push({ what: 'reload', with: [] }),
  terminalSize: () => ({ cols: 100, rows: 30 }),
  showTerminal: async (id: string) => {
    did.push({ what: 'showTerminal', with: [id] })
  },
  onScreenWith: async (flow: (ui: never) => Promise<void>) => {
    did.push({ what: 'onScreenWith', with: [] })
    await flow({ say: () => {}, run: async () => 0 } as never)
  },
  refreshModels: async () => {
    did.push({ what: 'refreshModels', with: [] })
  },
})

const machine = (world: ReturnType<typeof wiring>) => new Machine(world.wire, deps(world.did))

describe('running something where somebody can watch it', () => {
  it('opens a terminal, puts it in front, and only then types the command', async () => {
    const world = wiring({ project: 'shop' })
    await machine(world).watchCommand('updates', 'brew upgrade tmux')

    // The order is the point. A command typed into a terminal nobody has been
    // shown is a command run behind their back, which is exactly what the page
    // promises does not happen.
    expect(world.did.map((one) => one.what)).toEqual([
      'terminal',
      'openTerminal',
      'showTerminal',
      'runInTerminal',
    ])
    expect(world.did.at(-1)?.with).toEqual(['term-1', 'brew upgrade tmux'])
  })

  it('opens it the size of the pane it will be drawn in', async () => {
    const world = wiring({ project: 'shop' })
    await machine(world).watchCommand('updates', 'npm i -g tade-sh')
    expect(world.did[1]?.with[0]).toEqual({
      project: 'shop',
      name: 'updates',
      cols: 100,
      rows: 30,
    })
  })

  it('uses the terminal of that name again rather than opening a second', async () => {
    const world = wiring({ project: 'shop', terminal: { id: 'already-here' } })
    await machine(world).watchCommand('updates', 'brew upgrade tmux')
    expect(world.did.map((one) => one.what)).toEqual(['terminal', 'showTerminal', 'runInTerminal'])
    expect(world.did.at(-1)?.with[0]).toBe('already-here')
  })

  it('closes the page it was pressed on, so the terminal is what is in front', async () => {
    const world = wiring({ project: 'shop' })
    world.wire.put({ ...world.at(), panel: { kind: 'settings' } } as AppState)
    await machine(world).watchCommand('updates', 'brew upgrade tmux')
    expect(world.at().panel).toBeNull()
  })

  it('says the command back where there is no folder to open a shell in', async () => {
    const world = wiring({ project: null })
    ;(world.wire.opts as unknown as { config: unknown }).config = ConfigSchema.parse({})
    await machine(world).watchCommand('updates', 'brew upgrade tmux')

    // No project, no folder. The command is the answer — and it is never run
    // somewhere nobody chose.
    expect(world.at().notice).toBe('Run it yourself: brew upgrade tmux')
    expect(world.did).toEqual([])
  })

  it('falls back to the project it has where none is in front', async () => {
    const world = wiring({ project: null })
    await machine(world).watchCommand('updates', 'brew upgrade tmux')
    expect(world.did[0]?.with).toEqual(['updates', 'shop'])
  })

  it('says what went wrong rather than throwing out of a button', async () => {
    const world = wiring({ project: 'shop', fails: 'no room for another terminal' })
    await machine(world).watchCommand('updates', 'brew upgrade tmux')
    expect(world.at().notice).toBe('no room for another terminal')
  })
})

describe('the Updates page’s buttons', () => {
  it('reloads through the one path every reload goes', async () => {
    const world = wiring({ project: 'shop' })
    world.wire.put({ ...world.at(), panel: { kind: 'settings' } } as AppState)
    await machine(world).updateAction('updates:reload')
    // Asking first when it would stop agents living inside this window is the
    // reload's own business; what this must not do is a second way of doing it.
    expect(world.did.map((one) => one.what)).toEqual(['reload'])
    expect(world.at().panel).toBeNull()
  })

  it('does nothing for a button that is not on the page', async () => {
    const world = wiring({ project: 'shop' })
    await machine(world).updateAction('updates:something-else')
    expect(world.did).toEqual([])
  })
})

describe('who Tade runs as', () => {
  it('says how a provider is paid for, in the words the strip says it in', async () => {
    const world = wiring({
      credentials: { anthropic: 'signed-in', openai: 'api-key', openrouter: 'env-key' },
    })
    const subject = machine(world)
    await subject.loadAccounts()

    expect(subject.credential('anthropic')).toBe('signed in')
    expect(subject.credential('openai')).toBe('API key')
    expect(subject.credential('openrouter')).toBe('env API key')
    // Nothing recorded is nothing said, rather than a guess at how it is paid for.
    expect(subject.credential('mistral')).toBeNull()
    expect(subject.credential(null)).toBeNull()
  })

  it('reads the models again after signing in, because signing in changes them', async () => {
    const world = wiring({ credentials: { anthropic: 'signed-in' } })
    await machine(world).loadAccounts()
    expect(world.did.map((one) => one.what)).toEqual(['refreshModels'])
  })

  it('keeps the accounts it had when the workbench cannot be asked', async () => {
    const world = wiring({ project: 'shop' })
    const subject = machine(world)
    await subject.loadAccountViews()
    ;(world.wire.opts as unknown as { client: { accounts: unknown } }).client.accounts =
      async () => {
        throw new Error('the workbench has gone')
      }
    // An empty Accounts page reads as "you are signed in to nothing", which is
    // a different and much worse thing to say than nothing at all.
    await expect(subject.loadAccountViews()).resolves.toBeUndefined()
  })
})

describe('doing something to an account', () => {
  it('signs one out and reads the accounts back', async () => {
    const world = wiring({ project: 'shop' })
    await machine(world).accountAction('account:sign-out:claude-code:work')
    expect(world.did.map((one) => one.what)).toEqual(['signOut', 'accounts'])
    expect(world.did[0]?.with).toEqual(['claude-code', 'work'])
  })

  it('has new agents run as one, naming what that means on the page', async () => {
    const world = wiring({ project: 'shop' })
    world.wire.put({ ...world.at(), panel: { kind: 'settings' } } as AppState)
    await machine(world).accountAction('account:use:claude-code:work')
    expect(world.did[0]?.with).toEqual(['claude-code', 'work'])
    expect((world.at().panel as { saved?: string })?.saved).toBe(
      'New Claude Code agents run as work.',
    )
  })

  it('says the harness’s own sign-in is what an unnamed account means', async () => {
    const world = wiring({ project: 'shop' })
    world.wire.put({ ...world.at(), panel: { kind: 'settings' } } as AppState)
    await machine(world).accountAction('account:use:claude-code:')
    expect((world.at().panel as { saved?: string })?.saved).toBe(
      'New Claude Code agents run as its own sign-in.',
    )
  })

  it('never removes an account nobody named', async () => {
    const world = wiring({ project: 'shop' })
    await machine(world).accountAction('account:remove:claude-code:')
    expect(world.did.map((one) => one.what)).toEqual(['accounts'])
  })

  it('asks for a name before adding one, rather than inventing it', async () => {
    const world = wiring({ project: 'shop' })
    await machine(world).accountAction('account:add-key:claude-code:')
    const panel = world.at().panel as { kind: string; title: string; target: string }
    expect(panel.kind).toBe('prompt')
    expect(panel.title).toBe('Add a Claude Code account paid with an API key')
    // The harness and which kind it is, carried on the panel: what comes back
    // is a name, and by then nothing else remembers what it is a name for.
    expect(panel.target).toBe('claude-code api-key')
    // Nothing happened to any account yet.
    expect(world.did).toEqual([])
  })

  it('asks for the key itself against the account it belongs to', async () => {
    const world = wiring({ project: 'shop' })
    await machine(world).accountAction('account:key:claude-code:work')
    const panel = world.at().panel as { title: string; target: string }
    expect(panel.title).toBe("work's API key")
    expect(panel.target).toBe('work')
  })

  it('signs in through the harness’s own sign-in, on a screen of its own', async () => {
    const world = wiring({ project: 'shop', credentials: {} })
    ;(world.wire.opts as unknown as { client: Record<string, unknown> }).client.signInFor = () => ({
      how: 'Type /login.',
      launch: { command: '/bin/echo', args: ['login'], env: {} },
    })
    await machine(world).accountAction('account:sign-in:claude-code:work')
    // A subscription token never passes through Tade: its own sign-in runs in
    // a terminal a person can see, and then the accounts are read again.
    expect(world.did.map((one) => one.what)).toEqual(['onScreenWith', 'refreshModels', 'accounts'])
  })

  it('says what went wrong on the page rather than throwing out of a click', async () => {
    const world = wiring({ project: 'shop' })
    world.wire.put({ ...world.at(), panel: { kind: 'settings' } } as AppState)
    ;(world.wire.opts as unknown as { client: Record<string, unknown> }).client.signOut =
      async () => {
        throw new Error('claude is not installed')
      }
    await machine(world).accountAction('account:sign-out:claude-code:work')
    expect((world.at().panel as { error?: string })?.error).toBe('claude is not installed')
  })
})

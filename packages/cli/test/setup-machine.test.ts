import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ui } from '@tade/app'
import type { HarnessHere } from '@tade/workbench/machine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import type { Look } from '../src/commands/setup-facts.ts'
import {
  harnessLines,
  offerInstall,
  sayNativeTrouble,
  setUpKeys,
  setUpPrograms,
  signInSomewhere,
} from '../src/commands/setup-machine.ts'

// The half of setting up that is about the machine: what is missing, what
// would install it, which harness is signed in, and the keys the extensions
// asked for.
//
// Answered against a `Ui` that records rather than draws, because what has to
// be exact is *what is asked and what is run*: the command is shown before
// anybody agrees to it, a "no" runs nothing, and nothing that was not asked
// for is ever installed.

interface Recorder extends Ui {
  said: string[]
  asked: string[]
  ran: string[]
  paused: string[]
}

/** A Ui that answers with what it is told to, in order, and writes down the rest. */
function recorder(answers: {
  confirm?: boolean[]
  choose?: number[]
  ask?: string[]
  code?: number
}): Recorder {
  const said: string[] = []
  const asked: string[] = []
  const ran: string[] = []
  const paused: string[] = []
  const confirms = [...(answers.confirm ?? [])]
  const chooses = [...(answers.choose ?? [])]
  const asks = [...(answers.ask ?? [])]
  return {
    said,
    asked,
    ran,
    paused,
    say: (text: string) => said.push(text),
    context: () => {},
    async ask(question: string, fallback = '') {
      asked.push(question)
      return asks.shift() ?? fallback
    },
    async confirm(question: string, fallback: boolean) {
      asked.push(question)
      return confirms.shift() ?? fallback
    },
    async choose(question: string, options: readonly string[]) {
      asked.push(`${question} [${options.join(' | ')}]`)
      return chooses.shift() ?? options.length - 1
    },
    async pause(text: string) {
      paused.push(text)
    },
    async run(_title: string, command: string, args: string[]) {
      ran.push([command, ...args].join(' '))
      return answers.code ?? 0
    },
  }
}

const emptyLook: Look = {
  programs: [],
  missing: [],
  native: [],
  harnesses: [],
  keysWanted: [],
  secrets: [],
  extensions: [],
  installers: { platform: 'darwin', managers: ['brew'] },
}

const harness = (over: Partial<HarnessHere> & { id: string }): HarnessHere => ({
  inUse: false,
  installed: true,
  canRun: true,
  version: '1.0.0',
  problems: [],
  signedIn: false,
  who: null,
  problem: 'not signed in yet',
  signIn: { launch: { command: '/bin/echo', args: ['login'], env: {} }, how: 'Type /login.' },
  install: { cannot: 'nothing here says how to install it' },
  ...over,
})

describe('offering to install something', () => {
  it('shows the command before it asks, and runs exactly that', async () => {
    const ui = recorder({ confirm: [true] })
    expect(await offerInstall(ui, 'tmux', { command: 'brew install tmux' })).toBe(true)
    // Read first, agreed to second: never an install behind a spinner.
    expect(ui.said[0]).toContain('brew install tmux')
    expect(ui.asked[0]).toContain('install tmux?')
    expect(ui.ran).toEqual(['brew install tmux'])
  })

  it('runs nothing when the answer is no, and says how to do it later', async () => {
    const ui = recorder({ confirm: [false] })
    expect(await offerInstall(ui, 'tmux', { command: 'brew install tmux' })).toBe(false)
    expect(ui.ran).toEqual([])
    expect(ui.said.join('\n')).toContain('brew install tmux')
  })

  it('says why there is nothing to run rather than guessing a command', async () => {
    const ui = recorder({ confirm: [true] })
    expect(await offerInstall(ui, 'git', { cannot: 'macOS: `xcode-select --install`' })).toBe(false)
    expect(ui.asked).toEqual([])
    expect(ui.ran).toEqual([])
    expect(ui.said.join('\n')).toContain('xcode-select')
  })

  it('says so when the install itself failed', async () => {
    const ui = recorder({ confirm: [true], code: 1 })
    expect(await offerInstall(ui, 'tmux', { command: 'brew install tmux' })).toBe(false)
    expect(ui.said.join('\n')).toContain('that did not work')
  })
})

describe('the programs Tade runs', () => {
  const tmux = {
    command: 'tmux',
    title: 'tmux',
    why: 'holding every lane',
    optional: true,
    install: { command: 'brew install tmux' as const },
  }
  const git = {
    command: 'git',
    title: 'git',
    why: 'every commit an agent makes',
    optional: false,
    install: { command: 'brew install git' },
  }

  it('offers what is needed and never asks about what nobody asked for', async () => {
    const ui = recorder({ confirm: [true] })
    await setUpPrograms(ui, [tmux, git])
    // One question, about the one thing something in use needs.
    expect(ui.asked.filter((one) => one.startsWith('install'))).toEqual(['install git?'])
    expect(ui.ran).toEqual(['brew install git'])
    // And the other is said, with its command, so it can be had on purpose.
    expect(ui.said.join('\n')).toContain('brew install tmux')
  })

  it('says what each is for, because that is what the decision is made on', async () => {
    const ui = recorder({ confirm: [false] })
    await setUpPrograms(ui, [git])
    expect(ui.said.join('\n')).toContain('every commit an agent makes')
  })
})

describe('what Tade is built on', () => {
  it('says the whole fix and waits to be told it has been read', async () => {
    const ui = recorder({})
    await sayNativeTrouble(ui, [
      {
        module: 'node-pty',
        clause: 'node-pty cannot spawn',
        fix: "node-pty's spawn-helper is not executable\n\n  chmod +x /somewhere/spawn-helper\n",
        blocking: true,
      },
    ])
    const all = ui.said.join('\n')
    expect(all).toContain('chmod +x /somewhere/spawn-helper')
    // Nothing is run: the command that fixes it would have to be spawned
    // through the thing that is broken.
    expect(ui.ran).toEqual([])
    // And the screen does not close over the explanation.
    expect(ui.paused).toHaveLength(1)
  })
})

describe('signing in', () => {
  it('says which are signed in, and offers the rest', async () => {
    const look: Look = {
      ...emptyLook,
      harnesses: [
        harness({ id: 'pi', inUse: true, signedIn: true, who: 'anthropic', problem: null }),
        harness({ id: 'claude-code' }),
      ],
    }
    // Choose the first thing offered, then "that is enough".
    const ui = recorder({ choose: [0, 1] })
    await signInSomewhere(ui, look, async () => look)
    const all = ui.said.join('\n')
    expect(all).toContain('pi')
    expect(all).toContain('signed in as anthropic')
    // Only the ones that are not signed in are offered, and the harness's own
    // sign-in is what runs — no credential passes through Tade.
    expect(ui.asked[0]).toContain('claude-code')
    expect(ui.asked[0]).not.toContain('pi —')
    expect(ui.ran).toEqual(['/bin/echo login'])
  })

  it('stops the moment somebody says that is enough', async () => {
    const look: Look = { ...emptyLook, harnesses: [harness({ id: 'pi', inUse: true })] }
    const ui = recorder({ choose: [1] })
    await signInSomewhere(ui, look, async () => look)
    expect(ui.ran).toEqual([])
    expect(ui.said.join('\n')).toContain('Settings › Accounts')
  })

  it('offers to install one that is not here rather than a sign-in that would fail', async () => {
    const look: Look = {
      ...emptyLook,
      harnesses: [
        harness({
          id: 'codex',
          installed: false,
          canRun: false,
          version: null,
          signIn: null,
          install: { command: 'npm install --global @openai/codex' },
        }),
      ],
    }
    // Install it, then "that is enough": what it can do is asked again after
    // an install rather than assumed, so signing in is the next time round.
    const ui = recorder({ choose: [0, 1], confirm: [true] })
    await signInSomewhere(ui, look, async () => look)
    expect(ui.ran).toEqual(['npm install --global @openai/codex'])
    expect(ui.said.join('\n')).toContain('choose it again to sign in')
  })

  it('draws one line per harness, and never invents a sign-in for what is not here', () => {
    const lines = harnessLines([
      harness({ id: 'pi', inUse: true, signedIn: true, who: 'anthropic', problem: null }),
      harness({ id: 'claude-code', problem: 'not signed in yet' }),
      harness({
        id: 'codex',
        installed: false,
        version: null,
        signIn: null,
        install: { command: 'npm install --global @openai/codex' },
      }),
    ])
    expect(lines[0]).toContain('✓ pi — signed in as anthropic')
    expect(lines[1]).toContain('installed, not signed in yet')
    expect(lines[2]).toContain('not installed (npm install --global @openai/codex)')
    // Which of them anything is set to use is said, because a harness nothing
    // uses being signed out is not a problem.
    expect(lines[1]).toContain('nothing is set to use it')
  })
})

describe('the keys the extensions asked for', () => {
  const home = tmp('tade-setup-keys-')
  let was: string | undefined

  beforeEach(() => {
    was = process.env.TADE_HOME
    process.env.TADE_HOME = home
  })
  afterEach(() => {
    if (was === undefined) delete process.env.TADE_HOME
    else process.env.TADE_HOME = was
  })

  const look: Look = {
    ...emptyLook,
    keysWanted: [{ extension: 'jev', title: 'Jev', problem: 'Jev needs a TypeSafe API key' }],
    secrets: [
      {
        path: 'extensions.jev.key',
        extension: 'jev',
        title: 'Jev',
        key: 'key',
        label: 'API key',
        means: 'the TypeSafe API key',
        variables: ['TYPESAFE_API_KEY'],
        value: '',
        from: null,
        placeholder: 'tsk_…',
      },
    ],
  }

  it('writes a pasted key where the extension reads it, as it was typed', async () => {
    const ui = recorder({ ask: ['tsk_0123456789'] })
    await setUpKeys(ui, look)
    const written = readFileSync(join(home, 'config.yaml'), 'utf8')
    // In the config, in plain sight: a key you cannot read back is a key you
    // cannot check against the console you copied it from.
    expect(written).toContain('tsk_0123456789')
    // And what wins over it is said, so a machine that exports one is not a
    // mystery later.
    expect(ui.said.join('\n')).toContain('$TYPESAFE_API_KEY')
  })

  it('is explicit that everything works without one, and writes nothing when skipped', async () => {
    const skipped = tmp('tade-setup-skipped-')
    process.env.TADE_HOME = skipped
    const ui = recorder({ ask: [''] })
    await setUpKeys(ui, look)
    expect(ui.said.join('\n')).toContain('All of them work without one')
    expect(() => readFileSync(join(skipped, 'config.yaml'), 'utf8')).toThrow()
  })

  it('asks for nothing when nothing that is on wants a key', async () => {
    const ui = recorder({})
    await setUpKeys(ui, emptyLook)
    expect(ui.asked).toEqual([])
    expect(ui.said).toEqual([])
  })

  it('never asks for a key that is already set somewhere', async () => {
    const ui = recorder({})
    await setUpKeys(ui, {
      ...look,
      secrets: [
        { ...(look.secrets[0] as (typeof look.secrets)[number]), from: '$TYPESAFE_API_KEY' },
      ],
    })
    expect(ui.asked).toEqual([])
    expect(ui.said.join('\n')).toContain('already set in $TYPESAFE_API_KEY')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ui } from '@tade/app'
import type { HarnessHere } from '@tade/workbench/machine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { report, setUpWorkspace } from '../src/commands/setup.ts'
import type { Look } from '../src/commands/setup-facts.ts'
import {
  harnessLines,
  offerInstall,
  sayNativeTrouble,
  serverSays,
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
      // A line run through a shell is written down as the line, which is what
      // was shown before it ran.
      ran.push(
        command === '/bin/sh' && args[0] === '-c' ? (args[1] ?? '') : [command, ...args].join(' '),
      )
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
  unattended: null,
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
  until: null,
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

  it('runs the line whole, through a shell, so a server’s update-then-install is one command', async () => {
    const raw: string[][] = []
    const ui: Ui = {
      ...recorder({ confirm: [true] }),
      run: async (_title: string, command: string, args: string[]) => {
        raw.push([command, ...args])
        return 0
      },
    }
    const line = 'sudo apt-get update && sudo apt-get install -y tmux'
    expect(await offerInstall(ui, 'tmux', { command: line })).toBe(true)
    expect(raw).toEqual([['/bin/sh', '-c', line]])
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

describe('a tmux older than its driver can use', () => {
  // Found on a Linux VPS: `✓ tmux 3.1` in the Programs list, beside a
  // workspace step saying it was too old, which offered `brew install tmux`.
  const apt = 'sudo apt-get update && sudo apt-get install -y tmux'
  const old = (install: string, optional = false) => ({
    command: 'tmux',
    title: 'tmux',
    why: 'holding every lane',
    optional,
    tooOld: { have: '3.1', needs: '3.2' },
    install: { command: install },
  })
  const look = (install: string, managers: string[], platform: string): Look => ({
    ...emptyLook,
    installers: { platform, managers },
    programs: [
      {
        need: {
          command: 'tmux',
          title: 'tmux',
          versionArgs: ['-V'],
          optional: false,
          oldest: '3.2',
          needed: [{ what: 'the tmux driver', why: 'holding every lane', inUse: true }],
          inUse: true,
        },
        install: { manager: 'system', name: 'tmux', where: '/usr/bin/tmux', said: '' },
        version: '3.1',
        latest: null,
        cannotTell: null,
        update: { command: install },
        behind: false,
        tooOld: true,
      },
    ],
    missing: [old(install)],
  })

  it('is offered as a newer one on a server, with the apt line', async () => {
    const ui = recorder({ confirm: [true] })
    await setUpPrograms(ui, [old(apt)])
    expect(ui.said.join('\n')).toContain('tmux is too old: 3.1, needs 3.2 — holding every lane')
    expect(ui.asked).toEqual(['install a newer tmux?'])
    expect(ui.ran).toEqual([apt])
  })

  it('is said too old where nothing in use needs it, and asked about nowhere', async () => {
    const ui = recorder({})
    await setUpPrograms(ui, [old('brew upgrade tmux', true)])
    expect(ui.asked).toEqual([])
    expect(ui.said.join('\n')).toContain(
      'tmux is too old: 3.1, needs 3.2 — holding every lane (brew upgrade tmux)',
    )
  })

  describe('where agents run', () => {
    let was: string | undefined
    const home = tmp('tade-setup-workspace-')
    beforeEach(() => {
      was = process.env.TADE_HOME
      process.env.TADE_HOME = home
    })
    afterEach(() => {
      if (was === undefined) delete process.env.TADE_HOME
      else process.env.TADE_HOME = was
    })
    const config = () => readFileSync(join(home, 'config.yaml'), 'utf8')

    it('offers the line that brings it up to date before choosing tmux', async () => {
      const ui = recorder({ choose: [0], confirm: [true] })
      await setUpWorkspace(ui, look(apt, ['apt-get'], 'linux'))
      expect(ui.said).toContain('  tmux is too old: 3.1, needs 3.2')
      expect(ui.asked).toContain('install a newer tmux?')
      expect(ui.ran).toEqual([apt])
      expect(config()).toMatch(/driver: tmux/)
    })

    it('leaves it on pty when the newer one is declined, rather than a driver that will not start', async () => {
      const ui = recorder({ choose: [0], confirm: [false] })
      await setUpWorkspace(ui, look(apt, ['apt-get'], 'linux'))
      expect(ui.ran).toEqual([])
      expect(config()).toMatch(/driver: pty/)
    })
  })

  it('is never ticked by --check, on a server or on a Mac', () => {
    const server = report(look(apt, ['apt-get'], 'linux')).join('\n')
    expect(server).not.toContain('✓ tmux')
    expect(server).toContain(`○ tmux is too old: 3.1, needs 3.2 (${apt}) — holding every lane`)
    const mac = report(look('brew upgrade tmux', ['brew'], 'darwin')).join('\n')
    expect(mac).toContain('○ tmux is too old: 3.1, needs 3.2 (brew upgrade tmux)')
  })
})

describe('a server', () => {
  it('is told what to open for mosh as a step nothing requires, and nothing else is', () => {
    const box = { unattended: { user: 'you', linger: true, unit: '/u/tade.service' } }
    const said = serverSays(box)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/^optional, for mosh: open UDP 60000–61000 on this machine/)
    expect(said[0]).toContain('sudo ufw allow 60000:61000/udp')
    // A Mac, or a desktop: nothing another machine types in over.
    expect(serverSays({ unattended: null })).toEqual([])
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

describe('how long each sign-in lasts', () => {
  const now = Date.UTC(2026, 9, 16)
  const day = 86_400_000
  const signed = (over: Partial<HarnessHere> & { id: string }) =>
    harness({ signedIn: true, who: 'you@example.com', problem: null, ...over })

  it('says the days a harness wrote down, warns inside three, and cannot tell where it wrote none', () => {
    const [claude, soon, codex] = harnessLines(
      [
        signed({ id: 'claude-code', until: now + 12 * day }),
        signed({ id: 'claude-code', until: now + 2 * day }),
        signed({ id: 'codex', until: null }),
      ],
      now,
    )
    expect(claude).toBe(
      '  ✓ claude-code (nothing is set to use it) — signed in as you@example.com · 12 days left',
    )
    expect(soon).toContain('only 2 days left: sign in again before it runs out')
    expect(codex).toContain('cannot tell for how long')
  })

  it('says nothing about how long for a harness that is not signed in', () => {
    const [line] = harnessLines([harness({ id: 'pi', until: now + day })], now)
    expect(line).not.toContain('left')
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

  it('says who else can read the file, before asking anybody to paste a key into it', async () => {
    // The wizard is where most people meet this question, and `0600` is not
    // the answer to it: agents run as you, so the file is open to every one
    // of them. Said here with what to do instead, or it is a warning nobody
    // can act on.
    const ui = recorder({ ask: [''] })
    await setUpKeys(ui, look)
    const said = ui.said.join(' ').replace(/\s+/g, ' ')
    expect(said).toContain('any agent you run can read')
    expect(said).toContain('export its variable instead')
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

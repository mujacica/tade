import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOG, SERVICE, type ServiceState, START } from '@tade/core'
import { systemdHere } from '@tade/workbench/machine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  type Asker,
  lanesWouldStop,
  offerLinger,
  offerUnit,
  setUpUnattended,
  unitHere,
} from '../src/commands/host-service.ts'

// Tade on a server, kept running by the person's own service manager.
//
// What has to be exact is what is shown, what is written and what is run:
// the unit is printed whole before anything is written, nothing is written or
// started without a press, and the line that runs is the line that was shown.
// That systemd reads the unit this way, hears `tade serve` say it is ready, and
// that the agents outlive a restart of it, was proved in a Debian container
// under systemd (`set-up-the-machine`, "Proving it"): no runner here has a
// user manager to prove it with.

interface Recorder extends Asker {
  said: string[]
  asked: string[]
  ran: string[]
}

function recorder(answers: boolean[] = [], code = 0): Recorder {
  const said: string[] = []
  const asked: string[] = []
  const ran: string[] = []
  const queue = [...answers]
  return {
    said,
    asked,
    ran,
    say: (text) => said.push(text),
    async confirm(question, fallback) {
      asked.push(question)
      return queue.shift() ?? fallback
    },
    async run(_title, command, args) {
      ran.push(command === '/bin/sh' && args[0] === '-c' ? (args[1] ?? '') : command)
      return code
    },
  }
}

const unitAt = (dir: string) => ({
  text: '[Service]\nExecStart=/usr/bin/node /x/bin.ts serve\n',
  path: join(dir, 'systemd', 'user', SERVICE),
})

/** A service manager that answers this, and is asked nothing else. */
const standing = (state: ServiceState) => async () => state
const stopped = standing({ kind: 'stopped' })

let home: string
let saved: string | undefined
beforeEach(() => {
  saved = process.env.TADE_HOME
  home = tmp('tade-host-home-')
  process.env.TADE_HOME = home
})
afterEach(() => {
  if (saved === undefined) delete process.env.TADE_HOME
  else process.env.TADE_HOME = saved
})

describe('writing the unit', () => {
  it('writes it on a press, then offers to start it, running exactly the line it shows', async () => {
    const unit = unitAt(tmp('tade-host-'))
    const ask = recorder([true, true])
    expect(await offerUnit(ask, unit, { write: false, start: true }, stopped)).toBe(true)
    expect(readFileSync(unit.path, 'utf8')).toBe(unit.text)
    expect(ask.asked).toEqual([`write it to ${unit.path}?`, 'start it now, and at every boot?'])
    expect(ask.ran).toEqual([START])
    expect(ask.said.join('\n')).toContain(LOG)
    expect(ask.said.join('\n')).toContain('`tade remote add` shows it all')
  })

  it('writes nothing and starts nothing when the answer is no', async () => {
    const unit = unitAt(tmp('tade-host-'))
    const ask = recorder([false])
    expect(await offerUnit(ask, unit, { write: false, start: true })).toBe(false)
    expect(existsSync(unit.path)).toBe(false)
    expect(ask.ran).toEqual([])
  })

  it('says one is there before replacing it, and leaves one that already says this alone', async () => {
    const unit = unitAt(tmp('tade-host-'))
    mkdirSync(join(unit.path, '..'), { recursive: true })
    writeFileSync(unit.path, '[Service]\nsomebody else’s\n')
    const ask = recorder([false])
    await offerUnit(ask, unit, { write: false, start: true })
    expect(ask.asked[0]).toContain('in place of the one there')
    expect(readFileSync(unit.path, 'utf8')).toContain('somebody else’s')

    writeFileSync(unit.path, unit.text)
    const again = recorder([false])
    await offerUnit(again, unit, { write: false, start: true })
    expect(again.said[0]).toContain('already says this')
    expect(again.asked).toEqual(['start it now, and at every boot?'])
  })

  it('with --write, writes without asking and says how to start it rather than starting it', async () => {
    const unit = unitAt(tmp('tade-host-'))
    const ask = recorder()
    await offerUnit(ask, unit, { write: true, start: true })
    expect(existsSync(unit.path)).toBe(true)
    expect(ask.asked).toEqual([])
    expect(ask.ran).toEqual([])
    expect(ask.said.join('\n')).toContain(START)
  })

  it('says where to look when starting it did not work', async () => {
    const unit = unitAt(tmp('tade-host-'))
    const ask = recorder([true, true], 1)
    await offerUnit(ask, unit, { write: false, start: true })
    expect(ask.ran).toEqual([START])
    expect(ask.said.at(-1)).toContain('journalctl --user -u tade.service')
  })

  it('never starts it while a window holds this home, which would only refuse it', async () => {
    writeFileSync(join(home, 'tade.lock'), String(process.pid))
    const unit = unitAt(tmp('tade-host-'))
    const ask = recorder([true, true])
    await offerUnit(ask, unit, { write: false, start: true }, stopped)
    expect(ask.ran).toEqual([])
    expect(ask.said.join('\n')).toContain(`a window has this home open (pid ${process.pid})`)
  })

  // An older Tade's unit ran the window in tmux, and that window holds the
  // home: restarting the service is what moves it onto the unit just written.
  it('restarts the service on it where what holds the home is the service itself', async () => {
    writeFileSync(join(home, 'tade.lock'), String(process.pid))
    const unit = unitAt(tmp('tade-host-'))
    const ask = recorder([true, true])
    const running = standing({ kind: 'ready', pid: process.pid, status: '' })
    await offerUnit(ask, unit, { write: false, start: true }, running)
    expect(ask.asked.at(-1)).toBe('restart the service on it now, and at every boot?')
    expect(ask.ran).toEqual([START])
  })

  it('from setup, never starts it: the window setup was opened for would be refused its home', async () => {
    const unit = unitAt(tmp('tade-host-'))
    const ask = recorder([true])
    await offerUnit(ask, unit, { write: false, start: false })
    expect(ask.ran).toEqual([])
    expect(ask.said.join('\n')).toContain('once setup is done')
  })
})

describe('linger', () => {
  const box = { user: 'you', linger: false, unit: null }

  it('shows the command, and runs it in a terminal on a press — sudo may ask for a password', async () => {
    const ask = recorder([true])
    await offerLinger(ask, box)
    expect(ask.said[0]).toContain('`sudo loginctl enable-linger you`')
    expect(ask.ran).toEqual(['sudo loginctl enable-linger you'])
    expect(ask.said.at(-1)).toContain('linger is on')
  })

  it('runs nothing when skipped, and says the command again', async () => {
    const ask = recorder([false])
    await offerLinger(ask, box)
    expect(ask.ran).toEqual([])
    expect(ask.said.at(-1)).toContain('sudo loginctl enable-linger you')
  })

  it('says so when it did not work', async () => {
    const ask = recorder([true], 1)
    await offerLinger(ask, box)
    expect(ask.said.at(-1)).toContain('that did not work')
  })
})

describe('whether the agents would outlive the service', () => {
  const driver = (name: string) =>
    writeFileSync(join(home, 'config.yaml'), `workspace:\n  driver: ${name}\n`)

  it('says so where the configured driver’s lanes are Tade’s own children', async () => {
    driver('pty')
    expect(await lanesWouldStop()).toContain('stop whenever the service does')
  })

  it('says nothing where they outlive Tade', async () => {
    driver('tmux')
    expect(await lanesWouldStop()).toBeNull()
  })

  it('cannot tell where the config does not read, rather than taking it for pty', async () => {
    driver('kitty')
    expect(await lanesWouldStop()).toContain('does not read (`tade config --check` says why)')
  })
})

describe('the unit for this machine', () => {
  it('runs `tade serve` with this Node and this Tade, on the PATH it carries', () => {
    const unit = unitHere({ PATH: '/opt/bin:/usr/bin', HOME: '/home/you', LANG: 'en_US.UTF-8' })
    expect(unit.text).toContain(`ExecStart=${process.execPath} `)
    expect(unit.text).toMatch(/bin\.[tj]s serve\n/)
    expect(unit.text).toContain('Environment=PATH=/opt/bin:/usr/bin')
    expect(unit.text).toContain('Environment=LANG=en_US.UTF-8')
    expect(unit.path).toBe('/home/you/.config/systemd/user/tade.service')
  })

  it('draws in UTF-8 whatever the shell was set to, and needs no tmux of its own', () => {
    const unit = unitHere({ PATH: '/nowhere', HOME: '/home/you', LANG: 'C' })
    expect(unit.text).toContain('Environment=LANG=C.UTF-8')
  })
})

describe('setting up a server', () => {
  it('offers linger first, then shows the whole unit before writing it', async () => {
    const config = tmp('tade-host-xdg-')
    const was = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = config
    try {
      const ask = recorder([false, true])
      await setUpUnattended(ask, { user: 'you', linger: false, unit: null })
      expect(ask.asked[0]).toBe('turn linger on?')
      const said = ask.said.join('\n')
      expect(said).toContain('  [Service]')
      expect(said).toContain('serve')
      expect(ask.asked[1]).toContain(join(config, 'systemd', 'user', SERVICE))
      expect(existsSync(join(config, 'systemd', 'user', SERVICE))).toBe(true)
      expect(ask.ran).toEqual([])
    } finally {
      if (was === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = was
    }
  })

  it('asks nothing about a unit that is already written, and says how to start one not running', async () => {
    const ask = recorder()
    await setUpUnattended(ask, { user: 'you', linger: true, unit: '/u/tade.service' })
    expect(ask.asked).toEqual([])
    const ready = recorder()
    const box = { user: 'you', linger: true, unit: '/u/tade.service' }
    await setUpUnattended(ready, { ...box, service: { kind: 'ready', pid: 1, status: '' } })
    expect(ready.asked).toEqual([])
    expect(ready.said.join('\n')).not.toContain('tade.service:')
    const down = recorder()
    await setUpUnattended(down, { ...box, service: { kind: 'stopped' } })
    expect(down.asked).toEqual([])
    expect(down.ran).toEqual([])
    expect(down.said.at(-1)).toBe(`  tade.service: it is not running: \`${START}\``)
  })

  it('offers this Tade’s unit in place of one that is wrong, shown whole first', async () => {
    const config = tmp('tade-host-xdg-')
    const was = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = config
    try {
      const at = join(config, 'systemd', 'user', SERVICE)
      mkdirSync(join(at, '..'), { recursive: true })
      writeFileSync(at, '[Service]\nExecStart=/usr/bin/tmux new-session /x/bin.ts app\n')
      const ask = recorder([true])
      await setUpUnattended(ask, {
        user: 'you',
        linger: true,
        unit: at,
        unitTrouble: 'is an older Tade’s, which runs the window in tmux',
      })
      const said = ask.said.join('\n')
      expect(said).toContain(`the unit at ${at} is an older Tade’s`)
      expect(said).toContain('  [Service]')
      expect(ask.asked).toEqual([`write it to ${at}, in place of the one there?`])
      expect(readFileSync(at, 'utf8')).toMatch(/bin\.[tj]s serve\n/)
      expect(ask.ran).toEqual([])
    } finally {
      if (was === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = was
    }
  })
})

describe('tade host service', () => {
  const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const dir = tmp('tade-host-cli-')
      const child = spawn(process.execPath, [bin, ...args], {
        env: { ...process.env, TADE_HOME: dir, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('exit', (code) => resolve({ code, stdout, stderr }))
    })

  it('prints the unit and nothing else on standard output, and writes nothing unasked', async () => {
    const result = await run(['host', 'service'])
    expect(result.stdout.startsWith('# Tade, kept running by your own service manager.')).toBe(true)
    expect(result.stdout).toContain('[Service]')
    expect(result.stdout).toContain('WantedBy=default.target')
    expect(result.code).toBe(0)
    if (systemdHere()) {
      expect(result.stderr).toContain('`tade host service --write` writes it to')
    } else {
      expect(result.stderr).toContain('systemd does not run this machine')
    }
  })
})

import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ui } from '@tade/app'
import {
  AGENT_USER,
  type AgentsHere,
  type AgentUserSeen,
  appArmorCommands,
  bwrapProfile,
  ConfigSchema,
} from '@tade/core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { agentsLooked, setUpAgents } from '../src/commands/setup-agents.ts'

// Setting up agents as a user of their own: offered on a Linux server and
// wherever the config names a user, every command said before it runs, a
// "no" running nothing and writing nothing, and a group not yet held said as
// the login it is rather than proved against.

function recorder(confirm: boolean[]): Ui & { said: string[]; ran: string[] } {
  const said: string[] = []
  const ran: string[] = []
  return {
    said,
    ran,
    say: (text: string) => said.push(text),
    context: () => {},
    ask: async (_q: string, fallback = '') => fallback,
    confirm: async (_q: string, fallback: boolean) => confirm.shift() ?? fallback,
    choose: async () => 0,
    pause: async () => {},
    async run(_title: string, _command: string, args: string[]) {
      ran.push(args[1] ?? '')
      return 0
    },
  }
}

let home: string
const before = process.env.TADE_HOME

beforeEach(() => {
  home = tmp('tade-agents-setup-')
  process.env.TADE_HOME = home
})

afterEach(() => {
  if (before === undefined) delete process.env.TADE_HOME
  else process.env.TADE_HOME = before
})

describe('where setting up asks who agents run as', () => {
  it('is a Linux server, or anywhere the config names a user, and nowhere else', async () => {
    const none = ConfigSchema.parse({})
    expect(await agentsLooked(none, home, true, 'darwin')).toBeNull()
    expect(await agentsLooked(none, home, false, 'linux')).toBeNull()
    expect(await agentsLooked(none, home, true, 'linux')).toMatchObject({ seen: [] })
    expect(await agentsLooked(null, home, true, 'linux')).toBeNull()
  })
})

describe('setting it up', () => {
  it('runs nothing and writes nothing when the answer is no', async () => {
    writeFileSync(join(home, 'config.yaml'), 'projects: {}\n')
    const ui = recorder([false])
    await setUpAgents(ui, { self: 'tade', seen: [] }, home, 'pty')
    expect(ui.ran).toEqual([])
    expect(ui.said.join('\n')).toContain('skipped — agents go on running as you')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain(AGENT_USER)
  })

  it('shows every command before running any, runs them on a press, and only then names the user', async () => {
    writeFileSync(join(home, 'config.yaml'), 'projects: {}\n')
    const ui = recorder([true, true])
    await setUpAgents(ui, { self: 'tade', seen: [] }, home, 'pty')
    expect(ui.ran[0]).toContain(
      `useradd --create-home --user-group --shell /bin/bash ${AGENT_USER}`,
    )
    // Every line was said before the first of them ran.
    expect(ui.ran.every((line) => ui.said.some((said) => said.includes(line)))).toBe(true)
    expect(ui.ran.some((line) => line.includes('visudo -cf'))).toBe(true)
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain(`user: ${AGENT_USER}`)
    expect(ui.said.join('\n')).toContain('pushes with its own credentials, never yours')
  })

  it('names no user when a command fails', async () => {
    writeFileSync(join(home, 'config.yaml'), 'projects: {}\n')
    const ui = recorder([true, true])
    ui.run = async () => 1
    await setUpAgents(ui, { self: 'tade', seen: [] }, home, 'pty')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain(AGENT_USER)
    expect(ui.said.join('\n')).toContain('that did not work')
  })

  it('says a group that is not held yet as a login away, rather than proving a lane that would fail', async () => {
    writeFileSync(join(home, 'config.yaml'), `agents:\n  user: ${AGENT_USER}\n`)
    const done: AgentUserSeen = {
      user: AGENT_USER,
      home: `/home/${AGENT_USER}`,
      inGroup: true,
      groupHeld: true,
      sudo: true,
      share: true,
      git: true,
      homeClosed: true,
      roots: [],
      sandboxes: [],
    }
    const ui = recorder([])
    await setUpAgents(ui, { self: 'tade', seen: [done] }, home, 'pty')
    expect(ui.ran).toEqual([])
    // Looked at again on this machine, which has no such user in its group.
    expect(ui.said.join('\n')).toContain(`is in ${AGENT_USER}'s group from your next login`)
  })
})

describe('a kernel that keeps bwrap from its namespaces', () => {
  // Ubuntu 24.04's AppArmor, stood in: a `bwrap` that fails until the reload
  // has run, a `socat`, and a `sudo` that becomes nobody new. The user is
  // `nobody`, which every machine's password file has, so the look after the
  // reload tries the sandbox as a user that is there, the way setup does.
  const PATH = process.env.PATH
  let bin: string
  let loaded: string
  beforeAll(() => {
    bin = tmp('tade-agents-bin-')
    loaded = join(bin, 'loaded')
    const stand = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    stand('sudo', 'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"')
    stand('bwrap', `[ -f ${loaded} ]`)
    stand('socat', 'exit 0')
    process.env.PATH = `${bin}:${PATH}`
  })
  afterAll(() => {
    process.env.PATH = PATH
  })

  const user = 'nobody'
  const done: AgentUserSeen = {
    user,
    home: '/nonexistent',
    inGroup: true,
    groupHeld: true,
    sudo: true,
    share: true,
    git: true,
    homeClosed: true,
    roots: [],
    sandboxes: [{ harness: 'claude-code', needs: 'an AppArmor profile for bwrap' }],
  }
  const apparmor = {
    restricted: true,
    profile: false,
    bwrap: '/usr/bin/bwrap',
    harnesses: ['claude-code'],
  }
  const here: AgentsHere = { self: 'tade', seen: [done], apparmor }
  const config = `agents:\n  user: ${user}\nworkers:\n  default: a\n  routes:\n    a:\n      harness: claude-code\n`
  const look = { platform: 'linux' as const, service: async () => [] }

  /** A setup screen whose reload makes bwrap start, or not, and which notes what was said before the first run. */
  function screen(confirm: boolean[], fixes: boolean) {
    const ui = recorder(confirm)
    let before: string[] | null = null
    ui.run = async (_title, _command, args) => {
      before ??= [...ui.said]
      const line = args[1] ?? ''
      ui.ran.push(line)
      if (fixes && line.includes('reload apparmor')) writeFileSync(loaded, '')
      return 0
    }
    return { ui, before: () => before ?? [] }
  }

  beforeEach(() => {
    writeFileSync(join(home, 'config.yaml'), config)
    // Not loaded until the reload says so.
    rmSync(loaded, { force: true })
  })

  it('shows Claude Code’s profile and where it goes before running anything, writes and loads it on a press, and proves the sandbox after', async () => {
    const { ui, before } = screen([true], true)
    await setUpAgents(ui, here, home, 'pty', look)
    const commands = appArmorCommands(apparmor)
    expect(ui.ran).toEqual(commands.map((one) => one.line))
    expect(ui.ran[0]).toContain('sudo tee /etc/apparmor.d/bwrap')
    expect(ui.ran[1]).toBe('sudo systemctl reload apparmor')
    // The file, where it goes and both commands were said before the first ran.
    const shown = before().join('\n')
    expect(shown).toContain("Claude Code's sandbox page gives bwrap an AppArmor profile")
    expect(shown).toContain('this goes in /etc/apparmor.d/bwrap')
    for (const line of bwrapProfile('/usr/bin/bwrap')) expect(shown).toContain(line)
    for (const one of commands) expect(shown).toContain(one.line)
    // Tried again as that user, after the reload.
    expect(ui.said).toContain(`  claude-code's own sandbox starts as ${user} now`)
  })

  it('says so where the sandbox still will not start after loading it', async () => {
    const { ui } = screen([true], false)
    await setUpAgents(ui, here, home, 'pty', look)
    expect(ui.ran).toHaveLength(2)
    expect(ui.said.join('\n')).toContain(
      `claude-code's own sandbox still will not start as ${user}: it needs bubblewrap and socat`,
    )
  })

  it('writes nothing and loads nothing when the answer is no', async () => {
    const { ui } = screen([false], true)
    await setUpAgents(ui, here, home, 'pty', look)
    expect(ui.ran).toEqual([])
    expect(ui.said.join('\n')).toContain(
      'skipped — until it is there the sandbox refuses every command',
    )
    expect(ui.said.join('\n')).not.toContain('starts as nobody now')
  })

  it('offers nothing where a profile is already there', async () => {
    const { ui } = screen([], true)
    const there = { ...here, apparmor: { ...apparmor, profile: true } }
    await setUpAgents(ui, there, home, 'pty', look)
    expect(ui.ran).toEqual([])
    expect(ui.said.join('\n')).not.toContain('/etc/apparmor.d/bwrap')
  })
})

describe('a service started before its user was put in the agents’ group', () => {
  it('says to restart what has to restart, with the command, rather than proving a lane setup’s own groups would pass', async () => {
    writeFileSync(join(home, 'config.yaml'), `agents:\n  user: ${AGENT_USER}\n`)
    const seen: AgentUserSeen = {
      user: AGENT_USER,
      home: `/home/${AGENT_USER}`,
      inGroup: true,
      groupHeld: true,
      sudo: true,
      share: true,
      git: true,
      homeClosed: true,
      roots: [],
      sandboxes: [],
    }
    const ui = recorder([])
    const asked: string[][] = []
    await setUpAgents(ui, { self: 'tade', seen: [seen] }, home, 'pty', {
      service: async (users) => {
        asked.push([...users])
        return [{ user: AGENT_USER, pid: 4242, held: false, manager: false, uid: 1000 }]
      },
    })
    expect(asked).toEqual([[AGENT_USER]])
    const said = ui.said.join('\n')
    expect(said).toContain(
      "Tade's service (pid 4242) started before tade was put in tade-agent's group",
    )
    expect(said).toContain('`sudo systemctl restart user@1000.service`')
    // Neither a login nor a lane is what it needs.
    expect(said).not.toContain('from your next login')
    expect(said).not.toContain('Opening a lane')
  })
})

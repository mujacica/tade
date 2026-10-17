import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ui } from '@tade/app'
import { AGENT_USER, type AgentUserSeen, ConfigSchema } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

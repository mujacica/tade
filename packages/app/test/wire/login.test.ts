import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CARRY_SCHEMA, ConfigSchema } from '@tade/core'
import type { CarryAnswer } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { actions, matchActions } from '../../src/commands.ts'
import { type AppState, initialState } from '../../src/model.ts'
import { talkTab } from '../../src/talk-tab.ts'
import { Carries, orchestratorSignedIn } from '../../src/wire/carry.ts'

// `/login` on the orchestrator's line. The orchestrator's harness runs
// headless, so its own TUI commands never reach it, and a `/login` handed to
// the model as a sentence is a model asked to sign itself in. So it is one of
// the window's commands: here, the harness's own sign-in in a terminal over
// the window (`Machine.logIn`, held in `machine.test.ts`); on another
// machine's tab, that machine's own, over its link — what is held here.

describe('/login, in the commands', () => {
  it('is listed, and says whose orchestrator it signs in by the tab it was typed on', () => {
    const here = initialState()
    expect(matchActions(here, '/log').map((one) => one.name)).toEqual(['/login'])
    expect(actions(here).find((one) => one.name === '/login')).toEqual({
      name: '/login',
      about: "sign the orchestrator in: its harness's own sign-in, in a terminal here",
      ready: true,
    })
    const there: AppState = { ...here, bottom: talkTab('ipax') }
    expect(actions(there).find((one) => one.name === '/login')?.about).toBe(
      "sign ipax's orchestrator in, on ipax, through its link",
    )
  })
})

/** A `Carries` over one remote called ipax, and everything it asked of the link and the screen. */
function carries(over: { link?: boolean; exit?: number } = {}) {
  const home = tmp('tade-login-')
  const configPath = join(home, 'config.yaml')
  writeFileSync(configPath, '')
  const opened: string[][] = []
  const ran: unknown[][] = []
  const said: string[] = []
  const answer: CarryAnswer = {
    schema: CARRY_SCHEMA,
    machine: 'ipax',
    settings: [],
    files: [],
    signIns: [],
  }
  const link = {
    call: async () => ({ status: 200, body: answer }),
    terminal: (_remote: unknown, words: string[]) => {
      opened.push(words)
      return { command: 'ssh', args: ['ipax', 'tade', ...words] }
    },
  }
  const subject = new Carries({
    home,
    configPath,
    config: () => ConfigSchema.parse({}),
    reach: () =>
      over.link === false
        ? null
        : { link: link as never, remote: { name: 'ipax' } as never, live: true },
    secrets: () => new Set(),
    from: () => 'mac',
    log: async () => {},
    fold: async () => {},
    lines: async () => [],
    found: async () => {},
    take: async () => {},
    conflicted: async () => {},
    onScreenWith: async (flow) => {
      await flow({
        say: () => {},
        run: async (...args: unknown[]) => {
          ran.push(args)
          return over.exit ?? 0
        },
      } as never)
    },
    said: () => {
      throw new Error('a /login is said where its line is, never on the Settings page')
    },
    say: (line) => said.push(line),
    draw: () => {},
    now: () => Date.now(),
  })
  return { subject, opened, ran, said }
}

describe('/login on another machine’s tab', () => {
  it('runs that machine’s own orchestrator sign-in there, read out of its own config', async () => {
    const { subject, opened, ran, said } = carries()
    await subject.signInOrchestrator('ipax')
    // Which harness and account is that machine's to say: nothing here names them.
    expect(opened).toEqual([['accounts', 'sign-in', '--orchestrator']])
    expect(ran).toEqual([
      [
        'orchestrator on ipax',
        'ssh',
        ['ipax', 'tade', 'accounts', 'sign-in', '--orchestrator'],
        {},
      ],
    ])
    expect(said).toEqual([orchestratorSignedIn('ipax', 0)])
  })

  it('says the command to run there where no link opens a terminal to it', async () => {
    const { subject, ran, said } = carries({ link: false })
    await subject.signInOrchestrator('ipax')
    expect(ran).toEqual([])
    expect(said).toEqual([
      'ipax cannot be signed in from here: run `tade accounts sign-in --orchestrator` there',
    ])
  })

  it('says a sign-in that did not finish, and what works on a Tade there older than this one', async () => {
    const { subject, said } = carries({ exit: 1 })
    await subject.signInOrchestrator('ipax')
    expect(said).toEqual([orchestratorSignedIn('ipax', 1)])
    expect(orchestratorSignedIn('ipax', 1)).toContain('run `tade accounts sign-in <harness>` there')
    expect(orchestratorSignedIn('ipax', 0)).toBe(
      'The sign-in on ipax finished: its orchestrator runs on it once it starts again there.',
    )
  })
})

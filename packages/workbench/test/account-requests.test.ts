import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountRequestsSpool } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  type AccountActs,
  accountDone,
  awaitAccount,
  requestAccount,
  takeAccountRequests,
} from '../src/account-requests.ts'

// What a terminal asks of the accounts while a window holds the home — `tade
// accounts add` beside a running `tade serve` — done by that window with the
// workbench's own acts, and answered back to the terminal. The CLI test beside
// `tade accounts` runs it end to end against a real workbench; this one holds
// the spool to its word with acts that only say what they were asked.

const QUICK = { takeMs: 200, doMs: 200, everyMs: 10 }

/** Acts that write down what they were asked, and refuse what `refuse` names. */
function acts(refuse?: string) {
  const asked: unknown[][] = []
  const tade: AccountActs = {
    addAccount: async (req) => {
      asked.push(['add', req])
      if (refuse === req.name) throw new Error(`there is already an account called ${req.name}`)
    },
    removeAccount: async (name) => {
      asked.push(['remove', name])
    },
    useAccount: async (harness, name, project) => {
      asked.push(['use', harness, name, project])
    },
    nameOwnSignIn: async (harness, name) => {
      asked.push(['name', harness, name])
      return name?.toLowerCase() ?? null
    },
  }
  return { tade, asked }
}

describe('an account asked of while a window holds the home', () => {
  it('is done by the window on its beat and answered to the terminal waiting', async () => {
    const home = tmp('tade-account-requests-')
    const { tade, asked } = acts()
    const id = await requestAccount(home, {
      do: 'add',
      harness: 'claude-code',
      name: 'Work',
      kind: 'subscription',
      share: true,
    })
    const waiting = awaitAccount(home, id, QUICK)
    expect(await takeAccountRequests(home, tade)).toEqual({ taken: 1, trouble: null })
    expect(await waiting).toEqual({ ok: true, named: 'work' })
    expect(asked).toEqual([
      ['add', { name: 'Work', harness: 'claude-code', kind: 'subscription', share: true }],
    ])
    // Nothing is left in the spool once the answer is read.
    expect(readdirSync(accountRequestsSpool(home))).toEqual([])
  })

  it('answers with why the window refused, which the terminal says', async () => {
    const home = tmp('tade-account-requests-')
    const id = await requestAccount(home, {
      do: 'add',
      harness: 'claude-code',
      name: 'work',
      kind: 'subscription',
      share: true,
    })
    const waiting = awaitAccount(home, id, QUICK)
    await takeAccountRequests(home, acts('work').tade)
    expect(await waiting).toEqual({
      ok: false,
      error: 'there is already an account called work',
    })
  })

  it('is taken back when no window takes it in time, so nothing is done later', async () => {
    const home = tmp('tade-account-requests-')
    const id = await requestAccount(home, { do: 'remove', name: 'work' })
    expect(await awaitAccount(home, id, QUICK)).toBe('untaken')
    const { tade, asked } = acts()
    expect(await takeAccountRequests(home, tade)).toEqual({ taken: 0, trouble: null })
    expect(asked).toEqual([])
  })

  it('answers a file it did not write with why, and does nothing it says', async () => {
    const home = tmp('tade-account-requests-')
    const spool = accountRequestsSpool(home)
    mkdirSync(spool, { recursive: true })
    // A request widened past what the command line takes is not one Tade wrote.
    writeFileSync(
      join(spool, '1-1-a.json'),
      JSON.stringify({ do: 'remove', name: 'work', and: 'more' }),
    )
    writeFileSync(join(spool, '2-1-b.json'), 'not json')
    const { tade, asked } = acts()
    expect(await takeAccountRequests(home, tade)).toEqual({ taken: 2, trouble: null })
    expect(asked).toEqual([])
    const answers = readdirSync(spool).sort()
    expect(answers).toEqual(['1-1-a.answer.json', '2-1-b.answer.json'])
    expect(await awaitAccount(home, '1-1-a', QUICK)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not the shape Tade writes'),
    })
    expect(await awaitAccount(home, '2-1-b', QUICK)).toMatchObject({
      ok: false,
      error: expect.stringContaining('not JSON'),
    })
  })

  it('costs one look at a folder where nothing was ever asked', async () => {
    const home = tmp('tade-account-requests-')
    expect(await takeAccountRequests(home, acts().tade)).toEqual({ taken: 0, trouble: null })
    expect(existsSync(accountRequestsSpool(home))).toBe(false)
  })

  it('is each of the workbench’s own acts, as the command line asks them', async () => {
    const { tade, asked } = acts()
    expect(await accountDone(tade, { do: 'remove', name: 'work' })).toBe('work')
    expect(
      await accountDone(tade, { do: 'use', harness: 'claude-code', account: null, project: 'app' }),
    ).toBeNull()
    // No account at all, with a project: the question given back to the machine.
    await accountDone(tade, { do: 'use', harness: 'claude-code', project: 'app' })
    expect(await accountDone(tade, { do: 'name', harness: 'claude-code', name: 'Sentry' })).toBe(
      'sentry',
    )
    expect(asked).toEqual([
      ['remove', 'work'],
      ['use', 'claude-code', null, 'app'],
      ['use', 'claude-code', undefined, 'app'],
      ['name', 'claude-code', 'Sentry'],
    ])
  })
})

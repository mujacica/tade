import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { harnessAccount } from '../src/accounts.ts'
import { Workbench } from '../src/workbench.ts'

// Accounts over a real workbench: named, made ready, chosen for new agents and
// for one agent, and taken away again. Every harness's own sign-in is looked
// for in a home made for the test, so nothing here reads or writes yours.

describe('accounts', () => {
  let home: string
  let client: Workbench
  let repo: ReturnType<typeof mkrepo>

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-accounts-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home, version: '9.9.9', harnessHome: tmp('tade-own-home-') })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  const config = () => parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8'))

  it('lists each harness’s own sign-in, and says why one cannot have more', async () => {
    const all = await client.accounts()
    const pi = all.find((one) => one.harness === 'pi')
    expect(pi).toMatchObject({ name: null, canAdd: false })
    expect(pi?.why).toContain('one set of sign-ins')
    expect(all.find((one) => one.harness === 'claude-code')).toMatchObject({
      name: null,
      canAdd: true,
      forNewAgents: true,
      canSignIn: true,
    })
    await expect(client.addAccount({ name: 'two', harness: 'pi' })).rejects.toThrow(
      /one set of sign-ins/,
    )
  })

  it('adds one, ready to sign in to, and has new agents use it when asked', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    expect(config().accounts.work).toEqual({
      harness: 'claude-code',
      kind: 'subscription',
      share: true,
    })
    const folder = join(home, 'accounts', 'work')
    expect(existsSync(join(folder, '.claude.json'))).toBe(true)
    // Its sign-in is Claude Code's own, pointed at its folder.
    expect(client.signInFor('claude-code', 'work').launch).toMatchObject({
      args: ['auth', 'login', '--claudeai'],
      env: { CLAUDE_CONFIG_DIR: folder },
    })

    await client.useAccount('claude-code', 'work')
    expect(config().workers.accounts['claude-code']).toBe('work')
    const claude = (await client.accounts()).filter((one) => one.harness === 'claude-code')
    expect(claude.map((one) => [one.name, one.forNewAgents])).toEqual([
      [null, false],
      ['work', true],
    ])

    await expect(client.useAccount('pi', 'work')).rejects.toThrow(/not a pi account/)
    await expect(client.addAccount({ name: 'work', harness: 'claude-code' })).rejects.toThrow(
      /already/,
    )
    await expect(client.addAccount({ name: 'Bad Name!', harness: 'claude-code' })).rejects.toThrow(
      /cannot name an account/,
    )
  })

  it('runs one task’s agent as another account, and only as one of its own harness', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: 'fix it' })
    // On pi, which has no second account: refused rather than half done.
    await expect(
      client.setAgentAccount({ task: task.id, worktree: task.worktree, account: 'work' }),
    ).rejects.toThrow(/not a pi account/)

    await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'claude-code' })
    const moved = await client.setAgentAccount({
      task: task.id,
      worktree: task.worktree,
      account: 'work',
    })
    expect(moved).toEqual({ account: 'work', restarted: false, carried: false })
    expect(await client.agentHarness(task.id, task.worktree)).toMatchObject({
      harness: 'claude-code',
      account: 'work',
    })
  })

  it('says what every account can report about its plan, and none of it as money', async () => {
    const usage = client.planUsage()
    const pi = usage.find((one) => one.harness === 'pi')
    // pi prices every turn and is never told what a plan has left: it says so,
    // in its own words, rather than being left out or reported as nothing used.
    expect(pi).toMatchObject({ account: null, can: 'none', said: null })
    expect(pi?.why).toContain('plan')
    // A fresh window has heard nothing from either subscription harness. That
    // is not zero used, and the declaration is what makes the difference
    // readable: it can say, and has not yet.
    for (const harness of ['claude-code', 'codex']) {
      const one = usage.find((source) => source.harness === harness)
      expect(one?.can).toBe('while-working')
      expect(one?.said).toBeNull()
      expect((one?.why ?? '').length).toBeGreaterThan(10)
    }
    // No money anywhere in it: a plan is a share of a window, and the two are
    // never added up.
    expect(JSON.stringify(usage)).not.toContain('usd')
  })

  it('reports an added account’s plan apart from its harness’s own sign-in', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: 'fix it' })
    await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'claude-code' })
    await client.setAgentAccount({ task: task.id, worktree: task.worktree, account: 'work' })
    const claude = client.planUsage().filter((one) => one.harness === 'claude-code')
    expect(claude.map((one) => one.account).sort()).toEqual([null, 'work'])
  })

  it('reports every sign-in there is, before anything has run as one', async () => {
    await client.addAccount({ name: 'reviews', harness: 'claude-code' })
    await client.addAccount({ name: 'paid', harness: 'codex', kind: 'api-key' })
    // Nothing has been started as either. An account that exists and has said
    // nothing is somewhere somebody could go when a plan is nearly gone, and an
    // absent row is one nobody can suggest.
    const usage = client.planUsage()
    expect(usage.map((one) => `${one.harness}${one.account ? `@${one.account}` : ''}`)).toEqual([
      'pi',
      'claude-code',
      'claude-code@reviews',
      'codex',
      'codex@paid',
    ])
    // What pays for each: the harness's own declaration, never the name. A
    // subscription is charged nothing per turn, which is the only kind of thing
    // a rolling window can be used up of; an API-key account is money instead.
    expect(usage.map((one) => one.pays)).toEqual(['per-token', 'plan', 'plan', 'plan', 'per-token'])
  })

  it('writes an API-key account’s key beside the account, and hands out a command', async () => {
    await client.addAccount({ name: 'paid', harness: 'claude-code', kind: 'api-key' })
    expect(client.saveAccountKey('paid', '  sk-ant-0123456789  ')).toBe('config.yaml')
    // In the config, next to the account it pays for, as it was typed.
    expect(config().accounts.paid.key).toBe('sk-ant-0123456789')
    // What the harness is given is still a command that prints it: a key in a
    // launch line is a key in the process table.
    const account = harnessAccount(client.config, home, 'paid')
    expect(account.key).toContain('print-secret.ts')
    expect(account.key).not.toContain('sk-ant')
    // And it goes when the account does, because it is one of its fields.
    await client.removeAccount('paid')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('sk-ant')
    expect(() => client.saveAccountKey('paid', 'sk-ant-other')).toThrow(/API key/)
  })

  it('takes one away, and nothing is left pointing at it', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    await client.useAccount('claude-code', 'work')
    await client.removeAccount('work')
    expect(config().accounts ?? {}).toEqual({})
    expect(config().workers?.accounts?.['claude-code']).toBeUndefined()
    expect(existsSync(join(home, 'accounts', 'work'))).toBe(false)
    await expect(client.removeAccount('work')).rejects.toThrow(/no account called work/)
  })
})

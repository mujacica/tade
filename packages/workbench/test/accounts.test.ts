import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type InstallersHere, type LaneId } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { harnessAccount, listAccounts } from '../src/accounts.ts'
import { HARNESS_ADAPTERS } from '../src/harnesses.ts'
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

  it('reads no conversation for a task no agent ran, as an empty page rather than a throw', async () => {
    const task = await client.createTask({ project: 'app', slug: 'quiet', intent: 'nothing yet' })
    expect(await client.agentHistory(task.id, { limit: 20 })).toEqual({ items: [], earlier: null })
    // And no answer to any call of it, rather than a throw.
    expect(await client.agentAnswer(task.id, 'call_1')).toBeNull()
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
    expect(moved).toEqual({ account: 'work', restarted: false, carried: false, ownName: null })
    expect(await client.agentHarness(task.id)).toMatchObject({
      harness: 'claude-code',
      account: 'work',
    })
  })

  it('remembers which account a project’s new agents run as, over the machine’s', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    await client.addAccount({ name: 'home', harness: 'claude-code' })
    await client.useAccount('claude-code', 'work')
    await client.useAccount('claude-code', 'home', 'app')
    expect(config().projects.app.accounts).toEqual({ 'claude-code': 'home' })
    // A task in the project starts there without anybody choosing for it.
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: 'fix it' })
    await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'claude-code' })
    expect((await client.agentHarness(task.id)).account).toBe('home')
    // Every surface reads the same answer: whose new agents run as which.
    const claude = (await client.accounts()).filter((one) => one.harness === 'claude-code')
    expect(claude.map((one) => [one.name, one.forNewAgents, one.projects])).toEqual([
      [null, false, []],
      ['work', true, []],
      ['home', false, ['app']],
    ])
    expect(client.planUsage().find((one) => one.account === 'home')?.uses).toEqual({
      newAgents: false,
      projects: ['app'],
    })
    // Its own sign-in is an answer of its own, over a machine on another.
    await client.useAccount('claude-code', null, 'app')
    expect(config().projects.app.accounts['claude-code']).toBe('default')
    expect((await client.agentHarness(task.id)).account).toBeNull()
    // And nothing said gives it back to the machine.
    await client.useAccount('claude-code', undefined, 'app')
    expect(config().projects.app.accounts?.['claude-code']).toBeUndefined()
    expect((await client.agentHarness(task.id)).account).toBe('work')
    await expect(client.useAccount('claude-code', 'home', 'ghost')).rejects.toThrow(/no project/)
    const lines = (await client.events({ types: ['config_changed'] })).map(({ detail }) => detail)
    expect(lines.filter((one) => String(one.path).startsWith('projects.'))).toEqual([
      { path: 'projects.app.accounts.claude-code', was: '', now: 'home', by: 'window' },
      { path: 'projects.app.accounts.claude-code', was: 'home', now: 'default', by: 'window' },
      { path: 'projects.app.accounts.claude-code', was: 'default', now: '', by: 'window' },
    ])
  })

  it('brings an agent that has run back on the account its conversation is in, after a switch', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    await client.addAccount({ name: 'home', harness: 'claude-code' })
    await client.useAccount('claude-code', 'work', 'app')
    const task = await client.createTask({ project: 'app', slug: 'ran', intent: 'fix it' })
    await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'claude-code' })
    // Its agent ran as work and is gone — closed with Tade, or finished a turn
    // — and its lane's record is what is left of where it ran.
    await client.spawn({
      id: `${task.id}/agent` as LaneId,
      task: task.id,
      kind: 'agent',
      cwd: task.worktree,
      command: 'true',
      args: [],
      harness: 'claude-code',
      account: 'work',
    })
    await client.useAccount('claude-code', 'home', 'app')
    // The switch is for new agents: this one goes back where its conversation is.
    expect((await client.agentHarness(task.id)).account).toBe('work')
    // A new task in the project is a new agent, and starts on the switch.
    const next = await client.createTask({ project: 'app', slug: 'next', intent: 'fix it' })
    await client.setAgentHarness({ task: next.id, worktree: next.worktree, harness: 'claude-code' })
    expect((await client.agentHarness(next.id)).account).toBe('home')
    // What somebody chose for the task itself is over both.
    await client.setAgentAccount({ task: task.id, worktree: task.worktree, account: null })
    expect((await client.agentHarness(task.id)).account).toBeNull()
  })

  it('calls a harness’s own sign-in by a name, and takes that name as the own sign-in wherever one is chosen', async () => {
    await client.addAccount({ name: 'personal', harness: 'claude-code' })
    expect(await client.nameOwnSignIn('claude-code', ' Sentry ')).toBe('sentry')
    expect(config().workers.default_names).toEqual({ 'claude-code': 'sentry' })
    // Shown by it, and still the own sign-in underneath: no folder, no account.
    const claude = (await client.accounts()).filter((one) => one.harness === 'claude-code')
    expect(claude.map((one) => [one.name, one.ownName])).toEqual([
      [null, 'sentry'],
      ['personal', null],
    ])
    expect(config().accounts.sentry).toBeUndefined()
    expect(existsSync(join(home, 'accounts', 'sentry'))).toBe(false)
    expect(client.planUsage().find((one) => one.harness === 'claude-code')).toMatchObject({
      account: null,
      ownName: 'sentry',
    })
    // Chosen by it: written as the own sign-in, so a later name strands nothing.
    await client.useAccount('claude-code', 'personal')
    await client.useAccount('claude-code', 'sentry')
    expect(config().workers.accounts?.['claude-code']).toBeUndefined()
    await client.useAccount('claude-code', 'sentry', 'app')
    expect(config().projects.app.accounts['claude-code']).toBe('default')
    const task = await client.createTask({ project: 'app', slug: 'named', intent: 'fix it' })
    await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'claude-code' })
    await client.setAgentAccount({ task: task.id, worktree: task.worktree, account: 'personal' })
    const back = await client.setAgentAccount({
      task: task.id,
      worktree: task.worktree,
      account: 'sentry',
    })
    expect(back.account).toBeNull()
    // Said back by the name it was given, rather than as "its own sign-in".
    expect(back.ownName).toBe('sentry')
    expect((await client.agentHarness(task.id)).account).toBeNull()
    // One name is one sign-in, either way round.
    await expect(client.addAccount({ name: 'sentry', harness: 'claude-code' })).rejects.toThrow(
      /own sign-in is called/,
    )
    await expect(client.nameOwnSignIn('claude-code', 'personal')).rejects.toThrow(
      /already a claude-code account/,
    )
    await expect(client.nameOwnSignIn('claude-code', 'Not A Name!')).rejects.toThrow(
      /cannot name a sign-in/,
    )
    await expect(client.nameOwnSignIn('clod', 'x')).rejects.toThrow(/no harness called clod/)
    // And no name takes it away.
    expect(await client.nameOwnSignIn('claude-code', null)).toBeNull()
    expect(config().workers.default_names?.['claude-code']).toBeUndefined()
  })

  it('keeps a task on its own sign-in when one is chosen for it, whatever new agents use', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    await client.useAccount('claude-code', 'work')
    const task = await client.createTask({ project: 'app', slug: 'mine', intent: 'fix it' })
    await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'claude-code' })
    expect((await client.agentHarness(task.id)).account).toBe('work')
    await client.setAgentAccount({ task: task.id, worktree: task.worktree, account: null })
    expect((await client.agentHarness(task.id)).account).toBeNull()
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
    // readable: it can say, and has not yet — Claude Code only as its agents
    // reply, which it says in its own words, and Codex whenever it is asked.
    const claude = usage.find((source) => source.harness === 'claude-code')
    expect(claude?.can).toBe('while-working')
    expect(claude?.said).toBeNull()
    expect((claude?.why ?? '').length).toBeGreaterThan(10)
    const codex = usage.find((source) => source.harness === 'codex')
    expect(codex?.can).toBe('anytime')
    expect(codex?.said).toBeNull()
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
      'acp',
    ])
    // What pays for each: the harness's own declaration, never the name. A
    // subscription is charged nothing per turn, which is the only kind of thing
    // a rolling window can be used up of; an API-key account is money instead.
    expect(usage.map((one) => one.pays)).toEqual([
      'per-token',
      'plan',
      'plan',
      'plan',
      'per-token',
      'per-token',
    ])
  })

  it('writes an API-key account’s key beside the account, and hands out a command', async () => {
    await client.addAccount({ name: 'paid', harness: 'claude-code', kind: 'api-key' })
    expect(await client.saveAccountKey('paid', '  sk-ant-0123456789  ')).toBe('config.yaml')
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
    await expect(client.saveAccountKey('paid', 'sk-ant-other')).rejects.toThrow(/API key/)
  })

  it('writes every change it makes to the config down, by the window, and never the key', async () => {
    await client.addAccount({ name: 'paid', harness: 'claude-code', kind: 'api-key' })
    await client.saveAccountKey('paid', '  sk-ant-0123456789  ')
    await client.useAccount('claude-code', 'paid')
    await client.saveAccountKey('paid', '')
    await client.removeAccount('paid')
    const lines = (await client.events({ types: ['config_changed'] })).map(({ detail }) => detail)
    // What it was, what it is and who asked: what makes a change somebody was
    // not watching one they can find and undo. A key only as whether there is one.
    expect(lines).toEqual([
      { path: 'accounts.paid', was: '', now: 'set', by: 'window' },
      { path: 'accounts.paid.key', was: 'not set', now: 'set', by: 'window' },
      { path: 'workers.accounts.claude-code', was: '', now: 'paid', by: 'window' },
      { path: 'accounts.paid.key', was: 'set', now: 'not set', by: 'window' },
      { path: 'workers.accounts.claude-code', was: 'paid', now: '', by: 'window' },
      { path: 'accounts.paid', was: 'set', now: '', by: 'window' },
    ])
    expect(JSON.stringify(await client.events())).not.toContain('sk-ant')
    // A key saved again as it is changes nothing, and says nothing.
    await client.addAccount({ name: 'again', harness: 'claude-code', kind: 'api-key' })
    await client.saveAccountKey('again', 'sk-ant-same')
    await client.saveAccountKey('again', 'sk-ant-same')
    const keyLines = (await client.events({ types: ['config_changed'] })).filter(
      ({ detail }) => detail.path === 'accounts.again.key',
    )
    expect(keyLines).toHaveLength(1)
  })

  it('takes one away, and nothing is left pointing at it', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    await client.useAccount('claude-code', 'work')
    await client.useAccount('claude-code', 'work', 'app')
    await client.removeAccount('work')
    expect(config().accounts ?? {}).toEqual({})
    expect(config().workers?.accounts?.['claude-code']).toBeUndefined()
    expect(config().projects.app.accounts?.['claude-code']).toBeUndefined()
    expect(existsSync(join(home, 'accounts', 'work'))).toBe(false)
    await expect(client.removeAccount('work')).rejects.toThrow(/no account called work/)
  })

  it('says which sign-in the orchestrator runs as, and keeps that one until it is moved', async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    client.config = ConfigSchema.parse({
      ...config(),
      orchestrator: { harness: 'claude-code', account: 'work' },
    })
    const all = await client.accounts()
    expect(
      all
        .filter((one) => one.harness === 'claude-code')
        .map((one) => [one.name, one.forOrchestrator]),
    ).toEqual([
      [null, false],
      ['work', true],
    ])
    // Not a harness it talks through, so none of its sign-ins is one to move to.
    expect(all.find((one) => one.harness === 'pi')?.forOrchestrator).toBeNull()
    // Its conversation is in that folder, in another process.
    await expect(client.removeAccount('work')).rejects.toThrow(/the orchestrator runs as work/)
    expect(existsSync(join(home, 'accounts', 'work'))).toBe(true)
  })
})

describe('a harness that is not installed, on the Accounts page', () => {
  // "Claude Code is not installed" with nothing beside it was what Settings ›
  // Accounts and `tade accounts` said: setup's harness lines had the install
  // line, and the Accounts surfaces did not. Asked on a PATH with nothing on
  // it, against each kind of machine.
  const own = tmp('tade-accounts-install-')
  const env = { PATH: tmp('tade-empty-path-'), HOME: own }
  const config = ConfigSchema.parse({ accounts: { work: { harness: 'claude-code' } } })
  const views = (machine: InstallersHere) =>
    listAccounts(config, {
      adapterFor: (harness) => {
        const make = HARNESS_ADAPTERS[harness]
        if (!make) throw new Error(`no harness called ${harness}`)
        return make({ runDir: own, socketDir: own, approvals: 'bypass', home: own, env })
      },
      env,
      machine,
    })
  const claude = async (machine: InstallersHere) =>
    (await views(machine)).filter((one) => one.harness === 'claude-code')

  it('says this machine’s line on a Mac, and on a server', async () => {
    for (const machine of [
      { platform: 'darwin', managers: ['brew', 'npm'] },
      { platform: 'linux', managers: ['apt-get', 'npm'] },
    ]) {
      const [mine] = await claude(machine)
      expect(mine?.status.signedIn).toBe(false)
      expect(mine?.install).toEqual({ command: 'npm install --global @anthropic-ai/claude-code' })
    }
  })

  it('says plainly why there is nothing to run where this machine cannot', async () => {
    const [mine] = await claude({ platform: 'linux', managers: ['dnf'] })
    expect(mine?.install).toEqual({
      cannot: 'it installs with npm, and this machine has not got it',
    })
  })

  it('says it once, on the harness’s own row, and never where the program is here', async () => {
    const all = await views({ platform: 'darwin', managers: ['brew', 'npm'] })
    // An added account is the same program, already said on its harness's row.
    expect(all.find((one) => one.name === 'work')?.install).toBeNull()
    // pi ships with Tade, so it is here; acp is several programs and none of them is it.
    expect(all.find((one) => one.harness === 'pi')?.install).toBeNull()
    expect(all.find((one) => one.harness === 'acp')?.install).toBeNull()
  })
})

describe('a harness made the way the workbench is told', () => {
  it('answers for its own sign-in and for an account added beside it', async () => {
    const repo = mkrepo()
    const home = tmp('tade-accounts-made-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const make = HARNESS_ADAPTERS['claude-code']
    if (!make) throw new Error('no claude-code in the registry')
    const asked: string[] = []
    const client = await Workbench.open({
      home,
      harnessHome: tmp('tade-own-home-'),
      harnesses: {
        // The real adapter, asking nobody: an added account's is made the
        // first time it is needed, and must be made this way too.
        'claude-code': (opts) => {
          const adapter = make(opts)
          adapter.account = async () => {
            asked.push(opts.account?.name ?? 'own')
            return {
              signedIn: true,
              who: 'made@example.com',
              plan: null,
              method: null,
              problem: null,
            }
          }
          return adapter
        },
      },
    })
    try {
      await client.addAccount({ name: 'work', harness: 'claude-code' })
      const rows = (await client.accounts()).filter((one) => one.harness === 'claude-code')
      expect(rows.map((one) => [one.name, one.status.who])).toEqual([
        [null, 'made@example.com'],
        ['work', 'made@example.com'],
      ])
      expect(asked.sort()).toEqual(['own', 'work'])
      // Every other harness is still the registry's.
      expect((await client.accounts()).some((one) => one.harness === 'codex')).toBe(true)
    } finally {
      await client.close()
    }
  })
})

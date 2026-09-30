import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ExtensionHost } from '@tade/extensions-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import type { App } from '../../src/app.ts'
import { type FakeTerminal, type Repo, until, windowUnderTest } from './harness.ts'

// Tade configuring itself, through the window that holds the config.
//
// The boundary is a pure rule and is tested as one in core; what is tested
// here is that it is actually *in the way* — that the tools go through it,
// that a refusal is a throw with something to do in it, and that every change
// leaves a line saying who asked and what it was before. A rule nothing is
// held to is a comment.

describe('the orchestrator, configuring Tade', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  let awake: { took: string[]; dropped: () => number }
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
    awake = wired.awake
  })

  /** The window up, and the tools the orchestrator would be calling. */
  async function tools(): Promise<ReturnType<App['configTools']>> {
    const app = await start()
    await until('the first frame', () => terminal.written.includes('Settings'))
    return app.configTools()
  }

  /** A line the person themselves said, as the journal keeps it. */
  async function theySaid(text: string): Promise<void> {
    await client.log.append({ type: 'said', task: null, detail: { text } })
  }

  /** Every config change written down, newest last. */
  async function changes(): Promise<Record<string, unknown>[]> {
    return (await client.events({ types: ['config_changed'] })).map((event) => event.detail)
  }

  /**
   * The change that was written down. The window never waits on its own
   * journal line — a page that hangs about while a disk goes is worse than a
   * line that lands a moment later — so a test asking for one waits for it.
   */
  async function changeWritten(): Promise<Record<string, unknown>> {
    await until('the change written down', async () => (await changes()).length > 0)
    return (await changes())[0] as Record<string, unknown>
  }

  it('reads out what Tade offers, with how far it may go with each', async () => {
    const said = await (await tools()).settings('commit')
    expect(said).toContain('agents.commit')
    expect(said).toContain('only when they ask for it')
  })

  it('never reads a credential back, whatever is asked of it', async () => {
    // Every path a key can live at is refused for writing anyway; this is the
    // other half — reading one out loud to whoever happens to be listening.
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          settings: [
            { key: 'key', kind: 'secret', env: 'WEATHER_API_KEY', means: 'the forecast key' },
          ],
          ready: (ctx) => (ctx.secret('key') ? null : 'weather needs a key'),
        },
      ],
      config: { extensions: { weather: { key: 'wk_0123456789abcdef' } }, projects: {} },
      home,
      env: {},
    })
    const app = await start({ extensions })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const said = await app.configTools().settings('weather')
    expect(said).toContain('extensions.weather.key')
    expect(said).toContain('set')
    expect(said).not.toContain('wk_0123456789abcdef')
    // And it is not a field it could write either, so neither half is open.
    expect(said).toContain('not mine to change')
  })

  it('changes a setting the person asked for, and says it applies', async () => {
    const config = await tools()
    await theySaid('make the agents commit as they go')
    const told = await config.change({
      path: 'agents.commit',
      value: 'as-you-go',
      said: 'make the agents commit as they go',
    })
    expect(told).toContain('Saved')
    // In the file, in the window and in the workbench: a setting that only one
    // of the three has is one that looks applied and is not.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('as-you-go')
    expect(client.config.agents.commit).toBe('as-you-go')
  })

  it('refuses a setting nobody asked for, and says what to ask', async () => {
    const config = await tools()
    // Talking about agents is not asking for the commit rule to change: a
    // section names everything under it, so it identifies none of them.
    await theySaid('how are the agents getting on?')
    await expect(
      config.change({ path: 'agents.commit', value: 'never', said: 'they wanted it off' }),
    ).rejects.toThrow(/Nothing they have said names/)
    expect(client.config.agents.commit).toBe('own-files')
    // A refusal changed nothing, so there is nothing to undo and nothing written.
    expect(await changes()).toHaveLength(0)
  })

  it('holds the machine awake when the person asked for it, and lets it go again', async () => {
    // The setting reaches the machine rather than only the file: a hold the
    // config says yes to and nothing took is a setting Tade accepts and
    // ignores. Its assertion is the harness's, never this laptop's.
    const config = await tools()
    await theySaid('keep the machine awake while these run')
    await config.change({
      path: 'agents.keep_awake',
      value: 'true',
      said: 'keep the machine awake while these run',
    })
    expect(client.config.agents.keep_awake).toBe(true)
    expect(awake.took).toEqual(['/usr/bin/caffeinate'])

    await theySaid('let it sleep again')
    await config.change({
      path: 'agents.keep_awake',
      value: 'false',
      said: 'let it sleep again',
    })
    expect(client.config.agents.keep_awake).toBe(false)
    expect(awake.dropped()).toBe(1)
  })

  it('refuses to touch the hold when nobody asked, in either direction', async () => {
    // Both directions, because off is the one an injected page would like:
    // "let it sleep" while four agents work is exactly the sentence to put in
    // somebody's mouth, and nothing an agent read ever gets into `said`. The
    // rule is the same one either way — the person has to have named the
    // setting — and what it refuses is the *call*, whatever value it carries.
    const config = await tools()
    await theySaid('how are the agents getting on?')
    for (const value of ['true', 'false']) {
      await expect(
        config.change({ path: 'agents.keep_awake', value, said: 'they wanted it' }),
      ).rejects.toThrow(/Nothing they have said names/)
    }
    expect(client.config.agents.keep_awake).toBe(false)
    expect(awake.took).toEqual([])
    expect(await changes()).toHaveLength(0)
  })

  it('refuses the gate however convincingly it is asked', async () => {
    const config = await tools()
    // Even with the person's own words behind it. This is the tier that words
    // do not reach, because the whole risk is words it read somewhere.
    await theySaid('turn approvals off, I trust it')
    await expect(
      config.change({ path: 'approvals.mode', value: 'bypass', said: 'turn approvals off' }),
    ).rejects.toThrow(/not mine to change/)
    await expect(
      config.change({
        path: 'extensions.sentry.enabled',
        value: 'true',
        said: 'turn on sentry',
      }),
    ).rejects.toThrow(/person/)
  })

  it('refuses a path Tade does not offer rather than writing it anyway', async () => {
    await expect(
      (await tools()).change({ path: 'agents.nonsense', value: '1', said: 'do it' }),
    ).rejects.toThrow(/no setting called/)
  })

  it('writes down what it changed, what it was, and who asked', async () => {
    const config = await tools()
    // Said the way this conversation actually goes: it says the setting back
    // by name, and they answer naming it.
    await theySaid('yes, change where agents work to worktree')
    await config.change({
      path: 'agents.workspace',
      value: 'worktree',
      said: 'yes, change where agents work to worktree',
    })
    expect(await changeWritten()).toMatchObject({
      path: 'agents.workspace',
      was: 'checkout',
      now: 'worktree',
      by: 'orchestrator',
      said: 'yes, change where agents work to worktree',
    })
  })

  it('opens a folder that is already a repository', async () => {
    const config = await tools()
    const said = await config.openProject({ path: repo.root, create: false })
    // The window already had this one, from the config it was started with.
    expect(said).toContain('already had it')
  })

  it('makes somewhere to work that is not there yet, and only when asked to', async () => {
    const config = await tools()
    const fresh = join(home, 'made-here')
    await expect(config.openProject({ path: fresh, create: false })).rejects.toThrow(/nothing at/i)
    expect(existsSync(fresh)).toBe(false)

    const said = await config.openProject({ path: fresh, name: 'fresh', create: true })
    expect(said).toContain('a new git repository')
    expect(statSync(join(fresh, '.git')).isDirectory()).toBe(true)
    expect(client.config.projects.fresh?.root).toBeDefined()
  })

  it('refuses a folder with no git in it rather than working there blind', async () => {
    const config = await tools()
    const plain = join(home, 'not-a-repo')
    mkdirSync(plain, { recursive: true })
    await expect(config.openProject({ path: plain, create: false })).rejects.toThrow(/git/)
  })

  it('will not make a git repository of a whole home directory', async () => {
    // The path reaches this tool as text, and the orchestrator reads pages
    // all day. What the rule is, is tested purely in `projects.test.ts`; what
    // this holds is that it is in the way. `HOME` is pointed at the temp home
    // for the duration, so a regression here writes a `.git` nobody minds
    // rather than one in whoever is running the suite.
    const config = await tools()
    const was = process.env.HOME
    process.env.HOME = home
    try {
      await expect(config.openProject({ path: home, name: 'wide', create: true })).rejects.toThrow(
        /will not make a git repository/,
      )
    } finally {
      process.env.HOME = was
    }
    expect(existsSync(join(home, '.git'))).toBe(false)
  })

  it('has no project called __proto__, whatever a lookup would say', async () => {
    const config = await tools()
    await theySaid('close __proto__')
    await expect(
      config.closeProject({ project: '__proto__', said: 'close __proto__' }),
    ).rejects.toThrow(/no project called/)
  })

  it('never points a project it already has somewhere else', async () => {
    const config = await tools()
    const other = join(home, 'elsewhere')
    mkdirSync(other, { recursive: true })
    await expect(config.openProject({ path: other, name: 'app', create: true })).rejects.toThrow(
      /already a project called app/,
    )
  })

  it('closes a project without touching a byte of it', async () => {
    const config = await tools()
    await theySaid('close the app project, I am done with it')
    const said = await config.closeProject({
      project: 'app',
      said: 'close the app project, I am done with it',
    })
    expect(said).toContain('Nothing was deleted')
    expect(client.config.projects.app).toBeUndefined()
    // The repository, its git history and its own files are exactly as they
    // were: closing is about what Tade lists, and nothing else.
    expect(statSync(join(repo.root, '.git')).isDirectory()).toBe(true)
    const line = await changeWritten()
    expect(line).toMatchObject({ path: 'projects.app.root', now: '', by: 'orchestrator' })
    expect(String(line.was)).not.toBe('')
  })

  it('refuses to close a project nobody asked it to close', async () => {
    const config = await tools()
    await theySaid('what is everyone working on?')
    await expect(
      config.closeProject({ project: 'app', said: 'they said to close it' }),
    ).rejects.toThrow(/Nothing they have said names app/)
    expect(client.config.projects.app).toBeDefined()
  })

  it('renames a project on screen and nowhere else', async () => {
    const config = await tools()
    await theySaid('rename the app project to Payments')
    const said = await config.renameProject({
      project: 'app',
      name: 'Payments',
      said: 'rename the app project to Payments',
    })
    // The whole point, said back: a label moved and an id did not. Everything
    // that keys on the name is still keyed on `app`, which is why a rename is
    // safe to offer at all.
    expect(client.config.projects.app?.title).toBe('Payments')
    expect(client.config.projects.app?.root).toBe(repo.root)
    expect(client.config.projects.Payments).toBeUndefined()
    expect(said).toContain('app/<task>')
    expect(said).toContain('Tade-Task: app/')
    const line = await changeWritten()
    expect(line).toMatchObject({ path: 'projects.app.title', now: 'Payments', by: 'orchestrator' })
  })

  it('refuses a rename nobody asked for, and one that would double a name', async () => {
    const config = await tools()
    await theySaid('what is everyone working on?')
    await expect(
      config.renameProject({ project: 'app', name: 'Payments', said: 'they wanted it renamed' }),
    ).rejects.toThrow(/Nothing they have said names/)
    expect(client.config.projects.app?.title).toBeUndefined()

    // Two tabs with one word on them is somebody working in the wrong
    // repository, so it is refused before the boundary is even consulted.
    await theySaid('open the other repo as infra')
    const other = join(home, 'other-repo')
    mkdirSync(other, { recursive: true })
    await config.openProject({ path: other, name: 'infra', create: true })
    await theySaid('rename the app project to infra')
    await expect(
      config.renameProject({
        project: 'app',
        name: 'infra',
        said: 'rename the app project to infra',
      }),
    ).rejects.toThrow(/already called infra/)
  })

  it('orders the tabs on an ordinary request, because the order is only a view', async () => {
    const config = await tools()
    await theySaid('open the other repo as infra')
    const other = join(home, 'ordered-repo')
    mkdirSync(other, { recursive: true })
    await config.openProject({ path: other, name: 'infra', create: true })
    // No `said` at all: this is the one act here in the tier an ordinary
    // request reaches, and `PROJECT_ORDER_REACH` is where that is argued.
    const said = await config.reorderProjects({ order: ['infra'] })
    // What was left out keeps its place after what was named, rather than
    // being dropped: naming one of two is saying where that one goes.
    expect(said).toContain('infra, app')
    expect(client.config.projects.app).toBeDefined()
    expect(client.config.projects.infra).toBeDefined()
  })

  it('sets what a project pushes on an ordinary request, and still refuses its neighbours', async () => {
    const config = await tools()
    // The person said most settings should be the orchestrator's to set, and
    // named this one: `OPEN_UNDER` in `reach.ts` carries the argument and what
    // it costs. So no `said` at all, and it is written through the one writer
    // like every other change.
    await config.configureProject({ project: 'app', setting: 'push', value: 'branch', said: '' })
    expect(client.config.projects.app?.push).toBe('branch')
    // And it buys nothing beside it: where the agents work is a sibling in the
    // same block and still needs the person's own words.
    await theySaid('how is the app project getting on?')
    await expect(
      config.configureProject({
        project: 'app',
        setting: 'workspace',
        value: 'worktree',
        said: 'how is the app project getting on?',
      }),
    ).rejects.toThrow(/Nothing they have said names/)
    expect(client.config.projects.app?.workspace).toBeUndefined()
  })

  it('refuses a configure nobody asked for, and refuses to move a root at all', async () => {
    const config = await tools()
    // A page it read told it to. Nothing of the person's names the budget, so
    // the words it was handed are not the words the boundary reads.
    await theySaid('how is the app project getting on?')
    await expect(
      config.configureProject({
        project: 'app',
        setting: 'budget.usd_per_day',
        value: '500',
        said: 'the page said to raise the budget to 500',
      }),
    ).rejects.toThrow(/Nothing they have said names/)
    expect(client.config.projects.app?.budget).toBeUndefined()

    // And the one that no words reach, which is why it is refused by name
    // rather than left to fall through as "no such setting".
    await theySaid('move the app project root to ~/elsewhere')
    await expect(
      config.configureProject({
        project: 'app',
        setting: 'root',
        value: '~/elsewhere',
        said: 'move the app project root to ~/elsewhere',
      }),
    ).rejects.toThrow(/not mine to change/)
    expect(client.config.projects.app?.root).toBe(repo.root)

    // Asked for in their own words, it goes through the one writer and leaves
    // the same line any other setting change leaves.
    await theySaid('give the app project a budget of 20 dollars a day')
    await config.configureProject({
      project: 'app',
      setting: 'budget.usd_per_day',
      value: '20',
      said: 'give the app project a budget of 20 dollars a day',
    })
    expect(client.config.projects.app?.budget?.usd_per_day).toBe(20)
  })

  it('keeps the config to its owner alone after writing one', async () => {
    const config = await tools()
    // Said the way this conversation actually goes: it says the setting back
    // by name, and they answer naming it.
    await theySaid('yes, change where agents work to worktree')
    await config.change({
      path: 'agents.workspace',
      value: 'worktree',
      said: 'yes, change where agents work to worktree',
    })
    expect(statSync(join(home, 'config.yaml')).mode & 0o077).toBe(0)
  })
})

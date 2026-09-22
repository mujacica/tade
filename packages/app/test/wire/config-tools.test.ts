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
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
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

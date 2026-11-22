import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigSchema, machineLabel } from '@tade/core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { makeScriptedLink, type ScriptedRemote } from '@tade/remotes-scripted'
import type { Workbench } from '@tade/workbench'
import { readTaskFile } from '@tade/workbench/tasks'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { App } from '../../src/app.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

// Queued work started on another machine instead,
// through the whole window: "Start on vps" on its card where vps holds the
// same repository as a project, the work handed there over the owner channel
// with the person's words and its context, and gone from this queue — and
// the orchestrator's `tade_task_move`, held to a line of theirs naming the
// machine. The far end is a real away view (`far.ts`) answering where its work
// is with a real clone of this repository, over the scripted link.

const REPOSITORY = 'git@github.com:acme/app.git'
const TOMORROW = new Date(Date.now() + 24 * 3_600_000).toISOString()

describe('queued work, started on another machine instead', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let home: string
  let repo: Repo
  const fars: FarEnd[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
    client = one.client
    home = one.home
    repo = one.repo
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  const rows = () => screenOf(terminal.written)
  const shown = (text: string) => rows().some((row) => row.includes(text))

  /** The window linked to `vps`, whose project `tade` is a clone of this checkout. */
  async function linked(over: { client?: Workbench } = {}): Promise<{ far: FarEnd; window: App }> {
    repo.git('remote', 'add', 'origin', REPOSITORY)
    const there = join(tmp('tade-there-'), 'repo')
    runGit(repo.root, 'clone', '-q', repo.root, there)
    const far = await startFarEnd({ projects: ['tade'] })
    fars.push(far)
    far.show(['tade'])
    far.repositories = [
      {
        project: 'tade',
        root: there,
        repository: 'github.com/acme/app',
        base: 'main',
        branches: [],
      },
    ]
    const session = await far.pair('mac')
    const vps = {
      ssh: 'vps',
      tade: 'tade',
      device: session.device,
      session: session.cookie,
      csrf: session.csrf,
      host: session.host,
    }
    terminal.rows = 50
    terminal.columns = 160
    const table = new Map<string, ScriptedRemote>([['vps', far]])
    const window = await wired.start({
      ...over,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } }, remotes: { vps } }),
      remoteLinks: { ssh: (options) => makeScriptedLink({ ...options, remotes: table }) },
      thinker: { ask: async () => 'ok', tell: async () => {} },
    })
    await until('vps along the top', () => (rows()[0] ?? '').includes('vps'), 20_000)
    return { far, window }
  }

  /** Queued work here, not before tomorrow, so nothing starts it meanwhile. */
  async function queued(
    slug: string,
    after: { task: string; why: string; approved?: boolean }[] = [],
  ) {
    await client.createTask({
      project: 'app',
      slug,
      intent: `make the ${slug} page, the way we said`,
      context: 'It should load in under a second.',
      links: [{ title: 'the issue', url: 'https://github.com/acme/app/issues/7' }],
      by: 'you',
      start: { after, prompt: `Build the ${slug} page.`, touches: [], at: TOMORROW },
    })
  }

  it('offers Start on vps on its card, and a press hands it there and takes it off this queue', async () => {
    const { far } = await linked()
    await queued('landing')
    await until('the queued work in the side', () => shown('landing'), 20_000)
    const row = wired.find('landing')
    wired.click(row.col, row.row)
    await until('Start on vps on its card', () => shown('Start on vps'), 30_000)
    const button = wired.find('Start on vps')
    wired.click(button.col + 1, button.row)
    await until('vps was handed it', () => far.taken.length === 1, 20_000)
    const [handed] = far.taken
    expect(handed?.take).toMatchObject({
      project: 'tade',
      name: 'landing',
      was: 'app/landing',
      intent: 'make the landing page, the way we said',
      prompt: 'Build the landing page.',
      context: 'It should load in under a second.',
      links: [{ title: 'the issue', url: 'https://github.com/acme/app/issues/7' }],
      at: TOMORROW,
      check: false,
    })
    expect(handed?.take.begins).toBeUndefined()
    await until(
      'gone from this queue',
      async () => (await readTaskFile(home, 'app/landing')) === null,
    )
    const moved = await client.events({ types: ['task_moved'] })
    expect(moved.map((one) => [one.task, one.detail])).toEqual([
      ['app/landing', { to: 'vps', as: 'tade/landing', how: 'queued', by: 'you' }],
    ])
    await until('said where it went', () => shown('went to vps as tade/landing'), 10_000)
  }, 90_000)

  /** The orchestrator's move, tried until vps has said which of its projects is this repository. */
  async function moveWhenKnown(window: App, task: string, asked: string): Promise<string> {
    let said = ''
    await until(`${task} moved`, async () => {
      try {
        said = await window.remoteTools().move({ task, machine: 'vps', asked })
        return true
      } catch (err) {
        if (String(err).includes('has no project')) return false
        throw err
      }
    })
    return said
  }

  it('takes what it waits on with it, written as a wait on this machine, and what waits on it here holds until vps shows it taken', async () => {
    const { far, window } = await linked()
    await queued('landing', [{ task: 'app/refunds', why: 'the page shows refunds' }])
    await queued('banner', [{ task: 'app/landing', why: 'it links to the landing page' }])
    await client.log.append({
      type: 'said',
      task: null,
      detail: { text: 'start the landing page on the vps' },
    })
    const said = await moveWhenKnown(window, 'app/landing', 'start the landing page on the vps')
    expect(said).toContain('went to vps as tade/landing')
    const [handed] = far.taken
    // A task here, as vps reads it: this machine's own name in front.
    expect(handed?.take.after).toEqual([
      { task: `${machineLabel()}:app/refunds`, why: 'the page shows refunds' },
    ])
    const [moved] = await client.events({ types: ['task_moved'] })
    expect(moved?.detail).toMatchObject({
      to: 'vps',
      as: 'tade/landing',
      after: [`${machineLabel()}:app/refunds`],
    })
    // What waited on it here follows it, and holds — nothing of vps's journal
    // is kept here to show it taken, so it never starts on a guess.
    await until('the banner holds on where the landing page went', () =>
      (window.queueTools().describe() as Promise<string>).then((said) =>
        said.includes(
          "app/banner — after app/landing (app/landing, now vps:tade/landing: app/landing moved to vps as tade/landing, and vps's journal here does not show it taken yet",
        ),
      ),
    )
  }, 90_000)

  it('keeps here work that waits for the person to approve a document, and says why', async () => {
    const { far, window } = await linked()
    await queued('build', [{ task: 'app/plan', why: 'the plan says how', approved: true }])
    await client.log.append({
      type: 'said',
      task: null,
      detail: { text: 'start the build on the vps' },
    })
    await until('refused for the approval', async () => {
      try {
        await window
          .remoteTools()
          .move({ task: 'app/build', machine: 'vps', asked: 'start the build on the vps' })
      } catch (err) {
        return String(err).includes('which is approved on the machine that keeps it')
      }
      return false
    })
    expect(far.taken).toEqual([])
    expect((await readTaskFile(home, 'app/build'))?.parked).toBe(false)
  }, 90_000)

  it('places a plan’s later work on the hub where nothing ties it here, and says where and why', async () => {
    const { far, window } = await linked()
    await until('vps has said which project is this repository', async () => {
      const answer = await window.queueTools().plan({
        project: 'app',
        said: 'the nightly page and the menu',
        agents: [
          {
            name: `probe-${Date.now()}`,
            said: 'probe',
            prompt: 'probe',
            after: [],
            touches: [],
            at: TOMORROW,
          },
        ],
      })
      return answer.includes('went to vps')
    })
    far.taken.length = 0
    const answer = await window.queueTools().plan({
      project: 'app',
      said: 'the nightly page, and the menu here',
      agents: [
        {
          name: 'nightly',
          said: 'the nightly page',
          prompt: 'Build it.',
          after: [],
          touches: [],
          at: TOMORROW,
        },
        {
          name: 'menu',
          said: 'the menu',
          prompt: 'Build it.',
          after: [],
          touches: [],
          at: TOMORROW,
          machine: 'here',
        },
      ],
    })
    expect(far.taken.map((one) => one.take.name)).toEqual(['nightly'])
    expect(far.taken[0]?.take.placed).toBe(
      `placed on vps from ${machineLabel()}: it waits for later and nothing ties it to ${machineLabel()}, and vps is the hub (it is the one machine this one links to), so closing the lid strands nothing`,
    )
    expect(answer).toContain('app/nightly went to vps as tade/nightly')
    expect(await readTaskFile(home, 'app/nightly')).toBeNull()
    expect((await readTaskFile(home, 'app/menu'))?.parked).toBe(false)
  }, 90_000)

  it('moves for the orchestrator only where a line of theirs names the machine', async () => {
    const { far, window } = await linked()
    await queued('landing')
    await until('vps has said which project is this repository', async () => {
      try {
        await window
          .remoteTools()
          .move({ task: 'app/landing', machine: 'vps', asked: 'move it over there' })
      } catch (err) {
        return String(err).includes('Nothing they have said names vps')
      }
      return false
    })
    expect(far.taken).toEqual([])
    await client.log.append({
      type: 'said',
      task: null,
      detail: { text: 'put the landing page on the vps instead' },
    })
    await until('the move went through', async () => {
      try {
        const said = await window.remoteTools().move({
          task: 'app/landing',
          machine: 'vps',
          asked: 'put the landing page on the vps instead',
        })
        return said.includes('went to vps as tade/landing')
      } catch (err) {
        // Until vps has said which of its projects is this repository.
        if (String(err).includes('has no project')) return false
        throw err
      }
    })
    expect(far.taken.map((one) => one.take.name)).toEqual(['landing'])
    expect(existsSync(join(home, 'projects', 'app', 'tasks', 'landing', 'task.yaml'))).toBe(false)
    const [moved] = await client.events({ types: ['task_moved'] })
    expect(moved?.detail).toMatchObject({ to: 'vps', by: 'orchestrator' })
  }, 90_000)

  it("offers Hand to vps on a running agent's own menu, and a press tells it to commit and push", async () => {
    await client.createTask({
      project: 'app',
      slug: 'billing',
      intent: 'charge once per order',
      workspace: 'worktree',
    })
    // The agent, as far as this needs one: running, and told things.
    const told: string[] = []
    const running = new Proxy(client, {
      get: (target, key, receiver) => {
        if (key === 'runs') {
          return () => [{ run: 'run-1', task: 'app/billing', harness: 'pi' }, ...target.runs()]
        }
        if (key === 'steerAgent') {
          return async (_task: string, message: string) => {
            told.push(message)
          }
        }
        return Reflect.get(target, key, receiver)
      },
    })
    const { far } = await linked({ client: running })
    await until('the agent in the side', () => shown('billing'), 20_000)
    // Its own menu, opened again until vps has said which of its projects is this repository.
    await until('Hand to vps on its own menu', async () => {
      if (shown('Hand to vps')) return true
      terminal.press('\x1b')
      const row = wired.find(' billing')
      terminal.press(`\x1b[<2;${row.col + 2};${row.row + 1}M`)
      terminal.press(`\x1b[<2;${row.col + 2};${row.row + 1}m`)
      await new Promise((done) => setTimeout(done, 250))
      return shown('Hand to vps')
    })
    expect(shown('Remove agent')).toBe(true)
    const item = wired.find('Hand to vps')
    wired.click(item.col + 1, item.row)
    await until('its agent told to push', () => told.length === 1)
    expect(told[0]).toContain('git push origin HEAD:refs/heads/tade/billing')
    // Asked there first, making nothing; and written down here.
    expect(far.taken.map((one) => [one.take.name, one.take.check])).toEqual([['billing', true]])
    await until(
      'the hand-over written down',
      async () => (await client.events({ types: ['task_handing'] })).length === 1,
    )
    const [asked] = await client.events({ types: ['task_handing'] })
    expect(asked).toMatchObject({
      task: 'app/billing',
      detail: { to: 'vps', there: 'tade', branch: 'tade/billing', by: 'you' },
    })
  }, 90_000)

  it('picks it up here again as it was when the other machine will not take it', async () => {
    const { far, window } = await linked()
    far.taking = () => ({ took: false, said: 'app/landing was used before here' })
    await queued('landing')
    await client.log.append({
      type: 'said',
      task: null,
      detail: { text: 'start the landing page on the vps' },
    })
    await until('vps refused it', async () => {
      try {
        await window.remoteTools().move({
          task: 'app/landing',
          machine: 'vps',
          asked: 'start the landing page on the vps',
        })
      } catch (err) {
        return String(err).includes(
          'vps did not take app/landing: app/landing was used before here',
        )
      }
      return false
    })
    const file = await readTaskFile(home, 'app/landing')
    expect(file?.parked).toBe(false)
    expect(await client.events({ types: ['task_moved'] })).toEqual([])
  }, 90_000)
})

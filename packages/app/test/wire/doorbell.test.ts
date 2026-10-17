import { ConfigSchema } from '@tade/core'
import { ExtensionHost, type TadeExtension } from '@tade/extensions-core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { runGit } from '../../../../test/fixtures/mkrepo.ts'
import type { App } from '../../src/app.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { hooksFor } from '../../src/wire/doorbell.ts'
import type { Schedules } from '../../src/wire/schedules.ts'
import { type Repo, until, windowUnderTest } from './harness.ts'

// A webhook delivery in this window (REMOTE-TADE §6.1): which schedules one is
// for, that it makes them look through the look their clock uses — once more
// after a look under way, however many ring — and that the window then polls
// hourly and says why. The door in front of this is `@tade/web`'s
// `hooked.test.ts`; which delivery rings which watch is `hooks.test.ts` in core.

/** A watch on the repository's issues that rings for GitHub, and one on a channel that rings for Slack. */
function weather(
  looks: { rain: number; snow: number },
  gate: { held: Promise<void> },
): TadeExtension {
  return {
    name: 'weather',
    title: 'Weather',
    description: 'Whether it is raining.',
    watches: [
      {
        id: 'rain',
        title: 'Rain',
        means: 'Asks the radar about this repository, which is somewhere else.',
        every: '10m',
        network: true,
        about: 'repository',
        offers: 'ask',
        doorbell: { source: 'github', events: ['issues'] },
        check: async () => {
          looks.rain++
          await gate.held
          return { found: [], since: 'cursor' }
        },
      },
      {
        id: 'snow',
        title: 'Snow',
        means: 'Asks the channel somebody named.',
        every: '10m',
        network: true,
        about: 'repository',
        offers: 'ask',
        input: {
          type: 'object',
          properties: { channel: { type: 'string', description: 'the channel' } },
          required: ['channel'],
        },
        doorbell: { source: 'slack', events: ['app_mention'], input: 'channel' },
        check: async () => {
          looks.snow++
          return { found: [] }
        },
      },
    ],
  }
}

describe('a delivery, in this window', () => {
  let client: Workbench
  let repo: Repo
  let home: string
  const { start } = windowUnderTest((wired) => {
    client = wired.client
    repo = wired.repo
    home = wired.home
  })

  it('wakes the schedules it is about, owes one more look to a burst, and slows the poll', async () => {
    runGit(repo.root, 'remote', 'add', 'origin', 'git@github.com:Acme/App.git')
    const looks = { rain: 0, snow: 0 }
    const gate = { held: Promise.resolve() }
    const extensions = await ExtensionHost.load({
      builtin: [weather(looks, gate)],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const window: App = await start({ extensions })
    const schedules = (window as unknown as { schedules: Schedules }).schedules
    const wire = (window as unknown as { wire: Wiring }).wire
    await schedules.turnWatch('weather.rain', 'app', true, 'you')
    await schedules.set({
      name: 'Snow',
      project: 'app',
      said: 'watch the channel',
      watch: 'weather.snow',
      input: { channel: 'C0ABCDEF' },
      by: 'you',
    })
    const config = ConfigSchema.parse({
      projects: { app: { root: repo.root } },
      extensions: { intake: { github_webhook_secret: ' shh ' } },
    })
    const hooks = hooksFor(wire, () => config, schedules)

    // The secret is the intake extension's key, read as every key is.
    expect(hooks.secret('github')).toBe('shh')
    expect(hooks.secret('linear')).toBeNull()

    // Which schedules: the repository's own, for a kind it rings for; the
    // channel it was turned on with; nothing for anywhere or anything else.
    const github = { source: 'github', event: 'issues', where: 'github.com/acme/app' } as const
    expect(await hooks.match(github)).toEqual(['rain'])
    expect(await hooks.match({ ...github, where: 'github.com/acme/other' })).toEqual([])
    expect(await hooks.match({ ...github, event: 'push' })).toEqual([])
    expect(await hooks.match({ ...github, event: 'ping' })).toEqual(['rain'])
    const slack = { source: 'slack', event: 'app_mention', where: 'c0abcdef' } as const
    expect(await hooks.match(slack)).toEqual(['snow'])
    expect(await hooks.match({ ...slack, where: 'C0OTHER' })).toEqual([])

    // A look now, through the look its clock uses — and four more deliveries
    // while it is under way are one more look after it, never four.
    let open = () => {}
    gate.held = new Promise((done) => {
      open = done
    })
    hooks.wake(['rain'])
    await until('it looks', () => looks.rain === 1)
    for (let n = 0; n < 4; n++) hooks.wake(['rain'])
    open()
    const looked = async () =>
      (await client.events({ types: ['watch_checked'] })).filter(
        (event) => event.detail.schedule === 'rain',
      ).length
    await until('both looks written down', async () => (await looked()) === 2)
    const busy = schedules as unknown as { lookingWith: Map<string, unknown> }
    await until('nothing looking', () => busy.lookingWith.size === 0)
    expect(looks.rain).toBe(2)

    // A paused schedule is matched by nothing and woken by nothing.
    await schedules.turnWatch('weather.snow', 'app', false, 'you')
    expect(await hooks.match(slack)).toEqual([])
    hooks.wake(['snow'])
    expect(looks.snow).toBe(0)

    // With a delivery that verified written down before its look, the window
    // reads the doorbell as standing: hourly, and the row says why.
    await client.log.append({
      type: 'hook_rung',
      detail: { source: 'github', delivery: 'ab12', verified: true, woke: ['rain'] },
    })
    hooks.wake(['rain'])
    await until('the look the doorbell made', async () => (await looked()) === 3)
    await until('the window reads it', () => wire.live?.watchedOf('rain').bell !== undefined)
    const row = schedules.views().find((one) => one.id === 'rain')
    expect(row?.when).toContain('github rings it, so it polls hourly')
  })

  it('hands the look what a delivery named that a poll cannot see, until a look has read it', async () => {
    // A Slack mention inside a thread: the wake carries it, since its line is
    // appended and not yet read back; after that the journal does, so a look
    // that could not finish it — or a window closed before one — is handed it
    // again, and one that read it lets go of it.
    const handed: (readonly string[] | undefined)[] = []
    const reads = { read: true }
    const chat: TadeExtension = {
      name: 'chat',
      title: 'Chat',
      description: 'One channel.',
      watches: [
        {
          id: 'mentions',
          title: 'Mentions',
          means: 'Asks the channel somebody named.',
          every: '10m',
          network: true,
          about: 'repository',
          offers: 'ask',
          input: {
            type: 'object',
            properties: { channel: { type: 'string', description: 'the channel' } },
            required: ['channel'],
          },
          doorbell: { source: 'slack', events: ['app_mention'], input: 'channel' },
          check: async (ctx) => {
            handed.push(ctx.rang)
            return { found: [], since: 'c', ...(reads.read ? { read: ctx.rang ?? [] } : {}) }
          },
        },
      ],
    }
    const extensions = await ExtensionHost.load({
      builtin: [chat],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const window: App = await start({ extensions })
    const schedules = (window as unknown as { schedules: Schedules }).schedules
    const wire = (window as unknown as { wire: Wiring }).wire
    await schedules.set({
      name: 'Mentions',
      project: 'app',
      said: 'watch the channel',
      watch: 'chat.mentions',
      input: { channel: 'C0ABCDEF' },
      by: 'you',
    })
    const config = ConfigSchema.parse({ projects: { app: { root: repo.root } } })
    const hooks = hooksFor(wire, () => config, schedules)
    const item = '1727445000.000200/1727442000.000100'
    const checked = async () =>
      (await client.events({ types: ['watch_checked'] })).filter(
        (event) => event.detail.schedule === 'mentions',
      )
    const busy = schedules as unknown as { lookingWith: Map<string, unknown> }
    const looked = async (n: number) => {
      await until(`look ${n}`, async () => (await checked()).length === n)
      await until('nothing looking', () => busy.lookingWith.size === 0)
    }

    // Before its line is read back, the wake is what carries it.
    hooks.wake(['mentions'], item)
    await looked(1)
    expect(handed).toEqual([[item]])
    expect((await checked())[0]?.detail.read).toEqual([item])

    // Out of the line, to a look nothing named it to, until one reads it.
    reads.read = false
    await client.log.append({
      type: 'hook_rung',
      detail: { source: 'slack', delivery: 'd2', verified: true, woke: ['mentions'], item },
    })
    await until(
      'the window reads the line',
      () => wire.live?.watchedOf('mentions').rang !== undefined,
    )
    hooks.wake(['mentions'])
    await looked(2)
    hooks.wake(['mentions'])
    await looked(3)
    expect(handed.slice(1)).toEqual([[item], [item]])
    expect((await checked())[2]?.detail).not.toHaveProperty('read')
    reads.read = true
    hooks.wake(['mentions'])
    await looked(4)
    await until('let go of', () => wire.live?.watchedOf('mentions').rang === undefined)
    hooks.wake(['mentions'])
    await looked(5)
    expect(handed.at(-1)).toBeUndefined()
  })
})

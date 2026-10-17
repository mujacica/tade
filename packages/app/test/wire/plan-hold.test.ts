import { ConfigSchema, type PlanSource } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type Repo, SPAWNING_MS, until, windowUnderTest } from './harness.ts'

// Work a schedule or a watch made, on a plan window that is nearly gone: held
// at the moment it would start where `queue.hold_scheduled` says so, through
// the one hold path there is, and started as ever where it does not.

/** A sign-in on a plan whose session window has been seen 95% used. */
const nearlyFull = (): PlanSource => ({
  harness: 'claude-code',
  account: null,
  can: 'while-working',
  pays: 'plan',
  why: null,
  said: {
    at: Date.now(),
    windows: [{ label: '5h', used: 95, resetsAt: Date.now() + 3_600_000 }],
  },
})

describe('scheduled work on a full plan', () => {
  let client: Workbench
  let repo: Repo
  const { start } = windowUnderTest((wired) => {
    client = wired.client
    repo = wired.repo
  })

  /** A watch, and one finding of it made into queued work — not proposed, so the rule is what starts it. */
  async function found(): Promise<string> {
    await client.setSchedule(
      {
        id: 'deps-app',
        name: 'deps.updates',
        project: 'app',
        said: 'keep the dependencies current',
        when: { every: '1d' },
        does: { kind: 'watch', watch: 'deps.updates', input: {}, found: 'agent', most: 2 },
        missed: 'once',
        by: 'you',
        created: '2026-10-17T02:00:00.000Z',
      },
      'you',
    )
    const made = await client.watchFound(
      'deps-app',
      { key: 'left-pad@1.3.1', title: 'left-pad 1.3.1' },
      { agent: { title: 'bump left-pad', prompt: 'Bump it.', alone: true } },
    )
    return made.task ?? ''
  }

  it('holds it, names the setting, and starts nothing', async () => {
    client.planUsage = () => [nearlyFull()]
    const task = await found()
    const told: string[] = []
    // A window someone opened a moment ago: they are here, so nothing says otherwise.
    await start({ thinker: { ask: async () => 'ok', tell: async (text) => void told.push(text) } })
    await until(
      'held on the plan',
      async () =>
        String(
          (await client.events({ types: ['queue_held'], task }))[0]?.detail.because ?? '',
        ).includes('queue.hold_scheduled is on'),
      SPAWNING_MS,
    )
    expect(client.runs().some((run) => run.task === task)).toBe(false)
    await until('the orchestrator told', () => told.some((text) => text.includes(task)))
    const said = told.find((text) => text.includes(task)) ?? ''
    // The answer a plan hold has, never "start it anyway", which would only hold it again.
    expect(said).toContain('leave it until that window has started over')
    expect(said).not.toContain('start it anyway')
    expect(said).not.toContain('Nobody has been')
  })

  it('tells the orchestrator nobody is here, on a window a service manager keeps open', async () => {
    // The always-on box: systemd opened this window, nobody has typed since,
    // and no other screen of theirs has said a key was pressed.
    client.planUsage = () => [nearlyFull()]
    const task = await found()
    const told: string[] = []
    await start({
      keptBy: 'systemd',
      thinker: { ask: async () => 'ok', tell: async (text) => void told.push(text) },
    })
    await until(
      'the orchestrator told',
      () => told.some((text) => text.includes(task)),
      SPAWNING_MS,
    )
    const said = told.find((text) => text.includes(task)) ?? ''
    expect(
      said.startsWith('Nobody has been at a keyboard of theirs since systemd started this window'),
    ).toBe(true)
    // Above Tade's own words, never mistaken for the person's.
    expect(said.indexOf('Nobody has been')).toBeLessThan(said.indexOf('Tade says:'))
  })

  it('starts it as ever where the setting is off', async () => {
    client.planUsage = () => [nearlyFull()]
    const task = await found()
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        queue: { hold_scheduled: false },
      }),
    })
    await until('started', () => client.runs().some((run) => run.task === task), SPAWNING_MS)
    expect(await client.events({ types: ['queue_held'], task })).toEqual([])
  })
})

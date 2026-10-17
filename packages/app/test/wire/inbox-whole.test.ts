import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Config, ConfigSchema } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import type { StatusCollector } from '@tade/status'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { JOURNAL } from '../../src/histories.ts'
import { Live } from '../../src/live.ts'
import { type AppState, initialState } from '../../src/model.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { Intake } from '../../src/wire/intake.ts'

// The inbox — the window's INTAKE, the away view's requests and doors, and the
// statuses said back to a source — is a fold of the journal, and of the
// *whole* of it. `Live.events` is the last 500 lines, and a busy machine puts
// more than that after a request in an afternoon: folded from them, a request
// handed over this morning was gone from every surface, its door had never
// looked, and nobody who asked was ever told their work had finished.

const opened: { live: Live; client: Workbench }[] = []

afterEach(async () => {
  for (const one of opened.splice(0)) {
    await one.live.stop().catch(() => {})
    await one.client.close().catch(() => {})
  }
})

/** Status nobody looks at: what is asked here is the journal's, not the trees'. */
const unlooked: StatusCollector = {
  id: 'unlooked',
  collect: async () => ({ known: false, why: 'nothing here looks at status' }),
  close: async () => {},
}

/** The local door's grant, with whatever else a test grants it, as the home and the window read it. */
function granted(root: string, more: Record<string, string | boolean>) {
  const cli = { accept: true, projects: ['app'], from: ['kim'], ...more }
  const surfaces = { intake: { enabled: true, sources: { cli } } }
  const config: Config = ConfigSchema.parse({ projects: { app: { root } }, surfaces })
  // JSON is YAML, so the home's file says exactly what the window was handed.
  return { yaml: JSON.stringify({ projects: { app: { root } }, surfaces }), config }
}

/** The watch that looks with the local door, saying back whatever it is handed. */
async function watching(root: string, home: string, said: string[]): Promise<ExtensionHost> {
  return ExtensionHost.load({
    builtin: [
      {
        name: 'intake',
        title: 'Intake',
        description: 'Requests from outside.',
        watches: [
          {
            id: 'cli',
            title: 'requests written at this machine',
            means: 'takes in each request in the spool',
            every: '1d',
            intake: 'cli',
            check: async () => ({ found: [] }),
            agent: (finding) => ({ title: finding.title, prompt: 'A request came in.' }),
            recheck: async () => ({ still: true }),
            reply: async (request) => {
              said.push(request.say)
              return { posted: request.mark }
            },
          },
        ],
      },
    ],
    config: { extensions: {}, projects: { app: { root } } },
    home,
  })
}

/**
 * One request handed over through the door a watch uses, after a look that
 * found it — and then a busy machine: more lines than the window keeps.
 */
async function longAgo(
  more: Record<string, string | boolean>,
  between: (client: Workbench, task: string) => Promise<void> = async () => {},
) {
  const repo = mkrepo()
  const home = tmp('tade-inbox-whole-')
  const { yaml, config } = granted(repo.root, more)
  writeFileSync(join(home, 'config.yaml'), yaml)
  const client = await Workbench.open({ home })
  await client.setSchedule(
    {
      id: 'intake-cli',
      name: 'intake cli',
      project: 'app',
      said: '',
      when: { every: '5m' },
      does: { kind: 'watch', watch: 'intake.cli', input: {}, found: 'agent', most: 1 },
      missed: 'skip',
      by: 'you',
      created: '2026-10-17T02:00:00.000Z',
    },
    'you',
  )
  await client.log.append({
    type: 'watch_checked',
    detail: {
      schedule: 'intake-cli',
      found: 1,
      fresh: ['cli:req-1:1'],
      left: 0,
      since: '2026-10-17T00:00:00.000Z',
    },
  })
  const made = await client.watchFound(
    'intake-cli',
    {
      key: 'cli:req-1:1',
      title: 'Export button 500s',
      intake: {
        source: 'cli',
        externalId: 'req-1',
        revision: '1',
        url: 'https://example.invalid/req-1',
        requester: { id: 'kim', label: 'Kim', bot: false },
        from: 'app',
        verbatim: 'the export button 500s when the selection is empty',
        material: { ref: 'req-1.0001.json', hash: 'sha256:aaa' },
        attachments: [],
        sourceAt: '2026-10-17T00:00:00.000Z',
        seenAt: '2026-10-17T00:01:00.000Z',
        correlation: 'req-1-1',
      },
    },
    { agent: { title: 'cli req-1', prompt: 'A request came in from cli (req-1).' } },
  )
  const task = made.task
  if (!task) throw new Error(`that delivery made nothing: ${made.outcome}`)
  await between(client, task)
  for (let i = 0; i < JOURNAL + 20; i++) {
    await client.log.append({ type: 'output', lane: 'app/other/agent', detail: { bytes: 1 } })
  }
  const said: string[] = []
  const host = await watching(repo.root, home, said)
  const live = await Live.start({
    client,
    config,
    home: tmp('tade-inbox-whole-user-'),
    tadeHome: home,
    pollMs: 600_000,
    status: unlooked,
  })
  opened.push({ live, client })
  await live.refresh()
  let state: AppState = initialState()
  const wire = {
    opts: { client, config, extensions: host },
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    live,
    now: () => Date.now(),
    draw: () => {},
    note: () => {},
  } as unknown as Wiring
  return { client, live, task, said, intake: new Intake(wire, { advanceQueue: () => {} }) }
}

describe('the inbox, folded out of the whole journal', () => {
  it('lists a request handed over before the last 500 lines, everywhere it is drawn', async () => {
    const { live, intake } = await longAgo({})
    // The trap is set: the window's tail is nothing but a busy machine.
    expect(live.events.some((line) => line.type.startsWith('intake_'))).toBe(false)
    expect(live.events.some((line) => line.type === 'watch_checked')).toBe(false)

    intake.look()
    await vi.waitFor(() => expect(intake.factory().intake).toHaveLength(1), { timeout: 10_000 })
    // Down the side of the window.
    expect(intake.facts().intake?.map((row) => row.externalId)).toEqual(['req-1'])
    // On the away view, with the title its watch found it under.
    expect(intake.factory().intake[0]?.title).toBe('Export button 500s')
    // And its door has looked, and found it: not a door that never looked.
    expect(intake.factory().sources.find((one) => one.source === 'cli')?.state).toBe('found')

    // A row down the side opens: the page reads the same lines the side did.
    const item = intake.facts().intake?.[0]?.item ?? ''
    await intake.open(item)
    expect(intake.panel()?.intake?.row.externalId).toBe('req-1')
  })

  it('tells the source its work finished, however long ago it was handed over', async () => {
    const { client, task, said, intake } = await longAgo(
      { reply: true, mode: 'queue' },
      async (one, made) => {
        await one.log.append({ type: 'run_started', task: made, detail: {} })
      },
    )
    // Finished now, a busy afternoon after it was handed over and started.
    await client.log.append({ type: 'task_done', task, detail: { by: 'agent' } })
    await vi.waitFor(
      () => {
        intake.look()
        expect(said).toEqual(['Finished.'])
      },
      { timeout: 10_000 },
    )
  })
})

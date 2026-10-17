import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Config, ConfigSchema } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import type { StatusCollector } from '@tade/status'
import { approveIntake, inboxFrom, readTaskFile, Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { JOURNAL } from '../../src/histories.ts'
import { Live } from '../../src/live.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { standsFor } from '../../src/wire/queue-holds.ts'
import { homeConfig, INTAKE } from './away-intake.ts'

// Approving a request from away asks the queue's own question (`standsFor`):
// the grant, the plan and the source, again. Its record is the request's own
// intake lines, and a busy machine puts more than `Live.events`' 500 lines
// after them — so it is folded from the whole journal the queue folds, or a
// request handed over this morning is told it has no record on this machine.

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

/** The source, which says the request still stands, and counts that it was asked. */
async function source(root: string, home: string, asked: string[]): Promise<ExtensionHost> {
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
            recheck: async (request) => {
              asked.push(request.key)
              return { still: true }
            },
          },
        ],
      },
    ],
    config: { extensions: {}, projects: { app: { root } } },
    home,
  })
}

/** One request handed over through the door a watch uses, and parked as a proposal. */
async function delivered(client: Workbench): Promise<string> {
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
  const made = await client.watchFound(
    'intake-cli',
    {
      key: 'cli:req-1:1',
      title: 'cli req-1',
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
  if (!made.task) throw new Error(`that delivery made nothing: ${made.outcome}`)
  return made.task
}

describe('approving a request from away', () => {
  it('finds a request handed over before the last 500 lines, and asks its source', async () => {
    const repo = mkrepo()
    const home = tmp('tade-holds-')
    writeFileSync(join(home, 'config.yaml'), homeConfig(repo.root, true))
    const client = await Workbench.open({ home })
    const task = await delivered(client)
    // A busy morning since: more lines than the window keeps, none about it.
    for (let i = 0; i < JOURNAL + 20; i++) {
      await client.log.append({ type: 'output', lane: 'app/other/agent', detail: { bytes: 1 } })
    }
    const config: Config = ConfigSchema.parse({
      projects: { app: { root: repo.root } },
      surfaces: { intake: INTAKE },
    })
    const live = await Live.start({
      client,
      config,
      home: tmp('tade-holds-user-'),
      tadeHome: home,
      pollMs: 600_000,
      status: unlooked,
    })
    opened.push({ live, client })
    await live.refresh()
    // The trap is set: the window's tail has none of its lines, and the
    // queue's whole-journal list has them all.
    expect(live.events.some((line) => line.type === 'intake_received')).toBe(false)
    expect(live.queueFacts().events.some((line) => line.type === 'intake_received')).toBe(true)

    const asked: string[] = []
    const wire = {
      opts: { client, config, extensions: await source(repo.root, home, asked) },
      live,
      now: () => Date.now(),
      note: () => {},
    } as unknown as Wiring
    const [row] = (await inboxFrom({ home, events: await client.events({}) })).filter((one) =>
      one.tasks.includes(task),
    )
    if (!row) throw new Error(`no inbox row made ${task}`)

    // The door the away view's `intake` verb goes through, with the window's own question.
    await approveIntake(client, {
      item: row.item,
      by: 'device d1',
      config,
      stands: (one) => standsFor(wire, one),
    })
    expect((await readTaskFile(home, task))?.parked ?? false).toBe(false)
    // Approved because the source said it still stands, not for want of asking it.
    expect(asked).toEqual(['cli:req-1:1'])
  })
})

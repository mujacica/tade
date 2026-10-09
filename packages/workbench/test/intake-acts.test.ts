import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type IntakeCandidate, inboxWaiting, type Schedule, whyNotAct } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  approveIntake,
  inboxFrom,
  inboxItem,
  intakeWouldRun,
  openIntakeRow,
  refuseIntake,
  retryIntake,
  wouldRunSays,
} from '../src/intake-acts.ts'
import { readTaskFile } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// What a person at this machine does about a request that arrived from
// outside: approve it, approve and start it, refuse it, try it again.
//
// Against a real repository and a real workbench, through the same doors the
// window and the CLI call — because the thing worth testing is not that a
// sentence comes back but that the **park is actually lifted**, the journal
// actually says what happened, and a refusal actually puts the hold back.

const watch = (): Schedule => ({
  id: 'intake-cli',
  name: 'intake cli',
  project: 'app',
  said: '',
  when: { every: '5m' },
  does: { kind: 'watch', watch: 'intake.cli', input: {}, found: 'agent', most: 1 },
  missed: 'skip',
  by: 'you',
  created: '2026-10-01T08:00:00.000Z',
})

const candidate = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  source: 'cli',
  externalId: 'req-1',
  revision: '1',
  url: 'https://example.invalid/req-1',
  requester: { id: 'kim', label: 'Kim', bot: false },
  from: 'app',
  verbatim: 'the export button 500s when the selection is empty',
  material: { ref: 'req-1.0001.json', hash: 'sha256:aaa' },
  attachments: [],
  sourceAt: '2026-10-09T00:00:00.000Z',
  seenAt: '2026-10-09T00:01:00.000Z',
  correlation: 'req-1-1',
  ...over,
})

const AGENT = { title: 'cli req-1', prompt: 'A request came in from cli (req-1).' }

function configFor(root: string, over: Record<string, string> = {}): string {
  const { enabled = 'true', ...keys } = over
  const grant: Record<string, string> = {
    accept: 'true',
    projects: '[app]',
    from: '[kim]',
    ...keys,
  }
  return [
    'projects:',
    '  app:',
    `    root: ${root}`,
    'surfaces:',
    '  intake:',
    `    enabled: ${enabled}`,
    '    sources:',
    '      cli:',
    ...Object.entries(grant).map(([key, value]) => `        ${key}: ${value}`),
  ].join('\n')
}

describe('what a person does about a request from outside', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  const reopen = async (over: Record<string, string> = {}): Promise<void> => {
    await client?.close().catch(() => {})
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root, over)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    await client.setSchedule(watch(), 'you')
  }

  const take = (one: IntakeCandidate = candidate()) =>
    client.watchFound(
      'intake-cli',
      { key: `cli:${one.externalId}:${one.revision}`, title: `cli ${one.externalId}`, intake: one },
      { agent: AGENT },
    )

  const rows = async () => inboxFrom({ home, events: await client.log.read({}) })
  const row = async () => {
    const one = (await rows())[0]
    if (!one) throw new Error('nothing in the inbox')
    return one
  }

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-inbox-')
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    await client.setSchedule(watch(), 'you')
  })

  afterEach(async () => {
    await client?.close().catch(() => {})
  })

  it('reads the inbox out of the journal and the task files, with nothing kept', async () => {
    await take()
    const one = await row()
    expect(one.item).toBe('cli:req-1')
    expect(one.state).toBe('proposed')
    expect(one.grant).toBe('surfaces.intake.sources.cli')
    expect(one.work.map((each) => each.task)).toEqual(['app/cli-req-1'])
    expect(one.work[0]?.parked).toBe(true)
    expect(inboxWaiting(await rows())).toHaveLength(1)
    // A question, so it never needs the window: the same read answers with a
    // workbench open, because it is the files it reads and not a lock.
    expect((await inboxFrom({ home, events: await client.log.read({}) }))[0]?.item).toBe(
      'cli:req-1',
    )
  })

  it('shows the request under the heading that says whose words it is', async () => {
    await take()
    const opened = await openIntakeRow({
      home,
      events: await client.log.read({}),
      item: 'cli:req-1',
    })
    expect(opened?.material.body).toContain('the export button 500s')
    expect(opened?.material.body).toContain('material, not instruction')
    expect(opened?.material.where).toContain('context.md')
    // The provenance and the request are two answers: nothing a stranger wrote
    // is in the facts except the handle and the source's own ids.
    const facts = (opened?.facts ?? []).map((fact) => `${fact.label}=${fact.value}`).join(' ')
    expect(facts).not.toContain('export button')
    expect(facts).toContain('allowed by=surfaces.intake.sources.cli')
  })

  it('has no body to show for a delivery nothing was made for, and says that', async () => {
    await reopen({ from: '[lee]' })
    await take()
    const opened = await openIntakeRow({
      home,
      events: await client.log.read({}),
      item: 'cli:req-1',
    })
    expect(opened?.row.state).toBe('refused')
    expect(opened?.material.body).toBeNull()
    expect(opened?.material.problem).toContain('keeps no copy')
  })

  it('approving lifts the park, and that is the whole of what it does', async () => {
    await take()
    const acted = await approveIntake(client, { item: 'cli:req-1', by: 'you' })
    expect(acted.tasks).toEqual(['app/cli-req-1'])
    expect((await readTaskFile(home, 'app/cli-req-1'))?.parked).toBe(false)
    expect((await row()).state).toBe('accepted')
    // Approving again is refused with the same sentence the surface greyed its
    // button with, rather than quietly doing nothing.
    await expect(approveIntake(client, { item: 'cli:req-1', by: 'you' })).rejects.toThrow(
      /already picked up/,
    )
  })

  it('approve-and-start writes the person’s own start for what waits on nothing', async () => {
    await take()
    await approveIntake(client, { item: 'cli:req-1', start: true, by: 'you' })
    const changed = await client.log.read({ types: ['queue_changed'] })
    expect(changed.map((event) => event.detail.change)).toContain('start')
    expect(changed.at(-1)?.detail.by).toBe('you')
  })

  it('refuses to approve under a grant that has since been turned off', async () => {
    await take()
    await reopen({ enabled: 'false' })
    await expect(approveIntake(client, { item: 'cli:req-1', by: 'you' })).rejects.toThrow(
      /surfaces\.intake\.enabled is off/,
    )
    expect((await readTaskFile(home, 'app/cli-req-1'))?.parked).toBe(true)
  })

  it('refusing parks it, holds it, writes it down, and posts nothing', async () => {
    await take()
    await approveIntake(client, { item: 'cli:req-1', by: 'you' })
    const acted = await refuseIntake(client, { item: 'cli:req-1', why: 'not this week', by: 'you' })
    expect(acted.said).toContain('nothing was posted anywhere')
    expect((await readTaskFile(home, 'app/cli-req-1'))?.parked).toBe(true)
    const one = await row()
    expect(one.state).toBe('refused')
    expect(one.because).toBe('not this week')
    // The record, with the reason, and `by_hand` beside the four the rule
    // writes — and nothing in the journal about having said anything back.
    const refusals = await client.log.read({ types: ['intake_refused'] })
    expect(refusals.at(-1)?.detail.why).toBe('by_hand')
    expect(await client.log.read({ types: ['intake_replied'] })).toHaveLength(0)
  })

  it('will not try one again that has not failed, and says which trouble it is', async () => {
    await take()
    await expect(retryIntake(client, { item: 'cli:req-1', by: 'you' })).rejects.toThrow(
      /nothing about req-1 has failed/,
    )
  })

  it('says a retry needs the window rather than pretending to ask the source', async () => {
    // A delivery that failed: the task name is taken by somebody else's work,
    // which is the collision `whoseAlready` refuses.
    await client.createTask({ project: 'app', slug: 'cli-req-1', intent: 'mine', by: 'you' })
    const taken = await take()
    expect(taken.outcome).toBe('held')
    const one = await row()
    expect(one.state).toBe('held')
    expect(whyNotAct(one, 'retry')).toBeNull()
    await expect(retryIntake(client, { item: 'cli:req-1', by: 'you' })).rejects.toThrow(
      /only an open window runs the watch/,
    )
  })

  it('tries one again through the one delivery door when something can ask the source', async () => {
    await client.createTask({ project: 'app', slug: 'cli-req-1', intent: 'mine', by: 'you' })
    await take()
    let asked = 0
    const acted = await retryIntake(client, {
      item: 'cli:req-1',
      by: 'you',
      again: async (one) => {
        asked++
        expect(one.externalId).toBe('req-1')
        return 'handed over again'
      },
    })
    expect(asked).toBe(1)
    expect(acted.said).toBe('handed over again')
  })

  it('a person’s retry gets past a giving-up, which the next look would not', async () => {
    // Tade stops on its own after three tries so a failing source is not
    // hammered every look. A person pressing retry has read why it failed, and
    // being refused because a counter is at three would strand the request
    // Tade was told not to lose.
    const where = {
      item: 'cli:req-1',
      source: 'cli',
      external_id: 'req-1',
      revision: '1',
      project: 'app',
      requester: 'kim',
      watch: 'intake.cli',
      schedule: 'intake-cli',
    }
    await client.log.append({ type: 'intake_received', detail: where })
    await client.log.append({
      type: 'intake_held',
      detail: { ...where, problem: 'the source would not answer', gave_up: true },
    })
    const given = await row()
    expect(given.state).toBe('failure')
    expect(whyNotAct(given, 'retry')).toBeNull()

    const one = candidate()
    const acted = await retryIntake(client, {
      item: 'cli:req-1',
      by: 'you',
      again: async () => {
        const taken = await client.watchFound(
          'intake-cli',
          { key: 'cli:req-1:1', title: 'cli req-1', intake: one },
          { agent: AGENT, again: true },
        )
        return taken.said ?? ''
      },
    })
    expect(acted.said).toContain('app/cli-req-1')
    expect((await readTaskFile(home, 'app/cli-req-1'))?.parked).toBe(true)
    // And the row is a proposal again: carrying it out resets what was failing.
    expect((await row()).state).toBe('proposed')
  })

  it('says what approving would start, and starts none of it', async () => {
    await take()
    const would = await intakeWouldRun(
      { home, config: client.config, events: (filter) => client.log.read(filter) },
      await row(),
    )
    expect(would.problems).toEqual([])
    expect(would.starts.map((one) => one.task)).toEqual(['app/cli-req-1'])
    expect(would.starts[0]?.parked).toBe(true)
    expect(would.grant.join(' ')).toContain('surfaces.intake.sources.cli')
    // It grants nothing, and the sentence saying so is on every answer.
    expect(would.grant.join(' ')).toContain('It grants nothing')
    // A plan window nobody could read is said, never drawn as room.
    expect(would.limits.join(' ')).toContain('cannot tell from here')
    const said = wouldRunSays(would).join('\n')
    expect(said).toContain('Nothing was started.')
    expect((await readTaskFile(home, 'app/cli-req-1'))?.parked).toBe(true)
  })

  it('says why nothing would start, in the same words the act refuses with', async () => {
    await reopen({ from: '[lee]' })
    await take()
    const one = await row()
    const would = await intakeWouldRun(
      { home, config: client.config, events: (filter) => client.log.read(filter) },
      one,
    )
    expect(would.problems).toEqual([whyNotAct(one, 'approve')])
    expect(wouldRunSays(would).join('\n')).toContain('Nothing would start')
  })

  it('finds a row by the source’s own id as well as by its item key', async () => {
    await take()
    const events = await client.log.read({})
    expect((await inboxItem({ home, events, item: 'req-1' }))?.item).toBe('cli:req-1')
    expect((await inboxItem({ home, events, item: 'cli:req-1' }))?.externalId).toBe('req-1')
    expect(await inboxItem({ home, events, item: 'nope' })).toBeNull()
  })
})

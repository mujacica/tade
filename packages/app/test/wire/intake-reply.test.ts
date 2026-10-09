import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type InboxRow,
  type IntakeCandidate,
  intakeAgain,
  intakeFrom,
  type Schedule,
} from '@tade/core'
import type { ExtensionHost } from '@tade/extensions-core'
import { inboxFrom, Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { sayDue } from '../../src/wire/intake-reply.ts'

// Telling a source where its request got to, driven by the fold.
//
// **Against a scripted transport**, which is the only honest way to test this:
// what is under test is the retrying, the reconciling, the dedupe and the
// disclosure, and a real comment on somebody's issue tests none of them. The
// transport here answers what each test needs it to answer, and nothing in
// this file reaches a network.

const schedule: Schedule = {
  id: 'intake-cli',
  name: 'intake cli',
  project: 'app',
  said: '',
  when: { every: '5m' },
  does: { kind: 'watch', watch: 'intake.cli', input: {}, found: 'agent', most: 1 },
  missed: 'skip',
  by: 'you',
  created: '2026-10-01T08:00:00.000Z',
}

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

describe('saying a status back to a source', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench
  /** Every status the transport was handed, in the order it was handed them. */
  let posted: { key: string; say: string; mark: string }[]
  /** Marks it has already seen, which is what makes it idempotent. */
  let seen: Set<string>
  /** What it does instead of working, where a test wants it broken. */
  let broken: string | null
  /** The revision the source reports once something has been posted to it. */
  let moved: string | null

  const host = (): ExtensionHost =>
    ({
      reply: async (_id: string, req: Record<string, unknown>) => {
        if (broken) throw new Error(broken)
        const mark = String(req.mark)
        if (seen.has(mark)) return { posted: mark, already: true }
        seen.add(mark)
        posted.push({ key: String(req.key), say: String(req.say), mark })
        return { posted: mark, ...(moved ? { revision: moved } : {}) }
      },
    }) as unknown as ExtensionHost

  const open = async (grant: string[]): Promise<void> => {
    await client?.close().catch(() => {})
    writeFileSync(
      join(home, 'config.yaml'),
      `${[
        'projects:',
        '  app:',
        `    root: ${repo.root}`,
        'surfaces:',
        '  intake:',
        '    enabled: true',
        '    sources:',
        '      cli:',
        '        accept: true',
        '        projects: [app]',
        '        from: [kim]',
        ...grant.map((line) => `        ${line}`),
      ].join('\n')}\n`,
    )
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    await client.setSchedule(schedule, 'you')
  }

  /** Take one request in, the way the schedules' look does. */
  const take = async (one: IntakeCandidate = candidate()): Promise<void> => {
    await client.watchFound(
      'intake-cli',
      { key: `cli:${one.externalId}:${one.revision}`, title: `cli ${one.externalId}`, intake: one },
      { agent: { title: `cli ${one.externalId}`, prompt: 'A request came in.' } },
    )
  }

  /** Drain the outbox once, the way the inbox's fold does. */
  const drain = async (one: { host?: ExtensionHost | null; now?: number } = {}) => {
    const events = await client.log.read({})
    const rows = await inboxFrom({ home, events })
    return {
      rows,
      quiet: await sayDue({
        client,
        config: client.config,
        host: one.host === undefined ? host() : one.host,
        now: one.now ?? Date.now(),
        rows,
        items: intakeFrom(events),
        schedules: client.schedules(),
        machine: 'studio',
      }),
    }
  }

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-say-back-')
    posted = []
    seen = new Set()
    broken = null
    moved = null
    await open([])
  })

  afterEach(async () => {
    await client?.close().catch(() => {})
  })

  it('posts nothing, and says nothing about it, while the grant is off', async () => {
    // The ordinary case, and it must be silent: a line every refold about a
    // capability nobody turned on is noise that teaches people to ignore lines.
    await take()
    const { quiet } = await drain()
    expect(posted).toEqual([])
    expect(quiet).toEqual([])
  })

  it('says it is waiting for a person, where that is what is true', async () => {
    await open(['reply: true'])
    await take()
    await drain()
    // `propose` is the default, so the task is parked and the status says so.
    // Acceptance is not execution, and no copy may blur the two.
    expect(posted.map((one) => one.say)).toEqual(['Picked up. Waiting for a person to approve it.'])
    expect(posted[0]?.key).toBe('cli:req-1:1')
  })

  it('says it is queued where the owner granted the queue that source', async () => {
    await open(['reply: true', 'mode: queue'])
    await take()
    await drain()
    expect(posted.map((one) => one.say)).toEqual(['Queued.'])
  })

  it('names nothing at all unless naming is granted too', async () => {
    await open(['reply: true', 'mode: queue'])
    await take()
    await drain()
    // Not the task, not the machine, not the request, not a link. A public
    // issue is read by whoever finds it.
    const said = posted[0]?.say ?? ''
    expect(said).not.toContain('app/')
    expect(said).not.toContain('studio')
    expect(said).not.toContain('export button')
    expect(said).not.toContain('http')
  })

  it('names the work and the machine once that is granted', async () => {
    await open(['reply: true', 'mode: queue', 'names: true'])
    await take()
    await drain()
    expect(posted[0]?.say).toContain('app/cli-req-1')
  })

  it('says each status once, however many times the fold runs', async () => {
    // **Dedupe across restarts**: nothing is kept between drains, so the only
    // thing stopping a second post is the journal's own record. Draining four
    // times is four windows reopening.
    await open(['reply: true', 'mode: queue'])
    await take()
    for (let n = 0; n < 4; n++) await drain()
    expect(posted).toHaveLength(1)
  })

  it('moves on as the work does, one status for each thing that became true', async () => {
    await open(['reply: true', 'mode: queue'])
    await take()
    await drain()
    await client.log.append({ type: 'run_started', task: 'app/cli-req-1', detail: {} })
    await drain()
    await client.log.append({ type: 'task_done', task: 'app/cli-req-1', detail: {} })
    await drain()
    // Queued, running, done: three distinct facts and three distinct words.
    expect(posted.map((one) => one.say)).toEqual(['Queued.', 'Being worked on.', 'Finished.'])
  })

  it('never says a status late: a window that was shut says the newest and no more', async () => {
    // Nothing was drained while the work was queued and started, so the only
    // status that goes out is the one that is true now. Four at once would be
    // a machine talking about itself.
    await open(['reply: true', 'mode: queue'])
    await take()
    await client.log.append({ type: 'run_started', task: 'app/cli-req-1', detail: {} })
    await client.log.append({ type: 'task_done', task: 'app/cli-req-1', detail: {} })
    await drain()
    expect(posted.map((one) => one.say)).toEqual(['Finished.'])
    // And the ones it passed over stay passed over.
    await drain()
    expect(posted).toHaveLength(1)
  })

  it('tries again after a failure, and the failure is visible meanwhile', async () => {
    await open(['reply: true', 'mode: queue'])
    await take()
    broken = 'the source is read-only just now'
    // Real times, because the journal stamps its own lines with the real
    // clock: a fake `now` an hour behind one of its own records is a clock
    // that moved, which is a different branch and not this one.
    const base = Date.now()
    const first = await drain({ now: base })
    expect(posted).toEqual([])
    // Said out loud: a status nobody at the source ever saw is the quiet
    // failure this path must not have.
    expect(first.quiet[0]).toContain('could not say accepted back about req-1')
    const rows = await inboxFrom({ home, events: await client.log.read({}) })
    expect(rows[0]?.unsent).toEqual([
      { saying: 'accepted', attempts: 1, problem: 'the source is read-only just now' },
    ])
    // A minute has not passed, so nothing is tried again: a retry every refold
    // against a source that is down is the failure mode the wait exists for.
    await drain({ now: base + 1_000 })
    expect(
      (await inboxFrom({ home, events: await client.log.read({}) }))[0]?.unsent[0]?.attempts,
    ).toBe(1)
    // A minute later, and the source is back.
    broken = null
    await drain({ now: base + 61_000 })
    expect(posted.map((one) => one.say)).toEqual(['Queued.'])
    expect((await inboxFrom({ home, events: await client.log.read({}) }))[0]?.unsent).toEqual([])
  })

  it('stops after three tries, and the giving up is a thing somebody can see', async () => {
    await open(['reply: true', 'mode: queue'])
    await take()
    broken = 'the source would not take it'
    const base = Date.now()
    for (let n = 0; n < 5; n++) await drain({ now: base + n * 120_000 })
    const rows = await inboxFrom({ home, events: await client.log.read({}) })
    expect(rows[0]?.unsent[0]).toMatchObject({ saying: 'accepted', attempts: 3 })
    // And the work is untouched: a status is never a hold.
    expect(rows[0]?.state).toBe('accepted')
    expect(rows[0]?.work[0]?.held).toBeNull()
  })

  it('reconciles a crash after posting instead of posting a second time', async () => {
    // The window posted and died before writing its line: nothing in the
    // journal, so the status is due again. Same marker, and the transport says
    // the source already has it — one status at the source, and the journal
    // records that nothing was created this time.
    await open(['reply: true', 'mode: queue'])
    await take()
    seen.add('tade:cli:req-1:accepted')
    const { quiet } = await drain()
    expect(quiet).toEqual([])
    expect(posted).toEqual([])
    const line = (await client.log.read({ types: ['intake_replied'] }))[0]
    expect(line?.detail).toMatchObject({ saying: 'accepted', state: 'said', already: true })
    const rows = await inboxFrom({ home, events: await client.log.read({}) })
    expect(rows[0]?.said).toEqual(['accepted'])
  })

  it('does not read its own status as somebody rewriting the request', async () => {
    // **The loop closed.** The source counts a comment as a change, so posting
    // moves its revision; the transport says where it moved to, and the next
    // look must read that as Tade's own words rather than as an edit that
    // invalidates an approval a person just gave.
    await open(['reply: true', 'mode: queue'])
    await take()
    moved = '2'
    await drain()
    expect(posted).toHaveLength(1)
    const items = intakeFrom(await client.log.read({}))
    const one = items.get('cli:req-1')
    expect(one?.said[0]).toMatchObject({ saying: 'accepted', revision: '2' })
    expect(intakeAgain(one as never, candidate({ revision: '2' })).again).toBe('ignore')
    // A real edit still invalidates: the hash is the independent check, so a
    // revision Tade moved the thing to with *different text* behind it is
    // somebody's edit and is read as one.
    expect(
      intakeAgain(
        one as never,
        candidate({ revision: '2', material: { ref: 'x', hash: 'sha256:bbb' } }),
      ).again,
    ).toBe('invalidate')
  })

  it('does not put work back in the queue’s hold because it said something', async () => {
    // The claim the rule above exists for, through the door that would do it:
    // the next look hands over the revision Tade's own status moved the thing
    // to, and nothing is parked, nothing is held, and no second task is made.
    // A reply that re-parked approved work would be Tade undoing a person's
    // approval once per status, for ever.
    await open(['reply: true', 'mode: queue'])
    await take()
    moved = '2'
    await drain()
    const made = (await client.log.read({ types: ['task_created'] })).length
    await take(candidate({ revision: '2' }))
    expect(await client.log.read({ types: ['intake_held'] })).toEqual([])
    expect((await client.log.read({ types: ['task_created'] })).length).toBe(made)
    const rows = await inboxFrom({ home, events: await client.log.read({}) })
    expect(rows[0]?.work[0]).toMatchObject({ task: 'app/cli-req-1', parked: false, held: null })
    // And somebody else's edit still does all of that, which is the half that
    // makes the rule a rule rather than a hole.
    await take(candidate({ revision: '3', material: { ref: 'x', hash: 'sha256:bbb' } }))
    expect(await client.log.read({ types: ['intake_held'] })).not.toEqual([])
    expect((await inboxFrom({ home, events: await client.log.read({}) }))[0]?.work[0]?.parked).toBe(
      true,
    )
  })

  it('says nothing back about a refusal, and nothing at all with no extensions', async () => {
    // A reply to a refusal tells an unauthorised person the machine is there
    // and listening, which is the one thing a refusal must never do.
    await open(['reply: true', 'mode: queue'])
    await take(candidate({ requester: { id: 'stranger', label: '', bot: false } }))
    const { rows, quiet } = await drain()
    expect(rows[0]?.state).toBe('refused')
    expect(posted).toEqual([])
    expect(quiet).toEqual([])
    expect(await drain({ host: null })).toMatchObject({ quiet: [] })
  })

  it('says nothing about a request from something the source calls an app', async () => {
    // Tade's own replies cannot feed back in, and a bot's request is not a
    // person's: both are refused before anything is made, and a refusal is
    // never answered.
    await open(['reply: true', 'mode: queue'])
    await take(candidate({ requester: { id: 'kim', label: '', bot: true } }))
    const { rows } = await drain()
    expect(rows[0]?.state).toBe('refused')
    expect(rows[0]?.because).toContain('an app')
    expect(posted).toEqual([])
  })

  it('keeps reading a source whose writes are unavailable', async () => {
    // A write that cannot be done never takes a read down with it: the row is
    // still folded, the work still stands, and the only thing missing is that
    // somebody was told.
    await open(['reply: true', 'mode: queue'])
    await take()
    broken = 'this sign-in cannot comment on that repository'
    const { rows, quiet } = await drain()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.work[0]?.task).toBe('app/cli-req-1')
    expect(quiet[0]).toContain('cannot comment')
    expect((rows[0] as InboxRow).state).toBe('accepted')
  })
})

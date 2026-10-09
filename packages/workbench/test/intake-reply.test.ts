import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  INTAKE_REPLY_ATTEMPTS,
  INTAKE_REPLY_CAP,
  INTAKE_SAYINGS,
  type InboxRow,
  type IntakeReceipt,
  type IntakeSaying,
  inboxProvenance,
  intakeFrom,
} from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { intakeGrant, sayBackAbout } from '../src/intake.ts'
import { inboxFrom } from '../src/intake-acts.ts'
import { Workbench } from '../src/workbench.ts'

// Saying a status back to a source: the door, and the four gates in it.
//
// Its own file beside `intake.test.ts` because it is the other direction, and
// the source is split the same way: `intake.ts` is a delivery coming in and
// `intake-outbox.ts` is what may go back. What the window makes of a due
// status — which saying, when, and what a failure reads like — is
// `packages/app/test/wire/intake-reply.test.ts`.
//
// **The transport is scripted**, because what is under test is the gates, the
// records and the bounds: a real comment on somebody's issue tests none of
// them, and there is nothing here that reaches a network.

/** A config with intake on and one grant, with whichever keys a test is about. */
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

describe('saying a status back', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  const open = async (over: Record<string, string> = {}): Promise<void> => {
    await client?.close().catch(() => {})
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root, over)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
  }

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-intake-reply-')
    writeFileSync(join(home, 'config.yaml'), `${configFor(repo.root)}\n`)
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
  })

  afterEach(async () => {
    await client?.close().catch(() => {})
  })

  /** A transport whose answers a test chooses: the scripted half of the port. */
  const transport = (
    over: {
      throws?: string
      already?: boolean
      revision?: string
      /** Fail this many times before it starts working. */
      failTimes?: number
    } = {},
  ) => {
    const posted: { say: string; mark: string }[] = []
    let failed = 0
    return {
      posted,
      post: async (request: { key: string; say: string; mark: string }) => {
        if (over.throws) throw new Error(over.throws)
        if ((over.failTimes ?? 0) > failed) {
          failed += 1
          throw new Error('the source would not take it')
        }
        posted.push({ say: request.say, mark: request.mark })
        return {
          posted: request.mark,
          ...(over.already ? { already: true } : {}),
          ...(over.revision ? { revision: over.revision } : {}),
        }
      },
    }
  }

  const say = (
    post: (request: { key: string; say: string; mark: string }) => Promise<IntakeReceipt>,
    one: { saying?: IntakeSaying; now?: number } = {},
  ) =>
    sayBackAbout(client, {
      source: 'cli',
      candidate: { externalId: 'req-1', revision: '1', correlation: 'req-1-1' },
      saying: one.saying ?? 'accepted',
      task: 'app/cli-req-1',
      now: one.now ?? Date.now(),
      post,
    })

  it('posts nothing at all while reply is off, and names nothing while naming is', async () => {
    // Both defaults in one place, because they are two acts and neither
    // implies the other: replying posts into somebody else's system, and
    // naming puts a repository and a laptop in a stranger's tracker. What
    // each sentence then says is `packages/app/test/wire/intake-reply.test.ts`.
    const grant = intakeGrant(client.config, 'cli')
    expect([grant.reply, grant.names]).toEqual([false, false])
    const one = transport()
    const answer = await say(one.post)
    // Not "posted and ignored": the transport is never reached, which is the
    // difference between a capability that is off and one that is disabled.
    expect(one.posted).toEqual([])
    expect(answer.because).toContain('reply is off')
    expect(await client.log.read({ types: ['intake_replied'] })).toEqual([])
  })

  it('says one status once, however many times it is asked', async () => {
    // The dedupe that survives a restart: the journal says what has gone, so
    // the door refuses a second `accepted` even when a caller asks for one.
    await open({ reply: 'true' })
    const one = transport()
    expect((await say(one.post)).said).toBe('Queued.')
    const again = await say(one.post)
    expect(again.said).toBeNull()
    expect(again.because).toContain('already gone back')
    expect(one.posted).toHaveLength(1)
  })

  it('says every status a life has, each its own sentence and its own marker', async () => {
    // Every one of them in one go, because the cap is as high as the number of
    // sayings on purpose: one per saying already bounds a request's whole
    // life, so the cap can never be what stops an honest status. It was lower
    // than that once, and what it silently dropped was `finished`.
    await open({ reply: 'true' })
    const one = transport()
    const now = Date.now()
    for (const saying of INTAKE_SAYINGS) await say(one.post, { saying, now })
    // Acknowledged, queued, running and done are four facts and no copy blurs
    // them: a distinct sentence each, and a marker naming which status it is.
    expect(new Set(one.posted.map((each) => each.say)).size).toBe(INTAKE_SAYINGS.length)
    expect(one.posted.map((each) => each.mark)).toEqual(
      INTAKE_SAYINGS.map((saying) => `tade:cli:req-1:${saying}`),
    )
  })

  it('raises why the source refused it, even when the record cannot be written', async () => {
    // Writing it down must not be able to replace why it failed: the
    // transport's sentence is the only one that says what went wrong at the
    // source, and a journal that cannot be appended to is its own trouble.
    await open({ reply: 'true' })
    const one = transport({ throws: 'this sign-in cannot comment there' })
    // Reads still work — the door has to fold the journal to get this far —
    // and only the append is broken, which is the shape of a full disk.
    const broken = {
      read: (query: Parameters<Workbench['log']['read']>[0]) => client.log.read(query),
      append: async () => {
        throw new Error('the journal is full')
      },
    }
    await expect(
      sayBackAbout({ ...client, log: broken } as unknown as Workbench, {
        source: 'cli',
        candidate: { externalId: 'req-1', revision: '1', correlation: 'req-1-1' },
        saying: 'accepted',
        task: 'app/cli-req-1',
        now: Date.now(),
        post: one.post,
      }),
    ).rejects.toThrow('this sign-in cannot comment there')
  })

  it('writes a failure down and hands it back, rather than going quiet', async () => {
    await open({ reply: 'true' })
    const one = transport({ throws: 'the source is read-only just now' })
    await expect(say(one.post)).rejects.toThrow(/read-only/)
    const lines = await client.log.read({ types: ['intake_replied'] })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.detail).toMatchObject({
      saying: 'accepted',
      state: 'unsent',
      problem: 'the source is read-only just now',
    })
    // And it is in the inbox, which is the only place the silence shows.
    const rows = await inboxFrom({ home, events: await client.log.read({}) })
    expect(rows[0]?.unsent).toEqual([
      { saying: 'accepted', attempts: 1, problem: 'the source is read-only just now' },
    ])
    expect(inboxProvenance(rows[0] as InboxRow)).toContainEqual({
      label: 'could not say',
      value: 'accepted, 1 time: the source is read-only just now',
    })
  })

  it('tries a failed status again, and stops after three', async () => {
    await open({ reply: 'true' })
    const one = transport({ throws: 'the source would not take it' })
    // A minute apart, so the arithmetic under test is the count and not the
    // wait: `outboxFor` owns the wait, and this door owns the ceiling.
    for (let n = 0; n < INTAKE_REPLY_ATTEMPTS; n++) {
      await expect(say(one.post, { now: 1_000 + n * 120_000 })).rejects.toThrow()
    }
    const given = await say(one.post, { now: 1_000 + 9 * 120_000 })
    expect(given.said).toBeNull()
    expect(given.because).toContain('given up on after 3 tries')
    const rows = await inboxFrom({ home, events: await client.log.read({}) })
    expect(rows[0]?.unsent[0]).toMatchObject({ saying: 'accepted', attempts: 3 })
  })

  it('records that the source already had it, rather than posting a second one', async () => {
    // **Crash after posting.** Nothing was written down, so the status is due
    // again; the marker is the same, and the transport says it is already
    // there. What is recorded is that it went and that nothing was created.
    await open({ reply: 'true' })
    const one = transport({ already: true })
    expect((await say(one.post)).said).toBe('Queued.')
    const line = (await client.log.read({ types: ['intake_replied'] }))[0]
    expect(line?.detail).toMatchObject({ state: 'said', already: true, saying: 'accepted' })
    const rows = await inboxFrom({ home, events: await client.log.read({}) })
    expect(rows[0]?.said).toEqual(['accepted'])
    expect(rows[0]?.unsent).toEqual([])
  })

  it('writes down where the source’s revision moved, so its own words are not news', async () => {
    await open({ reply: 'true' })
    const one = transport({ revision: '2' })
    await say(one.post)
    const items = intakeFrom(await client.log.read({}))
    expect(items.get('cli:req-1')?.said[0]).toMatchObject({
      saying: 'accepted',
      sent: true,
      revision: '2',
    })
  })

  it('stops at the cap where the journal says more went than any saying can', async () => {
    // What the cap is actually for: lines saying something left this machine
    // that name no status — a journal with duplicate items, or one nobody can
    // read. Those count, because the one thing a bound must never do is
    // quietly widen.
    await open({ reply: 'true' })
    const now = Date.now()
    for (let n = 0; n < INTAKE_REPLY_CAP; n++) {
      await client.log.append({
        type: 'intake_replied',
        detail: { item: 'cli:req-1', source: 'cli', external_id: 'req-1' },
      })
    }
    const one = transport()
    const over = await say(one.post, { now })
    expect(one.posted).toEqual([])
    expect(over.because).toContain('enough has already been said back')
  })
})

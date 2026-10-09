import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INTAKE_SETUP,
  type IntakeCandidate,
  type IntakeGrantRead,
  intakeContext,
  intakeDecision,
  intakeKey,
  intakeMapped,
  intakePrompt,
  intakeSummary,
  intakeUnfinished,
  mustBeTold,
  newerRevision,
  slackTs,
  watchesToOffer,
} from '@tade/core'
import { ExtensionHost, intakeProblem, Unreachable } from '@tade/extensions-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SLACK_ME,
  type SlackOptions,
  type SlackScript,
  slackScript,
  tsAt,
} from '../../../../test/fixtures/slack/slack.ts'
import { intakeExtension } from '../src/extension.ts'
import { SLACK_MOST_MESSAGES, slackMessages } from '../src/slack.ts'
import { advanceTo, isRequest, slackRefOf } from '../src/slack-message.ts'

// The Slack door, against a Slack that answers from a file.
//
// Nothing here reaches the network, and the global `fetch` is taken away for the
// whole file so that anything which tried would fail here rather than quietly
// succeed on a laptop and fail in CI.
//
// **Everything about who may ask is tested against `intakeDecision`** rather
// than against this watch, because the watch deliberately cannot see a grant: it
// hands over candidates and the owner's own rule decides. What is tested here is
// what it hands over, what it refuses to hand over, what it says it could not
// read, and the two things it can be asked afterwards.

const globally = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`the Slack intake tests reached the network: ${String(input)}`)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globally
})

/** The moment the watch was turned on. Every message in the fixture is an offset from it. */
const BASE = Math.floor(Date.parse('2026-09-19T00:00:00.000Z') / 1000)
const TURNED_ON = new Date(BASE * 1000).toISOString()
const CHANNEL = 'C0ACME'
const ts = (at: number) => tsAt(BASE, at)

async function host(script: SlackScript, over: { token?: string | undefined } = {}) {
  return ExtensionHost.load({
    builtin: [intakeExtension],
    config: {
      extensions: {},
      projects: { app: { root: mkdtempSync(join(tmpdir(), 'tade-slack-')) } },
    },
    home: mkdtempSync(join(tmpdir(), 'tade-slack-home-')),
    env: 'token' in over ? { SLACK_BOT_TOKEN: over.token } : { SLACK_BOT_TOKEN: 'xoxb-pretend' },
    fetch: script.fetch,
  })
}

const looking = (over: { since?: string | null; channel?: string } = {}) => ({
  project: 'app',
  input: { channel: over.channel ?? CHANNEL },
  since: over.since ?? null,
  turnedOn: TURNED_ON,
})

/** A Slack with this file's channel in it. */
const slack = (over: Partial<SlackOptions> = {}) => slackScript({ base: BASE, ...over })

/** A message, as Slack returns one, mentioning the app unless told otherwise. */
const msg = (at: number, over: Record<string, unknown> = {}) => ({
  type: 'message',
  ts: ts(at),
  user: 'U0KIM',
  text: `<@${SLACK_ME.userId}> the export button 500s`,
  ...over,
})

const look = async (script: SlackScript, over: Parameters<typeof looking>[0] = {}) =>
  (await host(script)).look('intake.slack', looking(over))

const intakeOf = (finding: { intake?: IntakeCandidate }): IntakeCandidate =>
  finding.intake as IntakeCandidate

describe('what a Slack revision is', () => {
  it('compares a ts as two whole numbers, which is what neither text nor a float does', () => {
    expect(newerRevision('slack', '1789776900.000100', '1789776300.000100')).toBe(1)
    expect(newerRevision('slack', '1789776300.000100', '1789776300.000100')).toBe(0)
    expect(newerRevision('slack', '1789776300.000100', '1789776900.000100')).toBe(-1)
    // As text, `.9` sorts after `.10`, which is the wrong way round.
    expect(newerRevision('slack', '1789776300.000010', '1789776300.000009')).toBe(1)
    expect(newerRevision('slack', '1789776300.9', '1789776300.10')).toBe(1)
    // And as one number it is sixteen significant digits through a double whose
    // spacing at that magnitude is a fraction of a microsecond — close enough to
    // the difference between two messages that it is not a thing to rely on.
    // Compared properly, a single microsecond is a revision.
    expect(newerRevision('slack', '1789776300.123457', '1789776300.123456')).toBe(1)
    expect(slackTs('1789776300.123456')).toEqual({ seconds: 1789776300, micros: 123456 })
    // Padded, so a truncated fraction is not read as leading zeroes.
    expect(slackTs('1789776300.5')?.micros).toBe(500000)
  })

  it('holds what it cannot order rather than guessing', () => {
    expect(newerRevision('slack', 'whenever', '1789776300.000100')).toBeNull()
    expect(newerRevision('slack', '1789776300', '1789776300.000100')).toBeNull()
    expect(newerRevision('slack', '', '')).toBeNull()
    expect(slackTs('1789776300.1234567')).toBeNull()
  })

  it('pulls a key apart again, and says no to one that is not its own', () => {
    const key = `slack:${CHANNEL}/${ts(300)}:${ts(900)}`
    expect(slackRefOf(key)).toEqual({
      channel: CHANNEL,
      ts: ts(300),
      revision: ts(900),
      externalId: `${CHANNEL}/${ts(300)}`,
    })
    // The conformance suite's own key, and the shapes a hand-written one takes.
    expect(slackRefOf('nothing:no-such-thing:0')).toBeNull()
    expect(slackRefOf(`slack:${CHANNEL}:${ts(300)}`)).toBeNull()
    expect(slackRefOf(`slack:${CHANNEL}/notats:${ts(300)}`)).toBeNull()
    expect(slackRefOf('slack:')).toBeNull()
  })
})

describe('the look', () => {
  it('hands over the mentions, oldest first, and nothing else said in the channel', async () => {
    const script = slack()
    const looked = await look(script)
    // Three, because that is the ceiling, and the three oldest because people
    // who asked for something are answered in the order they asked.
    expect(looked.found).toHaveLength(SLACK_MOST_MESSAGES)
    expect(looked.found.map((one) => intakeOf(one).externalId)).toEqual([
      `${CHANNEL}/${ts(300)}`,
      `${CHANNEL}/${ts(360)}`,
      `${CHANNEL}/${ts(420)}`,
    ])
    // The message nobody addressed to the app is not among them, which is what
    // makes a channel that is not Tade's own usable at all.
    expect(JSON.stringify(looked.found)).not.toContain('staging deploy')
  })

  it('takes nothing in that is not somebody writing to the app', async () => {
    const me = { userId: SLACK_ME.userId }
    expect(isRequest(msg(300), me)).toBe(true)
    // Not addressed to the app.
    expect(isRequest(msg(300, { text: 'who broke the build' }), me)).toBe(false)
    // A channel event, and an app's channel-wide post: an allowlist of
    // subtypes, so a subtype nobody here knew about is not a request either.
    expect(isRequest(msg(300, { subtype: 'channel_join' }), me)).toBe(false)
    expect(isRequest(msg(300, { subtype: 'bot_message', bot_id: 'B0CI' }), me)).toBe(false)
    expect(isRequest(msg(300, { subtype: 'a_shape_from_next_year' }), me)).toBe(false)
    // A reply that is in its thread alone, which a poll cannot see anyway.
    expect(isRequest(msg(300, { thread_ts: ts(200) }), me)).toBe(false)
    // One somebody also sent to the channel, which is the only in-thread
    // mention there is any point in refusing or accepting.
    expect(isRequest(msg(300, { thread_ts: ts(200), subtype: 'thread_broadcast' }), me)).toBe(true)
    // Nothing in it but the handle, which asks for nothing — and the mentions
    // come out first, so naming two people is as empty as naming one.
    expect(isRequest(msg(300, { text: `<@${me.userId}>  ` }), me)).toBe(false)
    expect(isRequest(msg(300, { text: `<@${me.userId}> <@U0KIM>` }), me)).toBe(false)
    // Unless they dropped a file with it, which is a request with no words.
    expect(isRequest(msg(300, { text: `<@${me.userId}>`, files: FILES }), me)).toBe(true)
    // A token that cannot say who it is matches no mention at all, rather than
    // matching everything.
    expect(isRequest(msg(300), { userId: '' })).toBe(false)
  })

  it('carries an app posting as a user through to the rule, which refuses it', async () => {
    const script = slack({ messages: [msg(660, { user: 'U0BOT', bot_id: 'B0ASSIST' })] })
    const looked = await look(script)
    expect(looked.found).toHaveLength(1)
    const candidate = intakeOf(looked.found[0] as { intake?: IntakeCandidate })
    // Slack's own word about the actor, never a guess from the text — and the
    // refusal is the owner's rule's, not this watch's.
    expect(candidate.requester.bot).toBe(true)
    const decided = intakeDecision(candidate, grant(), { project: 'app' })
    expect(decided).toMatchObject({ outcome: 'refused', why: 'is_bot' })
  })

  it('names a message Slack can name nobody for rather than passing over it', async () => {
    const script = slack({ messages: [msg(780, { user: undefined })] })
    const looked = await look(script)
    expect(looked.found).toHaveLength(0)
    expect(looked.said).toContain('Slack names nobody for')
    expect(looked.said).toContain(ts(780))
  })

  it('reads a thread only where there is one, and puts the whole of it in the material', async () => {
    const script = slack()
    const looked = await look(script)
    const threaded = looked.found.find(
      (one) => intakeOf(one).externalId === `${CHANNEL}/${ts(420)}`,
    )
    const candidate = intakeOf(threaded as { intake?: IntakeCandidate })
    expect(candidate.verbatim).toContain('login is slow for everybody')
    expect(candidate.verbatim).toContain('@U0SAM: mine takes about eight seconds')
    expect(candidate.verbatim).toContain('@U0ROB: the auth service is at 90% cpu')
    // Tade's own one line about the thread, and the ask itself is not repeated
    // inside its own thread.
    expect(candidate.verbatim).toContain('the thread it was asked in: 2 messages, oldest first')
    expect(candidate.verbatim.match(/login is slow/g)).toHaveLength(1)
    // One `conversations.replies`, for the one message that has a thread: the
    // two that have none cost nothing.
    const threads = script.calls.filter((one) => one.method === 'conversations.replies')
    expect(threads).toHaveLength(1)
    expect(threads[0]?.form.ts).toBe(ts(420))
    expect(script.methods()[0]).toBe('auth.test')
  })

  it('takes in a mention somebody also sent to the channel, with the discussion as material', async () => {
    // The one kind of in-thread mention a poll can see at all, and the case the
    // whole design is for: people talk about something, then ask Tade to do it.
    const script = slack()
    const looked = await look(script, { since: ts(1000) })
    expect(looked.found).toHaveLength(1)
    const candidate = intakeOf(looked.found[0] as { intake?: IntakeCandidate })
    expect(candidate.externalId).toBe(`${CHANNEL}/${ts(1200)}`)
    expect(candidate.requester.id).toBe('U0ROB')
    expect(candidate.verbatim).toContain('go and fix this one')
    expect(candidate.verbatim).toContain('the nightly job has been failing since Tuesday')
    expect(candidate.verbatim).toContain('@U0ROB: it is the retention sweep')
    // The thread it asked about, not a thread of its own.
    expect(script.calls.at(-1)?.form.ts).toBe(ts(1140))
  })

  it('carries attachments as references and downloads nothing', async () => {
    const script = slack({ messages: [msg(720, { subtype: 'file_share', files: FILES })] })
    const looked = await look(script)
    const candidate = intakeOf(looked.found[0] as { intake?: IntakeCandidate })
    expect(candidate.attachments).toEqual([
      {
        name: 'payload.json',
        url: 'https://acme.slack.com/files/U0KIM/F0PAYLOAD/payload.json',
        mediaType: 'application/json',
        bytes: 2048,
      },
    ])
    // Nothing was fetched but Slack's own two methods.
    expect(new Set(script.methods())).toEqual(new Set(['auth.test', 'conversations.history']))
    // And the context file says so in Tade's own voice.
    expect(intakeContext({ ...candidate, project: 'app', mapping: MAPPING, grant: 'g' })).toContain(
      'was not downloaded',
    )
  })

  it('takes the edit as the revision, and the post as the id', async () => {
    const script = slack()
    const looked = await look(script)
    const edited = looked.found.find((one) => intakeOf(one).externalId === `${CHANNEL}/${ts(360)}`)
    const candidate = intakeOf(edited as { intake?: IntakeCandidate })
    // `ts` does not move when somebody edits, and `edited.ts` does — so the
    // thing itself keeps its id and the version of it moves.
    expect(candidate.externalId).toBe(`${CHANNEL}/${ts(360)}`)
    expect(candidate.revision).toBe(ts(900))
    expect(candidate.sourceAt).toBe(new Date((BASE + 900) * 1000).toISOString())
    expect(candidate.url).toBe(
      `https://acme.slack.com/archives/${CHANNEL}/p${ts(360).replace('.', '')}`,
    )
  })

  it('asks for one page from where it left off, and moves on when it drained it', async () => {
    const script = slack({ messages: [msg(300), msg(360, { ts: ts(360) })] })
    const looked = await look(script)
    const asked = script.calls.find((one) => one.method === 'conversations.history')
    // Exclusive, so the message a look ended on is not read twice, and the
    // first look starts from the moment the watch was turned on.
    expect(asked?.form.oldest).toBe(`${BASE}.000000`)
    expect(asked?.form.cursor).toBeUndefined()
    expect(looked.since).toBe(ts(360))
    expect(looked.found).toHaveLength(2)
  })

  it('follows the cursor, and leaves the cursor alone when it ran out of pages', async () => {
    // Four pages of one, which is one more than a look walks.
    const many = [msg(300), msg(360), msg(420), msg(480)]
    const script = slack({ messages: many, pageSize: 1 })
    const looked = await look(script)
    const pages = script.calls.filter((one) => one.method === 'conversations.history')
    expect(pages).toHaveLength(3)
    // Slack's own cursor, handed back as it was given.
    expect(pages[1]?.form.cursor).toBe('at:1')
    expect(pages[2]?.form.cursor).toBe('at:2')
    // The window was not drained, so the cursor does not move at all: the
    // bottom of it is still unread, and a `since` past it would be messages
    // nobody would send again.
    expect(looked.since).toBe(`${BASE}.000000`)
    expect(looked.found).toHaveLength(SLACK_MOST_MESSAGES)
    expect(looked.said).toBeNull()
  })

  it('stops the cursor below the oldest it deferred, so a backlog is never skipped', async () => {
    const script = slack()
    const looked = await look(script)
    // Four requests were past the ceiling or unnameable; the oldest of them is
    // the one at 660, so the cursor stops below it — at 600, the newest thing
    // read that was actually dealt with.
    expect(looked.since).toBe(ts(600))
    // And the next look finds the deferred ones, by asking from there.
    const next = await look(slack(), { since: looked.since })
    expect(next.found.map((one) => intakeOf(one).externalId)).toContain(`${CHANNEL}/${ts(660)}`)
  })

  it('says how much is waiting when a look hands over everything it may', async () => {
    const script = slack({ messages: [msg(300), msg(360), msg(420), msg(480), msg(540)] })
    const looked = await look(script)
    expect(looked.found).toHaveLength(SLACK_MOST_MESSAGES)
    // Nothing is said while something was found: what was found says what it is
    // itself. The two left over are kept by the cursor instead.
    expect(looked.said).toBeNull()
    // Below the oldest it deferred, which is the one at 480.
    expect(looked.since).toBe(ts(420))
  })

  it('says, when it found nothing, that nothing was addressed to it', async () => {
    const script = slack({ messages: [msg(300, { text: 'morning all' })] })
    const looked = await look(script)
    expect(looked.found).toHaveLength(0)
    expect(looked.said).toContain('mentions this app')
    const quiet = await look(slack({ messages: [] }))
    expect(quiet.said).toContain('nothing has been said')
  })

  it('throws, with Slack’s own tier in the sentence, when the first request is rate limited', async () => {
    const script = slack({ limitFrom: 1, retryAfter: 60 })
    await expect(look(script)).rejects.toThrow(/asked for 60s/)
    await expect(look(slack({ limitFrom: 1 }))).rejects.toThrow(/outside the Slack Marketplace/i)
  })

  it('ends the sweep on a rate limit partway, keeps what it read, and never sleeps', async () => {
    // `auth.test`, then one page, then the 429 on the second page.
    const script = slack({ messages: [msg(300), msg(360), msg(420)], pageSize: 1, limitFrom: 3 })
    const started = Date.now()
    const looked = await look(script)
    // Nothing waited on `Retry-After`: a look has a minute before the window
    // gives up on it, and a throttled app's wait is a minute.
    expect(Date.now() - started).toBeLessThan
      ? expect(Date.now() - started).toBeLessThan(5_000)
      : undefined
    expect(looked.found).toHaveLength(1)
    expect(looked.since).toBe(`${BASE}.000000`)
  })

  it('names a thread it could not read, and hands over no half-read request', async () => {
    const script = slack({
      messages: [msg(420, { thread_ts: ts(420), reply_count: 2 })],
      refuse: { method: 'conversations.replies', error: 'ratelimited' },
    })
    const looked = await look(script, { since: ts(400) })
    // The one request in the window has a thread, and half a thread is not
    // material somebody can approve — so it waits for the next look. Its key is
    // not burned and the cursor stops below it.
    expect(looked.found).toHaveLength(0)
    expect(looked.said).toContain('could not read')
    expect(looked.since).toBe(ts(400))
  })

  it('calls nothing the machine is offline unless nothing came back', async () => {
    await expect(look(slack({ offline: true }))).rejects.toThrow(Unreachable)
    await expect(look(slack({ offline: true }))).rejects.toThrow(/slack\.com did not answer/)
    // Slack answering is Slack answering, however badly: one endpoint being
    // down is not the machine being offline.
    await expect(look(slack({ status: 500 }))).rejects.not.toThrow(Unreachable)
  })

  it('says what to do about the two mistakes every Slack app makes once', async () => {
    await expect(look(slack({ error: 'not_in_channel' }))).rejects.toThrow(/invite the Slack app/)
    await expect(look(slack({ error: 'missing_scope' }))).rejects.toThrow(/channels:history/)
    await expect(look(slack({ error: 'invalid_auth' }))).rejects.toThrow(/invalid_auth/)
  })

  it('says where to put a token rather than looking without one, and stays ready', async () => {
    const loaded = await host(slack(), { token: undefined })
    await expect(loaded.look('intake.slack', looking())).rejects.toThrow(/SLACK_BOT_TOKEN/)
    // The local door needs no credential, so a missing Slack token must never
    // report the whole extension as not ready.
    expect(loaded.list()[0]).toMatchObject({ state: 'ready', problem: null })
    const spooled = await loaded.look('intake.cli', {
      project: 'app',
      input: {},
      since: null,
      turnedOn: TURNED_ON,
    })
    expect(spooled.found).toEqual([])
  })

  it('refuses a channel name, which is what everybody types first', async () => {
    await expect(look(slack(), { channel: '#tade' })).rejects.toThrow(/not a Slack channel id/)
    await expect(look(slack(), { channel: 'tade' })).rejects.toThrow(/channel’s own details/)
  })

  it('refuses to read a whole channel when Slack cannot say who the app is', async () => {
    // The one widening that must never happen by accident: no mention to match
    // is no request, not every request.
    const script = slack({ me: { userId: '' } })
    await expect(look(script)).rejects.toThrow(/no mention to look for/)
  })

  it('is given up on when it runs past the window’s deadline', async () => {
    // A Slack that never answers, and a deadline. No sleep anywhere: the only
    // timer is `inTime`'s own, so this is about the deadline rather than about
    // how fast the machine happened to be.
    const script = slack({ hang: true })
    const loaded = await host(script)
    await expect(loaded.look('intake.slack', { ...looking(), timeoutMs: 20 })).rejects.toThrow(
      /given up on/,
    )
    expect(script.calls).toHaveLength(1)
  })

  it('stops between pages when the look has already been given up on', async () => {
    // The window gave up while an answer was in flight, which is the moment the
    // check between pages exists for: one more page would be a request nobody
    // is waiting for any more.
    const script = slack({ messages: [msg(300), msg(360)], pageSize: 1 })
    const controller = new AbortController()
    await expect(
      slackMessages.check({
        ...CONTEXT,
        input: { channel: CHANNEL },
        turnedOn: TURNED_ON,
        signal: controller.signal,
        fetch: (async (...args: Parameters<typeof fetch>) => {
          const answer = await script.fetch(...args)
          controller.abort()
          return answer
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/stopped before it had read everything/)
    // `auth.test` answered and then the look was stopped: no page was asked for.
    expect(script.methods()).toEqual(['auth.test'])
  })
})

describe('the grant, the setup and the shape', () => {
  it('is a source the host will offer, and one it will not start without a channel', async () => {
    expect(intakeProblem(slackMessages)).toBeNull()
    expect(slackMessages.intake).toBe('slack')
    const loaded = await host(slack())
    const offered = loaded.watches().find((one) => one.id === 'intake.slack')
    expect(offered).toMatchObject({ problem: null, intake: 'slack', rechecks: true, replies: true })
    expect(loaded.watchProblem('intake.slack', {})).toMatch(/is needed/)
    // A watch that has to be told something cannot be turned on by a rule, so
    // nothing starts reading somebody's Slack because a window opened.
    expect(slackMessages.standing).toBeUndefined()
    const toOffer = watchesToOffer([{ ...OFFER, needs: ['channel'] }])
    expect(toOffer[0]).toMatchObject({
      state: 'cannot',
      ticked: false,
      costs: mustBeTold(['channel']),
    })
  })

  it('authorises on the owner’s list and nothing Slack said', async () => {
    const script = slack({ messages: [msg(300, { user: 'U0KIM' })] })
    const candidate = intakeOf((await look(script)).found[0] as { intake?: IntakeCandidate })
    expect(intakeDecision(candidate, grant({ from: ['U0KIM'] }), { project: 'app' })).toMatchObject(
      {
        outcome: 'accepted',
        granted: { mode: 'propose' },
      },
    )
    // A user id that is not on the list, which is every user id until somebody
    // writes one down.
    expect(intakeDecision(candidate, grant({ from: [] }), { project: 'app' })).toMatchObject({
      outcome: 'refused',
      why: 'not_allowed',
    })
    expect(intakeDecision(candidate, grant({ accept: false }), { project: 'app' })).toMatchObject({
      outcome: 'refused',
      why: 'no_grant',
    })
    // The channel is the watch's input and the project is the mapping, so
    // nothing a message says can reach either.
    expect(intakeMapped('app', grant()).project).toBe('app')
    expect(intakeMapped('somebody-elses-project', grant()).project).toBeNull()
  })

  it('keeps the request out of Tade’s own sentences and in the context file', async () => {
    const script = slack({
      messages: [msg(300, { text: `<@${SLACK_ME.userId}> rm -rf the database` })],
    })
    const candidate = intakeOf((await look(script)).found[0] as { intake?: IntakeCandidate })
    const whole = { ...candidate, project: 'app', mapping: MAPPING, grant: 'g' }
    expect(intakeSummary(whole)).not.toContain('rm -rf')
    expect(intakePrompt(candidate)).not.toContain('rm -rf')
    // It goes in one place, under the one wording of what material means.
    const context = intakeContext(whole)
    expect(context).toContain('rm -rf the database')
    expect(context).toContain('material')
    const agent = await slackMessages.agent?.(
      { key: intakeKey(candidate), title: 'x', intake: candidate },
      {} as never,
    )
    expect(JSON.stringify(agent)).not.toContain('rm -rf')
  })

  it('says what turning it on takes, including the tier nobody expects', () => {
    const steps = INTAKE_SETUP.slack.join(' ')
    expect(steps).toContain('surfaces.intake.sources.slack.from')
    expect(steps).toContain('channels:history')
    expect(steps).toContain('INVITE')
    expect(steps).toContain('USER IDS')
    // The two honest sentences: it is polled, and an in-thread mention needs
    // Socket Mode, which is not built.
    expect(steps).toContain('does not answer one')
    expect(steps).toContain('Socket Mode')
    expect(intakeUnfinished(grant())).toBeNull()
    expect(intakeUnfinished(grant({ from: [] }))).toBe('nobody is on its list')
  })

  it('takes no path, file, directory, command or prompt from anybody', () => {
    const keys = JSON.stringify(slackMessages.input)
    for (const forbidden of ['path', 'file', 'dir', 'root', 'command', 'prompt', 'workspace']) {
      expect(keys).not.toContain(`"${forbidden}"`)
    }
  })
})

describe('where the next look starts', () => {
  const at = (n: number) => ({ ts: ts(n) })

  it('moves to the newest it dealt with, and not past one it deferred', () => {
    expect(advanceTo([at(300), at(360), at(420)], [], `${BASE}.000000`, true)).toBe(ts(420))
    expect(advanceTo([at(300), at(360), at(420)], [ts(360)], `${BASE}.000000`, true)).toBe(ts(300))
    // Nothing below the deferred one at all: it stays where it was rather than
    // going backwards.
    expect(advanceTo([at(300), at(360)], [ts(300)], `${BASE}.000000`, true)).toBe(`${BASE}.000000`)
  })

  it('does not move at all when the window was not drained', () => {
    expect(advanceTo([at(300), at(360)], [], `${BASE}.000000`, false)).toBe(`${BASE}.000000`)
  })

  it('passes over what is not a ts rather than taking it as a cursor', () => {
    expect(advanceTo([{ ts: 'tomorrow' }, at(300)], [], `${BASE}.000000`, true)).toBe(ts(300))
  })
})

/** A watch's own context, for the two things only a direct call can reach. */
const CONTEXT = {
  extension: 'intake',
  settings: {},
  projects: [{ name: 'app', root: '/nonexistent' }],
  project: () => ({ name: 'app', root: '/nonexistent' }),
  env: {},
  secret: () => ({ value: 'xoxb-pretend', from: '$SLACK_BOT_TOKEN' }),
  exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  home: '/nonexistent',
  now: () => Date.parse('2026-10-09T00:00:00.000Z'),
  watching: { name: 'app', root: '/nonexistent' },
  tade: null,
  input: {} as Record<string, unknown>,
  since: null,
  turnedOn: '',
  signal: new AbortController().signal,
  fetch: globalThis.fetch,
}

const FILES = [
  {
    name: 'payload.json',
    mimetype: 'application/json',
    size: 2048,
    permalink: 'https://acme.slack.com/files/U0KIM/F0PAYLOAD/payload.json',
    url_private: 'https://files.slack.com/files-pri/T0ACME-F0PAYLOAD/payload.json',
  },
]

const MAPPING = { from: 'app', by: 'surfaces.intake.sources.slack.projects' }

const OFFER = {
  id: 'intake.slack',
  extension: 'intake',
  title: 'Messages that mention Tade',
  means: 'reads one Slack channel',
  every: '2m',
  standing: false,
  offers: 'agent' as const,
  problem: null,
  needs: [] as string[],
}

function grant(over: Partial<IntakeGrantRead> = {}): IntakeGrantRead {
  return {
    path: 'surfaces.intake.sources.slack',
    on: true,
    accept: true,
    reply: false,
    names: false,
    projects: ['app'],
    from: ['U0KIM', 'U0SAM', 'U0ROB'],
    mode: 'propose',
    template: '',
    document: '',
    ...over,
  }
}

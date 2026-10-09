import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INTAKE_SAYINGS,
  type IntakeCandidate,
  intakeAgain,
  intakeMark,
  intakeSays,
} from '@tade/core'
import { ExtensionHost, Unreachable } from '@tade/extensions-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SLACK_ME,
  type SlackOptions,
  type SlackScript,
  slackScript,
  tsAt,
} from '../../../../test/fixtures/slack/slack.ts'
import { intakeExtension } from '../src/extension.ts'
import { SLACK_REACTIONS, slackSayingOf } from '../src/slack-message.ts'

// The two things a Slack request can be asked after a look found it: whether it
// still stands at the moment the queue would start work on it, and the one
// status Tade may say back.
//
// Its own file because it is the half with a *write* in it, and because the
// three rules that keep that write from turning into a loop are only testable
// together: a status moves no revision, Tade's own words are not material, and
// one status is said once however many times the asking is interrupted.

const globally = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`the Slack intake tests reached the network: ${String(input)}`)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = globally
})

const BASE = Math.floor(Date.parse('2026-09-19T00:00:00.000Z') / 1000)
const TURNED_ON = new Date(BASE * 1000).toISOString()
const CHANNEL = 'C0ACME'
const ts = (at: number) => tsAt(BASE, at)

async function host(script: SlackScript) {
  return ExtensionHost.load({
    builtin: [intakeExtension],
    config: {
      extensions: {},
      projects: { app: { root: mkdtempSync(join(tmpdir(), 'tade-slack-')) } },
    },
    home: mkdtempSync(join(tmpdir(), 'tade-slack-home-')),
    env: { SLACK_BOT_TOKEN: 'xoxb-pretend' },
    fetch: script.fetch,
  })
}

const slack = (over: Partial<SlackOptions> = {}) => slackScript({ base: BASE, ...over })

const msg = (at: number, over: Record<string, unknown> = {}) => ({
  type: 'message',
  ts: ts(at),
  user: 'U0KIM',
  text: `<@${SLACK_ME.userId}> the export button 500s`,
  ...over,
})

const intakeOf = (finding: { intake?: IntakeCandidate }): IntakeCandidate =>
  finding.intake as IntakeCandidate

const look = async (script: SlackScript, since: string | null = null) =>
  (await host(script)).look('intake.slack', {
    project: 'app',
    input: { channel: CHANNEL },
    since,
    turnedOn: TURNED_ON,
  })

describe('whether a request still stands', () => {
  const key = (at: number, revision = at) => `slack:${CHANNEL}/${ts(at)}:${ts(revision)}`
  const recheck = async (script: SlackScript, one: string, channel = CHANNEL) =>
    (await host(script)).recheck('intake.slack', {
      project: 'app',
      input: { channel },
      key: one,
    })

  it('stands while the ask is the ask it was', async () => {
    expect(await recheck(slack({ messages: [msg(300)] }), key(300))).toEqual({ still: true })
  })

  it('reads one message and never its thread', async () => {
    const script = slack()
    await recheck(script, key(420))
    const asked = script.calls.filter((one) => one.method === 'conversations.history')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.form).toMatchObject({ oldest: ts(420), latest: ts(420), inclusive: 'true' })
    expect(script.methods()).not.toContain('conversations.replies')
  })

  it('holds an ask that was edited after the work was made', async () => {
    const script = slack({ messages: [msg(300)] })
    script.edit(ts(300), '<@ME> actually, delete the export feature', 900)
    expect(await recheck(script, key(300))).toMatchObject({
      still: false,
      because: expect.stringContaining('was edited'),
    })
  })

  it('does not hold for a reply, which is the whole reason this is not GitHub', async () => {
    const script = slack({ messages: [msg(300)] })
    script.replyTo(ts(300), { user: 'U0SAM', text: 'thanks, looking', at: 400 })
    // A Slack thread is several messages with their own ids, so a comment is
    // visibly not an edit of the ask. On GitHub the same event moves
    // `updated_at` and re-parks an approval a person has just given.
    expect(await recheck(script, key(300))).toEqual({ still: true })
  })

  it('holds one that was deleted, or that this app can no longer see', async () => {
    const script = slack({ messages: [msg(300)] })
    script.remove(ts(300))
    expect(await recheck(script, key(300))).toMatchObject({
      still: false,
      because: expect.stringContaining('not there to read any more'),
    })
    const gone = slack({ messages: [msg(300)], error: 'channel_not_found' })
    expect(await recheck(gone, key(300))).toMatchObject({
      still: false,
      because: expect.stringContaining('cannot be read any more'),
    })
  })

  it('holds one whose mention has been taken out of it', async () => {
    const script = slack({ messages: [msg(300)] })
    script.edit(ts(300), 'never mind', 900)
    expect(await recheck(script, key(300))).toMatchObject({
      still: false,
      because: expect.stringContaining('no longer mentions this app'),
    })
  })

  it('holds what it was not told enough to check, and what is not its channel', async () => {
    const script = slack({ messages: [msg(300)] })
    expect(await recheck(script, key(300), '')).toMatchObject({
      still: false,
      because: expect.stringContaining('without the channel'),
    })
    expect(await recheck(script, `slack:C0OTHER/${ts(300)}:${ts(300)}`)).toMatchObject({
      still: false,
      because: expect.stringContaining(`is not in ${CHANNEL}`),
    })
    expect(await recheck(script, 'nothing:no-such-thing:0')).toMatchObject({ still: false })
  })

  it('throws rather than answering no when Slack could not be asked', async () => {
    // A rate limit, a 500 and an outage are not "no longer stands": the start
    // door turns a throw into a hold saying the source could not be asked, and
    // an inaccessible source is never permission.
    await expect(recheck(slack({ limitFrom: 1 }), key(300))).rejects.toThrow(/rate limited/)
    await expect(recheck(slack({ offline: true }), key(300))).rejects.toThrow(Unreachable)
  })

  it('holds a revision that went backwards, which cannot have happened', async () => {
    const script = slack({ messages: [msg(300)] })
    expect(await recheck(script, key(300, 900))).toMatchObject({
      still: false,
      because: expect.stringContaining('earlier than'),
    })
  })
})

describe('saying a status back', () => {
  const key = `slack:${CHANNEL}/${ts(300)}:${ts(300)}`
  const say = async (script: SlackScript, saying: string, over: { key?: string } = {}) =>
    (await host(script)).reply('intake.slack', {
      project: 'app',
      input: { channel: CHANNEL },
      key: over.key ?? key,
      say: intakeSays(saying as never, { names: false }),
      mark: intakeMark(`slack:${CHANNEL}/${ts(300)}`, saying as never),
    })

  it('puts a reaction on the ask and the sentence in its own thread', async () => {
    const script = slack({ messages: [msg(300)] })
    const receipt = await say(script, 'accepted')
    expect(receipt.already).toBeUndefined()
    expect(script.reactions).toContain(`${ts(300)}:inbox_tray`)
    const posted = script.calls.find((one) => one.method === 'chat.postMessage')
    expect(posted?.form.text).toBe('Queued.')
    // In the thread of the thing it is about, and never broadcast over the
    // channel.
    expect(posted?.form.thread_ts).toBe(ts(300))
    expect(posted?.form.reply_broadcast).toBeUndefined()
    // The marker rides in metadata, which Slack shows nobody.
    expect(JSON.parse(String(posted?.form.metadata)).event_payload.mark).toContain(':accepted')
    expect(posted?.form.text).not.toContain('tade:')
  })

  it('says one status once, however many times it is asked', async () => {
    const script = slack({ messages: [msg(300)] })
    await say(script, 'accepted')
    const again = await say(script, 'accepted')
    // The reaction is the claim Slack remembers; the thread is read, Tade's own
    // marker is found, and nothing is created.
    expect(again.already).toBe(true)
    expect(script.calls.filter((one) => one.method === 'chat.postMessage')).toHaveLength(1)
  })

  it('finishes a reply that died between the reaction and the words', async () => {
    const script = slack({ messages: [msg(300)] })
    // What a window that crashed after reacting leaves behind.
    script.reactions.add(`${ts(300)}:inbox_tray`)
    const receipt = await say(script, 'accepted')
    expect(receipt.already).toBeUndefined()
    expect(script.calls.filter((one) => one.method === 'chat.postMessage')).toHaveLength(1)
  })

  it('does not read another app’s marker as a status of its own', async () => {
    // Slack only lets an app set metadata as itself, but an `event_type` is not
    // namespaced to an app — so another one could write the same marker, and a
    // status read as already said is a status that silently never goes.
    const mark = intakeMark(`slack:${CHANNEL}/${ts(300)}`, 'accepted')
    const script = slack({
      messages: [msg(300)],
      threads: {
        [ts(300)]: [
          msg(300),
          {
            type: 'message',
            ts: ts(310),
            thread_ts: ts(300),
            user: 'U0SOMEBODY',
            bot_id: 'B0OTHER',
            text: 'Queued.',
            metadata: { event_type: 'tade_intake_status', event_payload: { mark } },
          },
        ],
      },
    })
    // What a window that crashed after reacting leaves behind, so the thread is
    // read: the only thing in it carrying Tade's marker is somebody else's.
    script.reactions.add(`${ts(300)}:inbox_tray`)
    const receipt = await say(script, 'accepted')
    expect(receipt.already).toBeUndefined()
    expect(script.calls.filter((one) => one.method === 'chat.postMessage')).toHaveLength(1)
  })

  it('reports no revision, because nothing it does moves one', async () => {
    const script = slack({ messages: [msg(300)] })
    const receipt = await say(script, 'noticed')
    expect(receipt.revision).toBeUndefined()
    // And the proof: the next look reads the message again and reads the same
    // revision and the same hash, so `intakeAgain` has nothing to re-park.
    const looked = await look(script, ts(299))
    const candidate = intakeOf(looked.found[0] as { intake?: IntakeCandidate })
    expect(candidate.revision).toBe(ts(300))
    expect(
      intakeAgain(
        {
          ...ITEM,
          revision: ts(300),
          taken: ts(300),
          hash: candidate.material.hash,
        },
        candidate,
      ),
    ).toMatchObject({ again: 'ignore' })
  })

  it('leaves its own words out of what an agent reads as material', async () => {
    const script = slack({ messages: [msg(420, { thread_ts: ts(420), reply_count: 1 })] })
    await say(script, 'accepted', { key: `slack:${CHANNEL}/${ts(420)}:${ts(420)}` })
    const looked = await look(script, ts(419))
    const candidate = intakeOf(looked.found[0] as { intake?: IntakeCandidate })
    // By this app's own ids and its own metadata, not by matching the text —
    // which would be defeated the first time somebody quoted a status back.
    expect(candidate.verbatim).not.toContain('Queued')
    expect(candidate.verbatim).toContain('the export button 500s')
  })

  it('has one reaction per status, so no two statuses share an idempotency slot', () => {
    const named = INTAKE_SAYINGS.map((saying) => SLACK_REACTIONS[saying])
    expect(new Set(named).size).toBe(INTAKE_SAYINGS.length)
    for (const saying of INTAKE_SAYINGS) {
      expect(slackSayingOf(intakeMark('slack:C0ACME/1.0', saying))).toBe(saying)
    }
    expect(slackSayingOf('tade:slack:C0ACME/1.0:whatever')).toBeNull()
  })

  it('posts nothing it cannot name a status for, and nothing for another channel', async () => {
    const script = slack({ messages: [msg(300)] })
    await expect(
      (await host(script)).reply('intake.slack', {
        project: 'app',
        input: { channel: CHANNEL },
        key,
        say: 'Queued.',
        mark: 'tade:slack:C0ACME/1.0:not-a-status',
      }),
    ).rejects.toThrow(/nothing was posted/)
    await expect(
      say(script, 'accepted', { key: `slack:C0OTHER/${ts(300)}:${ts(300)}` }),
    ).rejects.toThrow(/is not in C0ACME/)
    expect(script.methods()).not.toContain('chat.postMessage')
  })

  it('is an ordinary error when Slack will not take the write, and stops no look', async () => {
    const script = slack({
      messages: [msg(300)],
      refuse: { method: 'chat.postMessage', error: 'missing_scope' },
    })
    await expect(say(script, 'accepted')).rejects.toThrow(/missing_scope/)
    // The work carries on being built: nothing a source does to a reply may
    // stop it, and the look still works.
    expect((await look(script, ts(299))).found).toHaveLength(1)
  })
})

const ITEM = {
  item: `slack:${CHANNEL}/${ts(300)}`,
  source: 'slack',
  externalId: `${CHANNEL}/${ts(300)}`,
  revision: '',
  taken: '',
  project: 'app',
  requester: 'U0KIM',
  grant: 'surfaces.intake.sources.slack',
  template: null,
  ref: '',
  url: '',
  correlation: '',
  watch: '',
  schedule: '',
  mode: null,
  task: null,
  tasks: [],
  state: 'accepted' as const,
  why: null,
  hash: '',
  attempts: 0,
  failedAt: 0,
  problem: null,
  gaveUp: false,
  at: 0,
  replies: [],
  said: [],
}

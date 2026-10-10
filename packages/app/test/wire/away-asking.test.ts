import type { Arm } from '@tade/core'
import { chatRev } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { AWAY_CONTROLS, awayPanel } from '../../src/panels/away/state.ts'
import { PLAIN } from '../../src/skin.ts'
import { deviceSaid, emptyTranscript, youSaid } from '../../src/transcript.ts'
import { transcriptLines } from '../../src/transcript-view.ts'
import {
  ask,
  closeAll,
  DEVICE,
  KEY,
  type Machine,
  machine,
  paired,
  waitFor,
} from './away-harness.ts'

// The window's own end of talking: one message carried through a real listener
// into a conversation the window holds, and the four ways it is refused.
//
// **Everything here is real but the browser and the model**, and the model is
// the one thing that could not be: what `askRemote` does with the words is a
// turn in another process. What is under test is the part that decides —
// whether the words are handed over at all, under which arm, and what the
// window and the journal say about it afterwards.

afterEach(closeAll)

/** A machine with talking on and a device granted `ask`, listening. */
async function ready(
  over: {
    scopes?: readonly string[]
    busy?: boolean
    whose?: string
    ask?: (said: string, arm: Arm) => Promise<void>
    stop?: () => Promise<boolean>
    talking?: boolean
  } = {},
): Promise<Machine> {
  const one = await machine({ talking: over.talking ?? true, ...over })
  await paired(one.home, one.port, over.scopes ?? ['read', 'ask'])
  await one.away.open()
  return one
}

/**
 * The conversation's own revision, as the projection would put it on `you`.
 *
 * **Through the same function both sides use**, never a literal: two spellings
 * of one revision is a comparison that is always true or always false.
 */
function revOf(busy = false): string {
  return chatRev({ busy })
}

describe('one message, all the way through', () => {
  it('reaches the conversation under an arm, and is written down as the device’s', async () => {
    const one = await ready()
    const answer = await ask(one.port, 'ask', {
      was: revOf(),
      key: KEY,
      rev: 0,
      said: 'is anything waiting for me?',
    })
    expect(answer.status).toBe(200)
    expect(answer.body.did).toBe(true)

    // **The arm**, built from the device record at the act: this device was
    // granted `ask` and nothing else, so the turn may read its own projection
    // and nothing it does can change anything.
    expect(one.armed).toEqual([{ how: 'remote', device: DEVICE, projects: null, may: [] }])
    // **The words**, in the conversation, marked as the device's.
    expect(one.said).toEqual([{ text: 'is anything waiting for me?', device: DEVICE }])

    // **The journal**, as a `web_asked` and never a `said` line: `namedBy`
    // reads those to authorise a setting change, and a request from a phone is
    // not somebody's own words.
    const lines = await waitFor(one.client, 'web_asked')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.detail).toMatchObject({ device: DEVICE, tool: 'ask', why: 'done' })
    expect(JSON.stringify(lines[0])).not.toContain('waiting for me')
    expect(await one.client.events({ types: ['said'] })).toEqual([])
  })

  it('carries the tiers the device was granted, and only those', async () => {
    const one = await ready({ scopes: ['read', 'ask', 'steer'] })
    await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: 'park the flaky one' })
    expect(one.armed).toEqual([{ how: 'remote', device: DEVICE, projects: null, may: ['steer'] }])
  })
})

describe('a message that is refused', () => {
  it('is a `404` with talking turned off, which is the path nobody built', async () => {
    // Read-only by absence: `routesFor` puts no asking route in the table, so
    // a crafted call meets the same answer as a path that was never there —
    // never a `403` naming a setting, which tells whoever is probing that
    // there is a route and what to turn on.
    const one = await ready({ talking: false })
    const answer = await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: 'hello' })
    expect(answer.status).toBe(404)
    expect(one.said).toEqual([])
  })

  it('needs `ask`, which being granted both acting tiers does not imply', async () => {
    const one = await ready({ scopes: ['read', 'answer', 'steer'] })
    const answer = await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: 'hello' })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
    expect(one.said).toEqual([])
  })

  it('refuses a second message while a turn is in flight, and says whose', async () => {
    // **The interleaving case**, and the one that is not recoverable by
    // refusing afterwards: a harness delivers a prompt that arrives mid-turn
    // *into* that turn, so a message accepted here would put a stranger's
    // words inside the person's question — and inside the person's arm.
    const one = await ready({ busy: true, whose: 'you' })
    const answer = await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: 'hello' })
    expect(answer.status).toBe(409)
    expect(answer.body.error).toBe('gone')
    // And what is true now, so the page draws it rather than a toast.
    expect(answer.body.rev).toBe('b1')
    expect(one.said).toEqual([])
  })

  it('refuses a device that was disconnected while it was typing', async () => {
    // **The arm is built from the device record at the act**, not from the
    // session the request arrived on: a session carries the scopes it was
    // minted with, and a person who disconnected a phone thirty seconds ago
    // meant it.
    const one = await ready()
    one.show()
    await one.away.panel()
    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.revoke}${DEVICE}`)
    const answer = await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: 'hello' })
    expect(answer.status).toBe(401)
    expect(one.said).toEqual([])
  })

  it('writes a refusal down too, which is the case the audit matters most in', async () => {
    const one = await ready({ scopes: ['read'] })
    await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: 'hello' })
    const lines = await waitFor(one.client, 'web_asked')
    expect(lines[0]?.detail).toMatchObject({ device: DEVICE, state: 'refused' })
  })
})

describe('stopping the turn from away', () => {
  it('stops the one in flight, and answers nothing in flight with a `404`', async () => {
    const busy = await ready({ busy: true, whose: `device ${DEVICE}` })
    const stopped = await ask(busy.port, 'stop', { was: revOf(true), key: KEY, rev: 0 })
    expect(stopped.status).toBe(200)

    const quiet = await ready({ busy: false })
    const nothing = await ask(quiet.port, 'stop', { was: revOf(), key: KEY, rev: 0 })
    expect(nothing.status).toBe(404)
  })

  it('says so rather than claiming it stopped, where the harness cannot', async () => {
    const one = await ready({ busy: true, stop: () => Promise.resolve(false) })
    const answer = await ask(one.port, 'stop', { was: revOf(true), key: KEY, rev: 0 })
    expect(answer.status).toBe(404)
    expect(answer.body.error).toBe('not_offered')
  })
})

describe('the grant, which is a keypress at this machine', () => {
  it('is its own control, and leaves acting exactly as it was', async () => {
    const one = await ready({ scopes: ['read', 'answer', 'steer'] })
    one.show()
    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.talk}${DEVICE}`)
    await one.away.reread()
    const answer = await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: 'hello' })
    expect(answer.status).toBe(200)
    // **Both, and the second control did not take the first away.** Two
    // controls over one list of scopes is how one of them silently revokes the
    // other.
    expect(one.armed[0]).toEqual({
      how: 'remote',
      device: DEVICE,
      projects: null,
      may: ['answer', 'steer'],
    })
  })

  it('takes it back, and the next message is refused', async () => {
    const one = await ready()
    one.show()
    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.talk}${DEVICE}`)
    await one.away.reread()
    const answer = await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: 'hello' })
    expect(answer.status).toBe(403)
  })
})

describe('whose words they are, where somebody reads them', () => {
  it('says a line came from a device, and says nothing about the person’s own', () => {
    // **The `said` confusion, one layer down.** A request from a phone that
    // read as something the person typed would be the same mistake in the one
    // place somebody actually reads the words.
    const at = Date.parse('2026-10-09T09:00:00.000Z')
    const mine = youSaid(emptyTranscript(), 'what is going on?', at)
    const theirs = deviceSaid(mine, 'is anything waiting for me?', at + 1, DEVICE)
    const drawn = transcriptLines(theirs, 80, PLAIN, { hover: null, pressed: null }, at + 2)
      .map((line) => line.text)
      .join('\n')
    expect(drawn).toContain(`from device ${DEVICE}, not from you`)
    expect(drawn.match(/not from you/g)).toHaveLength(1)
  })
})

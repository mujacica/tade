import type { Arm } from '@tade/core'
import { chatRev, digestOf, writeDevices } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { actions } from '../../src/commands.ts'
import { initialState } from '../../src/model.ts'
import { AWAY_CONTROLS, awayPanel } from '../../src/panels/away/state.ts'
import { PLAIN } from '../../src/skin.ts'
import { deviceSaid, emptyTranscript, youSaid } from '../../src/transcript.ts'
import { transcriptLines } from '../../src/transcript-view.ts'
import { answeredHere, FROM_AWAY, LOG_IN_IS_HERE } from '../../src/wire/web-asking.ts'
import {
  ask,
  closeAll,
  DEVICE,
  KEY,
  type Machine,
  machine,
  paired,
  SECRET,
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

/** A machine with talking on and a device paired, listening. */
async function ready(
  over: {
    busy?: boolean
    whose?: string
    ask?: (said: string, arm: Arm) => Promise<void>
    stop?: () => Promise<boolean>
    talking?: boolean
  } = {},
): Promise<Machine> {
  const one = await machine({ talking: over.talking ?? true, ...over })
  await paired(one.home, one.port)
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

    // **The arm**, built from the device record at the act: every paired
    // phone is the person's own, so its turn reaches what the keyboard does.
    expect(one.armed).toEqual([{ how: 'owner', device: DEVICE, theirs: true }])
    // **The words**, in the conversation, marked as the device's — and kept
    // as theirs, so a setting they name is named.
    expect(one.said).toEqual([{ text: 'is anything waiting for me?', device: DEVICE }])
    expect(one.theirs).toEqual(['is anything waiting for me?'])

    // **The journal**, as a `web_asked` naming the device, and never its words.
    const lines = await waitFor(one.client, 'web_asked')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.detail).toMatchObject({ device: DEVICE, tool: 'ask', why: 'done' })
    expect(JSON.stringify(lines[0])).not.toContain('waiting for me')
  })

  it('gives an owner device the keyboard’s reach on this machine, and still writes it down as the device’s', async () => {
    // A session `tade web pair --owner` minted,
    // bound to this machine, presented on the loopback listener. Every gate
    // answers its turn as a local one; nothing records it as the person.
    const one = await machine({ talking: true })
    await owned(one.home, one.port)
    await one.away.open()
    const answer = await ask(one.port, 'ask', {
      was: revOf(),
      key: KEY,
      rev: 0,
      said: 'start the flaky-test task',
    })
    expect(answer.status).toBe(200)
    expect(one.armed).toEqual([{ how: 'owner', device: DEVICE }])
    expect(one.said).toEqual([{ text: 'start the flaky-test task', device: DEVICE }])
    const lines = await waitFor(one.client, 'web_asked')
    expect(lines[0]?.detail).toMatchObject({ device: DEVICE, tool: 'ask', why: 'done' })
    expect(await one.client.events({ types: ['said'] })).toEqual([])
    expect(one.theirs).toEqual([])
  })

  it('takes a machine link’s line as the person’s where it says they typed it there', async () => {
    // From the Mac's tab for this machine: typed at the Mac's keyboard, so it
    // names a setting here as a line typed at this one would. Without the
    // word it is still the device's (above): what the Mac's orchestrator
    // passes on with tade_remote_tell never carries it.
    const one = await machine({ talking: true })
    await owned(one.home, one.port)
    await one.away.open()
    const answer = await ask(one.port, 'ask', {
      was: revOf(),
      key: KEY,
      rev: 0,
      said: 'watch the rehearsal requests on app',
      typed: true,
    })
    expect(answer.status).toBe(200)
    expect(one.armed).toEqual([{ how: 'owner', device: DEVICE, theirs: true, typed: true }])
    expect(one.theirs).toEqual(['watch the rehearsal requests on app'])
  })
})

describe('the window’s slash commands typed on the away view’s line', () => {
  it('/login is answered by the window with where the sign-in is, and never reaches the model', async () => {
    // The person's own phone, which reaches everything the keyboard does — and
    // still the words are never a turn: a model asked to sign itself in.
    const one = await ready()
    const answer = await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: ' /LOGIN ' })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ did: false, rev: revOf(), said: LOG_IN_IS_HERE })
    expect(one.armed).toEqual([])
    expect(one.said).toEqual([])
    expect(one.theirs).toEqual([])
    const lines = await waitFor(one.client, 'web_asked')
    expect(lines[0]?.detail).toMatchObject({ device: DEVICE, tool: 'ask', why: 'nothing to do' })
  })

  it('every other one is answered by the window too, what it is for included, and no turn starts', async () => {
    const one = await ready()
    const typed = ['/new fix the double charge', '/settings', '/away', '/workflows', '/Stop sentry']
    for (const [n, said] of typed.entries()) {
      // A key each: one key is one message, and these are five.
      const key = `${KEY.slice(0, -1)}${n}`
      const answer = await ask(one.port, 'ask', { was: revOf(), key, rev: 0, said })
      expect(answer.status).toBe(200)
      expect(answer.body).toMatchObject({ did: false, rev: revOf(), said: answeredHere(said) })
    }
    expect(one.armed).toEqual([])
    expect(one.said).toEqual([])
    expect(one.theirs).toEqual([])
  })

  it('has an answer for every command the window has, so a new one cannot become a sentence', () => {
    const names = actions(initialState()).map((action) => action.name)
    expect(Object.keys(FROM_AWAY).sort()).toEqual([...names].sort())
  })

  it('is only the command: a sentence about one, a path or another slash word is still Tade’s', () => {
    expect(answeredHere('/login')).toBe(LOG_IN_IS_HERE)
    expect(answeredHere('/login claude')).toBe(LOG_IN_IS_HERE)
    expect(answeredHere('why did /login fail?')).toBeNull()
    expect(answeredHere('/loginx')).toBeNull()
    expect(answeredHere('/tmp/build.log says it failed')).toBeNull()
    expect(answeredHere('/compact')).toBeNull()
  })

  it('still asks the arm first, so a device disconnected while typing one is refused', async () => {
    const one = await ready()
    one.show()
    await one.away.panel()
    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.revoke}${DEVICE}`)
    const answer = await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: '/login' })
    expect(answer.status).toBe(401)
  })
})

/** An owner device in the file, as `mintOwner` writes one, for the harness's cookie. */
async function owned(home: string, port: number): Promise<void> {
  await writeDevices(home, [
    {
      kind: 'paired',
      device: DEVICE,
      at: new Date().toISOString(),
      label: 'mac',
      digest: digestOf(SECRET),
      host: `127.0.0.1:${port}`,
      csrf: 'x'.repeat(43),
      until: new Date(Date.now() + 86_400_000).toISOString(),
      from: '',
      owner: true,
    },
  ])
}

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
    // session the request arrived on: a person who disconnected a phone
    // thirty seconds ago meant it.
    const one = await ready()
    one.show()
    await one.away.panel()
    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.revoke}${DEVICE}`)
    const answer = await ask(one.port, 'ask', { was: revOf(), key: KEY, rev: 0, said: 'hello' })
    expect(answer.status).toBe(401)
    expect(one.said).toEqual([])
  })

  it('writes a refusal down too, which is the case the audit matters most in', async () => {
    const one = await ready({ busy: true, whose: 'you' })
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

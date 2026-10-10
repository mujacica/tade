import { afterEach, describe, expect, it } from 'vitest'
import { AWAY_CONTROLS, awayPanel } from '../../src/panels/away/state.ts'
import type { Away } from '../../src/wire/web.ts'
import {
  closeAll,
  DEVICE,
  KEY,
  type Machine,
  machine,
  paired,
  parkedIn,
  act as post,
  revOf,
  waitFor,
} from './away-harness.ts'

// The window's own end of acting: the only door a scope widens through, and
// one park carried out through a real listener against a real repository.
//
// **Everything here is real but the browser**, and `away-harness.ts` says
// exactly what is not. What this file is about is the one verb that proved the
// path — the revision a phone echoes being the value the projection put on the
// row, compared against the file the workbench actually wrote, with the
// journal saying a device did it. The other seven are `away-verbs.test.ts`.

afterEach(closeAll)

/** One park, as a browser would send it. */
function act(port: number, body: Record<string, unknown>) {
  return post(port, 'park', body)
}

/** A machine with a device granted `steer`, listening, with the task in view. */
async function ready(over: { acting?: boolean } = {}): Promise<Machine> {
  const one = await machine(over)
  await paired(one.home, one.port, ['read', 'steer'])
  await one.away.open()
  return one
}

describe('one park, all the way through', () => {
  it('moves the task file and says a device did it', async () => {
    const one = await ready()

    const answer = await act(one.port, {
      task: one.task,
      parked: true,
      was: revOf(one, one.task),
      key: KEY,
      rev: 0,
    })
    expect(answer.status).toBe(200)
    await one.refresh()
    expect(answer.body).toEqual({ did: true, rev: revOf(one, one.task), said: 'set aside' })
    expect(parkedIn(one.home, one.task)).toBe(true)

    // **The provenance, in the journal.** `by` is the device and not `you`, so
    // `historyFrom` does not count it as the person's own doing — and there is
    // no `said` line anywhere, which is what keeps `namedBy` out of it.
    const changes = await one.client.events({ types: ['state_change'] })
    expect(changes.at(-1)?.detail).toMatchObject({
      state: 'parked',
      by: 'device 00112233445566aa',
    })
    expect(await one.client.events({ types: ['said'] })).toEqual([])
    const did = await waitFor(one.client, 'web_did')
    expect(did).toHaveLength(1)
    expect(did[0]?.task).toBe(one.task)
    expect(did[0]?.detail).toMatchObject({ device: '00112233445566aa', tool: 'park', why: 'done' })
  })

  it('picks it back up again, which is the same verb', async () => {
    const one = await ready()
    await one.client.parkTask(one.task, true)

    const answer = await act(one.port, {
      task: one.task,
      parked: false,
      was: revOf(one, one.task),
      key: KEY,
      rev: 0,
    })
    expect(answer.status).toBe(200)
    await one.refresh()
    expect(answer.body).toMatchObject({ did: true, rev: revOf(one, one.task) })
    expect(parkedIn(one.home, one.task)).toBe(false)
  })

  it('refuses a screen that was drawn before somebody parked it here', async () => {
    // **The stale screen, against the file.** The phone drew the row when the
    // task was not parked; somebody parked it at the keyboard since. The act
    // says what it assumed, so it is refused with what is true now and the
    // page redraws rather than undoing a decision.
    const one = await ready()
    const drawn = revOf(one, one.task)
    await one.client.parkTask(one.task, true)
    await one.refresh()

    const answer = await act(one.port, {
      task: one.task,
      parked: false,
      was: drawn,
      key: KEY,
      rev: 0,
    })
    expect(answer.status).toBe(409)
    expect(answer.body.error).toBe('gone')
    // The truth rides on the refusal, so the next frame is already consistent.
    expect(answer.body.rev).toBe(revOf(one, one.task))
    expect(parkedIn(one.home, one.task)).toBe(true)
  })

  it('refuses a replayed request, because the state it assumed has moved', async () => {
    // The same bytes twice, with the receipts deliberately out of the way: a
    // different key, so nothing about idempotency is doing the work and the
    // state re-check is what refuses it. DECISIONS §4.6.
    const one = await ready()
    const body = { task: one.task, parked: true, was: revOf(one, one.task), key: KEY, rev: 0 }
    expect((await act(one.port, body)).status).toBe(200)
    const again = await act(one.port, { ...body, key: 'second0012345678' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('gone')
  })

  it('answers the same key with the same answer, and parks nothing twice', async () => {
    const one = await ready()
    const body = { task: one.task, parked: true, was: revOf(one, one.task), key: KEY, rev: 0 }
    const first = await act(one.port, body)
    const again = await act(one.port, body)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    const changes = await one.client.events({ types: ['state_change'] })
    expect(changes.filter((event) => event.detail.state === 'parked')).toHaveLength(1)
  })

  it('answers `404` for a task that is not there, and writes nothing', async () => {
    const one = await ready()
    const answer = await act(one.port, {
      task: 'app/nothing',
      parked: true,
      was: revOf(one, one.task),
      key: KEY,
      rev: 0,
    })
    expect(answer.status).toBe(404)
    expect(answer.body.error).toBe('no_such')
  })

  it('answers `403` where the device was granted only reading', async () => {
    const one = await machine()
    await paired(one.home, one.port, [])
    await one.away.open()
    const answer = await act(one.port, {
      task: one.task,
      parked: true,
      was: revOf(one, one.task),
      key: KEY,
      rev: 0,
    })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
    expect(parkedIn(one.home, one.task)).toBe(false)
  })

  it('has no acting route at all while the setting is off', async () => {
    const one = await ready({ acting: false })
    const answer = await act(one.port, {
      task: one.task,
      parked: true,
      was: revOf(one, one.task),
      key: KEY,
      rev: 0,
    })
    expect(answer.status).toBe(404)
    expect(parkedIn(one.home, one.task)).toBe(false)
  })
})

describe('work that came from outside this machine', () => {
  it('cannot be picked up again from away, because that is approving it', async () => {
    // **A proposed intake *is* a parked task** — that is the shape the queue
    // fix chose, and approving one is `parkTask(id, false)`. So a device that
    // could lift any park could approve a stranger's ticket into an agent
    // here, which is DESIGN §9.1's *accept work from an outside source* by a
    // longer route: an act with two re-checks of its own that no phase builds.
    // Until it is built, the verb does not reach it.
    const one = await ready()
    const came = await one.client.createTask({
      project: 'app',
      slug: 'from-a-ticket',
      intent: 'intake: a ticket somebody else filed',
      by: 'intake:github',
    })
    one.watch(came.id)
    await one.client.parkTask(came.id, true)
    await one.refresh()

    const answer = await act(one.port, {
      task: came.id,
      parked: false,
      was: revOf(one, came.id),
      key: KEY,
      rev: 0,
    })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
    expect(parkedIn(one.home, came.id)).toBe(true)
  })

  it('can still be set aside from away, because a hold is always safe', async () => {
    const one = await ready()
    const came = await one.client.createTask({
      project: 'app',
      slug: 'from-a-ticket',
      intent: 'intake: a ticket somebody else filed',
      by: 'intake:github',
    })
    one.watch(came.id)
    await one.refresh()
    const answer = await act(one.port, {
      task: came.id,
      parked: true,
      was: revOf(one, came.id),
      key: KEY,
      rev: 0,
    })
    expect(answer.status).toBe(200)
    expect(parkedIn(one.home, came.id)).toBe(true)
  })

  it('is picked up at the keyboard as it always was', async () => {
    // The local door is untouched: approving a proposal is a keypress here,
    // and a rule that had broken that would have broken intake itself.
    const one = await machine()
    const came = await one.client.createTask({
      project: 'app',
      slug: 'from-a-ticket',
      intent: 'intake: a ticket somebody else filed',
      by: 'intake:github',
    })
    await one.client.parkTask(came.id, true)
    await one.client.parkTask(came.id, false)
    expect(parkedIn(one.home, came.id)).toBe(false)
  })
})

describe('letting one device act, at the machine', () => {
  it('is a keypress here, written down, and it takes effect at once', async () => {
    const one = await machine()
    await paired(one.home, one.port, [])
    await one.away.open()
    await one.away.reread()
    const body = { task: one.task, parked: true, was: revOf(one, one.task), key: KEY, rev: 0 }
    expect((await act(one.port, body)).status).toBe(403)

    // The panel's own control, by name, the way the window presses it.
    one.show()
    await grant(one.away, '00112233445566aa')
    expect(one.news.join(' ')).toContain('can act')
    const answer = await act(one.port, { ...body, key: 'second0012345678' })
    expect(answer.status).toBe(200)
    expect(parkedIn(one.home, one.task)).toBe(true)
  })

  it('takes it back the same way, and the device is read-only again', async () => {
    const one = await ready()
    await one.away.reread()
    await grant(one.away, '00112233445566aa')
    expect(one.news.join(' ')).toContain('can no longer act')
    const answer = await act(one.port, {
      task: one.task,
      parked: true,
      was: revOf(one, one.task),
      key: KEY,
      rev: 0,
    })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
  })

  it('never takes reading away as a side effect of either', async () => {
    const one = await machine()
    await paired(one.home, one.port, [])
    await one.away.open()
    await one.away.reread()
    one.show()
    await grant(one.away, '00112233445566aa')
    const view = one.away.panel()?.away
    expect(view?.devices[0]?.mayAct).toBe(true)
    const answer = await act(one.port, {
      task: one.task,
      parked: true,
      was: revOf(one, one.task),
      key: KEY,
      rev: 0,
    })
    expect(answer.status).toBe(200)
  })

  it('refuses while the setting is off, rather than writing a grant that does nothing', async () => {
    const one = await machine({ acting: false })
    await paired(one.home, one.port, [])
    await one.away.open()
    await one.away.reread()
    one.show()
    await grant(one.away, '00112233445566aa')
    // Said on the panel where the control was pressed, never swallowed.
    expect(one.away.panel()?.away?.problem).toContain('Let a paired device act')
  })

  it('says so when there is no such device', async () => {
    const one = await machine()
    await one.away.open()
    one.show()
    await grant(one.away, 'ffffffffffffffff')
    expect(one.away.panel()?.away?.problem).toContain('not paired')
  })
})

/** Press the panel's own grant control, the way a click reaches the subject. */
async function grant(away: Away, device: string): Promise<void> {
  const submit = away.submits().away
  if (submit === undefined) throw new Error('the away panel has no submit')
  await submit(awayPanel(), `${AWAY_CONTROLS.act}${device}`)
}

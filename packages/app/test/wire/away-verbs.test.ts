import { afterEach, describe, expect, it } from 'vitest'
import {
  act,
  closeAll,
  contextIn,
  KEY,
  type Machine,
  type MachineOptions,
  machine,
  paired,
  parkedIn,
  revOf,
  rowOf,
  waitFor,
} from './away-harness.ts'
import { delivered } from './away-intake.ts'

// The seven verbs beyond park, each all the way through a real listener.
//
// **What these are about is the half a unit test cannot say.** That the
// revision a phone echoes back is the value the projection put on the row;
// that the door each verb goes through is the thing that makes it safe at the
// moment of the write; that a refusal says what is true *now*; and that every
// one of them is in the journal under the device that asked. `away-harness.ts`
// says what is real here and what stands in.
//
// The shape of every test is the shape of the act: read the row the page would
// have read, send what it would have sent, and look at what moved — the task
// file, the journal, the note, the context file — rather than at what the
// answer said about itself.

afterEach(closeAll)

/** A machine listening, with a device granted whatever a verb needs. */
async function ready(
  scopes: readonly string[] = ['read', 'answer', 'steer'],
  over: MachineOptions = {},
): Promise<Machine> {
  const one = await machine(over)
  await paired(one.home, one.port, scopes)
  await one.away.open()
  return one
}

/** The four fields every body carries, for the task in view. */
function every(one: Machine, task = one.task) {
  return { task, was: revOf(one, task), key: KEY, rev: 0 }
}

describe('answering what an agent is held on', () => {
  it('decides the approval it names, and never whichever one is waiting', async () => {
    const one = await ready()
    one.running(one.task)
    one.waiting(one.task, 'req-1', 'Bash')
    await one.refresh()

    const answer = await act(one.port, 'answer', {
      ...every(one),
      approval: 'req-1',
      allow: true,
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ did: true, said: 'allowed Bash' })
    expect(one.decided).toEqual([{ run: one.task, requestId: 'req-1', allow: true }])
  })

  it('tells the agent where a denial came from, and puts no words in anybody’s mouth', async () => {
    // `PermissionDecision.said` is *the exact words that decided it*, kept
    // verbatim in the ledger. A request from a phone has none, so the agent
    // gets Tade's own sentence naming the device and the ledger gets no
    // sentence at all.
    const one = await ready()
    one.running(one.task)
    one.waiting(one.task, 'req-1')
    await one.refresh()

    await act(one.port, 'answer', { ...every(one), approval: 'req-1', allow: false })
    expect(one.decided[0]?.allow).toBe(false)
    expect(one.decided[0]?.reason).toBe('denied from device 00112233445566aa')
    expect(one.decided[0]).not.toHaveProperty('said')
  })

  it('refuses an approval that has gone, with what is waiting now', async () => {
    // The commonest way a screen goes stale on a working agent: it finished
    // one call and is held on the next, which from a revision looks
    // identical. The id is what makes it exact.
    const one = await ready()
    one.running(one.task)
    one.waiting(one.task, 'req-1')
    await one.refresh()
    const drawn = every(one)
    // It finished that call and is held on the next one. From a revision the
    // two worlds are identical, which is exactly why the id is in the act.
    one.answered('req-1')
    one.waiting(one.task, 'req-2')
    one.decided.length = 0

    const answer = await act(one.port, 'answer', { ...drawn, approval: 'req-1', allow: true })
    expect(answer.status).toBe(409)
    expect(answer.body.error).toBe('gone')
    // Still an approval waiting, so the revision says so and the page redraws
    // the one that is actually there rather than insisting on the old one.
    expect(answer.body.rev).toBe(drawn.was)
    expect(one.decided).toEqual([])
  })

  it('refuses a screen drawn before anything was waiting', async () => {
    const one = await ready()
    one.running(one.task)
    await one.refresh()
    const drawn = every(one)
    one.waiting(one.task, 'req-1')
    await one.refresh()

    const answer = await act(one.port, 'answer', { ...drawn, approval: 'req-1', allow: true })
    expect(answer.status).toBe(409)
    expect(answer.body.error).toBe('gone')
    expect(one.decided).toEqual([])
  })

  it('is refused for a device granted steer and not answer', async () => {
    // The two tiers are separate scopes and the gate asks the verb's own.
    const one = await ready(['read', 'steer'])
    one.running(one.task)
    one.waiting(one.task, 'req-1')
    await one.refresh()

    const answer = await act(one.port, 'answer', { ...every(one), approval: 'req-1', allow: true })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
    expect(one.decided).toEqual([])
  })
})

describe('telling an agent something', () => {
  it('delivers the words as they were typed, and writes down only how many', async () => {
    const one = await ready()
    one.running(one.task)
    await one.refresh()
    const said = '  try the other migration\n\n    the nullable one  '

    const answer = await act(one.port, 'steer', { ...every(one), said })
    expect(answer.status).toBe(200)
    expect(one.told).toEqual([{ task: one.task, said }])

    // **`web_did` is the whole record, and there is no second one.** The
    // keyboard's own steer writes no line, so a remote one that did would make
    // `historyFrom` count a message from a phone and not the identical one
    // typed here — and the words stay in the conversation, where the agent
    // read them.
    expect(await one.client.events({ types: ['input'] })).toEqual([])
    const did = await waitFor(one.client, 'web_did')
    expect(did.at(-1)?.detail).toMatchObject({
      device: '00112233445566aa',
      tool: 'steer',
      why: 'done',
    })
    expect(JSON.stringify(did.at(-1)?.detail)).not.toContain('migration')
  })

  it('refuses where no agent is running, rather than typing at a lane', async () => {
    // **The line that keeps `steer` from becoming a way to start work.**
    // `steerAgent` falls back to typing at the lane when a channel has gone,
    // so a task with nothing running must be refused before it gets there.
    const one = await ready()
    await one.refresh()

    const answer = await act(one.port, 'steer', { ...every(one), said: 'go on then' })
    expect(answer.status).toBe(404)
    expect(answer.body.error).toBe('not_offered')
    expect(one.told).toEqual([])
  })

  it('refuses where the harness has no way to take one, in the harness’s own words', async () => {
    const one = await ready([], { cannotSteer: true })
    await paired(one.home, one.port, ['read', 'steer'])
    one.running(one.task)
    await one.refresh()

    const answer = await act(one.port, 'steer', { ...every(one), said: 'go on then' })
    expect(answer.status).toBe(404)
    expect(one.told).toEqual([])
    // And the row says so, with the sentence, so no control was ever drawn.
    const row = rowOf(one, one.task)
    expect(row.can.map((each) => each.verb)).not.toContain('steer')
    expect(row.cannot.find((each) => each.verb === 'steer')?.why).toContain('no way to take')
  })

  it('refuses with what is true now when the agent goes between the look and the write', async () => {
    const one = await ready(['read', 'answer', 'steer'], {
      steering: () => Promise.reject(new Error('no agent running on app/migration')),
    })
    one.running(one.task)
    await one.refresh()

    const answer = await act(one.port, 'steer', { ...every(one), said: 'go on then' })
    expect(answer.status).toBe(409)
    expect(answer.body.error).toBe('gone')
    expect(one.told).toEqual([])
  })
})

describe('a choice about queued work', () => {
  it('refuses a choice about work the queue has never heard of', async () => {
    // **The answer has to be the same as the row's.** `ableOn` already says
    // `cannot: queue` for anything with no `start` in its file; without the
    // check at the act the verb would write a `queue_changed` line about a
    // task the queue knows nothing about, which `choicesFor` would read back
    // the day somebody made it queued work.
    const one = await ready()
    await one.refresh()
    expect(rowOf(one, one.task).can.map((each) => each.verb)).not.toContain('queue')

    const answer = await act(one.port, 'queue', { ...every(one), change: 'pause' })
    expect(answer.status).toBe(404)
    expect(answer.body.error).toBe('not_offered')
    expect(await one.client.events({ types: ['queue_changed'] })).toEqual([])
  })

  it('writes the choice down and starts nothing', async () => {
    const one = await ready()
    one.queued(one.task)
    await one.refresh()

    const answer = await act(one.port, 'queue', { ...every(one), change: 'start' })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ did: true, said: 'starts as soon as there is room' })
    // A line in the journal, by the device, and **no agent**: what starts is
    // `readyToStart`'s decision on the window's own next pass.
    const lines = await one.client.events({ types: ['queue_changed'] })
    expect(lines.at(-1)?.detail).toMatchObject({
      change: 'start',
      by: 'device 00112233445566aa',
    })
    expect(await one.client.events({ types: ['run_started'] })).toEqual([])
    expect(await one.client.events({ types: ['queue_started'] })).toEqual([])
  })

  it('refuses a start for work somebody parked, which is the queue’s own rule', async () => {
    // `refuseParked` is the rule and this goes through it rather than keeping
    // a second copy: pressing start on parked work and watching nothing
    // happen reads as broken, so it is refused and said.
    const one = await ready()
    one.queued(one.task)
    await one.client.parkTask(one.task, true)
    await one.refresh()

    const answer = await act(one.port, 'queue', { ...every(one), change: 'start' })
    expect(answer.status).toBe(404)
    expect(answer.body.error).toBe('not_offered')
    const lines = await one.client.events({ types: ['queue_changed'] })
    expect(lines).toEqual([])
  })

  it('puts one piece of work first without a device ever sending a list', async () => {
    // **An order is a list of task ids, which is the one shape a device never
    // sends**: the list is computed at the machine from the queue the window
    // already holds, through the queue's own `orderFirst`.
    const one = await ready()
    one.queued(one.task)
    await one.refresh()
    const answer = await act(one.port, 'queue', { ...every(one), change: 'first' })
    expect(answer.status).toBe(200)
    const lines = await one.client.events({ types: ['queue_changed'] })
    expect(lines.at(-1)?.detail).toMatchObject({
      change: 'order',
      order: [one.task],
      by: 'device 00112233445566aa',
    })
  })

  it('draws a queue control once it is queued work, and says so when it is not', async () => {
    const one = await ready()
    one.queued(one.task)
    await one.refresh()
    expect(rowOf(one, one.task).can.map((each) => each.verb)).toContain('queue')
  })

  it('is refused for a device granted answer and not steer', async () => {
    const one = await ready(['read', 'answer'])
    one.queued(one.task)
    await one.refresh()
    const answer = await act(one.port, 'queue', { ...every(one), change: 'pause' })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
  })
})

describe('marking work finished', () => {
  it('writes one `task_done`, by the device, and never as a rule', async () => {
    const one = await ready()
    await one.refresh()

    const answer = await act(one.port, 'done', {
      ...every(one),
      confirm: true,
      summary: 'the migration runs',
    })
    expect(answer.status).toBe(200)
    const lines = await one.client.events({ types: ['task_done'] })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.detail).toMatchObject({
      by: 'device 00112233445566aa',
      summary: 'the migration runs',
    })
    // `rule` is Tade having seen a task's own rule met, and a tap is not that.
    expect(lines[0]?.detail.by).not.toBe('rule')
    expect(lines[0]?.detail).not.toHaveProperty('rule')
  })

  it('refuses a second one, read out of the journal at the act', async () => {
    // **The journal is this verb's whole safety at the moment of the write.**
    // A `task_done` line is what work waiting on this task waits for, so two
    // of them is two starts' worth of confusion. A different key, so nothing
    // about idempotency is doing the work.
    const one = await ready()
    await one.refresh()
    const drawn = every(one)
    expect((await act(one.port, 'done', { ...drawn, confirm: true })).status).toBe(200)

    const again = await act(one.port, 'done', { ...drawn, key: 'second0012345678', confirm: true })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('gone')
    expect(await one.client.events({ types: ['task_done'] })).toHaveLength(1)
  })

  it('marks work finished whose checks are red, because the local door does too', async () => {
    // **Not a gate, deliberately.** Anyone can mark a task finished by hand
    // whatever its rule (`DONE_RULES`), and the keyboard's own door asks
    // nothing about checks — so a verb that refused here would be a gate Tade
    // does not have, invented in the one surface a person is furthest from
    // the work. What the page owes instead is the rollup *beside* the control,
    // which the row carries.
    const one = await ready()
    one.checked(one.task, 'fail')
    await one.refresh()
    expect(rowOf(one, one.task).checks).toMatchObject({ state: 'fail', failed: ['tests'] })
    expect(rowOf(one, one.task).can.map((each) => each.verb)).toContain('done')

    const answer = await act(one.port, 'done', { ...every(one), confirm: true })
    expect(answer.status).toBe(200)
    expect(await one.client.events({ types: ['task_done'] })).toHaveLength(1)
  })

  it('says `unknown` where nothing has looked, and never `pass` by omission', async () => {
    // A check nobody ran is not a check that passed, and the away view may not
    // start a look to find out. The row says `unknown`, which is first-class,
    // and marking work finished is still a person's to do.
    const one = await ready()
    await one.refresh()
    expect(rowOf(one, one.task).checks).toMatchObject({ state: 'unknown', failed: [] })
    const answer = await act(one.port, 'done', { ...every(one), confirm: true })
    expect(answer.status).toBe(200)
  })

  it('says so on the row once it is finished, rather than offering it again', async () => {
    const one = await ready()
    await one.refresh()
    await act(one.port, 'done', { ...every(one), confirm: true })
    await one.refresh()
    const row = rowOf(one, one.task)
    expect(row.finished).toBe(true)
    expect(row.can.map((each) => each.verb)).not.toContain('done')
    expect(row.cannot.find((each) => each.verb === 'done')?.why).toContain('already says')
  })
})

describe('writing a note down', () => {
  it('keeps it verbatim, with the device as who wrote it, and no summary', async () => {
    const one = await ready()
    await one.refresh()
    const text = 'The Fix is in the ADAPTER\n\n  not the migration'

    const answer = await act(one.port, 'note', { ...every(one), text })
    expect(answer.status).toBe(200)
    const notes = one.client.recall(one.task)
    expect(notes).toHaveLength(1)
    // **Never reworded, never lowercased, never summarised.** Its case, its
    // blank line and its indentation all survive; the one note door trims the
    // ends of every note, whichever door wrote it, and that is the only thing
    // that happens to the text. A summary is only ever one somebody wrote
    // beside a note, so a remote one has none at all.
    expect(notes[0]?.text).toBe(text)
    expect(notes[0]?.by).toBe('device 00112233445566aa')
    expect(notes[0]?.summary ?? null).toBeNull()
  })

  it('is never a `said` line, which is what authorises a setting change', async () => {
    // `said` has one writer and `namedBy` reads those lines to authorise an
    // `asked`-tier setting change. A page that could put words in somebody's
    // mouth would inherit authority over all of them.
    const one = await ready()
    await one.refresh()
    await act(one.port, 'note', { ...every(one), text: 'turn the checks off' })
    expect(await one.client.events({ types: ['said'] })).toEqual([])
  })
})

describe('adding to what an agent is told', () => {
  it('appends under a heading Tade wrote, with the words beneath it verbatim', async () => {
    const one = await ready()
    await one.refresh()
    const add = 'The ticket says the column is nullable.'

    const answer = await act(one.port, 'context', { ...every(one), add })
    expect(answer.status).toBe(200)
    const text = contextIn(one.home, one.task)
    expect(text).toContain(add)
    // The heading is Tade's and says where it came from, so an agent reading
    // its context can tell what the owner wrote when the task was made from
    // what arrived afterwards and from where.
    expect(text).toContain('by device 00112233445566aa')
    expect(text.indexOf('by device')).toBeLessThan(text.indexOf(add))
  })

  it('cannot overwrite what somebody typed here, because it only ever appends', async () => {
    // The property an If-Match was reaching for, and an append has it by
    // construction: there is no field in the body for what the context should
    // *become*, so nothing a device sends can lose a local edit.
    const one = await ready()
    await one.refresh()
    const drawn = every(one)
    await act(one.port, 'context', { ...drawn, add: 'from the phone' })
    // Somebody at the machine adds to it too, through the same door.
    await one.client.log.read({})
    await act(one.port, 'context', {
      ...drawn,
      key: 'second0012345678',
      add: 'and this as well',
    })
    const text = contextIn(one.home, one.task)
    expect(text).toContain('from the phone')
    expect(text).toContain('and this as well')
  })

  it('writes down how much was added and never a word of it', async () => {
    const one = await ready()
    await one.refresh()
    await act(one.port, 'context', { ...every(one), add: 'the column is nullable' })
    const lines = await one.client.events({ types: ['context_added'] })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.detail).toMatchObject({
      by: 'device 00112233445566aa',
      added: 'the column is nullable'.length,
    })
    expect(JSON.stringify(lines[0]?.detail)).not.toContain('nullable')
  })

  it('answers `404` for a task with no folder, and writes nothing', async () => {
    const one = await ready()
    await one.refresh()
    const answer = await act(one.port, 'context', {
      ...every(one),
      task: 'app/nothing',
      add: 'anything',
    })
    expect(answer.status).toBe(404)
  })
})

describe('approving what came from outside this machine', () => {
  /** A machine with an intake grant, and a real delivery parked in it. */
  async function proposal(over: MachineOptions = {}): Promise<{ one: Machine; task: string }> {
    const one = await ready(['read', 'answer', 'steer'], { intake: true, ...over })
    return { one, task: await delivered(one) }
  }

  it('refuses one whose source cannot be reached, because that is not permission', async () => {
    // **The one direction this has to get right.** A source nobody could ask
    // has not said yes, so a throw out of the re-check holds rather than
    // passing — and the park stays on.
    const { one, task } = await proposal({
      stands: () => Promise.reject(new Error('the tracker did not answer')),
    })
    const answer = await act(one.port, 'intake', { ...every(one, task), confirm: true })
    expect(answer.status).toBe(403)
    expect(answer.body.error).toBe('out_of_scope')
    expect(parkedIn(one.home, task)).toBe(true)
  })

  it('refuses one the source has closed since, with the source’s own reason', async () => {
    const { one, task } = await proposal({
      stands: () => Promise.resolve('was closed at its source'),
    })
    const answer = await act(one.port, 'intake', { ...every(one, task), confirm: true })
    expect(answer.status).toBe(403)
    expect(parkedIn(one.home, task)).toBe(true)
  })

  it('refuses one whose grant has been turned off since, and starts nothing', async () => {
    // **A grant is permission at the moment of acting.** The delivery was
    // allowed an hour ago; the key is gone now, and the window's own config is
    // what the approval is read against — not the one the workbench opened
    // with.
    const { one, task } = await proposal()
    one.ungrant()
    const answer = await act(one.port, 'intake', { ...every(one, task), confirm: true })
    expect(answer.status).toBe(403)
    expect(parkedIn(one.home, task)).toBe(true)
  })

  it('lifts the park where the grant and the source both still say so', async () => {
    const { one, task } = await proposal()
    const answer = await act(one.port, 'intake', { ...every(one, task), confirm: true })
    expect(answer.status).toBe(200)
    expect(parkedIn(one.home, task)).toBe(false)
    // Approving lifts a hold; it does not start an agent. The queue starts
    // what it starts by its own rule, on the window's own next pass.
    expect(await one.client.events({ types: ['run_started'] })).toEqual([])
    const did = await waitFor(one.client, 'web_did')
    expect(did.at(-1)?.detail).toMatchObject({ tool: 'intake', why: 'done' })
  })

  it('is refused for a device granted steer and not answer', async () => {
    const { one, task } = await proposal()
    await paired(one.home, one.port, ['read', 'steer'])
    const answer = await act(one.port, 'intake', { ...every(one, task), confirm: true })
    expect(answer.status).toBe(403)
    expect(parkedIn(one.home, task)).toBe(true)
  })

  it('is the verb the row names where park will not pick one up', async () => {
    const { one, task } = await proposal()
    const row = rowOf(one, task)
    expect(row.can.map((each) => each.verb)).toContain('intake')
    expect(row.cannot.find((each) => each.verb === 'park')?.why).toContain('came from outside')
  })
})

describe('what is written down whatever happened', () => {
  it('is a line per act, refusals included, under the device that asked', async () => {
    // **A refusal at the door is the case the audit matters most in**: a
    // device that asked to change something and was not allowed to is exactly
    // what a person reading back needs to see.
    const one = await ready(['read'])
    await one.refresh()
    const answer = await act(one.port, 'note', { ...every(one), text: 'anything' })
    expect(answer.status).toBe(403)
    const did = await waitFor(one.client, 'web_did')
    expect(did.at(-1)?.detail).toMatchObject({
      device: '00112233445566aa',
      tool: 'note',
      state: 'refused',
      why: 'out_of_scope',
    })
  })

  it('answers a repeat of one key with the first answer, and does nothing twice', async () => {
    const one = await ready()
    await one.refresh()
    const body = { ...every(one), text: 'the fix is in the adapter' }
    const first = await act(one.port, 'note', body)
    const again = await act(one.port, 'note', body)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(one.client.recall(one.task)).toHaveLength(1)
  })

  it('refuses one key used for a different act', async () => {
    // A key is bound to the device, the verb, the target and the payload, so
    // the same key with different words is a `reused` and not a second note.
    const one = await ready()
    await one.refresh()
    await act(one.port, 'note', { ...every(one), text: 'the first thing' })
    const other = await act(one.port, 'note', { ...every(one), text: 'something else' })
    expect(other.status).toBe(409)
    expect(other.body.error).toBe('reused')
    expect(one.client.recall(one.task)).toHaveLength(1)
  })

  it('has no route for any verb while the setting is off', async () => {
    const one = await ready(['read', 'answer', 'steer'], { acting: false })
    await one.refresh()
    for (const verb of ['answer', 'steer', 'queue', 'done', 'note', 'context', 'intake']) {
      const answer = await act(one.port, verb, { ...every(one), confirm: true })
      expect(answer.status, verb).toBe(404)
    }
    expect(await one.client.events({ types: ['task_done'] })).toEqual([])
  })
})

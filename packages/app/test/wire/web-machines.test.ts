import { ENV_FILE_SAID, KEYS_AND_AGENTS } from '@tade/core'
import { Memory } from '@tade/workbench/memory'
import { answerNotes, type NotesAsk, shareNotes } from '@tade/workbench/notes-shared'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { CANCEL, type MachinesShown } from '../../src/panels/settings/machines.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { notesFor, WaitingThere } from '../../src/wire/notes-shared.ts'
import { type MachinesHeld, machinesFrom } from '../../src/wire/web-machines.ts'

// The Machines page as this window answers the person's own phone
// (`web-machines.ts`): Settings › Machines' own grid, out of the same subject,
// a moment as an ISO string, and each press through the door the window's own
// press uses — the move written down as the device's, and refused where no
// plan is shown.

const AT = Date.parse('2026-11-22T10:00:00.000Z')

const SHOWN: MachinesShown = {
  columns: [
    { machine: 'mac', asOf: null, here: true, said: null },
    { machine: 'vps', asOf: AT, here: false, said: null },
  ],
  rows: [
    {
      id: 'secret:openai',
      kind: 'secret',
      label: 'OpenAI key',
      cells: [
        { mark: '✓', days: null, where: ['~/.zshenv:14'], said: 'only a shell sets it' },
        { mark: '✗', days: null, where: [], said: null },
      ],
    },
  ],
  looking: false,
  plan: null,
  busy: false,
  said: null,
} as unknown as MachinesShown

/** The inventory subject as the page reaches it, recording every door it went through. */
function held(shown: MachinesShown | null, fail = false) {
  const went: string[] = []
  const inventory: MachinesHeld = {
    shown: () => shown,
    look: async (origins?: boolean) => {
      went.push(`look ${origins}`)
      return null
    },
    planMove: async () => {
      went.push('plan')
      return null
    },
    move: async (by: string) => {
      went.push(`move ${by}`)
      if (fail) throw new Error('the shell would not start')
      return 'Moved.'
    },
    action: async (choice: string) => {
      went.push(`action ${choice}`)
    },
  }
  return { inventory, went }
}

function wiring(memory: Memory = Memory.open(tmp('tade-machines-'))) {
  const noted: unknown[] = []
  const wire = {
    note: (err: unknown) => noted.push(err),
    now: () => AT,
    opts: { client: { memory } },
  } as unknown as Wiring
  return { wire, noted }
}

/** A home with a note taken here that `vps` retired: waiting for a press here. */
function retiredThere() {
  const memory = Memory.open(tmp('tade-machines-'))
  const kept = memory.remember('deploys freeze on Fridays', null, 'voice', AT)
  const retire = {
    retire: { at: kept.at, text: kept.text },
    because: 'the freeze was lifted',
    by: 'device phone',
    at: new Date(AT + 1).toISOString(),
  }
  memory.take([{ line: JSON.stringify(retire) }], 'vps', AT + 2)
  return memory
}

describe('the Machines page, as this window answers a phone', () => {
  it('is Settings › Machines’ own grid, with a moment as an ISO string and the window’s words', () => {
    const { inventory } = held(SHOWN)
    const answer = machinesFrom(wiring().wire, inventory).shown()
    expect(answer.columns).toEqual([
      { machine: 'mac', asOf: null, here: true, said: null },
      { machine: 'vps', asOf: '2026-11-22T10:00:00.000Z', here: false, said: null },
    ])
    expect(answer.rows).toEqual(SHOWN.rows)
    expect(answer.file).toBe(ENV_FILE_SAID)
    expect(answer.agents).toBe(KEYS_AND_AGENTS)
  })

  it('says it is looking before the first look has come back', () => {
    const answer = machinesFrom(wiring().wire, held(null).inventory).shown()
    expect(answer).toMatchObject({ columns: null, rows: [], looking: true, plan: null })
  })

  it('goes through the window’s own doors, the move as the device’s', () => {
    const plan = { diff: ['~/.zshenv - export A=•••'], moved: ['A'], left: [] }
    const { inventory, went } = held({ ...SHOWN, plan } as MachinesShown)
    const machines = machinesFrom(wiring().wire, inventory)
    for (const press of ['look', 'plan', 'leave', 'move'] as const) {
      expect(machines.press(press, 'device d1')).toBe(true)
    }
    expect(went).toEqual(['look true', 'plan', `action ${CANCEL}`, 'move device d1'])
    expect(machines.shown().plan).toEqual(plan)
  })

  it('refuses a move with no plan shown, and moves nothing', () => {
    const { inventory, went } = held(SHOWN)
    expect(machinesFrom(wiring().wire, inventory).press('move', 'device d1')).toBe(false)
    expect(went).toEqual([])
  })

  it('lists a note taken here that another machine changed, and takes or leaves it as the device’s press', () => {
    const memory = retiredThere()
    const machines = machinesFrom(wiring(memory).wire, held(SHOWN).inventory)
    const [note] = machines.shown().notes
    expect(note).toMatchObject({
      label: 'Retired on vps',
      note: 'deploys freeze on Fridays',
      said: 'vps would retire “deploys freeze on Fridays” — device phone: the freeze was lifted',
    })
    expect(memory.all().map((one) => one.text)).toEqual(['deploys freeze on Fridays'])
    expect(machines.settle(note?.id ?? '', 'take', 'device d1')).toBe(true)
    expect(memory.all()).toEqual([])
    expect(machines.shown().notes).toEqual([])
    // Taken already: not waiting, so refused rather than written twice.
    expect(machines.settle(note?.id ?? '', 'leave', 'device d1')).toBe(false)

    const other = retiredThere()
    const leaving = machinesFrom(wiring(other).wire, held(SHOWN).inventory)
    expect(leaving.settle(leaving.shown().notes[0]?.id ?? '', 'leave', 'device d1')).toBe(true)
    expect(other.all().map((one) => one.text)).toEqual(['deploys freeze on Fridays'])
    expect(leaving.shown().notes).toEqual([])
  })

  it('shows a note taken on another machine and retired here as waiting there, only to look at, until that machine says it is not', async () => {
    // The Mac holds the link and asks; the box answers at its door and is the page here.
    const mac = Memory.open(tmp('tade-machines-'))
    const box = Memory.open(tmp('tade-machines-'))
    const kept = mac.remember('deploys freeze on Fridays', null, 'voice', AT)
    const door = (ask: NotesAsk) =>
      Promise.resolve({ status: 200, body: answerNotes(box, ask, ask.from, 'vps', AT) })
    await shareNotes(mac, door, { from: 'mac', name: 'vps' })
    box.retire({ at: kept.at }, 'the freeze was lifted', 'device phone', AT + 1)
    await shareNotes(mac, door, { from: 'mac', name: 'vps' })
    const [change] = mac.held()

    const waiting = new WaitingThere()
    const { wire } = wiring(box)
    const machines = machinesFrom(wire, held(SHOWN).inventory, waiting)
    // Done here at once, and nothing said of it before the Mac's next exchange.
    expect(box.all()).toEqual([])
    expect(machines.shown().waiting).toEqual([])
    const opening = { from: 'mac', sum: '0'.repeat(64), give: [], want: [] }
    await notesFor(wire, waiting)(
      { ...opening, held: [change?.digest ?? ''] },
      {
        device: 'd-mac',
        from: 'mac',
      },
    )
    expect(machines.shown().waiting).toEqual([
      {
        id: change?.digest,
        label: 'Retired · waits on mac',
        note: 'deploys freeze on Fridays',
        said: 'Retired here; mac still tells it to every agent there until you take it there — device phone: the freeze was lifted',
      },
    ])
    // Nothing to press here: it is the Mac's.
    expect(machines.shown().notes).toEqual([])
    expect(machines.settle(change?.digest ?? '', 'take', 'device d1')).toBe(false)
    // A round after the opening says nothing of it, and leaves what was said.
    await notesFor(wire, waiting)(
      { from: 'mac', give: [], want: [] },
      { device: 'd-mac', from: 'mac' },
    )
    expect(machines.shown().waiting).toHaveLength(1)
    // Taken on the Mac: its next opening names none, and none is shown.
    await notesFor(wire, waiting)(opening, { device: 'd-mac', from: 'mac' })
    expect(machines.shown().waiting).toEqual([])
  })

  it('says a press that failed rather than dropping it', async () => {
    const plan = { diff: [], moved: ['A'], left: [] }
    const { inventory } = held({ ...SHOWN, plan } as MachinesShown, true)
    const { wire, noted } = wiring()
    machinesFrom(wire, inventory).press('move', 'device d1')
    await new Promise((done) => setImmediate(done))
    expect(String(noted[0])).toContain('the shell would not start')
  })
})

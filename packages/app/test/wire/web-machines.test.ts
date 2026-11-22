import { ENV_FILE_SAID, KEYS_AND_AGENTS } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { CANCEL, type MachinesShown } from '../../src/panels/settings/machines.ts'
import type { Wiring } from '../../src/wire/context.ts'
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

function wiring() {
  const noted: unknown[] = []
  return { wire: { note: (err: unknown) => noted.push(err) } as unknown as Wiring, noted }
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

  it('says a press that failed rather than dropping it', async () => {
    const plan = { diff: [], moved: ['A'], left: [] }
    const { inventory } = held({ ...SHOWN, plan } as MachinesShown, true)
    const { wire, noted } = wiring()
    machinesFrom(wire, inventory).press('move', 'device d1')
    await new Promise((done) => setImmediate(done))
    expect(String(noted[0])).toContain('the shell would not start')
  })
})

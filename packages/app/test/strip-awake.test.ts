import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import { initialState, type TaskSnapshot, withProjects, withTasks } from '../src/model.ts'
import { BUTTONS, labelled } from '../src/view/foot.ts'
import { draw, renderApp } from '../src/view.ts'

// The anti-sleep hold, in the strip beside the sound.
//
// What is held here is that the button says the *state* and not the wish: on a
// machine with nothing to hold sleep off with, the setting can say yes and the
// machine still sleeps, and a button that read the setting would be claiming
// the laptop is awake because somebody asked for it to be.

/** The same row without its colour, so a label can be looked for in it. */
const plain = (row: string) =>
  row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const tasks: TaskSnapshot[] = [
  { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
]

const state = () => withTasks(withProjects(initialState(), ['checkout']), tasks)

/** The bottom row of the window, which is where the buttons are. */
const strip = (awake: Frame['awake']): string => {
  const rows = renderApp(state(), { width: 100, height: 24, screen: '', awake })
  return plain(rows[rows.length - 1] ?? '')
}

const button = (action: string) => BUTTONS.find((one) => one.action === action)

describe('the hold, in the strip', () => {
  it('sits beside the sound, because it is the same kind of control', () => {
    const names = BUTTONS.map((one) => one.action)
    expect(names.indexOf('awake')).toBe(names.indexOf('mute') + 1)
  })

  it('offers to hold sleep off, quietly, while nothing is held', () => {
    // Grey and not green: `go` is the press the window would like next, and an
    // anti-sleep hold is deliberately not one Tade asks anybody for.
    expect(
      labelled(button('awake') ?? BUTTONS[0]!, { awake: { held: false, problem: null } }),
    ).toEqual({ label: 'Keep awake', look: 'rest' })
    expect(strip({ held: false, problem: null })).toContain('Keep awake')
  })

  it('goes loud while sleep is being held off, and offers the way out', () => {
    // The state worth seeing from across the room, and the red is the press:
    // it stops something, exactly as the red beside it does.
    expect(
      labelled(button('awake') ?? BUTTONS[0]!, { awake: { held: true, problem: null } }),
    ).toEqual({ label: 'Let it sleep', look: 'danger' })
    const row = strip({ held: true, problem: null })
    expect(row).toContain('Let it sleep')
    expect(row).not.toContain('Keep awake')
  })

  it('says what is missing where there is nothing to hold it with', () => {
    // Rather than a grey button that looks exactly like one that works. Still
    // grey and still something to press: pressing it is how the reason is read.
    const frame: Pick<Frame, 'awake'> = {
      awake: { held: false, problem: 'nothing here holds sleep off' },
    }
    expect(labelled(button('awake') ?? BUTTONS[0]!, frame)).toEqual({
      label: 'No caffeinate',
      look: 'rest',
    })
    expect(strip(frame.awake)).toContain('No caffeinate')
  })

  it('draws the plain offer in a frame nothing looked for it in', () => {
    // The goldens and the README's pictures are drawn from made-up frames, and
    // what they must not do is differ by which machine drew them.
    expect(labelled(button('awake') ?? BUTTONS[0]!, {})).toEqual({
      label: 'Keep awake',
      look: 'rest',
    })
  })

  it('is something to click, like everything else in the strip', () => {
    const { hits } = draw(state(), { width: 100, height: 24, screen: '' })
    const pressable = hits.filter(
      (hit) => hit.target.kind === 'action' && hit.target.name === 'awake',
    )
    expect(pressable.length).toBeGreaterThan(0)
  })

  it('leaves the sound saying what it always said', () => {
    // The two are neighbours and one loop draws them; a change to either must
    // not quietly become a change to the other.
    const mute = button('mute') ?? BUTTONS[0]!
    expect(labelled(mute, {})).toEqual({ label: 'Mute', look: 'danger' })
    expect(labelled(mute, { muted: true })).toEqual({ label: 'Unmute', look: 'go' })
  })
})

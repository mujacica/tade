import { describe, expect, it } from 'vitest'
import { requestTherePanel } from '../src/panels/intake/there.ts'
import { close } from '../src/panels/outcome.ts'
import { panelClick, panelKey } from '../src/panels.ts'
import { PLAIN } from '../src/skin.ts'
import { draw } from '../src/view.ts'
import { MACHINE_THERE_SCREENS } from './screens/scenarios/machines-there.ts'

// One request handed to another machine, opened here (`panels/intake/there.ts`):
// a press on its row in that machine's INTAKE, a page that only reads and says
// whose it is, and no act on it — approving it is that machine's.

const scenario = (name: string) => {
  const one = MACHINE_THERE_SCREENS.find((screen) => screen.name === name)
  if (one === undefined) throw new Error(`no scenario ${name}`)
  return one
}

const actions = (drawn: ReturnType<typeof draw>) =>
  drawn.hits.flatMap((hit) => (hit.target.kind === 'action' ? [hit.target.name] : []))
const controls = (drawn: ReturnType<typeof draw>) =>
  drawn.hits.flatMap((hit) => (hit.target.kind === 'control' ? [hit.target.id] : []))

describe('a request on another machine', () => {
  it('is a press on its rows in that machine’s INTAKE, up or down', () => {
    for (const name of [
      'a-project-on-another-machine-all-of-it',
      'a-project-on-another-machine-all-of-it-down',
    ]) {
      const { state, frame } = scenario(name)
      const pressed = actions(draw(state, { ...frame, skin: PLAIN }))
      expect(pressed, name).toContain('remote-request:vps github:412')
      expect(pressed, name).toContain('remote-request:vps slack:C04/1712')
    }
  })

  it('opens on a page labelled with its machine that says approving it is that machine’s, and offers no act', () => {
    const { state, frame } = scenario('a-request-on-another-machine')
    const drawn = draw(state, { ...frame, skin: PLAIN })
    const text = drawn.rows.join('\n')
    expect(text).toContain('acme/checkout#412 on vps')
    expect(text).toContain('ON VPS')
    expect(text).toContain('Approving it is vps’s: on its tab here, or ask Tade to tell vps.')
    expect(text).toContain('THE REQUEST ITSELF')
    expect(text).toContain('Under load the webhook endpoint drops deliveries')
    expect(controls(drawn)).toEqual(['close'])
  })

  it('says as of when while the link is down, and says so where that machine no longer lists it', () => {
    const down = scenario('a-project-on-another-machine-all-of-it-down')
    const open = { ...down.state, panel: requestTherePanel('vps', 'github:412', 'its row') }
    expect(draw(open, { ...down.frame, skin: PLAIN }).rows.join('\n')).toMatch(/ON VPS ─+ +as of /)
    const gone = { ...down.state, panel: requestTherePanel('vps', 'github:999', 'its row') }
    const text = draw(gone, { ...down.frame, skin: PLAIN }).rows.join('\n')
    expect(text).toContain('vps no longer lists it')
    expect(text).toContain('its row on vps')
  })

  it('reads down on the arrows and closes on escape, enter or Close — and no letter is an act', () => {
    const panel = requestTherePanel('vps', 'github:412', 'its row')
    expect(panelKey(panel, 'escape', '')).toEqual(close)
    expect(panelKey(panel, 'enter', '\r')).toEqual(close)
    expect(panelKey(panel, 'down', '')).toEqual({ panel: { ...panel, scroll: 1 }, submit: false })
    for (const letter of ['a', 's', 'r', 't', 'y']) {
      expect(panelKey(panel, undefined, letter)).toEqual({ panel, submit: false })
    }
    expect(panelClick(panel, 'close')).toEqual(close)
    expect(panelClick(panel, 'approve')).toEqual({ panel, submit: false })
  })
})

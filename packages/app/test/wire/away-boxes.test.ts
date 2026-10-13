import { GRANTS, grantOf, reachOf, readDevices, SCOPES } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { AWAY_CONTROLS, awayPanel } from '../../src/panels/away/state.ts'
import { BOXES, type Box, readsAfter, ticked } from '../../src/wire/web-boxes.ts'
import { EVERYTHING } from '../../src/wire/web-grants.ts'
import { closeAll, DEVICE, machine, paired, projectionOf } from './away-harness.ts'

// **What a box in the Away panel grants is what the page it names needs.** A
// device given every box one at a time — act, stop agents, close projects,
// talk to Tade, change settings, see screens, read settings — had a composer
// that said *Not granted* above it, because `talk to Tade` wrote `ask` and
// not the conversation. These hold each box to the projection's own table
// (`WITHHOLDS`, through `grantOf`), and the person's own device to the fix.

afterEach(closeAll)

const boxes = Object.entries(BOXES as Record<string, Box>)

describe('what each box grants', () => {
  it('includes every reading grant the page it names is withheld under', () => {
    for (const [name, box] of boxes) {
      for (const path of box.draws) {
        const grant = grantOf(path)
        expect(grant, `${name}: ${path}`).not.toBeNull()
        expect(box.reads, `${name}: ${path}`).toContain(grant)
      }
      for (const scope of box.scopes) expect(SCOPES, name).toContain(scope)
      for (const grant of box.reads) expect(GRANTS, name).toContain(grant)
    }
  })

  it('is all of it under full access, so full access ticks every box', () => {
    const full = { scopes: [...EVERYTHING.scopes], granted: [...EVERYTHING.granted] }
    for (const [name, box] of boxes) expect(ticked(full, box), name).toBe(true)
  })

  it('takes back what it gave, and not what another box gives', () => {
    const device = { granted: ['titles', 'settings', 'talk'] }
    expect(readsAfter({ granted: ['titles'] }, BOXES.talk, true)).toEqual(['titles', 'talk'])
    expect(readsAfter(device, BOXES.talk, false)).toEqual(['titles', 'settings'])
    // `read settings` is a box of its own, so turning changing off leaves reading.
    expect(readsAfter(device, BOXES.configure, false)).toEqual(['titles', 'settings', 'talk'])
  })
})

describe('the device that was given every box one at a time', () => {
  // The record the person's own `web-devices.jsonl` held: every scope a box
  // writes, and of the reading grants only the two with a box of their own.
  const SCOPED = ['read', 'answer', 'steer', 'agents', 'projects', 'ask', 'configure']
  const READS = ['lanes', 'settings']

  it('is not drawn as talking until it can read the conversation, and one press makes it so', async () => {
    const one = await machine({ talking: true })
    await paired(one.home, one.port, SCOPED, READS)
    await one.away.open()
    await one.away.reread()
    one.show()
    const drawn = one.away.panel()?.away?.devices[0]
    expect(drawn).toMatchObject({ mayAct: true, mayTalk: false, mayReadSettings: true })
    expect(drawn?.full).toBe(false)

    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.talk}${DEVICE}`)
    const held = (await readDevices(one.home)).devices[0]
    expect(held?.scopes).toEqual(expect.arrayContaining(SCOPED))
    expect(held?.granted).toEqual([...READS, 'talk'])
    expect(one.away.panel()?.away?.devices[0]?.mayTalk).toBe(true)
    // And what the phone is sent: the conversation, and the composer with it.
    const reach = reachOf({ id: DEVICE, projects: null, granted: held?.granted ?? [] })
    const seen = projectionOf(one, reach.granted)
    expect(seen.you.reads).toContain('talk')
    expect(seen.pages.chat.omitted).toBe(0)
  })
})

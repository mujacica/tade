import { GRANTS, readDevices, SCOPES } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { AWAY_CONTROLS, awayPanel } from '../../src/panels/away/state.ts'
import { closeAll, DEVICE, machine, paired, waitFor } from './away-harness.ts'

// **Full access, as one press** — the owner's default for a device let in now,
// given from the panel to one paired before it: every reading grant and every
// scope, written down as the other grants are, and taken back the same way.
// A device paired read-only (as every device was until the default changed)
// could otherwise never be given Spend, talk or the workflows, because no
// other box grants a reading grant but screens and settings.

afterEach(closeAll)

describe('full access, from the panel', () => {
  it('gives a read-only device everything, writes it down, and takes it back', async () => {
    const one = await machine()
    await paired(one.home, one.port, ['read'], [])
    await one.away.open()
    one.show()

    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.everything}${DEVICE}`)
    const given = (await readDevices(one.home)).devices[0]
    expect(given?.granted).toEqual([...GRANTS])
    expect(given?.scopes).toEqual([...SCOPES])
    expect(one.news.at(-1)).toBe('iPhone has full access')
    const line = (await waitFor(one.client, 'web_paired'))[0] as { detail: Record<string, string> }
    expect(line.detail).toMatchObject({ device: DEVICE, granted: 'at the machine' })
    expect(one.away.panel()?.away?.devices[0]?.full).toBe(true)

    await one.away.submits().away?.(awayPanel(), `${AWAY_CONTROLS.everything}${DEVICE}`)
    const taken = (await readDevices(one.home)).devices[0]
    expect(taken?.granted).toEqual([])
    expect(taken?.scopes).toEqual(['read'])
    expect(one.news.at(-1)).toBe('iPhone reads names and counts only')
  })
})

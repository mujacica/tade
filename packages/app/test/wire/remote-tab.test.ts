import { rm } from 'node:fs/promises'
import type { FarAgent, FarEnd } from '@tade/remotes-core/far'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'
import { linkedToIpax } from './linked.ts'

// Another machine's project tabs along the top, through the whole window:
// this machine's tabs carry no name of their own, a tab there is pressed and
// stood in, and its `×` and `≡` are there as a tab here has them — the close
// that machine's own, asked over the link at its door.

const DOORBELL: FarAgent = { task: 'tade/doorbell', title: 'Doorbell', screen: '> ring' }

describe('another machine’s project tabs along the top', () => {
  let terminal: FakeTerminal
  const fars: FarEnd[] = []
  const wired = windowUnderTest((one) => {
    terminal = one.terminal
  })

  afterEach(async () => {
    await Promise.all(fars.map((far) => far.close()))
    await Promise.all(fars.map((far) => rm(far.home, { recursive: true, force: true })))
    fars.length = 0
  })

  const rows = () => screenOf(terminal.written)
  const top = () => rows()[0] ?? ''
  const said = (what: string) => () => `${what}, where the screen shows:\n${rows().join('\n')}`
  /** The column a label starts at in the top row, after the machine's name. */
  const onTop = (label: string) => top().indexOf(label, top().indexOf('ipax'))

  const linked = () => linkedToIpax(wired, (far) => fars.push(far), [DOORBELL])

  it('names no machine before this one’s tabs, and goes to a project there when its tab is pressed', async () => {
    await linked()
    expect(top()).not.toContain('this Mac')
    expect(top()).toMatch(/T A D E\s+\S/)
    wired.click(onTop(' tade ') + 2, 0)
    await until(
      said('its agents down the side'),
      () => wired.sidebar().includes('Doorbell'),
      20_000,
    )
    expect(wired.sidebar()).toContain('on ipax')
  })

  it('has a × and a ≡ on a tab there, and the ≡ says what cannot cross the link', async () => {
    await linked()
    wired.click(onTop(' hello ') + 2, 0)
    await until(said('standing in hello'), () => rows().some((row) => row.includes('none there')))
    // The tab you are in keeps its controls on every rung of the ladder.
    await until(said('its ≡'), () => onTop('≡') > onTop(' hello '))
    wired.click(onTop('≡'), 0)
    await until(said('its menu'), () => rows().some((row) => row.includes('Close on ipax')))
    const menu = rows().join('\n')
    expect(menu).toContain('Ask ipax…')
    expect(menu).toContain('renamed on ipax’s own window')
    expect(menu).toContain('its settings are ipax’s')
  })

  it('closes the project there when its × is pressed, and stands back here', async () => {
    const far = await linked()
    wired.click(onTop(' hello ') + 2, 0)
    await until(said('standing in hello'), () => rows().some((row) => row.includes('none there')))
    await until(said('its ×'), () => onTop('×') > onTop(' hello '))
    wired.click(onTop('×'), 0)
    await until(
      () => `a close asked of ipax, where it did: ${JSON.stringify(far.acted)}`,
      () => far.acted.some((one) => one.verb === 'close'),
      20_000,
    )
    expect(far.acted.find((one) => one.verb === 'close')?.call).toMatchObject({ project: 'hello' })
    await until(said('the close said'), () => rows().some((row) => row.includes('ipax:')), 20_000)
    await until(said('back here'), () => !rows().some((row) => row.includes('none there')))
  })
})

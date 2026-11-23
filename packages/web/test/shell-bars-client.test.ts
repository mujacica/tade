import { describe, expect, it } from 'vitest'
import { shellBars } from '../src/assets/shell-bars.js'

// The bars the shell raises about the page itself, moved out of `boot.js`
// whole: which stand for which state, in what order, and that the two that
// reload do so only on a press.

const NONE = { refused: null, restart: false, changed: false, newer: false }
const DOES = { reload: () => {}, update: () => {} }

describe('the shell’s own bars', () => {
  it('raises none where nothing is owed', () => {
    expect(shellBars(NONE, DOES)).toEqual([])
  })

  it('stands them in their order: a copy refused, code newer, the page changed, a new version', () => {
    const all = shellBars({ refused: 'insecure', restart: true, changed: true, newer: true }, DOES)
    expect(all.map((one) => one.key)).toEqual(['refused', 'restart', 'changed', 'update'])
  })

  it('says why a copy was refused, by which of the two it was', () => {
    const [insecure] = shellBars({ ...NONE, refused: 'insecure' }, DOES)
    const [browser] = shellBars({ ...NONE, refused: 'browser' }, DOES)
    expect(insecure?.lead).toBe('This address cannot keep a copy of this page.')
    expect(browser?.lead).toBe('This browser will not keep a copy of this page.')
  })

  it('reloads only on a press, and says the restart is at the machine with none', () => {
    const [restart] = shellBars({ ...NONE, restart: true }, DOES)
    expect(restart?.press).toBeUndefined()
    expect(restart?.under).toContain('restarted at the machine')
    const [changed] = shellBars({ ...NONE, changed: true }, DOES)
    const [update] = shellBars({ ...NONE, newer: true }, DOES)
    expect(changed?.press?.said).toBe('Reload')
    expect(update?.press?.said).toBe('Reload')
  })
})

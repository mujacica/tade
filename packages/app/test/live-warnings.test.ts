import { describe, expect, it } from 'vitest'
import { saidOnce } from '../src/live.ts'

// A look's warnings (`live.ts`), kept the way a watch keeps its keys: said
// when one appears, not again while it stands, and again if it went and came back.

describe('a look’s warnings', () => {
  it('are said once while they stand, and again only once one has gone and come back', () => {
    const gone = 'tade/merge-main-016b01a: no worktree of its own any more; its files are in …'
    const first = saidOnce(new Set(), [gone])
    expect(first.fresh).toEqual([gone])
    const again = saidOnce(first.standing, [gone, 'another'])
    expect(again.fresh).toEqual(['another'])
    const still = saidOnce(again.standing, ['another', gone])
    expect(still.fresh).toEqual([])
    const left = saidOnce(still.standing, ['another'])
    expect(left.fresh).toEqual([])
    expect(saidOnce(left.standing, ['another', gone]).fresh).toEqual([gone])
  })
})

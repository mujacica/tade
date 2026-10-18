import type { Arm } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { Thinker } from '../../src/wire/context.ts'
import { cannotTalk } from '../../src/wire/orchestrator-away.ts'

// Whether the window hands a turn from away to the orchestrator at all, by the
// arm it would run under. Sentry TADE-4: under Claude Code every message from
// the person's own phone was refused, because the harness cannot hold its own
// tool calls — which only a narrowed turn needs.

const DEVICE = 'a1b2c3d4e5f60718'
const yours: Arm = { how: 'owner', device: DEVICE, theirs: true }
const link: Arm = { how: 'owner', device: DEVICE }
const narrowedOne: Arm = { how: 'remote', device: DEVICE, projects: null, may: [] }

/** A thinker on a harness that cannot be narrowed, as Claude Code's is. */
const unarmable = {
  askFrom: async () => {},
  unarmed: () => 'has no place for pi extensions',
} as unknown as Thinker

describe('a turn from away, on a harness that cannot be narrowed', () => {
  it('is answered for an owner, whose turn is the keyboard’s', () => {
    expect(cannotTalk(unarmable, yours)).toBeNull()
    expect(cannotTalk(unarmable, link)).toBeNull()
  })

  it('is refused for a device somebody narrowed, in the harness’s own words', () => {
    expect(cannotTalk(unarmable, narrowedOne)).toBe('has no place for pi extensions')
  })

  it('is refused for everybody while nothing is there to answer', () => {
    expect(cannotTalk(null, yours)).toBe('Tade is still starting')
    expect(cannotTalk({} as Thinker, yours)).toBe('this Tade cannot answer a paired device')
  })
})

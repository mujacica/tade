import { heldFor } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { type Machine, NO_DETAIL } from '../../src/machines.ts'
import { initialState } from '../../src/model.ts'
import { showTalk, talkTab } from '../../src/talk-tab.ts'
import type { Wiring } from '../../src/wire/context.ts'
import { RemoteTalks } from '../../src/wire/remote-talk.ts'

// The card a machine's tab asks for when its link comes back, when that
// machine does not give one: an older Tade is let be, and anything else it
// answered is said on its tab — never a return that nobody hears about.

const NOW = Date.UTC(2026, 9, 17, 9, 0)

const vps: Machine = {
  name: 'vps',
  link: 'live',
  rev: 3,
  said: null,
  asOf: NOW,
  heard: true,
  projects: [],
  spend: null,
  talk: { lines: [], rev: 'b0', busy: false, whose: null, mine: true, more: 0 },
  detail: NO_DETAIL,
}

/** A window standing on vps's tab, linked to a machine that answers the card with `status`. */
function linkedTo(status: number) {
  let state = showTalk(initialState(), talkTab('vps'))
  const wire = {
    get state() {
      return state
    },
    put: (next: typeof state) => {
      state = next
    },
    now: () => NOW,
    draw: () => {},
  } as unknown as Wiring
  const asked: string[] = []
  const talks = new RemoteTalks(wire, {
    reach: () => ({
      link: {
        request: async (_name: string, path: string) => {
          asked.push(path)
          return { status, body: { error: 'broke', said: 'something went wrong here' } }
        },
      } as never,
      remote: { session: { device: 'a1' } } as never,
      live: true,
    }),
    machines: () => ({ here: 'this Mac', remotes: [vps] }),
    skew: () => 0,
  })
  return { talks, asked }
}

const live = { ...heldFor('vps'), link: { kind: 'live' as const, since: NOW }, heardAt: NOW }

describe('a card that does not come', () => {
  it('is said on its tab where the machine refused it', async () => {
    const { talks, asked } = linkedTo(500)
    talks.moved('vps', live)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toEqual(['/api/since'])
    const entries = talks.facts().talk?.transcript.entries ?? []
    expect(entries).toEqual([
      {
        kind: 'problem',
        text: 'what was missed on vps could not be asked: vps: something went wrong here',
        at: NOW,
      },
    ])
  })

  it('is let be where an older Tade there has none to give', async () => {
    const { talks, asked } = linkedTo(404)
    talks.moved('vps', live)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toEqual(['/api/since'])
    expect(talks.facts().talk?.transcript.entries).toEqual([])
  })
})

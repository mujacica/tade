import { testRemoteLink } from '@tade/remotes-core/conformance'
import type { FarEnd } from '@tade/remotes-core/far'
import { describe, expect, it } from 'vitest'
import { makeScriptedLink, type ScriptedRemote } from '../src/index.ts'

// The far ends are real away views (`far.ts`); this link reaches each by name
// out of a table, over loopback, with nothing carrying it.
const remotes = new Map<string, ScriptedRemote>()

testRemoteLink('scripted', async (options) => ({
  link: makeScriptedLink({ ...options, remotes }),
  reach: async (far: FarEnd) => {
    const address = `far-${remotes.size}`
    remotes.set(address, far)
    return { address, tade: 'tade' }
  },
  close: async () => remotes.clear(),
}))

describe('a scripted link with nothing in its table', () => {
  it('reaches no remote, and says so rather than dialling one', async () => {
    const link = makeScriptedLink({ home: '/nonexistent/home' })
    await expect(link.pair({ address: 'vps', tade: 'tade', label: 'mac' })).rejects.toThrow(
      'no scripted remote called vps',
    )
  })
})

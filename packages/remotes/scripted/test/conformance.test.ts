import { testRemoteLink } from '@tade/remotes-core/conformance'
import type { FarEnd } from '@tade/remotes-core/far'
import { describe, expect, it } from 'vitest'
import { makeScriptedLink, type ScriptedRemote } from '../src/index.ts'

// The far ends are real away views (`far.ts`); this link reaches each by name
// out of a table, over loopback, with nothing carrying it — and, asked to,
// opens a terminal there in a shell here, which is where they are.
const remotes = new Map<string, ScriptedRemote>()

for (const terminals of [false, true]) {
  describe(terminals ? 'opening terminals in a shell here' : 'opening none', () => {
    testRemoteLink('scripted', async (options) => ({
      link: makeScriptedLink({ ...options, remotes, terminals }),
      reach: async (far: FarEnd) => {
        const address = `far-${remotes.size}`
        remotes.set(address, far)
        return { address, tade: 'tade' }
      },
      close: async () => remotes.clear(),
    }))
  })
}

describe('a scripted link with nothing in its table', () => {
  it('reaches no remote, and says so rather than dialling one', async () => {
    const link = makeScriptedLink({ home: '/nonexistent/home' })
    await expect(link.pair({ address: 'vps', tade: 'tade', label: 'mac' })).rejects.toThrow(
      'no scripted remote called vps',
    )
  })
})

describe('meeting a scripted remote', () => {
  const at = (identity?: ScriptedRemote['identity']): ScriptedRemote => ({
    port: 1,
    pair: () => Promise.reject(new Error('not here')),
    revoke: () => Promise.resolve(),
    ...(identity === undefined ? {} : { identity }),
  })

  it('answers one it has no word on as met before', async () => {
    const link = makeScriptedLink({ home: '/nonexistent/home', remotes: new Map([['vps', at()]]) })
    expect(await link.identify('vps')).toMatchObject({ state: 'known', said: '' })
  })

  it('trusts one never met only for exactly what it offers, and knows it after', async () => {
    const vps = at({ fingerprints: ['ED25519 SHA256:a'], known: 'new' })
    const link = makeScriptedLink({ home: '/nonexistent/home', remotes: new Map([['vps', vps]]) })
    expect(await link.identify('vps')).toMatchObject({
      state: 'new',
      fingerprints: ['ED25519 SHA256:a'],
    })
    await expect(link.trust('vps', ['ED25519 SHA256:b'])).rejects.toThrow(
      'offers something other than what was shown',
    )
    expect((await link.identify('vps')).state).toBe('new')
    expect((await link.trust('vps', ['ED25519 SHA256:a'])).state).toBe('known')
    expect((await link.identify('vps')).state).toBe('known')
  })

  it('never trusts one whose identity changed, and says so', async () => {
    const vps = at({ fingerprints: ['ED25519 SHA256:c'], known: 'changed' })
    const link = makeScriptedLink({ home: '/nonexistent/home', remotes: new Map([['vps', vps]]) })
    expect((await link.identify('vps')).said).toContain('not what this machine met before')
    await expect(link.trust('vps', ['ED25519 SHA256:c'])).rejects.toThrow(
      'not what this machine met before',
    )
  })
})

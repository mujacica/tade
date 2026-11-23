import { existsSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Remote } from '@tade/remotes-core'
import { afterAll, describe, expect, it } from 'vitest'
import { makeSshLink, masterArgs } from '../src/index.ts'
import { accepted, commentFor, keyOf, signInArgs } from '../src/own-key.ts'
import { startSshd } from './sshd.ts'

// A key of its own for each machine link, held against a real `sshd`: minted
// at pairing and written there as one line, signed in with alone, taken back
// out at signing out — and a machine whose sshd reads its keys from somewhere
// else is signed into as before, and said so, rather than paired and then
// unreachable.

const sshd = await startSshd()
afterAll(async () => {
  if (typeof sshd !== 'string') await sshd.stop()
})

const cannot = typeof sshd === 'string' ? sshd : null
const SESSION = { device: 'ab12cd34', cookie: 'ab12cd34.secret', csrf: 'x', host: 'localhost:7654' }

describe('what a link signs in with', () => {
  it('is its own key alone where one is here, and whatever ssh picks where none is', () => {
    expect(signInArgs('/nowhere/at/all')).toEqual([])
    expect(signInArgs(import.meta.filename)).toEqual([
      '-i',
      import.meta.filename,
      '-o',
      'IdentitiesOnly=yes',
    ])
    const paths = { control: '/r/a.ctl', forward: '/r/a.sock' }
    const master = masterArgs(paths, 7654, 'vps', signInArgs(import.meta.filename))
    expect(master.slice(master.indexOf('-i'), master.indexOf('-i') + 4)).toEqual(
      signInArgs(import.meta.filename),
    )
    expect(master.indexOf('-i')).toBeLessThan(master.indexOf('--'))
  })

  it('is kept by the name the config holds, and nothing that could leave its folder', () => {
    expect(keyOf('/h', 'vps')).toBe('/h/links/ssh/vps')
    for (const name of ['../x', 'VPS', 'a/b', ''])
      expect(() => keyOf('/h', name), name).toThrow(/remotes/)
  })

  it('is named in its line there for the machine it lets in, in characters a comment keeps', () => {
    expect(commentFor('Amir’s MacBook Pro', 'vps')).toBe('tade-link:Amir-s-MacBook-Pro->vps')
    expect(commentFor('', 'vps')).toBe('tade-link:a-machine->vps')
  })

  it('is proved by the key ssh says the server took, never by another one it offered', () => {
    const said = [
      'debug1: Offering public key: /h/links/ssh/vps ED25519 SHA256:abc explicit',
      'debug1: Server accepts key: /h/links/ssh/vps ED25519 SHA256:abc explicit',
    ].join('\n')
    expect(accepted(said, '/h/links/ssh/vps')).toBe(true)
    expect(accepted(said, '/h/links/ssh/vp')).toBe(false)
    expect(accepted('debug1: Server accepts key: /home/me/.ssh/id_ed25519 ED25519', '/h/k')).toBe(
      false,
    )
  })
})

describe.skipIf(cannot !== null)(
  `a key of its own per machine link, over a real sshd${cannot ? ` (${cannot})` : ''}`,
  () => {
    /** A Tade there that pairs and signs out as the real one prints, and writes down what it ran. */
    async function tadeThere(dir: string): Promise<string> {
      const tade = join(dir, 'tade-there')
      await writeFile(
        tade,
        [
          '#!/bin/sh',
          `echo "$*" >> '${dir}/ran'`,
          `[ "$2" = pair ] && printf '%s' '${JSON.stringify(SESSION)}'`,
          'exit 0',
          '',
        ].join('\n'),
      )
      await chmod(tade, 0o755)
      return tade
    }

    /** The suite's client config without its own key: what reaches it is this link's key or nothing. */
    async function onlyTheLinksKey(config: string): Promise<string> {
      const bare = `${config}-bare`
      const lines = (await readFile(config, 'utf8')).split('\n')
      await writeFile(bare, lines.filter((line) => !/Identit/.test(line)).join('\n'))
      return bare
    }

    it('is written there as one line at pairing, signs in alone, and is taken back out with the session', async () => {
      if (typeof sshd === 'string') throw new Error(cannot ?? '')
      const tade = await tadeThere(sshd.dir)
      const authorized = join(sshd.dir, 'authorized_keys')
      const theirs = await readFile(authorized, 'utf8')
      const home = join(sshd.dir, 'home')
      const options = { home, authorizedKeys: authorized }
      const link = makeSshLink({ ...options, args: ['-F', sshd.config] })

      const paired = await link.pair({
        address: 'far',
        tade,
        label: 'mac',
        ownCredentialFor: 'vps',
      })
      expect(paired).toMatchObject(SESSION)
      expect(paired.signsIn).toMatch(/signs in there with a key of its own/)
      expect(paired.signsIn).toContain('tade-link:mac->vps')
      const key = keyOf(home, 'vps')
      expect(existsSync(key)).toBe(true)
      const lines = (await readFile(authorized, 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toBe(theirs.trim())
      expect(lines[1]).toMatch(/^ssh-ed25519 \S+ tade-link:mac->vps$/)

      // Signed into with nothing but that key: the person's own is not offered.
      const alone = makeSshLink({ ...options, args: ['-F', await onlyTheLinksKey(sshd.config)] })
      const remote: Remote = { name: 'vps', address: 'far', tade, session: SESSION }
      await alone.unpair(remote)
      expect(await readFile(join(sshd.dir, 'ran'), 'utf8')).toContain(
        `web revoke ${SESSION.device}`,
      )
      expect((await readFile(authorized, 'utf8')).trim()).toBe(theirs.trim())
      expect(existsSync(key)).toBe(false)
      expect(existsSync(`${key}.pub`)).toBe(false)
    })

    it('is a way in that machine takes back by taking out its one line', async () => {
      if (typeof sshd === 'string') throw new Error(cannot ?? '')
      const tade = await tadeThere(sshd.dir)
      const authorized = join(sshd.dir, 'authorized_keys')
      const theirs = await readFile(authorized, 'utf8')
      const home = join(sshd.dir, 'home')
      const link = makeSshLink({ home, authorizedKeys: authorized, args: ['-F', sshd.config] })
      await link.pair({ address: 'far', tade, label: 'mac', ownCredentialFor: 'box' })
      await writeFile(authorized, theirs)

      const alone = makeSshLink({
        home,
        authorizedKeys: authorized,
        args: ['-F', await onlyTheLinksKey(sshd.config)],
      })
      const refused = await alone
        .unpair({ name: 'box', address: 'far', tade, session: SESSION })
        .then(
          () => 'signed out',
          (err: unknown) => String(err),
        )
      expect(refused).toMatch(/no longer takes this link’s own key/)
      // And it says the line it would have taken out is the one already gone.
      expect(refused).toContain('tade-link:mac->box')
    })

    it('is taken back out where that machine reads its keys from somewhere else, and said', async () => {
      if (typeof sshd === 'string') throw new Error(cannot ?? '')
      const tade = await tadeThere(sshd.dir)
      const elsewhere = join(sshd.dir, 'not-read-by-sshd')
      const home = join(sshd.dir, 'home')
      const link = makeSshLink({ home, authorizedKeys: elsewhere, args: ['-F', sshd.config] })

      const paired = await link.pair({
        address: 'far',
        tade,
        label: 'mac',
        ownCredentialFor: 'odd',
      })
      expect(paired).toMatchObject(SESSION)
      expect(paired.signsIn).toMatch(/would not sign in with odd’s own key/)
      expect(paired.signsIn).toMatch(/signed into as before/)
      expect((await readFile(elsewhere, 'utf8')).trim()).toBe('')
      expect(existsSync(keyOf(home, 'odd'))).toBe(false)
    })

    it('is not made where nobody asked for one', async () => {
      if (typeof sshd === 'string') throw new Error(cannot ?? '')
      const tade = await tadeThere(sshd.dir)
      const authorized = join(sshd.dir, 'authorized_keys')
      const theirs = await readFile(authorized, 'utf8')
      const home = join(sshd.dir, 'home')
      const link = makeSshLink({ home, authorizedKeys: authorized, args: ['-F', sshd.config] })
      const paired = await link.pair({ address: 'far', tade, label: 'mac' })
      expect(paired.signsIn).toBeUndefined()
      expect(await readFile(authorized, 'utf8')).toBe(theirs)
    })
  },
)

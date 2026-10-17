import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProgram } from '@tade/core'
import { LinkError } from '@tade/remotes-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeSshLink } from '../src/index.ts'
import { fingerprintOf } from '../src/known.ts'
import { type Sshd, startSshd } from './sshd.ts'

// Meeting a machine for the first time, against a fresh `sshd` this one has
// never connected to (`known.ts`): its key is shown, nothing is written down
// until the person says so, exactly what they were shown is what is written,
// and a key that changed is said plainly and never trusted past.

// Asked once whether one will start here at all, and skipped with the reason where not.
const fresh = await startSshd({ met: false })
if (typeof fresh !== 'string') await fresh.stop()
const suite = typeof fresh === 'string' ? describe.skip : describe

suite(`meeting a machine${typeof fresh === 'string' ? ` (${fresh})` : ''}`, () => {
  let sshd: Sshd
  let known: string
  beforeEach(async () => {
    // A fresh one per test: each starts as a machine never met.
    const started = await startSshd({ met: false })
    if (typeof started === 'string') throw new Error(started)
    sshd = started
    known = join(sshd.dir, 'known_hosts')
  })
  afterEach(async () => {
    await sshd?.stop()
  })

  const link = () => makeSshLink({ home: sshd.dir, args: ['-F', sshd.config] })
  const login = () =>
    runProgram('ssh', ['-F', sshd.config, '-o', 'BatchMode=yes', 'far', 'true'], {
      timeoutMs: 15_000,
    })
  /** What `ssh-keygen -l` says the machine's own key is. */
  const itsKey = async () => {
    const ran = await runProgram('ssh-keygen', ['-lf', join(sshd.dir, 'host.pub')], {
      timeoutMs: 10_000,
    })
    const [, digest, ...rest] = ran.stdout.trim().split(/\s+/)
    return `${(rest.at(-1) ?? '').replace(/[()]/g, '')} ${digest}`
  }

  it('shows its key, writes nothing, and is refused until the person trusts it', async () => {
    const seen = await link().identify('far')
    expect(seen.state).toBe('new')
    expect(seen.fingerprints).toEqual([await itsKey()])
    expect(seen.where).toBe(known)
    expect(await readFile(known, 'utf8').catch(() => '')).toBe('')
    expect((await login()).stderr).toMatch(/Host key verification failed/)

    const trusted = await link().trust('far', seen.fingerprints)
    expect(trusted.state).toBe('known')
    // Written the way ssh writes it: the name it is known by, its type, its key.
    const port = /Port (\d+)/.exec(await readFile(sshd.config, 'utf8'))?.[1]
    const written = (await readFile(known, 'utf8')).trim()
    expect(written).toMatch(new RegExp(`^\\[127\\.0\\.0\\.1\\]:${port} ssh-ed25519 `))
    expect(fingerprintOf(written)).toBe(await itsKey())
    expect((await login()).code).toBe(0)
    // Known now, and trusting it again writes nothing more.
    expect(await link().identify('far')).toMatchObject({ state: 'known', fingerprints: [] })
    await link().trust('far', seen.fingerprints)
    expect((await readFile(known, 'utf8')).trim()).toBe(written)
  })

  it('trusts nothing but exactly what the person was shown', async () => {
    await expect(link().trust('far', ['ED25519 SHA256:somebody-else'])).rejects.toThrow(
      /not what you were shown/,
    )
    expect(await readFile(known, 'utf8').catch(() => '')).toBe('')
  })

  it('says plainly when the key changed, and never trusts past it', async () => {
    const seen = await link().identify('far')
    await link().trust('far', seen.fingerprints)
    // The machine answers with another key now: rebuilt, or somebody in between.
    const other = join(sshd.dir, 'other')
    await runProgram('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other], {
      timeoutMs: 10_000,
    })
    const line = (await readFile(known, 'utf8')).trim().split(' ')
    const [otherType, otherKey] = (await readFile(`${other}.pub`, 'utf8')).trim().split(' ')
    await writeFile(known, `${line[0]} ${otherType} ${otherKey}\n`)

    const changed = await link().identify('far')
    expect(changed.state).toBe('changed')
    const refused = await link()
      .trust('far', changed.fingerprints)
      .catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(LinkError)
    expect((refused as LinkError).message).toMatch(
      /different host key from the one this machine met/,
    )
    expect((refused as LinkError).message).toMatch(/ssh-keygen -R/)
    expect((await readFile(known, 'utf8')).trim()).toBe(`${line[0]} ${otherType} ${otherKey}`)
    // And pairing through it says the same thing, in the same words.
    const pairing = await link()
      .pair({ address: 'far', tade: 'tade', label: 'mac' })
      .catch((err: unknown) => err)
    expect((pairing as LinkError).message).toMatch(/different host key/)
  })
})

describe('a fingerprint, read the way ssh-keygen says one', () => {
  it('reads a plain line, a hashed one and a marked one, and nothing else', () => {
    const key = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
    expect(fingerprintOf(`vps ssh-ed25519 ${key}`)).toMatch(/^ED25519 SHA256:[A-Za-z0-9+/]+$/)
    expect(fingerprintOf(`|1|abc=|def= ssh-ed25519 ${key}`)).toBe(
      fingerprintOf(`vps ssh-ed25519 ${key}`),
    )
    expect(fingerprintOf(`@cert-authority *.example ssh-ed25519 ${key}`)).toBe(
      fingerprintOf(`vps ssh-ed25519 ${key}`),
    )
    expect(fingerprintOf('vps ecdsa-sha2-nistp256 AAAA')).toMatch(/^ECDSA SHA256:/)
    expect(fingerprintOf('# a comment')).toBeNull()
  })
})

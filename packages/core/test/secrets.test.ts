import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeSetting } from '../src/config.ts'
import { masked, type RunResult, SECRET_VAULTS, Secrets, secretName } from '../src/secrets.ts'

// A key pasted into Tade has to end up somewhere better than the config, be
// findable again, never be drawn back, and never beat what the shell says.
// Those four are the whole promise, so they are what is tested here.

const home = () => mkdtempSync(join(tmpdir(), 'tade-secrets-'))

const KEY = 'tsk_0123456789abcdefghij'

/** A `security` that answers from a table, so no test touches the real keychain. */
function fakeKeychain(): {
  run: (command: string, args: readonly string[], input?: string) => RunResult
  items: Map<string, string>
  argv: string[][]
} {
  const items = new Map<string, string>()
  const argv: string[][] = []
  const run = (command: string, args: readonly string[], input?: string): RunResult => {
    argv.push([command, ...args])
    const account = args[args.indexOf('-a') + 1] ?? ''
    const what = args[0]
    if (what === '-h' || what === 'help') return { code: 0, stdout: '', stderr: '' }
    if (what === 'find-generic-password') {
      const found = items.get(account)
      return found === undefined
        ? { code: 44, stdout: '', stderr: 'could not be found' }
        : { code: 0, stdout: `${found}\n`, stderr: '' }
    }
    if (what === 'add-generic-password') {
      // What `security` prompts for, twice, on standard input.
      const [first, second] = String(input ?? '').split('\n')
      if (!first || first !== second)
        return { code: 1, stdout: '', stderr: "passwords don't match" }
      items.set(account, first)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (what === 'delete-generic-password') {
      const had = items.delete(account)
      return had ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `no ${what}` }
  }
  return { run, items, argv }
}

describe('a file of Tade’s own', () => {
  it('keeps a key only its owner can read, and gives it back', () => {
    const at = home()
    const vault = SECRET_VAULTS.file?.({ home: at })
    if (!vault) throw new Error('there is no file vault')
    expect(vault.read('jev.key')).toBeNull()
    vault.write('jev.key', KEY)
    expect(vault.read('jev.key')).toBe(KEY)
    const path = join(at, 'secrets.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // In its own file, and nowhere near the config people commit.
    expect(readFileSync(path, 'utf8')).toContain(KEY)
    vault.forget('jev.key')
    expect(vault.read('jev.key')).toBeNull()
  })

  it('answers nothing, rather than throwing, when the file is rubbish', () => {
    const at = home()
    writeFileSync(join(at, 'secrets.json'), 'this is not json{')
    const vault = SECRET_VAULTS.file?.({ home: at })
    expect(vault?.read('jev.key')).toBeNull()
    // And writing over it still works: a broken file is not a lost key.
    vault?.write('jev.key', KEY)
    expect(vault?.read('jev.key')).toBe(KEY)
  })
})

describe('the OS keychain', () => {
  it('is only usable where there is one', () => {
    const { run } = fakeKeychain()
    expect(SECRET_VAULTS.keychain?.({ home: home(), platform: 'linux', run }).usable()).toBe(false)
    expect(SECRET_VAULTS.keychain?.({ home: home(), platform: 'darwin', run }).usable()).toBe(true)
  })

  it('never puts the key in a command line, where anybody could read it', () => {
    const keychain = fakeKeychain()
    const vault = SECRET_VAULTS.keychain?.({ home: home(), platform: 'darwin', run: keychain.run })
    if (!vault) throw new Error('there is no keychain vault')
    vault.write('jev.key', KEY)
    expect(vault.read('jev.key')).toBe(KEY)
    // The process table is world-readable on macOS: the value goes in on
    // standard input, so no argument of any call may contain it.
    for (const call of keychain.argv) expect(call.join(' ')).not.toContain(KEY)
    vault.forget('jev.key')
    expect(vault.read('jev.key')).toBeNull()
  })
})

describe('where a key goes, and what beats it', () => {
  it('prefers the keychain, and falls back to a file where there is none', () => {
    const keychain = fakeKeychain()
    const at = home()
    const kept = Secrets.open({ home: at, platform: 'darwin', run: keychain.run })
    expect(kept.set(secretName('jev', 'key'), KEY)).toBe('the macOS keychain')
    expect(keychain.items.get('jev.key')).toBe(KEY)
    expect(kept.get('jev.key')).toBe(KEY)
    expect(kept.where('jev.key')).toBe('the macOS keychain')

    const elsewhere = home()
    const filed = Secrets.open({ home: elsewhere, platform: 'linux', run: keychain.run })
    expect(filed.set('jev.key', KEY)).toContain('secrets.json')
    expect(filed.get('jev.key')).toBe(KEY)
  })

  it('finds a key written before there was a keychain, and keeps only one copy', () => {
    const keychain = fakeKeychain()
    const at = home()
    SECRET_VAULTS.file?.({ home: at }).write('jev.key', 'older')
    const kept = Secrets.open({ home: at, platform: 'darwin', run: keychain.run })
    expect(kept.get('jev.key')).toBe('older')
    // Saving a new one leaves nothing behind in the file for `get` to find.
    kept.set('jev.key', KEY)
    expect(kept.get('jev.key')).toBe(KEY)
    expect(SECRET_VAULTS.file?.({ home: at }).read('jev.key')).toBeNull()
  })

  it('lets the environment win, always', () => {
    const at = home()
    const kept = Secrets.open({ home: at, platform: 'linux' })
    kept.set('jev.key', KEY)
    // A machine that works today by exporting a variable goes on working
    // exactly as it did, whatever anybody has pasted since.
    expect(
      kept.find('jev.key', {
        env: { TYPESAFE_API_KEY: 'from-the-shell' },
        variables: ['TYPESAFE_API_KEY'],
      }),
    ).toEqual({ value: 'from-the-shell', from: '$TYPESAFE_API_KEY' })
    // With nothing in the environment, the pasted one is used and says where
    // it came from — the place, never a second copy of the value.
    const found = kept.find('jev.key', { env: {}, variables: ['TYPESAFE_API_KEY'] })
    expect(found?.value).toBe(KEY)
    expect(found?.from).toContain('secrets.json')
    // An empty variable is not a credential.
    expect(
      kept.find('jev.key', { env: { TYPESAFE_API_KEY: '  ' }, variables: ['TYPESAFE_API_KEY'] })
        ?.value,
    ).toBe(KEY)
  })

  it('clears one when the field is emptied, and refuses a key with a line in it', () => {
    const kept = Secrets.open({ home: home(), platform: 'linux' })
    kept.set('jev.key', KEY)
    expect(kept.set('jev.key', '   ')).toContain('cleared')
    expect(kept.get('jev.key')).toBeNull()
    expect(() => kept.set('jev.key', 'one\ntwo')).toThrow(/one line/)
  })

  it('says there is nowhere, rather than pretending it kept it', () => {
    const nowhere = Secrets.none()
    expect(nowhere.keeper).toBeNull()
    expect(() => nowhere.set('jev.key', KEY)).toThrow(/nowhere/)
    expect(nowhere.get('jev.key')).toBeNull()
  })
})

describe('never echoed', () => {
  it('shows bullets and no characters of the key', () => {
    expect(masked('')).toBe('')
    expect(masked('abc')).toBe('•••')
    expect(masked(KEY)).toBe('•'.repeat(12))
    expect(masked(KEY)).not.toContain('t')
  })

  it('refuses to write a credential into the config at all', () => {
    const at = home()
    const path = join(at, 'config.yaml')
    expect(() => writeSetting(path, 'secrets.jev.key', KEY)).toThrow(/kept out of the config/)
  })
})

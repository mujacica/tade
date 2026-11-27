import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, writeSetting } from '../src/config-file.ts'
import { secretCommand } from '../src/secret-command.ts'
import { findSecret, secretPath } from '../src/secrets.ts'

// A key pasted into Tade goes in the config, as itself: it can be read back,
// copied and checked for a typo. What the shell says still wins, and the file
// stays one person's. Those four are the whole promise, so they are what is
// tested here.

const home = () => mkdtempSync(join(tmpdir(), 'tade-secrets-'))

const KEY = 'tsk_0123456789abcdefghij'

describe('a key is a setting', () => {
  it('is written into the config and read back as itself', async () => {
    const path = join(home(), 'config.yaml')
    writeSetting(path, secretPath('jev', 'key'), KEY)
    expect(readFileSync(path, 'utf8')).toContain(KEY)
    const loaded = await loadConfig(path)
    expect(loaded.ok && loaded.config.extensions.jev?.key).toBe(KEY)
  })

  it('names the setting it is, so nothing has to know a second place', () => {
    expect(secretPath('jev', 'key')).toBe('extensions.jev.key')
    expect(secretPath('mcp-linear', 'key')).toBe('extensions.mcp-linear.key')
  })

  it('leaves the file readable by nobody else', () => {
    const path = join(home(), 'config.yaml')
    writeSetting(path, secretPath('jev', 'key'), KEY)
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('never puts a key into a file somebody else can read, even for a moment', () => {
    // `mode` on a write only applies to a file being made: written in place, a
    // `0644` config held the new key world-readable until it was narrowed. A
    // new file, renamed over, never is — and a crash leaves the old one whole.
    const dir = home()
    const path = join(dir, 'config.yaml')
    writeFileSync(path, 'projects: {}\n')
    chmodSync(path, 0o644)
    const before = statSync(path).ino
    writeSetting(path, secretPath('jev', 'key'), KEY)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(path).ino).not.toBe(before)
    expect(readdirSync(dir)).toEqual(['config.yaml'])
  })

  it('writes through a config kept somewhere else by a link, rather than replacing the link', () => {
    const dir = home()
    const real = join(dir, 'dotfiles.yaml')
    const path = join(dir, 'config.yaml')
    writeFileSync(real, 'projects: {}\n', { mode: 0o600 })
    symlinkSync(real, path)
    writeSetting(path, secretPath('jev', 'key'), KEY)
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toContain(KEY)
    expect(readdirSync(dir).sort()).toEqual(['config.yaml', 'dotfiles.yaml'])
  })

  it('takes a key out when the field is cleared', async () => {
    const path = join(home(), 'config.yaml')
    writeSetting(path, secretPath('jev', 'key'), KEY)
    writeSetting(path, secretPath('jev', 'key'), '')
    expect(readFileSync(path, 'utf8')).not.toContain(KEY)
    const loaded = await loadConfig(path)
    expect(loaded.ok && loaded.config.extensions.jev?.key).toBeUndefined()
  })

  it('is written by `writeSetting`, which used to refuse exactly this', () => {
    const path = join(home(), 'config.yaml')
    writeSetting(path, 'extensions.review.token', 'ghp_x')
    expect(readFileSync(path, 'utf8')).toContain('ghp_x')
  })
})

describe('what is used, and what it says about where it came from', () => {
  const settings = { key: KEY }

  it('is what the config holds', () => {
    expect(findSecret({ settings, key: 'key', env: {} })).toEqual({
      value: KEY,
      from: 'config.yaml',
    })
  })

  it('is the environment where there is one, whatever is pasted', () => {
    const found = findSecret({
      settings,
      key: 'key',
      env: { TYPESAFE_API_KEY: 'from-the-shell' },
      variables: ['TYPESAFE_API_KEY'],
    })
    expect(found).toEqual({ value: 'from-the-shell', from: '$TYPESAFE_API_KEY' })
  })

  it('takes the variables in the order it is given them', () => {
    const env = { FIRST: '', SECOND: 'second' }
    expect(findSecret({ settings: {}, key: 'key', env, variables: ['FIRST', 'SECOND'] })).toEqual({
      value: 'second',
      from: '$SECOND',
    })
  })

  it('is nothing at all when neither has one', () => {
    expect(findSecret({ settings: { key: '   ' }, key: 'key', env: {} })).toBeNull()
    expect(findSecret({ settings: undefined, key: 'key', env: {} })).toBeNull()
  })

  it('trims what it finds, because a pasted line often carries a space', () => {
    expect(findSecret({ settings: { key: ` ${KEY} ` }, key: 'key', env: {} })?.value).toBe(KEY)
  })
})

describe('the command that prints one', () => {
  it('names the config path it reads, and never the value', () => {
    const command = secretCommand('/home/tade', 'accounts.work.key')
    expect(command).toContain('print-secret.ts')
    expect(command).toContain("'accounts.work.key'")
    expect(command).not.toContain(KEY)
  })
})

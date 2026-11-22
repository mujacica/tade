import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HIDDEN, namesSystemdReads, resolveCommand } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  applyConsolidation,
  envFilePath,
  loginShellHas,
  planConsolidation,
  setNamesIn,
  type Verifier,
} from '../src/consolidate.ts'

// Keys moved out of a person's shell files into one file: a diff first with
// every value hidden, a fresh login shell asked before and after, and every
// file put back byte for byte where anything differs.

const ZSHENV = [
  '# my zshenv',
  'export OPENROUTER_API_KEY="sk-or-111"',
  'export EDITOR=vim',
  'export WORK_TOKEN="$(op read op://work/token)"',
  '',
].join('\n')
const ZSHRC = ['alias ll="ls -l"', "export ANTHROPIC_API_KEY='sk-ant-222'", 'bindkey -e', ''].join(
  '\n',
)

function home() {
  const dir = tmp('tade-move-')
  writeFileSync(join(dir, '.zshenv'), ZSHENV, { mode: 0o644 })
  writeFileSync(join(dir, '.zshrc'), ZSHRC, { mode: 0o600 })
  return dir
}

const zsh = resolveCommand('zsh', { PATH: process.env.PATH ?? '' })

describe('the diff', () => {
  it('moves each literal key, leaves what the shell works out, and never shows a value', async () => {
    const homeDir = home()
    const plan = await planConsolidation({ homeDir, names: new Set() })
    expect(plan.moved).toEqual([
      { name: 'ANTHROPIC_API_KEY', from: ['~/.zshrc:2'] },
      { name: 'OPENROUTER_API_KEY', from: ['~/.zshenv:2'] },
    ])
    expect(plan.left.map((one) => [one.name, one.where])).toEqual([['WORK_TOKEN', '~/.zshenv:4']])
    const diff = plan.diff.join('\n')
    expect(diff).toContain(`2 - export OPENROUTER_API_KEY=${HIDDEN}`)
    expect(diff).toContain('~/.config/tade/env (new, 0600)')
    expect(diff).not.toContain('sk-')
    // Nothing is written by working it out.
    expect(readFileSync(join(homeDir, '.zshenv'), 'utf8')).toBe(ZSHENV)
    expect(existsSync(envFilePath(homeDir))).toBe(false)
  })
})

describe('moving them', () => {
  it.skipIf(zsh === null)(
    'makes a file a fresh `zsh -l` and systemd’s EnvironmentFile= read to the same names, and keeps a copy of each file',
    async () => {
      const homeDir = home()
      const shell = zsh ?? ''
      const verify: Verifier = (names) => loginShellHas(names, { shell, homeDir, env: process.env })
      const before = await verify(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'])
      expect(before).toEqual(new Set(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']))
      const plan = await planConsolidation({ homeDir, names: new Set() })
      const done = await applyConsolidation(plan, { verify })
      expect(done.outcome).toBe('moved')
      const env = readFileSync(envFilePath(homeDir), 'utf8')
      expect(statSync(envFilePath(homeDir)).mode & 0o777).toBe(0o600)
      const login = await verify(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'])
      expect(new Set(namesSystemdReads(env))).toEqual(login)
      expect(readFileSync(join(homeDir, '.zshenv'), 'utf8')).not.toContain('sk-or-111')
      expect(readFileSync(join(homeDir, '.zshenv.tade-before'), 'utf8')).toBe(ZSHENV)
      expect(statSync(join(homeDir, '.zshrc')).mode & 0o777).toBe(0o600)
      expect(done.said).not.toContain('sk-')
    },
  )

  it('puts every file back byte for byte when the login shell sets something else afterwards', async () => {
    const homeDir = home()
    const original = {
      zshenv: readFileSync(join(homeDir, '.zshenv')),
      zshrc: readFileSync(join(homeDir, '.zshrc')),
    }
    let asked = 0
    // Before: both set. After: one gone — what a broken `.` would look like.
    const verify: Verifier = async () =>
      ++asked === 1
        ? new Set(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'])
        : new Set(['ANTHROPIC_API_KEY'])
    const plan = await planConsolidation({ homeDir, names: new Set() })
    const done = await applyConsolidation(plan, { verify })
    expect(done.outcome).toBe('rolled back')
    expect(done.why).toContain('no longer set: OPENROUTER_API_KEY')
    expect(readFileSync(join(homeDir, '.zshenv')).equals(original.zshenv)).toBe(true)
    expect(readFileSync(join(homeDir, '.zshrc')).equals(original.zshrc)).toBe(true)
    expect(existsSync(envFilePath(homeDir))).toBe(false)
    expect(existsSync(join(homeDir, '.zshenv.tade-before'))).toBe(false)
    expect(done.said).toContain('byte for byte')
  })

  it('puts back the one file that was there before, as it was', async () => {
    const homeDir = home()
    const path = envFilePath(homeDir)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(homeDir, '.config', 'tade'), { recursive: true })
    writeFileSync(path, "KEEP_TOKEN='x'\n", { mode: 0o600 })
    let asked = 0
    const verify: Verifier = async () => (++asked === 1 ? new Set(['A']) : new Set(['B']))
    const done = await applyConsolidation(await planConsolidation({ homeDir, names: new Set() }), {
      verify,
    })
    expect(done.outcome).toBe('rolled back')
    expect(readFileSync(path, 'utf8')).toBe("KEEP_TOKEN='x'\n")
  })

  it('writes nothing where a file changed since the diff, or the login shell cannot be asked', async () => {
    const homeDir = home()
    const plan = await planConsolidation({ homeDir, names: new Set() })
    writeFileSync(join(homeDir, '.zshrc'), `${ZSHRC}# edited\n`)
    const changed = await applyConsolidation(plan, { verify: async () => new Set() })
    expect(changed).toMatchObject({ outcome: 'refused' })
    expect(changed.why).toContain('~/.zshrc changed since the diff was made')
    const again = await planConsolidation({ homeDir, names: new Set() })
    const unasked = await applyConsolidation(again, { verify: async () => null })
    expect(unasked.outcome).toBe('refused')
    expect(existsSync(envFilePath(homeDir))).toBe(false)
  })
})

describe('what a login shell printed', () => {
  it('is read for the marked names asked about, and nothing else it said', () => {
    const said = 'Welcome!\n__tade_set__ A_KEY\n__tade_set__ NOT_ASKED\nexport B_KEY=leak\n'
    expect(setNamesIn(said, ['A_KEY', 'B_KEY'])).toEqual(new Set(['A_KEY']))
  })

  it('is not asked of a shell it cannot ask that way', async () => {
    expect(
      await loginShellHas(['A'], { shell: '/usr/bin/fish', homeDir: tmp('tade-fish-'), env: {} }),
    ).toBeNull()
  })
})

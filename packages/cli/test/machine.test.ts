import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Inventory, resolveCommand } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

// `tade machine`, run as a person runs it, over a home of its own: where each
// key is set by file and line and never what it is, the keys moved into one
// file on a press with the move written down, and a new box walked against
// what another machine told it it has.

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const VALUES = ['sk-or-cli-111', 'sk-ant-cli-222']

/** A person's home with two keys in their shell files, and Tade's home inside it. */
function homes() {
  const dir = tmp('tade-machine-cli-')
  writeFileSync(join(dir, '.zshenv'), `export OPENROUTER_API_KEY="${VALUES[0]}"\n`)
  writeFileSync(join(dir, '.zshrc'), `alias ll="ls -l"\nexport ANTHROPIC_API_KEY='${VALUES[1]}'\n`)
  const tade = join(dir, '.tade')
  mkdirSync(tade)
  writeFileSync(join(tade, 'config.yaml'), '')
  return { dir, tade }
}

function run(
  args: string[],
  where: { dir: string; tade: string },
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: where.dir,
        TADE_HOME: where.tade,
        XDG_CONFIG_HOME: join(where.dir, '.config'),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

const zsh = resolveCommand('zsh', { PATH: process.env.PATH ?? '' })

describe('tade machine env', () => {
  it('names each key at its file and line, and never what it is', async () => {
    const where = homes()
    const said = await run(['machine', 'env', '--json'], where)
    expect(said.code, said.stderr).toBe(0)
    const read = JSON.parse(said.stdout) as {
      names: { name: string; places: { where: string }[] }[]
    }
    expect(read.names.map((one) => [one.name, one.places.map((place) => place.where)])).toEqual([
      ['ANTHROPIC_API_KEY', ['~/.zshrc:2']],
      ['OPENROUTER_API_KEY', ['~/.zshenv:1']],
    ])
    for (const value of VALUES) expect(said.stdout + said.stderr).not.toContain(value)
  }, 60_000)

  it.skipIf(zsh === null)(
    'moves them on --yes, having shown the diff, and writes the move down with no value in it',
    async () => {
      const where = homes()
      const said = await run(['machine', 'env', '--move', '--yes'], where, { SHELL: zsh ?? '' })
      expect(said.code, said.stderr).toBe(0)
      expect(said.stdout).toContain('export OPENROUTER_API_KEY=‹hidden›')
      expect(said.stdout).toContain(
        'Moved ANTHROPIC_API_KEY, OPENROUTER_API_KEY into ~/.config/tade/env',
      )
      expect(readFileSync(join(where.dir, '.config', 'tade', 'env'), 'utf8')).toContain(
        `OPENROUTER_API_KEY='${VALUES[0]}'`,
      )
      const journal = readFileSync(join(where.tade, 'events.jsonl'), 'utf8')
      expect(journal).toContain('"type":"env_consolidated"')
      expect(journal).toContain('"outcome":"moved"')
      for (const value of VALUES) {
        expect(journal).not.toContain(value)
        expect(said.stdout + said.stderr).not.toContain(value)
      }
    },
    60_000,
  )

  it('moves nothing with nobody to ask and no --yes, and says how', async () => {
    const where = homes()
    const said = await run(['machine', 'env', '--move'], where)
    expect(said.stderr).toContain('nobody here to ask, so nothing was moved')
    expect(existsSync(join(where.dir, '.config', 'tade', 'env'))).toBe(false)
  }, 60_000)
})

describe('tade machine setup --from', () => {
  it('walks what another machine told this one it has, and says what to do here for each', async () => {
    const where = homes()
    const mac: Inventory = {
      machine: 'mac',
      at: '2026-11-22T12:00:00.000Z',
      shell: 'zsh',
      service: false,
      items: [
        {
          id: 'env:LINEAR_API_KEY',
          kind: 'env',
          label: 'LINEAR_API_KEY',
          state: 'set',
          digest: 'c'.repeat(64),
          until: null,
          where: ['~/.zshenv:3'],
          said: null,
          variables: ['LINEAR_API_KEY'],
          service: null,
        },
      ],
    }
    const kept = join(where.tade, 'machines', 'mac')
    mkdirSync(kept, { recursive: true })
    writeFileSync(join(kept, 'inventory.json'), JSON.stringify({ inventory: mac, heardAt: 1 }))
    const said = await run(['machine', 'setup', '--from', 'mac'], where)
    expect(said.code, said.stderr).toBe(0)
    expect(said.stderr).toContain('what mac told this machine it has')
    expect(said.stdout).toContain('LINEAR_API_KEY: this machine does not have it')
    expect(said.stdout).toContain("add LINEAR_API_KEY='…' to ~/.config/tade/env on this machine")
    expect(said.stdout).toContain('checklist: 0 of 1')
  }, 60_000)

  it('says where nothing was told, rather than walking nothing', async () => {
    const said = await run(['machine', 'setup', '--from', 'nowhere'], homes())
    expect(said.code).toBe(1)
    expect(said.stderr).toContain('nowhere has never told this machine what it has')
  }, 60_000)
})

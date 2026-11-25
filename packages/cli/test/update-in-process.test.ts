import { execFileSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { run } from '../src/program.ts'

// `tade update`, run in this worker the way `bin.ts` runs it, where
// `update.test.ts` runs the binary. Without `--check` it asks the network
// nothing, so what is held here is this command's own half: the text answer
// and the JSON one, what it keeps in Tade's home, and the refusal of a config
// it cannot read. Its PATH holds only git and node: on a machine with whisper
// or ffmpeg installed, asking them their version is reaching for audio
// (`test/no-gui.ts`), and the binary's own tests are the ones that may.

let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

const GIT = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()

async function tade(home: string, ...args: string[]) {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  symlinkSync(process.execPath, join(bin, 'node'))
  symlinkSync(join(GIT, 'git'), join(bin, 'git'))
  Object.assign(process.env, { TADE_HOME: home, HOME: home, PATH: bin })
  const out: string[] = []
  const err: string[] = []
  const code = await run(['node', 'tade', ...args], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('tade update, in process', () => {
  it('says what is here and that nothing was asked, as text', async () => {
    const said = await tade(tmp('tade-cli-update-here-'), 'update')
    expect(said.code, said.err).toBe(0)
    expect(said.out).toMatch(/^tade\s+\d/m)
    expect(said.out).toMatch(/^git\s/m)
    expect(said.out).toMatch(/^node\s/m)
    expect(said.out).toContain(
      'Nothing was asked of the network: run with --check for what is current.',
    )
  }, 60_000)

  it('says the same look as JSON, asked of nobody', async () => {
    const said = await tade(tmp('tade-cli-update-json-'), 'update', '--json')
    expect(said.code, said.err).toBe(0)
    const look = JSON.parse(said.out) as {
      asked: boolean
      programs: { need: { command: string }; latest: string | null }[]
    }
    expect(look.asked).toBe(false)
    expect(look.programs.map((one) => one.need.command)).toContain('git')
    expect(look.programs.every((one) => one.latest === null)).toBe(true)
  }, 60_000)

  it('refuses a config it cannot read, saying what tells you why', async () => {
    const home = tmp('tade-cli-update-bad-')
    const config = join(home, 'config.yaml')
    writeFileSync(config, 'surfaces: [not, a, map]\n')
    const said = await tade(home, 'update', '--config', config)
    expect(said.code).toBe(2)
    expect(said.err).toBe(`${config}: invalid config (run \`tade config --check\`)`)
    expect(said.out).toBe('')
  })
})

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// `tade update` says what is installed and what would move it forward. It
// never installs anything, and without `--check` it asks nobody anything —
// which is what makes it safe to run in a test.

const run = (args: string[], home: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, TADE_HOME: home, HOME: home },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })

it('says what is here, and that nobody has been asked what is current', async () => {
  const home = tmp('tade-cli-update-')
  const result = await run(['update', '--json'], home)
  expect(result.code).toBe(0)
  const look = JSON.parse(result.stdout) as {
    asked: boolean
    tade: { version: string; from: string; update: unknown }
    programs: { need: { command: string }; latest: string | null; behind: boolean }[]
  }
  // Nothing was asked, so nothing is current and nothing is behind.
  expect(look.asked).toBe(false)
  expect(look.programs.every((one) => one.latest === null)).toBe(true)
  expect(look.programs.every((one) => one.behind === false)).toBe(true)
  // And the list is the one the ports declared, not one written here.
  const commands = look.programs.map((one) => one.need.command)
  expect(commands).toContain('git')
  expect(commands).toContain('node')
  expect(look.tade.version).toMatch(/^\d/)
}, 60_000)

it('says what it would run, and runs none of it', async () => {
  const home = tmp('tade-cli-update-said-')
  const result = await run(['update'], home)
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('tade')
  expect(result.stdout).toContain('run with --check')
  // Whatever it offers for git, it is a command written out, never one run.
  expect(result.stdout).not.toContain('installing')
}, 60_000)

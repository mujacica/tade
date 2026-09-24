import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// `tade setup --check` on a machine Tade has never been set up on.
//
// It asks nobody anything and writes nothing, which is what makes it safe to
// run here — and it opens a lane, runs a command in it and closes it, which is
// the part that cannot be faked: everything else in setting up is a reading of
// a file, and a wizard that says "all set" without ever starting a process is
// how `posix_spawnp failed.` reaches a user.

const run = (args: string[], home: string, tty = false) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, TADE_HOME: home, HOME: home },
      // Never a terminal: the wizard asks for one rather than hanging on a
      // question nobody can answer, and `--check` never needed one.
      stdio: tty ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })

interface Checked {
  ready: boolean
  steps: { id: string; done: boolean; required: boolean; detail: string }[]
  proof: { ok: boolean; driver: string; says: string }
  programs: { need: { command: string; title: string }; version: string | null }[]
  harnesses: { id: string; installed: boolean; signedIn: boolean; signIn: unknown }[]
}

it('proves a lane really opens, and says what is still missing', async () => {
  const home = tmp('tade-cli-setup-')
  const result = await run(['setup', '--check', '--json'], home)
  const checked = JSON.parse(result.stdout) as Checked

  // A lane, a command in it, and the lane closed again: the one part of this
  // that is not a reading of a file.
  expect(checked.proof).toMatchObject({ ok: true, driver: 'pty' })
  expect(checked.steps.find((step) => step.id === 'works')).toMatchObject({ done: true })

  // Nothing is set up here, so it says so and exits non-zero.
  expect(checked.ready).toBe(false)
  expect(result.code).toBe(1)
  const project = checked.steps.find((step) => step.id === 'project')
  expect(project).toMatchObject({ done: false, required: true })
  expect(project?.detail.length).toBeGreaterThan(0)

  // What Tade is built on and what it shells out to are both answered, and the
  // programs are the ones the ports declared rather than a list written
  // anywhere: git and Node are Tade's own.
  expect(checked.steps.map((step) => step.id).slice(0, 2)).toEqual(['native', 'programs'])
  const commands = checked.programs.map((one) => one.need.command)
  expect(commands).toContain('git')
  expect(commands).toContain('node')
  expect(commands).toContain('tmux')

  // And every harness answers for itself, sign-in and all.
  expect(checked.harnesses.map((one) => one.id).sort()).toEqual(['claude-code', 'codex', 'pi'])
  for (const harness of checked.harnesses) {
    if (!harness.installed) expect(harness.signIn).toBeNull()
  }

  // It changed nothing: a check that writes a config is a check that cannot be
  // run twice, and this is the one somebody runs when they are not sure.
  expect(existsSync(join(home, 'config.yaml'))).toBe(false)
}, 120_000)

it('says what is missing rather than hanging where there is nothing to type into', async () => {
  const home = tmp('tade-cli-setup-tty-')
  const result = await run(['setup'], home)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('setup needs a terminal')
  // And it still says the whole list, so a log somebody pastes is useful.
  expect(result.stderr).toContain('A project to work on')
  expect(existsSync(join(home, 'config.yaml'))).toBe(false)
}, 60_000)

it('says the exact command for a program it has not got, and installs nothing', async () => {
  const home = tmp('tade-cli-setup-install-')
  const result = await run(['setup', '--check'], home)
  // Whatever is missing on this machine, what is offered is a command written
  // out — never one that was run.
  expect(result.stdout).toContain('Programs:')
  expect(result.stdout).toContain('Agents:')
  expect(result.stdout).not.toContain('installing')
}, 120_000)

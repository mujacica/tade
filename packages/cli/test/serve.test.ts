import { type ChildProcess, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workbench } from '@tade/workbench'
import { afterEach, expect, it } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { NOT_SERVED, SERVES } from '../src/commands/serve.ts'

// `tade serve` as somebody's service manager runs it: the real binary, with
// no terminal on any of its streams, over a home with a project in it.

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

/** A process and everything it has printed so far, on each stream. */
interface Running {
  child: ChildProcess
  out: () => string
  err: () => string
  exited: Promise<number | null>
}

const started: ChildProcess[] = []

afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
})

function tade(args: string[], home: string): Running {
  const child = spawn(process.execPath, [bin, ...args], {
    env: { ...process.env, TADE_HOME: home, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  started.push(child)
  let out = ''
  let err = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk
  })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, out: () => out, err: () => err, exited }
}

async function until(what: string, ok: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await ok()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

it('runs what came due with no screen, says it on standard error, and lets go of the home when stopped', async () => {
  const repo = mkrepo()
  repo.commit('first')
  const home = repo.home
  writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
  // Written before, and let go of: the command opens the home itself.
  const before = await Workbench.open({ home })
  await before.setSchedule(
    {
      id: 'morning-brief',
      name: 'Morning brief',
      project: 'app',
      said: 'in a moment, tell me what happened',
      when: { at: new Date(Date.now() + 1_000).toISOString() },
      does: { kind: 'ask', prompt: 'Say what the agents did, and what needs the person first.' },
      missed: 'once',
      by: 'you',
      created: new Date().toISOString(),
    },
    'you',
  )
  await before.close()

  const serving = tade(['serve'], home)
  await until('it says what it runs', () => serving.err().includes(`${SERVES}, with no screen.`))
  expect(serving.err()).toContain(NOT_SERVED)
  await until('the schedule ran, and the log says so', () =>
    /\d\d:\d\d Morning brief ran: the orchestrator is asked/.test(serving.err()),
  )
  // Nobody is here to be asked: what it would have been asked is said, not dropped.
  await until('what it was for, said', () =>
    serving
      .err()
      .includes(
        'for the orchestrator, which is not here: It is time for "Morning brief", a schedule the person made',
      ),
  )

  // It is a window: a second one on the same home is refused, and says why.
  const second = tade(['serve'], home)
  expect(await second.exited).toBe(1)
  expect(second.err()).toContain('Only one window at a time')

  serving.child.kill('SIGTERM')
  expect(await serving.exited).toBe(0)
  expect(serving.err()).toContain(`tade serve on ${home} stopped.`)
  // Nothing is drawn, so nothing is written where a screen would be.
  expect(serving.out()).toBe('')
  // And the home is let go of: the next window opens it.
  const after = await Workbench.open({ home })
  expect(await after.events({ types: ['schedule_fired'] })).toHaveLength(1)
  await after.close()
}, 120_000)

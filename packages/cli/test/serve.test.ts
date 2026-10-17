import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WHILE_STARTING } from '@tade/app/heart'
import { Workbench } from '@tade/workbench'
import { afterEach, expect, it } from 'vitest'
import {
  type FakeModel,
  startFakeModel,
  writeProviderExtension,
} from '../../../test/fixtures/fake-model.ts'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { NOT_SERVED, SERVES } from '../src/commands/serve.ts'

// `tade serve` as somebody's service manager runs it: the real binary, with
// no terminal on any of its streams, over a home with a project in it — and
// a real pi as its orchestrator, on a scripted model, so what it is told and
// what it decides with nobody at a screen is the real thing.

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

/** A process and everything it has printed so far, on each stream. */
interface Running {
  child: ChildProcess
  out: () => string
  err: () => string
  exited: Promise<number | null>
}

const started: ChildProcess[] = []
let model: FakeModel | null = null

afterEach(async () => {
  for (const child of started.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  await model?.close()
  model = null
})

function tade(args: string[], home: string, env: NodeJS.ProcessEnv = {}): Running {
  const child = spawn(process.execPath, [bin, ...args], {
    env: { ...process.env, TADE_HOME: home, HOME: home, ...env },
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

/** A port the machine has just said is free. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const address = server.address()
  await new Promise<void>((done) => server.close(() => done()))
  return typeof address === 'object' && address !== null ? address.port : 0
}

it('runs what came due with no screen, tells the orchestrator, which decides, and lets go of the home when stopped', async () => {
  const repo = mkrepo()
  repo.commit('first')
  const home = repo.home
  // It looks at the queue when asked, and says so: a tool the heart answers.
  model = await startFakeModel({
    tool: { name: 'tade_queue', arguments: {} },
    finalText: 'Nothing is waiting on you.',
  })
  // The scripted model is a provider pi loads from its own folder, as it
  // loads a person's: nothing of Tade's is told about it.
  const piExtensions = join(home, '.pi', 'agent', 'extensions')
  mkdirSync(piExtensions, { recursive: true })
  writeProviderExtension(piExtensions)
  const port = await freePort()
  writeFileSync(
    join(home, 'config.yaml'),
    [
      'projects:',
      '  app:',
      `    root: ${repo.root}`,
      'orchestrator:',
      '  harness: pi',
      '  provider: tade-test',
      '  model: fake',
      'surfaces:',
      '  web:',
      '    enabled: true',
      `    port: ${port}`,
      '',
    ].join('\n'),
  )
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

  const serving = tade(['serve'], home, { TADE_TEST_BASE_URL: model.url })
  await until('it says what it runs', () => serving.err().includes(`${SERVES}, with no screen.`))
  expect(serving.err()).toContain(NOT_SERVED)
  await until('the schedule ran, and the log says so', () =>
    /\d\d:\d\d Morning brief ran: the orchestrator is asked/.test(serving.err()),
  )
  await until('the orchestrator came up', () => /\d\d:\d\d orchestrator ready/.test(serving.err()))
  // It was told what came due — then and there, or, where that was before it
  // had started, the moment it had, since nobody types here to carry it.
  await until('it was told', () =>
    (model?.requests ?? []).some((request) =>
      JSON.stringify(request).includes('Say what the agents did, and what needs the person first.'),
    ),
  )
  const told = JSON.stringify(model.requests[0])
  if (serving.err().includes('for the orchestrator, which is not running: It is time for')) {
    expect(told).toContain(WHILE_STARTING.slice(0, 40))
  }
  // And it decided with nobody at a screen: it looked at the queue, the heart
  // answered, and what it did and said is in the log where a window draws it.
  await until('it answered', () => (model?.requests.length ?? 0) >= 2)
  expect(JSON.stringify(model.requests[1])).toContain('Morning brief')
  await until('the log has what it did and said', () =>
    /\d\d:\d\d orchestrator: Nothing is waiting on you\./.test(serving.err()),
  )
  expect(serving.err()).toMatch(/\d\d:\d\d orchestrator ran tade_queue: done/)

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
  // The away view listened while it ran, with no window to have opened it,
  // and stopped with it.
  const listened = await after.events({ types: ['web_enabled'] })
  expect(listened.map((one) => (one.detail as { enabled: boolean }).enabled)).toEqual([true, false])
  expect(String(listened[0]?.detail?.bound)).toContain(String(port))
  await after.close()
}, 120_000)

/** Whether anything answers a TCP connection on this port. */
function answers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })
}

// Under the unit `tade host service` writes, systemd counts it started only
// once it says so: a `systemd-notify` that writes down what it was asked to
// say, and where, stands in for systemd's own.
it('tells its service manager it is ready once its away view listens, and that it is stopping', async () => {
  const repo = mkrepo()
  repo.commit('first')
  const home = repo.home
  const port = await freePort()
  writeFileSync(
    join(home, 'config.yaml'),
    [
      'projects:',
      '  app:',
      `    root: ${repo.root}`,
      'surfaces:',
      '  web:',
      '    enabled: true',
      `    port: ${port}`,
      '',
    ].join('\n'),
  )
  const bin = join(home, 'bin')
  mkdirSync(bin)
  const told = join(home, 'told')
  writeFileSync(
    join(bin, 'systemd-notify'),
    `#!/bin/sh\nprintf '%s %s\\n' "$NOTIFY_SOCKET" "$*" >> '${told}'\n`,
  )
  chmodSync(join(bin, 'systemd-notify'), 0o755)
  const said = () => (existsSync(told) ? readFileSync(told, 'utf8') : '')
  const socket = '/run/user/1001/systemd/notify'

  const serving = tade(['serve'], home, {
    NOTIFY_SOCKET: socket,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  })
  await until('it said it is ready', () => said().includes('READY=1'))
  expect(said().trim().split('\n')).toEqual([
    `${socket} READY=1 STATUS=holding ${home} with no screen`,
  ])
  // Ready is reachable: the away view a Mac's link goes to already answers.
  expect(await answers(port)).toBe(true)
  expect(serving.err()).toContain(`${SERVES}, with no screen.`)

  serving.child.kill('SIGTERM')
  expect(await serving.exited).toBe(0)
  expect(said().trim().split('\n').at(-1)).toBe(`${socket} STOPPING=1`)
  expect(serving.err()).not.toContain('systemd was not told')
}, 120_000)

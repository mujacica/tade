import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { CLOSED, type StatusAsk, type StatusCollector } from '../src/collector.ts'
import {
  type ChildOptions,
  lastWords,
  lookInChild,
  RESTART_MAX_MS,
  restartWait,
} from '../src/forked.ts'

// The window's half of looking in a child, against a child that misbehaves on
// purpose (`fixtures/fake-child.ts`): one that is slow, one that hangs, one
// that falls over, one that talks nonsense.
//
// Paced by what happened — a fork, an ask, a process gone — and never by a
// stretch of wall clock: the deadlines here are short so a test is quick, and
// every assertion is one that a slow machine makes no less true.

const FAKE = fileURLToPath(new URL('./fixtures/fake-child.ts', import.meta.url))
const WINDOW = fileURLToPath(new URL('./fixtures/window.ts', import.meta.url))

const ask: StatusAsk = {
  config: ConfigSchema.parse({ workspace: { adopt: false } }),
  now: 0,
  home: '/nowhere',
  tadeHome: '/nowhere',
  pr: false,
  lanes: {},
}

const opened: StatusCollector[] = []
const spawned: number[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((collector) => collector.close()))
  for (const pid of spawned.splice(0)) kill(pid)
})

/** A collector over the fake child, and what the fake wrote down. */
function fake(how: string, opts: ChildOptions = {}, extra: string[] = []) {
  const log = join(tmp('tade-fake-child-'), 'log')
  const look = lookInChild({ entry: FAKE, args: [how, log, ...extra], ...opts })
  opened.push(look)
  const said = (what: string) =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith(`${what} `))
          .map((line) => line.slice(what.length + 1))
      : []
  return {
    look,
    boots: () => said('boot').map(Number),
    asks: () => said('ask').length,
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Gone already.
  }
}

async function until<T>(check: () => T | Promise<T>, timeout = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('a child that answers', () => {
  it('answers from another process, started once and asked once per look', async () => {
    const { look, boots, asks } = fake('answer')
    const first = await look.collect(ask)
    const second = await look.collect(ask)
    expect(first).toMatchObject({ known: true })
    expect(second).toMatchObject({ known: true })
    if (!first.known) return
    expect(first.spent.pid).not.toBe(process.pid)
    expect(boots()).toEqual([first.spent.pid])
    expect(asks()).toBe(2)
  })

  it('is started before the first ask, so the window does not wait for Node to boot', async () => {
    const { boots } = fake('answer')
    // Nothing has been asked: the child came up on its own.
    await until(() => boots().length === 1)
  })

  it('is started at the first ask when told not to start early', async () => {
    const { look, boots } = fake('answer', { eager: false })
    expect(boots()).toEqual([])
    expect(await look.collect(ask)).toMatchObject({ known: true })
    expect(boots()).toHaveLength(1)
  })
})

describe('a child that is slow', () => {
  it('is unknown at the deadline, keeps looking, and answers the next ask with that same look', async () => {
    const { look, asks } = fake('slow', { deadlineMs: 100 }, ['600'])
    const first = await look.collect(ask)
    expect(first).toMatchObject({
      known: false,
      why: expect.stringMatching(/longer than 1s .* busy machine rather than a broken one/),
    })
    // The next ask is answered by the look already under way, rather than
    // handing a machine too busy to answer one a second fork storm.
    const second = await until(async () => {
      const answer = await look.collect(ask)
      return answer.known ? answer : null
    })
    expect(second.known).toBe(true)
    expect(asks()).toBe(1)
  })
})

describe('a child that wedges', () => {
  it('is ended once one look goes unanswered too long, and the next ask starts another', async () => {
    const { look, boots } = fake('hang', { deadlineMs: 10_000, wedgedMs: 200, restartMs: 0 })
    const stopped = { known: false, why: expect.stringMatching(/^status stopped answering/) }
    expect(await look.collect(ask)).toMatchObject(stopped)
    // Another child was started and asked, and wedged in its turn — which a
    // child not started could not do: that ask would be the wait's sentence.
    // Said by the answers rather than by counting boots, because a child
    // ended 200ms after it was forked may not have got as far as saying so
    // on a loaded machine.
    expect(await look.collect(ask)).toMatchObject(stopped)
    // And every one that did get that far was ended rather than left behind.
    for (const pid of boots()) await until(() => !running(pid))
  })

  it('counts a child that never says it is listening as wedged too', async () => {
    const { look, asks } = fake('silent', { deadlineMs: 10_000, wedgedMs: 200 })
    expect(await look.collect(ask)).toMatchObject({
      known: false,
      why: expect.stringMatching(/stopped answering/),
    })
    expect(asks()).toBe(0)
  })
})

describe('a child that dies', () => {
  it('is unknown with what it said as it fell, never an empty workspace', async () => {
    const { look } = fake('crash')
    expect(await look.collect(ask)).toEqual({
      known: false,
      why: "status's process exited 1: Error: the child fell over",
    })
  })

  it('answers the look it was killed in at once, not at the deadline', async () => {
    const { look, boots, asks } = fake('hang', { deadlineMs: 60_000 })
    const answer = look.collect(ask)
    await until(() => asks() === 1)
    kill(boots()[0] ?? 0)
    expect(await answer).toMatchObject({
      known: false,
      why: expect.stringMatching(/was ended by SIGKILL/),
    })
  })

  it('is started again after being killed, and the new one answers', async () => {
    const { look, boots } = fake('answer', { restartMs: 0 })
    const first = await look.collect(ask)
    if (!first.known) throw new Error(first.why)
    kill(first.spent.pid)
    const again = await until(async () => {
      const answer = await look.collect(ask)
      return answer.known ? answer : null
    })
    expect(again.spent.pid).not.toBe(first.spent.pid)
    expect(running(first.spent.pid)).toBe(false)
    expect(boots()).toHaveLength(2)
  })

  it('is not started again on every ask while they keep dying', async () => {
    const { look, boots } = fake('crash', { restartMs: 60_000 })
    await look.collect(ask)
    const answers = []
    for (let i = 0; i < 20; i++) answers.push(await look.collect(ask))
    // Twenty asks in a row after a crash are twenty `unknown`s and no forks:
    // a child that keeps falling over is waited on, never stormed.
    expect(boots()).toHaveLength(1)
    for (const answer of answers) {
      expect(answer).toMatchObject({
        known: false,
        why: "status's process exited 1: Error: the child fell over; starting it again after 60s",
      })
    }
  })

  it('is started again once the wait is over', async () => {
    const { look, boots } = fake('die', { restartMs: 50 })
    expect(await look.collect(ask)).toMatchObject({ why: "status's process exited 3" })
    await until(async () => {
      await look.collect(ask)
      return boots().length >= 2
    })
  })

  it('waits twice as long for each that ends in a row, up to a minute', () => {
    expect([1, 2, 3, 4].map((deaths) => restartWait(1_000, deaths))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ])
    expect(restartWait(1_000, 30)).toBe(RESTART_MAX_MS)
  })
})

describe('a child that talks nonsense', () => {
  it('is ended for an answer that is not a workspace', async () => {
    const { look, boots } = fake('garbage')
    expect(await look.collect(ask)).toMatchObject({
      known: false,
      why: expect.stringMatching(/not an answer/),
    })
    const [pid] = boots()
    await until(() => pid !== undefined && !running(pid))
  })

  it('is ended for saying something that is not an answer at all', async () => {
    const { look } = fake('noise')
    expect(await look.collect(ask)).toMatchObject({
      known: false,
      why: expect.stringMatching(/not an answer/),
    })
  })
})

describe('whose the child is', () => {
  it('ends it on close, and a look after that is unknown', async () => {
    const { look } = fake('answer')
    const answer = await look.collect(ask)
    if (!answer.known) throw new Error(answer.why)
    await look.close()
    expect(running(answer.spent.pid)).toBe(false)
    expect(await look.collect(ask)).toEqual({ known: false, why: CLOSED })
    await look.close()
  })

  it('goes with a window that is killed outright, which runs no exit path at all', async () => {
    const window = spawn(process.execPath, [WINDOW, tmp('tade-window-')], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    if (window.pid) spawned.push(window.pid)
    let out = ''
    window.stdout.setEncoding('utf8')
    window.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    const line = await until(() => (out.includes('\n') ? out.trim() : ''), 30_000)
    const child = Number(line)
    expect(Number.isInteger(child), line).toBe(true)
    expect(running(child)).toBe(true)
    // SIGKILL: nothing in the window gets to say goodbye.
    window.kill('SIGKILL')
    spawned.push(child)
    await until(() => !running(child), 30_000)
  })
})

describe('lastWords', () => {
  it('finds the error a dying Node printed, past its stack and its version', () => {
    const tail = [
      'file:///x/child.ts:3',
      '  throw new Error("boom")',
      '  ^',
      '',
      'TypeError: boom',
      '    at file:///x/child.ts:3:9',
      '',
      'Node.js v26.11.1',
    ].join('\n')
    expect(lastWords(tail)).toBe('TypeError: boom')
  })

  it('says the last thing it said when nothing was an error, and nothing when it said nothing', () => {
    expect(lastWords('one\ntwo\n\nNode.js v26.11.1\n')).toBe('two')
    expect(lastWords('')).toBe('')
  })
})

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from '@tade/drivers-core/conformance'
import { spawn as inTerminal } from 'node-pty'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  closeAll,
  hangingUp,
  leftBehind,
  onSignals,
  QUIT_MS,
  type TerminalStreams,
} from '../src/quitting.ts'

// Quitting hands the terminal back in about a second, whatever hangs, and a
// second ctrl+c is never asked to wait. Measured from outside, on a real
// process, because "the process ended" is not something a process can say.

const FIXTURE = join(import.meta.dirname, 'fixtures', 'quitting.ts')

/** Room for a loaded runner to start Node and load the module; a hang never fits in it. */
const ROOM_MS = 4_000

interface Ran {
  said: string[]
  code: number | null
  /** From the first line it said to its end: past starting Node and loading what it needs. */
  took: number
  signal: (name: NodeJS.Signals) => void
  ended: Promise<void>
}

function run(mode: string, until: (said: string[]) => boolean): Promise<Ran> {
  return new Promise((ready) => {
    const child = spawn(process.execPath, [FIXTURE, mode], { stdio: ['ignore', 'pipe', 'inherit'] })
    const ran: Ran = {
      said: [],
      code: null,
      took: 0,
      signal: (name) => child.kill(name),
      ended: new Promise((done) => child.on('exit', () => done())),
    }
    let first = 0
    let rest = ''
    child.stdout.on('data', (chunk: Buffer) => {
      rest += chunk.toString('utf8')
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      if (lines.length > 0 && first === 0) first = performance.now()
      ran.said.push(...lines)
      if (until(ran.said)) ready(ran)
    })
    child.on('exit', (code) => {
      ran.code = code
      ran.took = performance.now() - first
      ready(ran)
    })
  })
}

describe('quitting', () => {
  it('ends the process with every close hung and a child holding it open', async () => {
    const ran = await run('hung', () => false)
    await ran.ended
    const child = Number(ran.said.find((line) => line.startsWith('child '))?.slice(6))
    try {
      expect(ran.said).toContain('late the orchestrator,the workbench,the reporter')
      expect(ran.code).toBe(0)
      expect(ran.took).toBeLessThan(QUIT_MS + ROOM_MS)
    } finally {
      if (child) process.kill(child, 'SIGKILL')
    }
  })

  it('closes on the first signal and ends at once on the second', async () => {
    const ran = await run('signals', (said) => said.includes('ready'))
    ran.signal('SIGINT')
    await new Promise<void>((done) => {
      const look = setInterval(() => {
        if (ran.said.includes('closing')) {
          clearInterval(look)
          done()
        }
      }, 10)
    })
    expect(ran.code).toBe(null)
    ran.signal('SIGINT')
    await ran.ended
    expect(ran.code).toBe(130)
  })

  it('names what it gave up on, and says nothing when nothing was', async () => {
    const never = () => new Promise<void>(() => {})
    const quick = async () => {}
    const between: string[] = []
    const late = await closeAll({
      together: [
        { name: 'the orchestrator', close: never },
        { name: 'the status child', close: quick },
      ],
      between: () => between.push('between'),
      last: { name: 'the workbench', close: quick },
      meanwhile: [{ name: 'the reporter', close: quick }],
    })
    expect(late).toEqual([{ name: 'the orchestrator' }])
    expect(between).toEqual(['between'])
    expect(leftBehind(late)).toEqual([
      'closed without waiting for the orchestrator, which did not finish closing in time',
    ])
    expect(
      leftBehind([
        { name: 'the voice' },
        { name: 'the status child', error: new Error('it had already gone') },
        { name: 'the away view' },
        { name: 'the reporter' },
      ]),
    ).toEqual([
      'closed without waiting for the voice, the away view and the reporter, which did not finish closing in time',
      'the status child could not be closed: it had already gone',
    ])
    expect(leftBehind([])).toEqual([])
  })

  it('takes a signal after a quit already under way as the second ask', () => {
    const target = new EventEmitter()
    const did: string[] = []
    let closing = false
    const stop = onSignals(
      target,
      () => did.push('close'),
      () => did.push('now'),
      () => closing,
      () => did.push('hung up'),
    )
    closing = true
    target.emit('SIGTERM')
    expect(did).toEqual(['now'])
    stop()
    target.emit('SIGINT')
    target.emit('SIGHUP')
    expect(did).toEqual(['now'])
    expect(target.listenerCount('SIGINT')).toBe(0)
    expect(target.listenerCount('SIGHUP')).toBe(0)
  })

  it('takes every hang-up as the terminal going, never as the second ask', () => {
    const target = new EventEmitter()
    const did: string[] = []
    let closing = false
    onSignals(
      target,
      () => did.push('close'),
      () => did.push('now'),
      () => closing,
      () => {
        did.push('hung up')
        closing = true
      },
    )
    // One window closing is two: the kernel's, and the shell's to its jobs.
    target.emit('SIGHUP')
    target.emit('SIGHUP')
    expect(did).toEqual(['hung up', 'hung up'])
    // Anything asked after it is asked while closing, so it ends at once.
    target.emit('SIGINT')
    expect(did).toEqual(['hung up', 'hung up', 'now'])
  })

  it('writes nothing to a terminal once it has hung up, and closes once', () => {
    const wrote: string[] = []
    const out = () => {
      const stream = new EventEmitter() as EventEmitter & {
        write: (data: string, done?: () => void) => boolean
      }
      stream.write = (data: string) => {
        wrote.push(data)
        return true
      }
      return stream
    }
    const terminal = { stdin: new EventEmitter(), stdout: out(), stderr: out() }
    let closes = 0
    const hangUp = hangingUp(terminal as unknown as TerminalStreams, () => {
      closes += 1
    })
    terminal.stdout.write('a frame')
    // The first to hear of it is a write that failed, before any signal.
    terminal.stdout.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }))
    expect(closes).toBe(1)
    let answered = false
    expect(terminal.stdout.write('the screen given back', () => (answered = true))).toBe(true)
    terminal.stderr.write('closed without waiting for the orchestrator')
    // The signal after it, and another error, are the same hang-up.
    hangUp()
    terminal.stdin.emit('error', new Error('setRawMode EIO'))
    expect(closes).toBe(1)
    expect(wrote).toEqual(['a frame'])
    return until(() => answered)
  })

  it('closes as quitting does when its terminal closes, and writes nothing to it after', async () => {
    const dir = tmp('tade-hangup-')
    const log = join(dir, 'said')
    // What the tmux driver leaves when it is never let go of.
    const folder = join(dir, 'tade-tmux-left')
    mkdirSync(folder)
    const terminal = inTerminal(process.execPath, [FIXTURE, 'hangup', log, folder], {
      cols: 80,
      rows: 24,
    })
    terminal.onData(() => {})
    const ended = new Promise<{ exitCode: number; signal?: number }>((done) =>
      terminal.onExit(done),
    )
    const said = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [])
    try {
      await until(() => said().includes('ready'), { timeout: ROOM_MS * 3 })
    } catch {
      terminal.kill('SIGKILL')
      throw new Error(`never ready; it said ${JSON.stringify(said())}`)
    }
    const closed = performance.now()
    // A terminal's window closing: its end of the pty goes, then SIGHUP. Every
    // terminal node-pty makes can, and its types do not say so.
    ;(terminal as typeof terminal & { destroy(): void }).destroy()
    const how = await Promise.race([
      ended,
      new Promise<null>((done) => setTimeout(() => done(null), QUIT_MS + ROOM_MS)),
    ])
    if (how === null) terminal.kill('SIGKILL')
    // Ended by itself rather than by the signal, having let go of everything.
    expect({ how, said: said() }).toEqual({
      how: { exitCode: 0, signal: 0 },
      said: ['ready', 'closing', 'let go', 'closed', 'exit 0', ''],
    })
    expect(existsSync(folder)).toBe(false)
    expect(performance.now() - closed).toBeLessThan(QUIT_MS + ROOM_MS)
  })
})

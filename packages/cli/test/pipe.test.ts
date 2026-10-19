import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { endsQuietly } from '../src/pipe.ts'
import { hangingUp, type TerminalStreams } from '../src/quitting.ts'

// A reader that stops reading early — `tade web status | head -2` — closes the
// pipe under a command still writing. Found rehearsing a box from a shell,
// where it was an unhandled EPIPE with a stack trace.

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

describe('a pipe closed under a command', () => {
  it('ends it quietly, as head ends cat', async () => {
    const child = spawn(process.execPath, [bin, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
    // Closed before a byte is read, so every write after the first meets EPIPE.
    child.stdout.destroy()
    let err = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      err += chunk
    })
    const code = await new Promise<number | null>((done) => child.on('exit', (one) => done(one)))
    expect(err).not.toContain('EPIPE')
    expect(code).toBe(0)
  })
})

describe('an error on stdout', () => {
  const failed = (code: string) => Object.assign(new Error(`write ${code}`), { code })

  it('is thrown as Node throws it while nobody else listens', () => {
    const stdout = new EventEmitter()
    endsQuietly(stdout, () => {})
    expect(() => stdout.emit('error', failed('EIO'))).toThrow('write EIO')
  })

  it('ends the command at EPIPE', () => {
    const stdout = new EventEmitter()
    let ended = 0
    endsQuietly(stdout, () => {
      ended += 1
    })
    stdout.emit('error', failed('EPIPE'))
    expect(ended).toBe(1)
  })

  // TADE-5 and TADE-6: the window's terminal went, a frame's write came back
  // `write EIO`, and the listener `bin.ts` puts on first threw it before the
  // window's own (`hangingUp`) was told — so Tade died of it as a crash, and the
  // restore on the way down wrote to the terminal again and threw again.
  it("is the window's to answer once the window listens, wired as `tade app` wires it", () => {
    const stream = () =>
      Object.assign(new EventEmitter(), { write: (_data: string) => true }) as EventEmitter & {
        write: (data: string) => boolean
      }
    const terminal = { stdin: new EventEmitter(), stdout: stream(), stderr: stream() }
    let ended = 0
    endsQuietly(terminal.stdout, () => {
      ended += 1
    })
    let closes = 0
    hangingUp(terminal as unknown as TerminalStreams, () => {
      closes += 1
    })
    expect(() => terminal.stdout.emit('error', failed('EIO'))).not.toThrow()
    expect({ closes, ended }).toEqual({ closes: 1, ended: 0 })
  })
})

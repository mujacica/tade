import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

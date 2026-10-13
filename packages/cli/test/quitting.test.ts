import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { closeAll, leftBehind, onSignals, QUIT_MS } from '../src/quitting.ts'

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
    expect(late).toEqual(['the orchestrator'])
    expect(between).toEqual(['between'])
    expect(leftBehind(late)).toBe(
      'closed without waiting for the orchestrator, which did not finish closing in time',
    )
    expect(leftBehind(['the voice', 'the away view', 'the reporter'])).toBe(
      'closed without waiting for the voice, the away view and the reporter, which did not finish closing in time',
    )
    expect(leftBehind([])).toBe(null)
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
    )
    closing = true
    target.emit('SIGTERM')
    expect(did).toEqual(['now'])
    stop()
    target.emit('SIGINT')
    expect(did).toEqual(['now'])
    expect(target.listenerCount('SIGINT')).toBe(0)
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from '@tade/drivers-core/conformance'
import { spawn as inTerminal } from 'node-pty'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { type Again, startAgain } from '../src/reloading.ts'

// After a reload the window is still the terminal's. It used to start a new
// `tade` detached and end: the shell took the terminal back, two programs read
// one keyboard, half a mouse report was typed into the line as numbers and
// punctuation, and ctrl+c went to the shell. Only a real shell in a real
// terminal can show that, so that is where this runs.

const FIXTURE = join(import.meta.dirname, 'fixtures', 'reloading.ts')

/** Room for a loaded runner to start Node and load the module, twice. */
const ROOM_MS = 8_000

/** A click as the terminal reports it with the mouse on, then three keys. */
const TYPED = '\x1b[<0;10;5Mxyz'

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

describe('reloading', () => {
  it('keeps the terminal: every key reaches the window that comes back, ctrl+c too', async () => {
    const log = join(tmp('tade-reload-'), 'said')
    // Interactive, so it has job control and takes the terminal back from a
    // job that ends, as the shell somebody runs `tade` in does.
    const terminal = inTerminal('/bin/sh', ['-i'], {
      cols: 80,
      rows: 24,
      env: { PATH: process.env.PATH ?? '', PS1: '$ ', ENV: '', TERM: 'xterm-256color' },
    })
    let screen = ''
    terminal.onData((data) => {
      screen += data
    })
    const said = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [])
    const read = (generation: number) =>
      said()
        .filter((line) => line.startsWith(`${generation} read `))
        .map((line) => JSON.parse(line.slice(`${generation} read `.length)) as string)
        .join('')
    const waitFor = async (what: string, ok: () => boolean) => {
      try {
        await until(ok, { timeout: ROOM_MS })
      } catch {
        throw new Error(
          `never ${what}; it said ${JSON.stringify(said())}, and the terminal showed ${JSON.stringify(screen.slice(-400))}`,
        )
      }
    }
    try {
      await waitFor('prompted', () => screen.includes('$ '))
      terminal.write(`${quoted(process.execPath)} ${quoted(FIXTURE)} ${quoted(log)}\r`)
      await waitFor('up', () => said().some((line) => line.startsWith('1 up ')))
      terminal.write('r')
      await waitFor('back', () => said().some((line) => line.startsWith('2 up ')))
      terminal.write(TYPED)
      await waitFor('read what was typed', () => read(2) === TYPED)
      terminal.write('\x03')
      await waitFor('caught ctrl+c', () => said().includes('2 ctrl+c'))
      // The same process, so the same pid: what agents find the window by.
      const pids = said()
        .filter((line) => / up \d+$/.test(line))
        .map((line) => line.split(' ').at(-1))
      expect(new Set(pids).size).toBe(1)
    } finally {
      terminal.kill('SIGKILL')
    }
  })

  it('tells what listens for an exit before it starts again, with the arguments and flags it had', () => {
    const happened: string[] = []
    const proc: Again = {
      execPath: '/bin/node',
      execArgv: ['--no-warnings'],
      argv: ['/bin/node', '/tade/bin.ts', 'app', '--config', 'c.yaml'],
      env: { TADE_HOME: '/home' },
      emit: (event) => happened.push(event),
      execve: ((file: string, args: string[], env: NodeJS.ProcessEnv) => {
        happened.push(`execve ${file} ${args.join(' ')} ${env.TADE_HOME}`)
        return undefined as never
      }) as Again['execve'],
      stderr: { write: (text) => happened.push(text) },
      exit: ((code: number) => happened.push(`exit ${code}`)) as Again['exit'],
    }
    startAgain(proc)
    expect(happened).toEqual([
      'exit',
      'execve /bin/node /bin/node --no-warnings /tade/bin.ts app --config c.yaml /home',
    ])
  })

  it('says so where Node cannot start a process again in place', () => {
    const happened: string[] = []
    startAgain({
      execPath: '/bin/node',
      execArgv: [],
      argv: ['/bin/node', '/tade/bin.ts'],
      env: {},
      emit: (event) => happened.push(event),
      stderr: { write: (text) => happened.push(text) },
      exit: ((code: number) => happened.push(`exit ${code}`)) as Again['exit'],
    })
    expect(happened).toEqual(['Tade cannot start itself again here: run `tade` again.\n', 'exit 0'])
  })
})

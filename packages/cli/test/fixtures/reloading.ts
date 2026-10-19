import { appendFileSync } from 'node:fs'
import { startAgain } from '../../src/reloading.ts'

// A window reloading the way `tade app` reloads, run by `reloading.test.ts`
// as a job of a real shell in a real terminal: raw mode and mouse reports on,
// as the window has them, and everything it reads written to a file. `r` gives
// the terminal back as the window does and makes the call `tade app` makes;
// what starts again says it is the next one, and ends on ctrl+c.
//
//   node reloading.ts <log>

const [log = ''] = process.argv.slice(2)
const GENERATION = 'TADE_TEST_GENERATION'
const generation = Number(process.env[GENERATION] ?? '1')
const say = (line: string) => appendFileSync(log, `${generation} ${line}\n`)

/** Mouse reports, as SGR: what a window with the mouse on has the terminal send. */
const MOUSE = '\x1b[?1000h\x1b[?1006h'
const NO_MOUSE = '\x1b[?1000l\x1b[?1006l'

const giveBack = () => {
  process.stdout.write(NO_MOUSE)
  process.stdin.setRawMode(false)
  process.stdin.pause()
}

process.stdin.setRawMode(true)
process.stdout.write(MOUSE)
process.stdin.resume()
say(`up ${process.pid}`)
process.stdin.on('data', (chunk: Buffer) => {
  const keys = chunk.toString('utf8')
  say(`read ${JSON.stringify(keys)}`)
  if (keys.includes('\x03')) {
    giveBack()
    say('ctrl+c')
    process.exit(0)
  }
  if (generation === 1 && keys === 'r') {
    giveBack()
    process.env[GENERATION] = String(generation + 1)
    startAgain()
  }
})

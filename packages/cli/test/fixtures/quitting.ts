import { spawn } from 'node:child_process'
import { appendFileSync, rmSync } from 'node:fs'
import { closeAll, endSoon, hangingUp, onSignals } from '../../src/quitting.ts'

// A process quitting the way `tade app` quits, with the piece that hung on a
// real home hung here on purpose. Run by `quitting.test.ts`, which times it
// from outside: the only place "the process ended" can be seen.
//
//   node quitting.ts hung      every close hangs, and a child holds the loop open
//   node quitting.ts signals   closing never finishes; the second signal must end it
//   node quitting.ts hangup <log> <folder>
//                              in a terminal, drawing, until the terminal closes

const never = () => new Promise<void>(() => {})
const say = (line: string) => process.stdout.write(`${line}\n`)

if (process.argv[2] === 'hung') {
  // Let go of without being ended, as the orchestrator's model process was:
  // its pipes alone keep this process from ending by itself.
  const held = spawn('sleep', ['30'], { stdio: ['pipe', 'pipe', 'pipe'] })
  say(`child ${held.pid}`)
  const late = await closeAll({
    together: [{ name: 'the orchestrator', close: never }],
    last: { name: 'the workbench', close: never },
    meanwhile: [{ name: 'the reporter', close: never }],
  })
  say(`late ${late.map((one) => one.name).join(',')}`)
  endSoon()
}

if (process.argv[2] === 'signals') {
  // Something closing that never finishes, keeping the process open meanwhile.
  setInterval(() => {}, 1_000)
  onSignals(
    process,
    () => say('closing'),
    () => process.exit(130),
    () => false,
    () => say('hung up'),
  )
  say('ready')
}

if (process.argv[2] === 'hangup') {
  // Drawing in a terminal the way the window does, wired as `tade app` wires
  // it, and closed the way it is closed: the screen given back, the folder a
  // driver made taken away, a line said about it — each of which writes to the
  // terminal. What happened goes to a file, because the terminal it would have
  // been said on is the thing that is gone. stderr is not touched before
  // `hangingUp` takes it, as the window does not touch it.
  const [log = '', folder = ''] = process.argv.slice(3)
  const wrote = (line: string) => appendFileSync(log, `${line}\n`)
  process.on('uncaughtExceptionMonitor', (error) => wrote(`threw ${error.message}`))
  process.on('exit', (code) => wrote(`exit ${code}`))
  process.stdin.setRawMode(true)
  process.stdin.resume()
  let closing = false
  let begin = () => {}
  const begun = new Promise<void>((done) => {
    begin = done
  })
  const close = () => {
    if (closing) return
    closing = true
    begin()
  }
  const frames = setInterval(() => process.stdout.write('\x1b[H\x1b[2Ka frame'), 5)
  onSignals(
    process,
    close,
    () => process.exit(130),
    () => closing,
    hangingUp(process, close),
  )
  // A write that reached a terminal which had gone says so, a moment later.
  // Counted from the close on: the frame that first met the hang-up is how
  // `hangingUp` can come to hear of it, before any signal.
  let restoring = false
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error) => {
      if (restoring) wrote(`wrote to a terminal that had gone: ${error.message}`)
    })
  }
  wrote('ready')
  await begun
  wrote('closing')
  restoring = true
  clearInterval(frames)
  // What `App.stop` gives back: the screen, the cursor, the keys as they were.
  process.stdout.write('\x1b[?1049l\x1b[?25h')
  process.stdin.setRawMode(false)
  process.stdin.pause()
  const late = await closeAll({
    together: [],
    last: {
      name: 'the workbench',
      close: async () => {
        rmSync(folder, { recursive: true, force: true })
        wrote('let go')
      },
    },
    meanwhile: [],
  })
  // As what did not close is said on the way out, to stderr.
  process.stderr.write(`late ${late.length}\n`)
  wrote('closed')
  endSoon()
}

import { spawn } from 'node:child_process'
import { closeAll, endSoon, onSignals } from '../../src/quitting.ts'

// A process quitting the way `tade app` quits, with the piece that hung on a
// real home hung here on purpose. Run by `quitting.test.ts`, which times it
// from outside: the only place "the process ended" can be seen.
//
//   node quitting.ts hung      every close hangs, and a child holds the loop open
//   node quitting.ts signals   closing never finishes; the second signal must end it

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
  say(`late ${late.join(',')}`)
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
  )
  say('ready')
}

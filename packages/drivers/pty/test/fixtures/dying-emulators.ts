import { parentPort } from 'node:worker_threads'
import { Emulators } from '../../src/emulator.ts'
import type { Order } from '../../src/protocol.ts'

// The emulators' thread exactly as it runs (`src/emulator-thread.ts`), except
// that it dies — the way an uncaught throw inside xterm would kill it — when
// a lane prints `emulators, die`. Only when it is printed: a thread started
// again is shown the lane's replay as it opens, which carries the cue, and a
// fixture that died on that would be testing the cue rather than the driver.

const port = parentPort
if (!port) throw new Error('run as a worker')
const emulators = new Emulators((report) => port.postMessage(report))
port.on('message', (order: Order) => {
  if (order.do === 'data' && order.data.includes('emulators, die')) {
    throw new Error('the emulator choked on what it was shown')
  }
  emulators.take(order)
})

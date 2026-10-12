import { parentPort } from 'node:worker_threads'
import { Emulators } from '../../src/emulator.ts'
import type { Order } from '../../src/protocol.ts'

// The emulators' thread exactly as it runs (`src/emulator-thread.ts`), except
// that it never makes a frame of a lane smaller than the biggest it was asked
// for: a watch for fewer lines than that is dropped. A capture a bigger frame
// already answers must never wait for one of its own, and here one that did
// would wait out its whole bound.

const port = parentPort
if (!port) throw new Error('run as a worker')
const emulators = new Emulators((report) => port.postMessage(report))
const most = new Map<number, number>()
port.on('message', (order: Order) => {
  if (order.do === 'watch') {
    if (order.lines < (most.get(order.key) ?? 0)) return
    most.set(order.key, order.lines)
  }
  emulators.take(order)
})

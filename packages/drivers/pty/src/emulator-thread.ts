import { parentPort } from 'node:worker_threads'
import { Emulators } from './emulator.ts'
import type { Order } from './protocol.ts'

// The thread the emulators run on, and nothing else: the pty driver starts it
// (`thread.ts`), and everything that happens here is `Emulators`.
//
// No extension, harness or anybody's code is ever loaded here — only xterm —
// so `--safe` has nothing to say about it, and a thread that dies takes no
// lane with it: the processes are the driver's, on the thread it runs on.

const port = parentPort
if (!port) throw new Error('the terminal emulators run on a thread the pty driver starts')
const emulators = new Emulators((report) => port.postMessage(report))
port.on('message', (order: Order) => emulators.take(order))

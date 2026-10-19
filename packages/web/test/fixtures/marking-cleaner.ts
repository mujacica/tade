import { parentPort, workerData } from 'node:worker_threads'

// A cleaning thread that marks what it makes (`cleaning.test.ts`): every turn
// it is handed comes back as one reply saying so, which nothing else would
// make — so a row that reads it was made on this thread and not again.

const { turns } = workerData as { turns: unknown[] }
parentPort?.postMessage(
  turns.map(() => ({
    row: {
      at: null,
      kind: 'reply',
      text: { words: 'made on the thread', more: false },
      tool: null,
      outcome: null,
      call: null,
    },
    taken: 7,
  })),
)

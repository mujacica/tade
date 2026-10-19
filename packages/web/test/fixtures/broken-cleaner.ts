import { workerData } from 'node:worker_threads'

// A cleaning thread that never cleans (`cleaning.test.ts`): told `throw`, it
// dies on its first line; told `quiet`, it stays and says nothing; told `exit`,
// it ends without a word.

const { known } = workerData as { known: string[] }
if (known[0] === 'throw') throw new Error('the cleaner fell over')
if (known[0] === 'quiet') setInterval(() => {}, 1_000)

import { parentPort, workerData } from 'node:worker_threads'
import { cleanText } from './screen.ts'

// The thread one large answer is cleaned on (`cleaning.ts`): the same rule as
// everywhere else, run once on what it was started with, said back, and gone.

const { text, known } = workerData as { text: string; known: string[] }
parentPort?.postMessage(cleanText(text, known))

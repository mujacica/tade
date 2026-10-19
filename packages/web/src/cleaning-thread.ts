import { parentPort, workerData } from 'node:worker_threads'
import type { Places } from './command.ts'
import { type TurnIn, turnOf } from './conversation.ts'
import { cleanText } from './screen.ts'

// The thread one large answer, or an agent's long turns, is cleaned on
// (`cleaning.ts`): the same rule as everywhere else, run once on what it was
// started with, said back, and gone.

const job = workerData as
  | { text: string; known: string[] }
  | { turns: TurnIn[]; known: string[]; places: Places }
parentPort?.postMessage(
  'turns' in job
    ? job.turns.map((one) => turnOf(one, job.known, job.places))
    : cleanText(job.text, job.known),
)

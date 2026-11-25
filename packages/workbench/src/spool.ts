import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A request a terminal hands to the window that holds the home, and the
// window's answer: one file each, in a folder under the home.
//
// **One writer numbers the journal** (`config-changes.ts` says why at length),
// so a terminal beside a window — `tade serve` on a machine nobody sits at,
// whose shell is the only one there is — never does what writes a line. It
// writes what it was asked here, the window does it on its next beat through
// its own workbench, and writes the answer beside it for the terminal to print.
//
// **A request is claimed by renaming it**, so two beats never do one twice,
// and a terminal that gave up waiting takes its request back by removing it —
// whichever happens first is what happened. An answer nobody came back for is
// taken away after an hour.
//
// `task-requests.ts` is the first of these and keeps its own copy; the
// accounts' (`account-requests.ts`) is this one's.

/** An answer nobody came back for is taken away after this long. */
const ANSWER_KEPT_MS = 60 * 60_000

const REQUEST = '.json'
const ANSWER = '.answer.json'
const TAKING = '.taking'

/** How long a window is given to take a request, and then to do it. */
export interface Waiting {
  /** A window beats every two seconds; one that has not taken it by this is not taking it. */
  takeMs: number
  /** How long doing it may take, once taken. */
  doMs: number
  /** Between looks for the answer. */
  everyMs: number
}

/** Into the spool, whole or not at all; the id to wait on its answer by. */
export async function spoolRequest(dir: string, request: unknown): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const id = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`
  await whole(join(dir, `${id}${REQUEST}`), request)
  return id
}

/** The window's answer to request `id`, taken away once read; null while there is none. */
async function answerFor<A>(
  dir: string,
  id: string,
  parse: (text: string) => A,
): Promise<A | null> {
  const file = join(dir, `${id}${ANSWER}`)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  await rm(file, { force: true })
  return parse(text)
}

/** Take request `id` back before a window claimed it: true where it was still waiting. */
async function withdraw(dir: string, id: string): Promise<boolean> {
  try {
    await rm(join(dir, `${id}${REQUEST}`))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * What came of request `id`: the window's answer; `'untaken'` where no window
 * took it in time, so it was taken back and nothing was done; or `'doing'`
 * where one took it and has not answered in time, so it may yet be done.
 */
export async function awaitSpooled<A>(
  dir: string,
  id: string,
  parse: (text: string) => A,
  waiting: Waiting,
): Promise<A | 'untaken' | 'doing'> {
  let until = Date.now() + waiting.takeMs
  let taken = false
  for (;;) {
    const answer = await answerFor(dir, id, parse)
    if (answer) return answer
    if (Date.now() >= until) {
      if (taken) return 'doing'
      if (await withdraw(dir, id)) return 'untaken'
      taken = true
      until = Date.now() + waiting.doMs
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, waiting.everyMs))
  }
}

/** What one take did, and what stopped it reading the spool, if anything did. */
export interface Taken {
  taken: number
  trouble: string | null
}

/**
 * Do every request waiting, oldest first, by `act`, and answer each — a
 * request that is not one Tade wrote, or that `act` threw on, answered with
 * `failed`. Never throws: what stopped it is handed back. A spool that is not
 * there is nothing to take, and costs one look at a directory.
 */
export async function takeSpooled<R, A>(
  dir: string,
  parse: (text: string) => R | string,
  act: (request: R) => Promise<A>,
  failed: (error: string) => A,
  now: number = Date.now(),
): Promise<Taken> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { taken: 0, trouble: null }
    return { taken: 0, trouble: `could not read ${dir}: ${String(err)}` }
  }
  let taken = 0
  for (const name of names.filter(waiting).sort()) {
    const id = name.slice(0, -REQUEST.length)
    const file = join(dir, name)
    const claimed = `${file}${TAKING}`
    try {
      await rename(file, claimed)
    } catch (err) {
      // Withdrawn by the terminal that wrote it, a moment ago.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      return { taken, trouble: `could not take ${file}: ${String(err)}` }
    }
    // Whatever stops it being done is the terminal's answer: it is waiting to say it.
    let answer: A
    try {
      const request = parse(await readFile(claimed, 'utf8'))
      answer =
        typeof request === 'string'
          ? failed(`${file} is not a request Tade wrote (${request})`)
          : await act(request)
    } catch (err) {
      answer = failed(err instanceof Error ? err.message : String(err))
    }
    try {
      await whole(join(dir, `${id}${ANSWER}`), answer)
      await rm(claimed, { force: true })
    } catch (err) {
      return { taken, trouble: `could not answer ${file}: ${String(err)}` }
    }
    taken += 1
  }
  for (const name of names.filter((n) => n.endsWith(ANSWER))) {
    const file = join(dir, name)
    try {
      if (now - (await stat(file)).mtimeMs > ANSWER_KEPT_MS) await rm(file, { force: true })
    } catch (err) {
      // Read by the terminal it was for, since the look: what was to be taken away is gone.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      return { taken, trouble: `could not take away ${file}: ${String(err)}` }
    }
  }
  return { taken, trouble: null }
}

/** A finished request: never one being written, claimed or answered. */
function waiting(name: string): boolean {
  return !name.startsWith('.') && name.endsWith(REQUEST) && !name.endsWith(ANSWER)
}

/** Written beside its name and renamed over it, so a reader reads all of it or none. */
async function whole(file: string, value: unknown): Promise<void> {
  const draft = join(file, '..', `.${randomUUID()}.draft`)
  await writeFile(draft, JSON.stringify(value), { mode: 0o600 })
  await rename(draft, file)
}

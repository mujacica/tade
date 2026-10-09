import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Outcome } from './acting.ts'

// What a device asked for, and what came of it: `<home>/web-acts.jsonl`,
// append-only, `0600`, a bad line skipped rather than thrown over.
//
// **Two lines per act, and the order is the whole guarantee.** `asked` is
// written *before* the verb runs and `came` after it, so a window that died in
// between leaves an `asked` with nothing after it — which is the one state
// this file exists to be able to read. A repeat of that key afterwards is
// answered **`unsure`**: Tade does not know whether it happened, will not do it
// again, and says so. That is failing closed, and it is the honest answer in
// the only case where there is no honest certain one.
//
// **What a key is, and what it is not.** It is minted by the client and is
// bound here to four things — the authenticated device, the verb, the target
// and the canonical payload (`boundTo`). So:
//
// - a concurrent repeat of the same key gets the first call's answer and the
//   verb runs **once**, because the in-flight promise is what the second one
//   awaits;
// - a repeat after the first finished gets the same answer again, from the
//   record, and the verb does not run;
// - the same key with a **different** payload is `reused` and runs nothing: a
//   key is not a licence, and a client that re-uses one for a second act is a
//   client with a bug or somebody editing a captured request;
// - a key from a **previous server lifetime** is answered from the record if
//   there is a complete one, and `unsure` if there is only an `asked`. Either
//   way it does not execute anew, which is the property DESIGN.md §9.3 step 3
//   claimed for a ten-minute LRU and did not have.
//
// **And the thing this cannot promise, said plainly.** A key that has fallen
// out of the kept window — past `KEPT`, or a file somebody deleted — is a key
// with no record, so it is a *new* act, and it will run if the entity it names
// is still in the state it expects. That is not a hole in the store: it is
// DECISIONS §4.6, which is that the key is a fast path and the guarantee is
// the state re-check. What follows from it is a sentence nobody may quietly
// drop: **nothing here promises exactly-once side effects**, and a verb whose
// effect could not be made safe to repeat against a re-checked state is a verb
// that does not ship (`verbs.ts`). Park is safe because a park that already
// happened is a park whose `was` no longer matches.

/** What the file is called, under the home. Never inside a project. */
export const RECEIPTS_FILE = 'web-acts.jsonl'

/** Where it is. */
export function receiptsPath(home: string): string {
  return join(home, RECEIPTS_FILE)
}

/**
 * How many keys are kept in memory, newest first.
 *
 * Bounded because a map keyed by whatever a client sends is a memory leak with
 * an idempotency store's name on it. The file keeps every line — it is the
 * audit, it is one or two short lines per remote act, and nothing rewrites it
 * — and what is dropped is only the *fast path*. A key that falls out meets
 * the state re-check instead, which is the guarantee anyway.
 */
export const KEPT = 1000

const AskedLine = z.strictObject({
  kind: z.literal('asked'),
  key: z.string().max(64),
  /** The digest of `boundTo`: the device, the verb, the target, the payload. */
  bound: z.string().regex(/^[0-9a-f]{64}$/),
  /** The server lifetime it was asked in. A key from another one never runs. */
  epoch: z.string().max(64),
  device: z.string().regex(/^[0-9a-f]{16}$/),
  verb: z.string().max(40),
  task: z.string().max(200),
  at: z.string(),
})

const CameLine = z.strictObject({
  kind: z.literal('came'),
  key: z.string().max(64),
  bound: z.string().regex(/^[0-9a-f]{64}$/),
  did: z.boolean(),
  rev: z.string().max(64),
  said: z.string().max(400),
  at: z.string(),
})

const Line = z.discriminatedUnion('kind', [AskedLine, CameLine])
export type ReceiptLine = z.infer<typeof Line>

/** One key's record, folded out of its lines. */
export interface Receipt {
  key: string
  bound: string
  epoch: string
  /** What came of it, or null where only the `asked` line is there. */
  outcome: Outcome | null
}

/**
 * What claiming a key came to.
 *
 * `Claimed` rather than `Claim`, which is what `tickets.ts` calls the answer to
 * the same-shaped question about a pairing ticket: one package, one spelling
 * per type.
 */
export type Claimed =
  /** Nobody has used this key. Run the verb, then `came`. */
  | { kind: 'fresh' }
  /** It ran already, in this lifetime or an earlier one. This is its answer. */
  | { kind: 'again'; outcome: Outcome }
  /** It is running now, in this process. Await this and answer with it. */
  | { kind: 'running'; outcome: Promise<Outcome> }
  /** The same key, bound to something else. Nothing runs. */
  | { kind: 'reused' }
  /** It began and nothing recorded an end. Nothing runs, and Tade says so. */
  | { kind: 'unsure' }

/** The receipts in the file, or none at all where there is no file yet. */
export async function readReceipts(
  home: string,
): Promise<{ receipts: Receipt[]; skipped: number }> {
  let text: string
  try {
    text = await readFile(receiptsPath(home), 'utf8')
  } catch {
    return { receipts: [], skipped: 0 }
  }
  return receiptsIn(text)
}

/**
 * The receipts, folded newest-state-last.
 *
 * A `came` for a key no `asked` introduced is counted as neither: the line
 * parsed and says something true, and there is nothing to be the record of.
 * A line that does not parse is skipped — a file one truncated write has
 * damaged must still be the record of the acts before it.
 */
export function receiptsIn(text: string): { receipts: Receipt[]; skipped: number } {
  const held = new Map<string, Receipt>()
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: ReceiptLine
    try {
      parsed = Line.parse(JSON.parse(line))
    } catch {
      skipped++
      continue
    }
    if (parsed.kind === 'asked') {
      held.set(parsed.key, {
        key: parsed.key,
        bound: parsed.bound,
        epoch: parsed.epoch,
        outcome: null,
      })
      continue
    }
    const was = held.get(parsed.key)
    if (was === undefined || was.bound !== parsed.bound) continue
    held.set(parsed.key, {
      ...was,
      outcome: { did: parsed.did, rev: parsed.rev, said: parsed.said },
    })
  }
  // Newest last in the file, so the newest `KEPT` are the tail.
  const all = [...held.values()]
  return { receipts: all.slice(Math.max(0, all.length - KEPT)), skipped }
}

/** The digest of what a key is bound to. The file keeps this, not the string. */
export function boundDigest(bound: string): string {
  return createHash('sha256').update(bound, 'utf8').digest('hex')
}

export interface ReceiptsOptions {
  home: string
  /** This server's lifetime. A record from another one never runs again. */
  epoch: string
  /** Said where somebody at the machine reads it. Never throws, never blocks. */
  tell?: (said: string) => void
}

/**
 * The receipt store: the kept window, the in-flight promises, and the file.
 *
 * Opened once by the server, which hands it the lifetime it will stamp. It is
 * the one thing in the acting path that touches a file, which is why the gate
 * (`acts.ts`) stays pure and this does not.
 */
export class Receipts {
  private readonly home: string
  private readonly epoch: string
  private readonly tell: (said: string) => void
  private readonly held = new Map<string, Receipt>()
  private readonly running = new Map<string, Promise<Outcome>>()
  /**
   * How to settle the promise a concurrent repeat is awaiting.
   *
   * Held from the moment a key is claimed rather than from the moment the verb
   * starts, which is the ordering the concurrent case turns on: claiming
   * appends a line, and a second request arriving during that append would
   * otherwise find an empty map and be told it was fresh too.
   */
  private readonly settle = new Map<
    string,
    { done: (came: Outcome) => void; failed: (error: unknown) => void }
  >()

  constructor(opts: ReceiptsOptions) {
    this.home = opts.home
    this.epoch = opts.epoch
    this.tell = opts.tell ?? (() => {})
  }

  /** Read what is already on disk. Called once, before anything is served. */
  async open(): Promise<void> {
    const read = await readReceipts(this.home)
    for (const receipt of read.receipts) this.held.set(receipt.key, receipt)
    if (read.skipped > 0) {
      this.tell(
        `${read.skipped} line(s) of the record of what paired devices did could not be read and were skipped`,
      )
    }
  }

  /** How many keys are kept now. For a test, and for a budget. */
  get size(): number {
    return this.held.size
  }

  /**
   * Claim a key for one act, writing the `asked` line if it is a fresh one.
   *
   * **Every decision is made before the first `await`, and that is the whole
   * of why concurrent repeats run once.** The tempting shape — look, append,
   * then answer `fresh` — has an append's worth of event loop in the middle of
   * it, and two requests that arrived in the same tick both look at an empty
   * map and are both told they are the first. So the decision and the marks
   * that record it are synchronous, and the file append is what the answer
   * waits on rather than what the decision does.
   *
   * The write still comes before the verb runs — see the file's header —
   * because `fresh` is only answered once the line is on disk.
   */
  claim(ask: {
    key: string
    bound: string
    device: string
    verb: string
    task: string
    now: number
  }): Promise<Claimed> {
    const bound = boundDigest(ask.bound)
    const running = this.running.get(ask.key)
    const was = this.held.get(ask.key)
    // **Bound first, and before the in-flight look is answered with.** A key
    // whose record is about a different act is `reused` whether or not that
    // act is still going: answering a *different* payload with the first
    // call's outcome would be the altered-payload replay this check exists
    // for, with the concurrency making it look like idempotency.
    if (was !== undefined && was.bound !== bound) return Promise.resolve({ kind: 'reused' })
    if (running !== undefined) return Promise.resolve({ kind: 'running', outcome: running })
    if (was !== undefined) {
      if (was.outcome !== null) return Promise.resolve({ kind: 'again', outcome: was.outcome })
      // An `asked` with no `came`: the window died in the middle of this one,
      // or is dying now. Either way nothing runs again.
      return Promise.resolve({ kind: 'unsure' })
    }
    // Marked as claimed and as in flight **now**, so a second request in this
    // same tick finds both. The record going in before the line lands is the
    // safe direction too: a write that failed leaves a key that reads as
    // `unsure` rather than one that reads as never asked.
    this.keep({ key: ask.key, bound, epoch: this.epoch, outcome: null })
    this.running.set(ask.key, this.awaited(ask.key))
    return this.write({
      kind: 'asked',
      key: ask.key,
      bound,
      epoch: this.epoch,
      device: ask.device,
      verb: ask.verb,
      task: ask.task,
      at: new Date(ask.now).toISOString(),
    }).then(
      () => ({ kind: 'fresh' }) as Claimed,
      (error: unknown) => {
        // **The line did not land, so the in-flight mark has to go.** Left
        // behind, a repeat of this key would be handed a promise nothing will
        // ever settle — a request held open for ever by a disk that was full
        // for a moment. The *record* stays, so the repeat is `unsure`: Tade
        // cannot say whether the act ran, and here it did not even get as far
        // as starting it.
        this.settle.get(ask.key)?.failed(error)
        this.settle.delete(ask.key)
        this.running.delete(ask.key)
        throw error
      },
    )
  }

  /**
   * The promise a concurrent repeat of this key awaits, settled by `while`.
   *
   * Its rejection is caught here and nowhere else matters: nobody may be
   * waiting on it, and an unawaited rejected promise is reported by the
   * window's own watcher as a bug. A refusal is not a bug.
   */
  private awaited(key: string): Promise<Outcome> {
    const promise = new Promise<Outcome>((done, failed) => {
      this.settle.set(key, { done, failed })
    })
    promise.catch(() => {})
    return promise
  }

  /**
   * Run the act, and settle whatever a concurrent repeat is awaiting with it.
   *
   * **A thunk and not a promise**, so that a verb which throws *synchronously*
   * still settles the thing other callers are waiting on: handed a promise,
   * this function is never reached in that case and a repeat waits for ever.
   *
   * The in-flight mark is dropped when it settles. A failed act is not a kept
   * answer — the `asked` line stands with nothing after it, so a later repeat
   * is `unsure` — which is the fail-closed half, said once here and once in
   * the file's header.
   */
  while(key: string, work: () => Promise<Outcome>): Promise<Outcome> {
    const settle = this.settle.get(key)
    this.settle.delete(key)
    let going: Promise<Outcome>
    try {
      going = work()
    } catch (error) {
      going = Promise.reject(error)
    }
    going.then(
      (came) => settle?.done(came),
      (error) => settle?.failed(error),
    )
    return going.finally(() => this.running.delete(key))
  }

  /** Write what came of it, and keep it for the next repeat. */
  async came(key: string, bound: string, outcome: Outcome, now: number): Promise<void> {
    const digest = boundDigest(bound)
    await this.write({
      kind: 'came',
      key,
      bound: digest,
      did: outcome.did,
      rev: outcome.rev,
      said: outcome.said,
      at: new Date(now).toISOString(),
    })
    const was = this.held.get(key)
    if (was !== undefined) this.keep({ ...was, outcome })
  }

  /**
   * Keep a record, newest last, dropping the oldest past `KEPT`.
   *
   * A `Map` keeps insertion order, so the oldest key is its first — which is
   * why this is a `delete` of one key and not a sort.
   */
  private keep(receipt: Receipt): void {
    this.held.delete(receipt.key)
    this.held.set(receipt.key, receipt)
    if (this.held.size <= KEPT) return
    for (const key of [...this.held.keys()]) {
      if (this.held.size <= KEPT) break
      // **Never one that is still going.** Dropping an in-flight key would
      // make a concurrent repeat of it look fresh, which is exactly the double
      // act this store exists to stop — so the kept window is `KEPT` plus
      // whatever is in flight, which the socket caps already bound.
      if (this.running.has(key)) continue
      this.held.delete(key)
    }
  }

  /** One line, with the mode narrowed on every write, as the device list is. */
  private async write(line: ReceiptLine): Promise<void> {
    const path = receiptsPath(this.home)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(Line.parse(line))}\n`, { mode: 0o600 })
    await chmod(path, 0o600).catch(() => {})
  }
}

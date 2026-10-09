import type { ExtensionContext, ExtensionWorkbench } from './port.ts'
import type {
  ExtensionWatch,
  Finding,
  Recheck,
  ReplyReceipt,
  ReplyRequest,
  WatchAgent,
  WatchContext,
} from './watch.ts'

// Asking a watch something: the look, the re-check and the reply, each inside
// the deadline every ask of an extension is held to.
//
// **Why the deadline is here rather than beside each caller.** Nothing the
// window runs may wait on a child process: it draws four times a second and
// answers keys in between, on one thread, so an extension that hangs would stop
// the window rather than itself. `inTime` is the one shape that holds, and it
// is in this file so the two doors below cannot be written without it.
//
// **Why `recheck` and `reply` are beside the look rather than inside it.** A
// look happens on a clock and its answer is a list; those two happen at the
// moment something is about to be done about one finding — the queue is about
// to start work on it, or a status is about to go back to where it came from —
// and they have no `since` and nothing to carry forward. Same extension, same
// readiness, same deadline, different question.
//
// What stays in the host is everything about *which* extension: finding it,
// whether it is ready, and what it was loaded with. This is only what happens
// once one has been found.

/** A promise that settles in time, or is given up on — its work told to stop — with why. */
export async function inTime<T>(
  work: Promise<T>,
  limit: number,
  late: string,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(late))
        }, limit)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** One watch, its context and its deadline, for a door that is not a look. */
export interface Watching {
  watch: ExtensionWatch
  ctx: WatchContext
  controller: AbortController
  limit: number
}

/**
 * What a watch is asked with, outside a look: the extension's own context,
 * narrowed to one project, with no `since` and nothing turned on — because
 * neither of these questions is about what is new.
 */
export function watchingWith(
  base: ExtensionContext,
  watch: ExtensionWatch,
  request: {
    project: string
    input: Readonly<Record<string, unknown>>
    timeoutMs?: number
    tade?: ExtensionWorkbench | null
  },
  limit: number,
): Watching {
  const controller = new AbortController()
  return {
    watch,
    ctx: {
      ...base,
      watching: base.project(request.project),
      input: request.input,
      since: null,
      turnedOn: new Date(0).toISOString(),
      tade: request.tade ?? null,
      signal: controller.signal,
    },
    controller,
    limit: request.timeoutMs ?? limit,
  }
}

/**
 * Whether one finding still stands. Throws when the watch cannot be asked or
 * has no answer to give, which is a hold: an inaccessible source is never
 * permission, and a shrug is not a yes.
 */
export async function askRecheck(one: Watching, id: string, key: string): Promise<Recheck> {
  const ask = one.watch.recheck
  if (!ask) throw new Error(`${id} cannot say whether what it found still stands`)
  const answer = await inTime(
    Promise.resolve().then(() => ask({ key }, one.ctx)),
    one.limit,
    `${id} took longer than ${Math.round(one.limit / 1000)}s to say whether ${key} still stands`,
    one.controller,
  )
  if (!answer || typeof answer.still !== 'boolean') {
    throw new Error(`${id} said nothing about whether ${key} still stands`)
  }
  // Only ever a hold, and a hold has to carry the sentence a person reads: one
  // that did not would be work stopped for a reason nobody could act on.
  if (answer.still === false && !answer.because?.trim()) {
    throw new Error(`${id} said ${key} no longer stands and did not say why`)
  }
  return answer.still ? { still: true } : { still: false, because: answer.because }
}

/**
 * Say one status back to where a finding came from. The sentence is the
 * caller's and Tade generated it; whether anything may be said at all is the
 * owner's grant, read before this is reached.
 */
export async function askReply(
  one: Watching,
  id: string,
  request: ReplyRequest,
): Promise<ReplyReceipt> {
  const say = one.watch.reply
  if (!say) throw new Error(`${id} has no way of saying anything back to its source`)
  const receipt = await inTime(
    Promise.resolve().then(() => say(request, one.ctx)),
    one.limit,
    `${id} took longer than ${Math.round(one.limit / 1000)}s to say something back about ${request.key}`,
    one.controller,
  )
  // A transport that says nothing has posted something it cannot describe,
  // which is allowed: an empty receipt is honest and reads as "it went, and I
  // cannot tell you any more than that". What is not allowed is reading a
  // missing answer as `already` — that would silently stop a status from ever
  // going out — so every field is only ever taken when it is actually there.
  return {
    ...(receipt?.posted ? { posted: receipt.posted } : {}),
    ...(receipt?.already === true ? { already: true } : {}),
    ...(receipt?.revision ? { revision: receipt.revision } : {}),
  }
}

/** What one look came to, and how to ask what an agent on a finding would be told. */
export interface Looked {
  found: Finding[]
  since: string | null
  /** Why it found nothing, where the watch had something to say about that. */
  said: string | null
  agent: (finding: Finding) => Promise<WatchAgent>
}

/**
 * Look with a watch: what it found, where the next look starts, and what an
 * agent on a finding would be told.
 *
 * Throws with why it could not look — a look that failed, took too long, or
 * found something it could not name. What it finds is checked rather than
 * trusted: a finding with no key is a finding Tade cannot promise to act on
 * once, which is the one promise the whole watch path makes.
 */
export async function askLook(one: Watching, id: string): Promise<Looked> {
  const { watch, ctx, controller, limit } = one
  const looked = await inTime(
    Promise.resolve().then(() => watch.check(ctx)),
    limit,
    `${id} took longer than ${Math.round(limit / 1000)}s to look, and was given up on`,
    controller,
  )
  const found: Finding[] = []
  for (const finding of looked.found ?? []) {
    if (typeof finding?.key !== 'string' || finding.key === '' || !finding.title) {
      throw new Error(`${id} found something without a key and a title to know it by`)
    }
    // The same thing said twice in one look is one finding.
    if (!found.some((other) => other.key === finding.key)) found.push(finding)
  }
  return {
    found,
    since: looked.since ?? ctx.since,
    // Only ever about a look that found nothing: what was found says what it is
    // itself, and a sentence beside a finding would be a second wording of the
    // same thing for nobody to read.
    said: found.length === 0 && looked.said ? looked.said : null,
    agent: async (finding) => {
      // A watch with nothing to start is not a broken one: it is told to
      // somebody, which is what it said it was for.
      const ask = watch.agent
      if (!ask) {
        throw new Error(
          `${id} has nothing to start work on: what it finds is told to the orchestrator`,
        )
      }
      const agent = await inTime(
        Promise.resolve().then(() => ask(finding, ctx)),
        limit,
        `${id} took longer than ${Math.round(limit / 1000)}s to say what to tell an agent about ${finding.key}`,
        controller,
      )
      if (!agent?.title || !agent.prompt) {
        throw new Error(`${id} said nothing to tell an agent about ${finding.key}`)
      }
      return agent
    },
  }
}

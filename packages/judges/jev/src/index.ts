import { createHash } from 'node:crypto'
import {
  type Answer,
  type AskRequest,
  type Judge,
  type JudgeCapabilities,
  JudgeError,
  type Judgement,
  type JudgeOptions,
  probability,
  type Question,
  refuseBadAsk,
  shareOut,
  stateText,
} from '@tade/judges-core'

// Jev, from TypeSafe: the one implementation that knows their vocabulary.
//
// `noul`, `systemone`, `criteria` and `instructions` appear here and nowhere
// else in Tade; everything above this file speaks the port's words. What it
// answers with is a probability and nothing else — no sentence, no rationale —
// which is why the question's own words have to be the explanation.
//
// It reads its state literally, cannot count, cannot compare dates, and does
// not treat what it reads as hostile. None of that is this file's to fix: it
// is why a caller keeps the arithmetic in code and may only ever add caution.

export const JEV_URL = 'https://api.typesafe.ai'
const ENDPOINT = '/v1/systemone'

/**
 * What a setting that names no version asks for: whatever TypeSafe calls its
 * newest. A pin went stale under everybody once — `jev-1.13.0` was retired,
 * every ask was a 400, and the review watch read as though it had found
 * nothing — so the default follows the provider, and every answer keeps the
 * version that gave it (`Judgement.version`), which is what thresholds and
 * calibration are read against instead. `extensions.jev.model` still pins one.
 */
export const LATEST = 'latest'

/**
 * What input costs, per million tokens, as TypeSafe published it on
 * 2026-09-17 — output is free. Provider-reported and not measured here: it is
 * used to say roughly what a look cost, never to bill anybody.
 */
export const USD_PER_MTOK = 0.042

/**
 * Their documented limits, as of `jev-1.13`. Their Models page says 64k per
 * request and their Primitives page says around 32k; until somebody measures
 * it, the smaller one is what a caller is held to — being refused a state that
 * would have fit is recoverable, and silently answering about half a diff is
 * not.
 */
const CAPABILITIES: JudgeCapabilities = {
  confidence: true,
  // Questions are answered in parallel against one state, so asking more of
  // them costs almost nothing; what binds first is the state budget, and 200
  // is what their own guidance suggests for a request of one-line questions.
  questionsPerAsk: 200,
  stateTokens: 32_000,
  optionsPerQuestion: 255,
  remote: true,
}

export interface JevOptions extends JudgeOptions {
  /** How many times to ask again when the answer was "later". */
  retries?: number
}

/**
 * The version a setting pins, or null where it asks for the latest: unset,
 * empty, or `latest` said in so many words.
 */
export function pinnedOf(options: Pick<JudgeOptions, 'model'>): string | null {
  const said = options.model?.trim() ?? ''
  return said === '' || said.toLowerCase() === LATEST ? null : said
}

/**
 * The newest of the versions a key can ask: TypeSafe's own `latest` alias
 * where it lists one, otherwise the highest version number among what it
 * lists, otherwise null. Pure, so the choice is a test rather than a hope.
 */
export function newestOf(listed: readonly string[]): string | null {
  const ids = listed.map((one) => one.trim()).filter(Boolean)
  const alias =
    ids.find((one) => /^jev-latest$/i.test(one)) ?? ids.find((one) => /(^|[-_.])latest$/i.test(one))
  if (alias) return alias
  const numbered = ids
    .map((id) => ({ id, parts: /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(id) }))
    .filter((one): one is { id: string; parts: RegExpExecArray } => one.parts !== null)
    .map((one) => ({ id: one.id, at: one.parts.slice(1, 4).map((part) => Number(part ?? 0)) }))
  numbered.sort((a, b) => {
    for (let at = 0; at < 3; at++) {
      const by = (b.at[at] ?? 0) - (a.at[at] ?? 0)
      if (by !== 0) return by
    }
    return 0
  })
  return numbered[0]?.id ?? null
}

/**
 * The latest version, as resolved once per Tade run and per key — the first
 * ask after Tade starts lists the versions, and a call told its version is
 * unknown lists them again (`forgetLatest`). Keyed by the `fetch` it was
 * asked with as well, so two hosts in one process never share an answer.
 * Only a version is kept — listed, or fallen back to — and a listing that
 * failed with nothing to fall back to is asked again next time.
 */
const latest = new WeakMap<typeof fetch, Map<string, Promise<string>>>()

/**
 * The last unpinned version an ask answered under, per key, which is what an
 * ask falls back to when the versions cannot be listed. An ask naming no
 * version is one TypeSafe refuses — 422, `model: Field required` — so every
 * batch of every change was refused the night listing failed under load, and
 * the review watch read nothing.
 */
const worked = new WeakMap<typeof fetch, Map<string, string>>()

function latestKey(options: JevOptions): string {
  return `${options.url ?? JEV_URL}\u0000${options.key ?? ''}`
}

/**
 * The name the version is kept under past this run: the address and the key,
 * hashed, so a file somebody reads holds no credential and two keys keep two
 * versions.
 */
function keptUnder(options: JevOptions): string {
  return createHash('sha256').update(latestKey(options)).digest('hex').slice(0, 16)
}

/**
 * The version that last answered, from this run or — after a restart, when
 * this run has none — from where it was kept (`JudgeOptions.kept`), or why
 * there is none to fall back to beyond nothing having answered.
 */
async function lastAnswered(
  options: JevOptions,
): Promise<{ version: string | null; problem: string | null }> {
  const here = workedFor(options).get(latestKey(options))
  if (here) return { version: here, problem: null }
  if (!options.kept) return { version: null, problem: null }
  try {
    const kept = await options.kept.read(keptUnder(options))
    if (kept) workedFor(options).set(latestKey(options), kept)
    return { version: kept, problem: null }
  } catch (err) {
    // Read only when the list could not be, so this is said in the one error
    // that follows — the one that has no version to ask with.
    return { version: null, problem: `the kept one could not be read: ${message(err)}` }
  }
}

/**
 * Keeps `version` past this run. A write that fails throws out of the ask:
 * Tade's home that cannot be written is trouble somebody has to hear about,
 * and the record of the same reading would fail beside it anyway.
 */
async function keep(options: JevOptions, version: string | null, said: string): Promise<void> {
  if (!options.kept) return
  try {
    await options.kept.write(keptUnder(options), version)
  } catch (err) {
    throw new Error(`${said}: ${message(err)}`, { cause: err })
  }
}

/** TypeSafe answered its list of versions with none at all. */
class NothingListed extends Error {}

function workedFor(options: JevOptions): Map<string, string> {
  const call = options.fetch ?? globalThis.fetch
  const kept = worked.get(call) ?? new Map<string, string>()
  worked.set(call, kept)
  return kept
}

/**
 * The version to ask under: the newest listed, else the last one that
 * answered here, else a `JudgeError` that cannot answer — never null, because
 * an ask with no version in it is refused whatever is in it.
 */
function latestFor(options: JevOptions): Promise<string> {
  const call = options.fetch ?? globalThis.fetch
  const kept = latest.get(call) ?? new Map<string, Promise<string>>()
  latest.set(call, kept)
  const key = latestKey(options)
  const had = kept.get(key)
  if (had) return had
  const asking = jevVersions(options)
    .then((listed) => {
      const found = newestOf(listed)
      if (found !== null) return found
      if (listed.length === 0) throw new NothingListed('TypeSafe lists no versions for this key')
      throw new Error(`none of the versions it lists (${listed.join(', ')}) reads as a version`)
    })
    .catch(async (err: unknown) => {
      // A key it refused is refused for the ask too, and is said as that.
      if (err instanceof JudgeError && err.cannotAnswer) throw err
      // A listing that could not be read — slow, down, or empty — falls back
      // to the version that last answered, and that is kept as the answer, so
      // the asks behind this one do not each wait out a listing that hangs.
      const before = await lastAnswered(options)
      if (before.version) return before.version
      // Nothing to fall back to: one loud error for the whole look rather than
      // a refusal per batch, and asked again by the next look, never kept.
      const why =
        err instanceof NothingListed
          ? err.message
          : `TypeSafe's list of versions could not be read (${message(err)})`
      const unkeptSaid = before.problem ? ` (${before.problem})` : ''
      throw new JudgeError(
        `Jev has no version to ask with: ${why} and no version that answered here is kept to fall back to${unkeptSaid}, so nothing was asked. It is listed again on the next look; pinning one in extensions.jev.model asks that one without listing`,
        { retryable: true, cannotAnswer: true },
      )
    })
    // A failure is never kept: a key put right, or a listing that answers
    // again, is asked next time.
    .catch((err: unknown) => {
      kept.delete(key)
      throw err
    })
  kept.set(key, asking)
  return asking
}

/** What was resolved as the latest is no longer to be trusted: list again. */
export function forgetLatest(options: JevOptions): void {
  latest.get(options.fetch ?? globalThis.fetch)?.delete(latestKey(options))
}

/**
 * The version that answered, kept for the next time listing fails — in this
 * run, and past it where there is somewhere to keep it, written only when it
 * changed rather than once per ask.
 */
async function answeredUnder(options: JevOptions, version: string): Promise<void> {
  const here = workedFor(options)
  if (here.get(latestKey(options)) === version) return
  await keep(options, version, `${version} answered but could not be kept for after a restart`)
  here.set(latestKey(options), version)
}

/** A version TypeSafe refused is not one to fall back to, here or after a restart. */
async function refusedUnder(options: JevOptions, version: string): Promise<void> {
  const here = workedFor(options)
  if (here.get(latestKey(options)) !== version) return
  here.delete(latestKey(options))
  await keep(options, null, `${version} was refused but could not be forgotten`)
}

/** Waits for `pending`, or for `signal` to abort — whichever is first. */
function until<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** TypeSafe said the version it was asked for is not one it has. */
class UnknownVersion extends JudgeError {}

interface JevAnswer {
  type?: unknown
  noul?: unknown
  choice?: unknown
  score?: unknown
  legend?: unknown
  probabilities?: unknown
  confidence?: unknown
}

export class JevJudge implements Judge {
  readonly id = 'jev'
  readonly capabilities = CAPABILITIES
  private readonly opts: JevOptions

  constructor(options: JevOptions = {}) {
    this.opts = options
  }

  /** Never the network: this is asked on every load, by everybody, unasked. */
  ready(): string | null {
    return this.opts.key
      ? null
      : 'Jev needs a TypeSafe API key: paste one into Extensions › Jev › Set up…, which writes it into your config, or export TYPESAFE_API_KEY in your shell'
  }

  /**
   * Whether the key is one TypeSafe will take. One request, and only where
   * somebody has just asked: `ready()` runs on every load and never does this.
   */
  async verify(): Promise<string | null> {
    const missing = this.ready()
    if (missing) return missing
    try {
      const versions = await jevVersions(this.opts)
      const wanted = pinnedOf(this.opts)
      // A pin is asked without listing, so an empty list costs it nothing.
      if (versions.length === 0) {
        return wanted === null
          ? 'the key works, but TypeSafe lists no versions for this key, so there is none to ask: pin one in extensions.jev.model'
          : null
      }
      if (wanted === null) {
        return newestOf(versions) === null
          ? `the key works, but none of the versions it lists (${versions.join(', ')}) reads as a version`
          : null
      }
      return versions.includes(wanted)
        ? null
        : `the key works, but ${wanted}, which extensions.jev.model pins, is not one of the versions it can ask (${versions.join(', ')}): empty the setting to ask the latest`
    } catch (err) {
      return message(err)
    }
  }

  async ask(request: AskRequest): Promise<Judgement> {
    const missing = this.ready()
    if (missing)
      throw new JudgeError(missing, { status: 401, retryable: false, cannotAnswer: true })
    refuseBadAsk(request.questions, request.state, this.capabilities)
    const pinned = pinnedOf(this.opts)
    // Shared by every ask with this key, so it is not tied to this one's
    // signal; this ask only stops waiting for it when it is itself aborted.
    let model = pinned ?? (await until(latestFor(this.opts), request.signal))
    const body = (version: string) =>
      JSON.stringify({
        state: stateText(request.state),
        model: version,
        questions: Object.fromEntries(request.questions.map((one) => [one.id, asked(one)])),
      })
    const first = await this.post(body(model), request.signal).catch((err: unknown) => {
      if (!(err instanceof UnknownVersion)) throw err
      // A pin is a person's, and a pin TypeSafe no longer has is theirs to
      // move: said as a judge that cannot answer, never quietly swapped.
      if (pinned) {
        throw new JudgeError(
          `TypeSafe does not have ${pinned}, which extensions.jev.model pins: empty the setting to ask whatever is latest, or pin a version it has`,
          { status: err.status, cannotAnswer: true },
        )
      }
      return err
    })
    let response: Response
    if (first instanceof UnknownVersion) {
      // The latest moved under us — retired between asks. Listed again, once,
      // and where the list still names the one refused, that refusal stands.
      forgetLatest(this.opts)
      await refusedUnder(this.opts, model)
      const again = await until(latestFor(this.opts), request.signal)
      if (again === model) throw first
      model = again
      response = await this.post(body(model), request.signal)
    } else response = first
    const read = (await response.json().catch(() => null)) as {
      model?: unknown
      answers?: Record<string, JevAnswer>
      usage?: { input_tokens?: unknown }
    } | null
    if (!read || typeof read !== 'object') {
      throw new JudgeError('TypeSafe answered something that was not a judgement', {
        status: response.status,
        retryable: true,
      })
    }
    const answers: Record<string, Answer> = {}
    for (const question of request.questions) {
      const answer = read.answers?.[question.id]
      // A question with no answer is a broken contract, not a zero: saying so
      // is the whole reason a caller can trust the rest of the table.
      if (!answer) {
        throw new JudgeError(`TypeSafe did not answer ${question.id}`, {
          status: response.status,
          retryable: false,
        })
      }
      answers[question.id] = understood(question, answer)
    }
    // Only a whole answer makes a version one to fall back to.
    if (!pinned) await answeredUnder(this.opts, model)
    const tokens =
      typeof read.usage?.input_tokens === 'number' ? Number(read.usage.input_tokens) : null
    return {
      // What TypeSafe says answered, which under an alias is the only place
      // the real version is named; what was asked for where it says nothing.
      version: typeof read.model === 'string' && read.model !== '' ? read.model : model,
      answers,
      cost: {
        requests: 1,
        inputTokens: tokens,
        usd: tokens === null ? null : (tokens / 1_000_000) * USD_PER_MTOK,
      },
    }
  }

  /**
   * One ask, asked again while the answer is "later". 429 and 529 are their
   * own words for come back — everything else is something a caller has to
   * act on, so it is raised the first time with what it said.
   */
  private async post(body: string, signal?: AbortSignal): Promise<Response> {
    const url = `${(this.opts.url ?? JEV_URL).replace(/\/+$/, '')}${ENDPOINT}`
    const call = this.opts.fetch ?? globalThis.fetch.bind(globalThis)
    const retries = this.opts.retries ?? 2
    let last: JudgeError | null = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      // Called off is called off: no further try, and the caller hears its own
      // abort rather than whatever the last try happened to fail with.
      if (signal?.aborted) throw signal.reason
      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 10_000)
      const response = await call(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.key ?? ''}`,
          'content-type': 'application/json',
        },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }).catch((err: unknown) => {
        // Nobody answered at all: worth one more try, and worth saying which.
        last = new JudgeError(`TypeSafe could not be reached: ${message(err)}`, {
          retryable: true,
        })
        return null
      })
      if (response?.ok) return response
      if (response) last = await refusal(response)
      if (signal?.aborted) throw signal.reason
      if (!last?.retryable || attempt === retries) break
      await pause(waitFor(response, attempt, this.opts.retryMs ?? 500), signal)
    }
    throw last ?? new JudgeError('TypeSafe did not answer', { retryable: true })
  }
}

/** A question in TypeSafe's own words. The only place they are spoken. */
function asked(question: Question): Record<string, unknown> {
  if (question.kind === 'yes-no') {
    const means = question.means
      ? ` Yes means ${question.means.yes}. No means ${question.means.no}.`
      : ''
    return { type: 'noul', instructions: `${question.ask}${means}` }
  }
  if (question.kind === 'pick') {
    return {
      type: 'choice',
      instructions: question.ask,
      criteria: Object.fromEntries(
        Object.entries(question.options).map(([option, means]) => [option, means ?? option]),
      ),
    }
  }
  return { type: 'score', instructions: question.ask, criteria: [...question.levels] }
}

/** Their answer, in the port's words. */
function understood(question: Question, answer: JevAnswer): Answer {
  const given = (answer.probabilities ?? {}) as Record<string, unknown>
  if (question.kind === 'yes-no') {
    return { kind: 'yes-no', probability: probability(answer.noul) }
  }
  const confidence =
    typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
      ? Math.min(1, Math.max(0, answer.confidence))
      : null
  if (question.kind === 'pick') {
    const options = Object.keys(question.options)
    const probabilities = shareOut(options, given)
    const said = typeof answer.choice === 'string' ? answer.choice : ''
    // An option nobody declared is not an answer: take the likeliest declared
    // one instead of handing a caller a name it has no branch for.
    const picked = options.includes(said)
      ? said
      : (options.slice().sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0))[0] ?? '')
    return { kind: 'pick', picked, probabilities, confidence }
  }
  const levels = [...question.levels]
  const score = typeof answer.score === 'number' && Number.isFinite(answer.score) ? answer.score : 0
  return {
    kind: 'rate',
    level: Math.min(levels.length - 1, Math.max(0, score)),
    levels,
    probabilities: shareOut(levels, given),
    confidence,
  }
}

/**
 * Whether what they refused was the size of the ask.
 *
 * Their own words for it, matched on the one part of the body that is a
 * machine-readable name rather than prose. It is worth telling apart from
 * everything else a 400 can be, because it is the one a caller can do
 * something about without anybody's help.
 */
function tooLong(said: string): boolean {
  return /max_tokens_exceeded|too (many|long)|context length/i.test(said)
}

/** Whether what they refused was the version asked for: `Unknown model: jev-1.13.0`. */
function unknownVersion(said: string): boolean {
  return /unknown[ _-]model|model[ _-]not[ _-]found|no such model|invalid[ _-]model/i.test(said)
}

/** What a refusal means, in words somebody can act on. */
async function refusal(response: Response): Promise<JudgeError> {
  const said = (await response.text().catch(() => '')).slice(0, 400).trim()
  const status = response.status
  // The body is JSON, and a reader who has been handed it verbatim has been
  // told nothing: `{"detail":{"error_type":"max_tokens_exceeded"}}` reached
  // somebody as the whole of why a review did not happen. So the one shape
  // worth recognising is said in words, and the rest still carries what they
  // said, because an error nobody recognises is evidence.
  if (unknownVersion(said)) {
    return new UnknownVersion(
      `TypeSafe answered ${status}: the version asked for is not one it has (${said})`,
      { status, cannotAnswer: true },
    )
  }
  const because = tooLong(said)
    ? 'the state was longer than one ask takes: read it in pieces, or give it fewer files at a time'
    : status === 401
      ? 'the key was not accepted: check TYPESAFE_API_KEY'
      : status === 400 || status === 422
        ? `a question or the state would not do: ${said || 'it did not say which'}`
        : status === 429
          ? 'too many requests: ask less often, or for fewer things at once'
          : status === 529
            ? 'TypeSafe is overloaded: it is worth trying again shortly'
            : said || 'it did not say why'
  return new JudgeError(`TypeSafe answered ${status}: ${because}`, {
    status,
    // Asking the same thing again cannot make it shorter.
    retryable: !tooLong(said) && (status === 429 || status === 529 || status >= 500),
    // Said as a fact rather than left in the sentence: what a caller does about
    // this is ask for less, and nobody should have to match on prose to know it.
    tooBig: tooLong(said),
    // A key refused is refused for every ask, whatever is in it.
    cannotAnswer: status === 401 || status === 403,
  })
}

/** How long before asking again: what they said, or backing off with jitter. */
function waitFor(response: Response | null, attempt: number, base: number): number {
  const said = Number(response?.headers.get('retry-after') ?? '')
  if (Number.isFinite(said) && said > 0) return Math.min(said * 1000, 10_000)
  const backoff = Math.min(base * 2 ** attempt, 5_000)
  return backoff + backoff * 0.25 * Math.random()
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  // An ask called off before the wait began has no 'abort' left to hear: a
  // listener added now never fires, and it would wait out the whole delay.
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((done) => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        done()
      },
      { once: true },
    )
  })
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The versions a key can ask. Asked only when somebody is sitting in front of
 * the screen having just asked for it — never from `ready()`, which runs on
 * every load and touches no network.
 */
export async function jevVersions(options: JevOptions): Promise<string[]> {
  const url = `${(options.url ?? JEV_URL).replace(/\/+$/, '')}/v1/models`
  const call = options.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await call(url, {
    headers: { authorization: `Bearer ${options.key ?? ''}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  })
  if (!response.ok) throw await refusal(response)
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  // What they answer has moved under us once already: `{ data: [{ id }] }`
  // became `{ models: [{ name, description, release_date }] }`, every entry
  // read as nameless, and the list read as empty — so every ask had no version
  // and nothing was asked for a night. An entry may be a name on its own, or
  // carry it as `id` or `name`.
  const listed = [body?.data, body?.models, body?.versions].find(Array.isArray) ?? []
  const ids = listed.map(versionIn).filter((one): one is string => one !== null)
  if (listed.length > 0 && ids.length === 0) {
    // Entries with no name Tade can read are not an empty list, and saying
    // "it listed none" about them sends whoever reads it the wrong way.
    throw new Error(
      `it listed ${listed.length} but named none in a way Tade reads (${JSON.stringify(listed[0]).slice(0, 120)})`,
    )
  }
  return ids
}

/** The version one entry of the list names, or null where it names none. */
function versionIn(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() || null
  if (!entry || typeof entry !== 'object') return null
  const { id, name } = entry as { id?: unknown; name?: unknown }
  for (const said of [id, name]) {
    if (typeof said === 'string' && said.trim() !== '') return said.trim()
  }
  return null
}

/** A Jev judge, for the registry. */
export const makeJevJudge = (options: JudgeOptions): Judge => new JevJudge(options)

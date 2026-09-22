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
export const JEV_MODEL = 'jev-1.13.0'
const ENDPOINT = '/v1/systemone'

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
      const wanted = this.opts.model ?? JEV_MODEL
      return versions.length === 0 || versions.includes(wanted)
        ? null
        : `the key works, but ${wanted} is not one of the versions it can ask (${versions.join(', ')})`
    } catch (err) {
      return message(err)
    }
  }

  async ask(request: AskRequest): Promise<Judgement> {
    const missing = this.ready()
    if (missing) throw new JudgeError(missing, { status: 401, retryable: false })
    refuseBadAsk(request.questions, request.state, this.capabilities)
    const model = this.opts.model ?? JEV_MODEL
    const body = JSON.stringify({
      state: stateText(request.state),
      model,
      questions: Object.fromEntries(request.questions.map((one) => [one.id, asked(one)])),
    })
    const response = await this.post(body, request.signal)
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
    const tokens =
      typeof read.usage?.input_tokens === 'number' ? Number(read.usage.input_tokens) : null
    return {
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

/** What a refusal means, in words somebody can act on. */
async function refusal(response: Response): Promise<JudgeError> {
  const said = (await response.text().catch(() => '')).slice(0, 400).trim()
  const status = response.status
  const because =
    status === 401
      ? 'the key was not accepted: check TYPESAFE_API_KEY'
      : status === 422
        ? `a question or the state would not do: ${said || 'it did not say which'}`
        : status === 429
          ? 'too many requests: ask less often, or for fewer things at once'
          : status === 529
            ? 'TypeSafe is overloaded: it is worth trying again shortly'
            : said || 'it did not say why'
  return new JudgeError(`TypeSafe answered ${status}: ${because}`, {
    status,
    retryable: status === 429 || status === 529 || status >= 500,
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
  if (ms <= 0) return Promise.resolve()
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
  const body = (await response.json().catch(() => null)) as {
    data?: { id?: unknown }[]
    models?: { id?: unknown }[]
  } | null
  const listed = body?.data ?? body?.models ?? []
  return listed.map((one) => String(one?.id ?? '')).filter(Boolean)
}

/** A Jev judge, for the registry. */
export const makeJevJudge = (options: JudgeOptions): Judge => new JevJudge(options)

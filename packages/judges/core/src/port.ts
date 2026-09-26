// The Judge port: something that answers bounded questions about a piece of
// state with a number, and writes nothing.
//
// A judge does not generate text. You declare the answers a question may have
// before you ask it — yes or no, one of these options, one of these levels —
// and you get back a probability for each. There is no parse step and no
// rationale: the question's own words are the explanation, so whoever acts on
// an answer reads the thing that was judged.
//
// Vocabulary rule (R2): no name here is one implementation's. It is `yes-no`,
// never `noul`; `rate`, never `score`; `options`, never `criteria`. If a second
// implementation would have to learn a vendor's word to satisfy this
// interface, the interface is wrong.

/** One bounded question, with the answers it may have declared before it is asked. */
export type Question =
  | {
      id: string
      kind: 'yes-no'
      /** The proposition, as literally as it can be put: a judge reads it as written. */
      ask: string
      /** What each answer would mean, when the proposition alone is not enough. */
      means?: { yes: string; no: string }
    }
  | {
      id: string
      kind: 'pick'
      ask: string
      /** Each option by name, with what it covers; null where the name says it. */
      options: Readonly<Record<string, string | null>>
    }
  | {
      id: string
      kind: 'rate'
      ask: string
      /** The levels, worst to best or least to most: the order is the scale. */
      levels: readonly string[]
    }

/** What a judge answered one question with. Never a sentence: there is none to give. */
export type Answer =
  | { kind: 'yes-no'; probability: number }
  | {
      kind: 'pick'
      picked: string
      probabilities: Readonly<Record<string, number>>
      /** How concentrated the answer is, where the judge says; null where it does not. */
      confidence: number | null
    }
  | {
      kind: 'rate'
      /** Where it landed on the scale, between levels: 0 is the first level. */
      level: number
      levels: readonly string[]
      probabilities: Readonly<Record<string, number>>
      confidence: number | null
    }

/** What one ask cost, as far as the judge knows. Counted, never judged. */
export interface Cost {
  requests: number
  /** Tokens the judge says it read; null when it does not say. */
  inputTokens: number | null
  /** Dollars, where the price is known; null otherwise. */
  usd: number | null
}

/** One ask, answered. */
export interface Judgement {
  /**
   * The version that answered. A threshold is tuned against one version's
   * distributions and an alias moves under you, so every finding keeps this.
   */
  version: string
  /** One answer per question, by the id the question was asked under. */
  answers: Readonly<Record<string, Answer>>
  cost: Cost
}

/** What a judge can do. Call sites branch on these, never on `judge.id`. */
export interface JudgeCapabilities {
  /** It says how concentrated an answer is, not only what it picked. */
  confidence: boolean
  /** How many questions one ask may carry, each answered against the same state. */
  questionsPerAsk: number
  /** How much state one ask may carry, in tokens as this judge counts them. */
  stateTokens: number
  /** The most options one `pick` may declare. */
  optionsPerQuestion: number
  /** It asks something else over the network, so nothing on a hot path may wait on it. */
  remote: boolean
}

/** Why an ask did not happen, in words the caller can act on. */
export class JudgeError extends Error {
  /** What the other end answered with, when it answered at all. */
  readonly status: number | null
  /** Asking again later could work: rate limited, overloaded, a timeout. */
  readonly retryable: boolean
  /**
   * What it refused was the *size* of the ask, declared rather than left in the
   * prose for a caller to match on.
   *
   * It is the one refusal a caller can do something about with nobody's help,
   * and the thing to do is never to ask again — `retryable` is false — but to
   * ask for less. A caller that cannot tell this refusal from the others has
   * only one move for both, which is to give up on the whole reading; that is
   * how one 400 came to be the whole of why a review did not happen.
   */
  readonly tooBig: boolean

  constructor(
    message: string,
    options: { status?: number | null; retryable?: boolean; tooBig?: boolean } = {},
  ) {
    super(message)
    this.name = 'JudgeError'
    this.status = options.status ?? null
    this.retryable = options.retryable ?? false
    this.tooBig = options.tooBig ?? false
  }
}

export interface AskRequest {
  /** What is being judged: text, or records as an object. Structure beats a blob of prose. */
  state: unknown
  questions: readonly Question[]
  signal?: AbortSignal
}

export interface Judge {
  /** Which implementation this is. Never branched on: that is what capabilities are for. */
  readonly id: string
  readonly capabilities: JudgeCapabilities
  /**
   * Whether it can answer here, and what to do about it if not. Never touches
   * the network: this is asked on every load, unasked.
   */
  ready(): string | null
  /**
   * Whether what it needs actually works — the key, the address — or what is
   * wrong with it. This one may ask, because it is only ever called when
   * somebody has just asked for it, with their eyes on the screen. `ready()`
   * may never do this, and the difference between the two is the whole reason
   * there are two.
   */
  verify(): Promise<string | null>
  /**
   * Answer every question about one state. Throws a `JudgeError`, with what to
   * do about it, when it cannot: a question it will not take, a state over
   * budget, a refusal from whatever answers.
   */
  ask(request: AskRequest): Promise<Judgement>
}

/** What every judge is built from, so a call site names one rather than constructing it. */
export interface JudgeOptions {
  /** The credential it needs, where it needs one. */
  key?: string
  /** Where to ask, when it is not the implementation's own address. */
  url?: string
  /** Which version answers. */
  model?: string
  fetch?: typeof fetch
  /** Answers from a table, for a judge that asks nobody. */
  answers?: Readonly<Record<string, number | string>>
  /** How long one attempt may take. */
  timeoutMs?: number
  /** How long to wait before asking again, where asking again is worth it. */
  retryMs?: number
}

export type MakeJudge = (options: JudgeOptions) => Judge

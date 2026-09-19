import {
  type Answer,
  type AskRequest,
  type Judge,
  type JudgeCapabilities,
  JudgeError,
  type Judgement,
  type JudgeOptions,
  refuseBadAsk,
  shareOut,
} from '@tade/judges-core'

// A judge that asks nobody: it answers from a table you wrote.
//
// It is what the tests use, what `--safe` can fall back to, and the honest way
// to show the loop working with no key — and it is never a silent default in a
// real window, because a judge that always answers 0 is a review that always
// passes, which is worse than no review at all. Whoever wants it names it.

export interface ScriptedOptions extends JudgeOptions {
  /**
   * What to answer, by question id: a number for a yes-no, an option's name
   * for a pick, a level's name or its number for a rate.
   */
  answers?: Readonly<Record<string, number | string>>
  /** What a question the table does not name is answered with. */
  otherwise?: number
  /** Answer every ask with a refusal instead: for seeing what callers do with one. */
  refuse?: { status?: number; retryable?: boolean; message?: string }
  version?: string
}

const CAPABILITIES: JudgeCapabilities = {
  confidence: true,
  questionsPerAsk: 200,
  stateTokens: 32_000,
  optionsPerQuestion: 255,
  remote: false,
}

export class ScriptedJudge implements Judge {
  readonly id = 'scripted'
  readonly capabilities = CAPABILITIES
  private readonly opts: ScriptedOptions

  constructor(options: ScriptedOptions = {}) {
    this.opts = options
  }

  /** It needs nothing, and says so: a table is always there. */
  ready(): string | null {
    return null
  }

  /** There is nobody to ask, so there is nothing that could be wrong. */
  async verify(): Promise<string | null> {
    return null
  }

  async ask(request: AskRequest): Promise<Judgement> {
    refuseBadAsk(request.questions, request.state, this.capabilities)
    const refuse = this.opts.refuse
    if (refuse) {
      throw new JudgeError(refuse.message ?? 'the judge was refused', {
        status: refuse.status ?? null,
        retryable: refuse.retryable ?? true,
      })
    }
    const table = this.opts.answers ?? {}
    const otherwise = this.opts.otherwise ?? 0
    const answers: Record<string, Answer> = {}
    for (const question of request.questions) {
      const said = table[question.id]
      if (question.kind === 'yes-no') {
        const probability = typeof said === 'number' ? said : otherwise
        answers[question.id] = {
          kind: 'yes-no',
          probability: Math.min(1, Math.max(0, probability)),
        }
        continue
      }
      if (question.kind === 'pick') {
        const options = Object.keys(question.options)
        const picked =
          typeof said === 'string' && options.includes(said) ? said : (options[0] ?? '')
        answers[question.id] = {
          kind: 'pick',
          picked,
          probabilities: shareOut(
            options,
            Object.fromEntries(options.map((option) => [option, option === picked ? 1 : 0])),
          ),
          confidence: 1,
        }
        continue
      }
      const levels = [...question.levels]
      const at =
        typeof said === 'number'
          ? said
          : typeof said === 'string' && levels.includes(said)
            ? levels.indexOf(said)
            : 0
      const level = Math.min(levels.length - 1, Math.max(0, at))
      answers[question.id] = {
        kind: 'rate',
        level,
        levels,
        probabilities: shareOut(
          levels,
          Object.fromEntries(
            levels.map((one, index) => [one, index === Math.round(level) ? 1 : 0]),
          ),
        ),
        confidence: 1,
      }
    }
    return {
      version: this.opts.version ?? 'scripted',
      answers,
      cost: { requests: 1, inputTokens: null, usd: 0 },
    }
  }
}

/** A scripted judge, for the registry. */
export const makeScriptedJudge = (options: JudgeOptions): Judge => new ScriptedJudge(options)

import { type JudgeCapabilities, JudgeError, type Question } from './port.ts'

// The checks every judge makes before it asks anybody anything, in one place
// so that two implementations refuse the same things in the same words — and
// so the conformance suite can hold them to it.
//
// Pure: questions and a state in, a sentence or null out.

/**
 * Roughly how many tokens a state is. Four characters to a token is the
 * estimate every provider's own guidance starts from; it exists so a caller
 * can be told to cut before a request is made, not to bill anybody.
 */
export function stateTokens(state: unknown): number {
  const text = typeof state === 'string' ? state : JSON.stringify(state ?? '')
  return Math.ceil((text?.length ?? 0) / 4)
}

/** The state as it goes on the wire: a string stays one, anything else is JSON. */
export function stateText(state: unknown): string {
  return typeof state === 'string' ? state : JSON.stringify(state ?? '')
}

/**
 * Why this ask will not do, in words the caller can fix it from, or null.
 *
 * A state over budget is refused rather than quietly truncated: a judge that
 * silently drops the half of a diff the question was about answers about
 * something else and says nothing.
 */
export function askProblem(
  questions: readonly Question[],
  state: unknown,
  capabilities: JudgeCapabilities,
): string | null {
  if (questions.length === 0) return 'ask at least one question'
  if (questions.length > capabilities.questionsPerAsk) {
    return `${questions.length} questions is more than one ask takes (${capabilities.questionsPerAsk}): ask in batches`
  }
  const seen = new Set<string>()
  for (const question of questions) {
    if (!question.id || !/^[a-z0-9][a-z0-9_]*$/.test(question.id)) {
      return `"${String(question.id)}" is not a question id: lowercase letters, digits and underscores`
    }
    if (seen.has(question.id)) return `two questions are called ${question.id}`
    seen.add(question.id)
    if (!question.ask?.trim()) return `${question.id} does not say what it asks`
    if (question.kind === 'pick') {
      const options = Object.keys(question.options ?? {})
      if (options.length < 2) return `${question.id} has ${options.length} option(s) to pick from`
      if (options.length > capabilities.optionsPerQuestion) {
        return `${question.id} has ${options.length} options, more than the ${capabilities.optionsPerQuestion} one question takes`
      }
    }
    if (question.kind === 'rate' && (question.levels?.length ?? 0) < 2) {
      return `${question.id} has ${question.levels?.length ?? 0} level(s) to rate against`
    }
  }
  const tokens = stateTokens(state)
  if (tokens > capabilities.stateTokens) {
    const over = tokens - capabilities.stateTokens
    return `the state is about ${tokens} tokens, ${over} over what one ask takes (${capabilities.stateTokens}): cut roughly ${over * 4} characters, or ask about it in pieces`
  }
  return null
}

/** The same check, thrown the way a judge fails. */
export function refuseBadAsk(
  questions: readonly Question[],
  state: unknown,
  capabilities: JudgeCapabilities,
): void {
  const problem = askProblem(questions, state, capabilities)
  if (problem) throw new JudgeError(problem, { retryable: false })
}

/** A probability as it was answered, kept inside 0–1 and never NaN. */
export function probability(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.min(1, Math.max(0, number))
}

/** Probabilities over the options that were declared, adding to one. */
export function shareOut(
  options: readonly string[],
  answered: Readonly<Record<string, unknown>>,
): Record<string, number> {
  const raw = options.map((option) => probability(answered[option]))
  const total = raw.reduce((sum, one) => sum + one, 0)
  const even = options.length > 0 ? 1 / options.length : 0
  return Object.fromEntries(
    options.map((option, index) => [option, total > 0 ? (raw[index] ?? 0) / total : even]),
  )
}

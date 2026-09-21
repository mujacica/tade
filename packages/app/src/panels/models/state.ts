import { close, control, type PanelOutcome, stay } from '../outcome.ts'

// Choosing a model: what there is to choose from, what each costs, and what
// typing narrows it to. The drawing is beside this in `view.ts`.

/** Choosing a model: for the orchestrator, or for one agent's session. */
export interface ModelPanel {
  kind: 'model'
  /** `orchestrator`, or the task whose agent it is for. */
  for: string
  query: string
  index: number
  busy: boolean
  error: string | null
}

export interface ModelChoice {
  /** `provider/id`, as the harness names it. */
  id: string
  provider: string
  name: string
  /** US dollars per million tokens, where the catalog prices it. */
  price?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/** A price per million tokens, the way a person reads one: $5, $0.95, $12.50, $0.016. */
export function perMillion(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd)}`
  if (usd >= 1) return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`
  if (usd === 0) return '$0'
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`
}

/**
 * What a model costs per million tokens, as three cells: in, out, and read
 * back from the cache — which is most of what a long session reads, and so
 * most of what it costs. A catalog price of nothing is one of two things: a
 * free model, or a router whose price is whichever model it picks.
 */
export function priceCells(model: ModelChoice): [string, string, string] {
  const price = model.price
  if (!price) return ['', '', '']
  if (price.input === 0 && price.output === 0 && price.cacheRead === 0) {
    return [/(:|\/)free$/.test(model.id) ? 'free' : 'varies', '', '']
  }
  return [perMillion(price.input), perMillion(price.output), perMillion(price.cacheRead)]
}

/** The same, on one line, for a list without columns: `$5 in · $25 out · $0.50 cached`. */
export function priceSaid(model: ModelChoice): string | null {
  const [input, output, cached] = priceCells(model)
  if (!input) return null
  if (!output) return input
  return `${input} in · ${output} out · ${cached} cached`
}

export function modelPanel(target: string): ModelPanel {
  return { kind: 'model', for: target, query: '', index: 0, busy: false, error: null }
}

/** The models that fit what is typed: every word somewhere in the id or the name. */
export function modelChoices(models: readonly ModelChoice[], query: string): ModelChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return models.filter((model) => {
    const text = `${model.id} ${model.name}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

export function modelKey(
  panel: ModelPanel,
  key: string | undefined,
  data: string,
  models: readonly ModelChoice[],
): PanelOutcome {
  const choices = modelChoices(models, panel.query)
  if (key === 'escape') return close
  if (key === 'up') return stay({ ...panel, index: Math.max(0, panel.index - 1) })
  if (key === 'down')
    return stay({ ...panel, index: Math.min(Math.max(0, choices.length - 1), panel.index + 1) })
  if (key === 'pageUp') return stay({ ...panel, index: Math.max(0, panel.index - 10) })
  if (key === 'pageDown')
    return stay({ ...panel, index: Math.min(Math.max(0, choices.length - 1), panel.index + 10) })
  if (key === 'enter') {
    const chosen = choices[panel.index]
    return chosen
      ? { panel: { ...panel, busy: true, error: null }, submit: true, choice: chosen.id }
      : stay(panel)
  }
  if (key === 'backspace') return stay({ ...panel, query: panel.query.slice(0, -1), index: 0 })
  if (key === 'space') return stay({ ...panel, query: `${panel.query} `, index: 0 })
  const typed = data.startsWith('\x1b') ? '' : [...data].filter((char) => !control(char)).join('')
  if (typed) return stay({ ...panel, query: panel.query + typed, index: 0, error: null })
  return stay(panel)
}

export function modelClick(
  panel: ModelPanel,
  control: string,
  models: readonly ModelChoice[],
): PanelOutcome {
  if (control === 'cancel') return close
  const chosen = modelChoices(models, panel.query)[Number(control.slice(4))]
  return control.startsWith('row:') && chosen
    ? { panel: { ...panel, busy: true, error: null }, submit: true, choice: chosen.id }
    : stay(panel)
}

// What a spoken sentence means.
//
// A small closed vocabulary, resolved before anything reaches a model: it is
// deterministic, instant, and free. Everything it doesn't recognise falls
// through as free text, so the grammar is an accelerator and never a cage.
//
// Pure, and deliberately conservative: when a sentence is ambiguous it falls
// through rather than guessing, because acting on a misheard command is much
// worse than asking again.

export type Intent =
  | { kind: 'status'; scope: string | null }
  | { kind: 'focus'; task: string }
  | { kind: 'steer'; task: string; message: string }
  /** Switch the model an agent runs on. `task` may be empty: the one being talked about. */
  | { kind: 'model'; task: string; model: string }
  | { kind: 'approve' }
  | { kind: 'deny' }
  /** The distinct phrase a destructive command requires. Never a bare yes. */
  | { kind: 'confirm'; phrase: string }
  | { kind: 'start'; project: string; intent: string }
  | { kind: 'park'; task: string }
  | { kind: 'resume'; task: string }
  | { kind: 'remember'; text: string }
  /**
   * Something to do with a terminal along the bottom of the window. `name` is
   * which one, as said (`tests`, `2`), or null for the one in front of you.
   */
  | {
      kind: 'terminal'
      action: 'open' | 'show' | 'close' | 'rename' | 'run' | 'search'
      name: string | null
      /** A new name, for rename. */
      to?: string
      /** The command line, exactly as said, for run. */
      command?: string
      /** What to look for, for search. */
      text?: string
    }
  /** Open the settings, so changing one never means closing Tade. */
  | { kind: 'settings' }
  /** Everything that matters, in one paragraph: the brief, now rather than in the morning. */
  | { kind: 'brief' }
  | { kind: 'free'; text: string }

export interface Vocabulary {
  /** Task ids, like `checkout/stripe-v15`. */
  tasks: string[]
  projects: string[]
}

const STATUS = /^(where are we|what'?s (going on|happening)|status|how are (we|things))\b/
const STATUS_SCOPED = /^(what about|how is|how'?s|status (of|for))\s+(?<scope>.+?)[?.]?$/
const FOCUS = /^(show me|pull up|open|bring up)\s+(?<task>.+?)[?.]?$/
const STEER = /^(tell|ask)\s+(?<rest>.+)$/
const START = /^(start|kick off|begin)\s+(?<rest>.+)$/
const PARK = /^(park|pause|set aside)\s+(?<task>.+?)[?.]?$/
const SETTINGS = /^((open|show|change)\s+)?(settings|preferences|config(uration)?)[?.]?$/
const BRIEF =
  /^((give me|read me|what'?s|what is)\s+)?(the\s+|a\s+|my\s+)?(morning\s+)?brief(ing)?(\s+me)?[?.!]?$|^(brief me|catch me up|what did i miss)[?.!]?$/
const RESUME = /^(resume|unpark|pick up|pick)\s+(?<task>.+?)(\s+back up)?[?.]?$/
/**
 * Everything people say when they want something written down. `note` and
 * `important` lead a lot of sentences, so each needs something after it.
 */
const REMEMBER =
  /^(remember|note to self|note down|note|make a note( of)?|write down|jot down|keep in mind|don'?t forget|do not forget|never forget|important|for the record)(\s+that)?\s*[:,\-–]?\s+(?<text>.+)$/
// Terminals. Every one of these says the word "terminal", so an instruction
// meant for an agent ("run the tests") is never mistaken for one.
const NAMED = String.raw`(?:(?:the|my)\s+)?(?:(?<name>.+?)\s+)?terminal(?:\s+(?<after>(?!to\b)[\w-]+))?`
const TERMINAL_OPEN =
  /^(?:open|start|launch|create|new)(?:\s+up)?(?:\s+(?:a|another|a new|new))?\s+terminal(?:\s+(?:called|named)\s+(?<called>.+?))?[.!]?$/
const TERMINAL_SHOW = new RegExp(
  String.raw`^(?:show(?:\s+me)?|switch to|go to|bring up)\s+${NAMED}[.?]?$`,
)
const TERMINAL_CLOSE = new RegExp(String.raw`^(?:close|kill|end)\s+${NAMED}[.!]?$`)
const TERMINAL_RENAME =
  /^(?:rename|call)\s+(?:(?:the|my)\s+)?(?:(?<name>.+?)\s+)?terminal(?:\s+(?<after>(?!to\b)[\w-]+))?\s+(?:to\s+)?(?<to>.+?)[.!]?$/
const TERMINAL_RUN = new RegExp(
  String.raw`^(?:run|execute|type)\s+(?<command>.+?)\s+in(?:to)?\s+${NAMED}$`,
)
const TERMINAL_SEARCH = new RegExp(
  String.raw`^(?:search|find|look)(?:\s+for)?\s+(?<text>.+?)\s+in\s+${NAMED}[.?]?$`,
)

// Switching an agent's model. Each names the word "model", so "switch refunds
// to the new API" stays an instruction for the agent.
const MODEL_WORDS = String.raw`(?:the\s+)?(?:currently\s+selected\s+|current\s+|selected\s+)?model`
const MODEL_IN = new RegExp(
  String.raw`^in\s+(?<task>.+?)[,\s]+(?:change|switch|set)\s+${MODEL_WORDS}\s+to\s+(?<model>.+?)[.!]?$`,
)
const MODEL_OF = new RegExp(
  String.raw`^(?:change|switch|set)\s+${MODEL_WORDS}\s+(?:of|for|in|on)\s+(?<task>.+?)\s+to\s+(?<model>.+?)[.!]?$`,
)
const MODEL_ONTO =
  /^(?:switch|move|put)\s+(?<task>.+?)\s+(?:over\s+)?(?:to|onto)\s+(?:the\s+)?(?<model>.+?)\s+model[.!]?$/

const APPROVE = /^(yes|yep|yeah|go ahead|do it|approve|approved|sure|please do)[.!]?$/
const DENY = /^(no|nope|don'?t|deny|denied|stop|cancel|refuse)[.!]?$/
const CONFIRM = /^confirm\s+(?<phrase>.+?)[.!]?$/

/** Words a transcriber reliably mangles, mapped to what was meant. */
const HOMOPHONES: Array<[RegExp, string]> = [
  [/\bbark\b/g, 'park'],
  [/\bthe neigh\b/g, 'deny'],
  [/\bdee nye\b/g, 'deny'],
  [/\bcheck out\b/g, 'checkout'],
  [/\bpicked up\b/g, 'pick up'],
  [/\bwill co\b/g, 'tade'],
]

/** Words that mean "the one we were just talking about". */
const SPOKEN_PRONOUNS = new Set(['it', 'that', 'this', 'that one', 'this one', 'them', 'the same'])

/**
 * A pronoun is not a name, so the grammar hands it on rather than guessing:
 * working out which task you meant is the resolver's job, not the parser's.
 */
export function isPronoun(text: string): boolean {
  const said = text.trim().toLowerCase()
  // Check as said first: "the same" is itself a pronoun, so stripping "the"
  // before looking would make that entry unreachable.
  return SPOKEN_PRONOUNS.has(said) || SPOKEN_PRONOUNS.has(said.replace(/^the\s+/, ''))
}

export function normalise(text: string): string {
  let out = text.toLowerCase().trim().replace(/\s+/g, ' ')
  for (const [pattern, replacement] of HOMOPHONES) out = out.replace(pattern, replacement)
  return out.replace(/[,;]+$/, '')
}

export function parseUtterance(text: string, vocabulary: Vocabulary): Intent {
  const said = normalise(text)
  /** Lowercased only: keeps spans lined up with what was actually said. */
  const lower = text.toLowerCase().trim().replace(/\s+/g, ' ')
  const free: Intent = { kind: 'free', text: text.trim() }
  if (said === '') return free

  // Confirmation first: it must never be reachable by accident.
  const confirm = CONFIRM.exec(said)
  if (confirm?.groups?.phrase) return { kind: 'confirm', phrase: confirm.groups.phrase }

  if (APPROVE.test(said)) return { kind: 'approve' }
  if (DENY.test(said)) return { kind: 'deny' }

  if (SETTINGS.test(said)) return { kind: 'settings' }
  if (BRIEF.test(said)) return { kind: 'brief' }

  if (STATUS.test(said)) return { kind: 'status', scope: null }
  const scoped = STATUS_SCOPED.exec(said)
  if (scoped?.groups?.scope) {
    const scope = resolve(scoped.groups.scope, vocabulary)
    return scope ? { kind: 'status', scope } : free
  }

  const remember = REMEMBER.exec(said)
  // Kept exactly as it was said, like an intent: a note is the one thing
  // nothing else can reconstruct, and normalised text would file "I work from
  // home on Fridays" as "i work from home on fridays".
  if (remember?.groups?.text) {
    return { kind: 'remember', text: original(text, remember.groups.text) }
  }

  const terminal = parseTerminal(said, lower, text)
  if (terminal) return terminal

  // Matched against lightly-normalised text, so the intent keeps the words as
  // they were said: it is stored verbatim and nothing else can reconstruct it.
  const start = START.exec(lower)
  if (start?.groups?.rest) {
    const rest = start.groups.rest
    // A sentence can hold several prepositions ("double-charges on retries in
    // checkout"), and no regex knows which one starts the project name. Try
    // each boundary from the right and let the known projects decide.
    const boundaries = [...rest.matchAll(/\s+(in|on)\s+/g)].reverse()
    for (const boundary of boundaries) {
      const at = boundary.index
      if (at === undefined) continue
      const project = resolveProject(rest.slice(at + boundary[0].length), vocabulary)
      if (project) {
        return { kind: 'start', project, intent: span(text, rest.slice(0, at)) }
      }
    }
    return free
  }

  const focus = FOCUS.exec(said)
  if (focus?.groups?.task) {
    if (isPronoun(focus.groups.task)) return { kind: 'focus', task: '' }
    const task = resolve(focus.groups.task, vocabulary)
    return task ? { kind: 'focus', task } : free
  }

  const park = PARK.exec(said)
  if (park?.groups?.task) {
    if (isPronoun(park.groups.task)) return { kind: 'park', task: '' }
    const task = resolve(park.groups.task, vocabulary)
    return task ? { kind: 'park', task } : free
  }

  const resume = RESUME.exec(said)
  if (resume?.groups?.task) {
    if (isPronoun(resume.groups.task)) return { kind: 'resume', task: '' }
    const task = resolve(resume.groups.task, vocabulary)
    return task ? { kind: 'resume', task } : free
  }

  for (const pattern of [MODEL_IN, MODEL_OF, MODEL_ONTO]) {
    const match = pattern.exec(lower)
    const named = match?.groups?.task?.trim()
    if (named && match?.groups?.model) {
      const task = isPronoun(named) ? '' : resolve(named, vocabulary)
      if (task !== null) return { kind: 'model', task, model: match.groups.model.trim() }
    }
  }

  const steer = STEER.exec(said)
  if (steer?.groups?.rest) {
    // Where the name ends and the message begins can't be found by a regex:
    // a greedy capture swallows the first word of the message, and the engine
    // never backtracks because the match still succeeds. So try one word as
    // the name, then two, and let the known names decide.
    const words = steer.groups.rest.split(' ')
    // "tell it to also update the docs": the resolver works out which one.
    if (words.length > 1 && isPronoun(words[0] ?? '')) {
      return { kind: 'steer', task: '', message: original(text, words.slice(1).join(' ')) }
    }
    for (const take of [1, 2]) {
      if (words.length <= take) break
      const task = resolve(words.slice(0, take).join(' '), vocabulary)
      if (task) {
        return { kind: 'steer', task, message: original(text, words.slice(take).join(' ')) }
      }
    }
  }

  return free
}

/** A sentence about a terminal, or null. A command or search keeps the casing it was said with. */
function parseTerminal(said: string, lower: string, text: string): Intent | null {
  const name = (groups: Record<string, string | undefined> | undefined): string | null => {
    const spoken = (groups?.name ?? groups?.after ?? '').trim()
    return spoken === '' || spoken === 'this' || spoken === 'that' ? null : spoken
  }
  const open = TERMINAL_OPEN.exec(said)
  if (open) {
    return {
      kind: 'terminal',
      action: 'open',
      name: open.groups?.called ? span(text, open.groups.called) : null,
    }
  }
  const run = TERMINAL_RUN.exec(lower)
  if (run?.groups?.command) {
    return {
      kind: 'terminal',
      action: 'run',
      name: name(run.groups),
      command: span(text, run.groups.command),
    }
  }
  const search = TERMINAL_SEARCH.exec(lower)
  if (search?.groups?.text) {
    return {
      kind: 'terminal',
      action: 'search',
      name: name(search.groups),
      text: span(text, search.groups.text),
    }
  }
  const rename = TERMINAL_RENAME.exec(said)
  if (rename?.groups?.to) {
    return {
      kind: 'terminal',
      action: 'rename',
      name: name(rename.groups),
      to: span(text, rename.groups.to),
    }
  }
  const close = TERMINAL_CLOSE.exec(said)
  if (close) return { kind: 'terminal', action: 'close', name: name(close.groups) }
  const show = TERMINAL_SHOW.exec(said)
  if (show) return { kind: 'terminal', action: 'show', name: name(show.groups) }
  return null
}

/** The same span of the original text, with its casing intact. */
function span(text: string, fragment: string): string {
  const index = text.toLowerCase().indexOf(fragment)
  return (index >= 0 ? text.slice(index, index + fragment.length) : fragment).trim()
}

/** Find the original casing and punctuation for a matched fragment. */
function original(text: string, fragment: string): string {
  const index = text.toLowerCase().indexOf(fragment.slice(0, 12))
  return index >= 0 ? text.slice(index).trim() : fragment
}

/** Match a spoken name against known tasks, then projects. */
export function resolve(spoken: string, vocabulary: Vocabulary): string | null {
  const name = spoken.trim().replace(/^(the|my)\s+/, '')
  const candidates = [...vocabulary.tasks]
  const exact = candidates.find((t) => t === name || t.split('/').at(-1) === name)
  if (exact) return exact

  const collapsed = name.replace(/\s+/g, '')
  const loose = candidates.filter(
    (t) => t.split('/').at(-1)?.replace(/-/g, '') === collapsed.replace(/-/g, ''),
  )
  if (loose.length === 1) return loose[0]!

  const project = resolveProject(name, vocabulary)
  if (project) {
    const owned = candidates.filter((t) => t.startsWith(`${project}/`))
    // A project name only resolves to a task when it owns exactly one.
    if (owned.length === 1) return owned[0]!
    return project
  }
  return null
}

export function resolveProject(spoken: string, vocabulary: Vocabulary): string | null {
  const name = spoken
    .trim()
    .replace(/^(the|my)\s+/, '')
    .replace(/\s+/g, '')
  return vocabulary.projects.find((p) => p.replace(/-/g, '') === name.replace(/-/g, '')) ?? null
}

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
  | { kind: 'approve' }
  | { kind: 'deny' }
  /** The distinct phrase a destructive command requires. Never a bare yes. */
  | { kind: 'confirm'; phrase: string }
  | { kind: 'start'; project: string; intent: string }
  | { kind: 'park'; task: string }
  | { kind: 'resume'; task: string }
  | { kind: 'remember'; text: string }
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
const RESUME = /^(resume|unpark|pick up|pick)\s+(?<task>.+?)(\s+back up)?[?.]?$/
const REMEMBER = /^(remember|note|keep in mind)(\s+that)?\s+(?<text>.+)$/
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
  [/\bwill co\b/g, 'wilco'],
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

  if (STATUS.test(said)) return { kind: 'status', scope: null }
  const scoped = STATUS_SCOPED.exec(said)
  if (scoped?.groups?.scope) {
    const scope = resolve(scoped.groups.scope, vocabulary)
    return scope ? { kind: 'status', scope } : free
  }

  const remember = REMEMBER.exec(said)
  if (remember?.groups?.text) return { kind: 'remember', text: remember.groups.text }

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

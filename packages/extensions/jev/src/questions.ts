import type { Question } from '@tade/judges-core'

// Every question Tade asks a judge, and every threshold, in one file.
//
// This is the artefact with the value in it: not the client, not the tools —
// the rubric. It is here in one place so it can be read and argued with
// without reading the code that asks it, and because a question hiding several
// judgments is the first mistake to make. Each is one judgment, written
// literally, about the words in front of it: a judge reads instructions as
// written, cannot count, cannot do arithmetic and cannot compare dates, so
// anything of that shape is computed in code and put in the state.
//
// There is no rationale in an answer, ever. So a question's own words are the
// explanation somebody woken by it reads — write them for that person.

/** What a probability has to reach to be worth saying at all. */
export const REPORT = 0.6
/** What it has to reach before work is started rather than somebody asked. */
export const ACT = 0.85
/** The most requests one look or one tool call may make. */
export const BUDGET = 200
/** How long a branch has to have been still before its diff is worth reading. */
export const SETTLE = '10m'

/** How bad it would be to ship a change as it stands. Ordered, worst last. */
export const SEVERITY = [
  'nothing worth saying',
  'worth a comment',
  'should be fixed before release',
  'must not ship',
] as const

const yesNo = (id: string, ask: string): Question => ({ id, kind: 'yes-no', ask })

// ── Reading a change ────────────────────────────────────────────────────────
//
// Hazards first: one question per hazard, never one "is this safe?", because a
// question that hides several judgments cannot be thresholded or deleted.

export const HAZARDS: readonly Question[] = [
  yesNo(
    'shell_injection',
    'Does this change pass a value that came from outside the program into a shell command, without escaping it or checking it against a list of allowed values?',
  ),
  yesNo(
    'sql_injection',
    'Does this change put a value that came from outside the program into an SQL query as text, rather than as a query parameter?',
  ),
  yesNo(
    'secret_committed',
    'Does this change add a password, API key, token or private key written out in the code, rather than read from the environment?',
  ),
  yesNo(
    'authz_removed',
    'Does this change remove or weaken a permission check on an operation that already had one?',
  ),
  yesNo(
    'path_traversal',
    'Does this change build a filesystem path out of a value that came from outside the program?',
  ),
  yesNo(
    'unsafe_exec',
    'Does this change run code that was built from data while the program is running, such as eval or new Function?',
  ),
  yesNo(
    'error_swallowed',
    'Does this change catch an error and carry on without reporting it anywhere?',
  ),
  yesNo(
    'test_missing',
    'Does this change alter what the program does without adding or changing a test that covers it?',
  ),
]

/**
 * The house rules: what a reviewer reads for and a compiler cannot. These are
 * this repository's own invariants written almost verbatim, and a project with
 * other rules replaces them here rather than anywhere else.
 */
export const HOUSE: readonly Question[] = [
  yesNo(
    'port_vocabulary',
    'Does this change give a shared interface a method or field named after one implementation, such as sendKeys, tmux or pi, rather than after what it does?',
  ),
  yesNo(
    'sniffed_capability',
    'Does this change decide what to do by checking which implementation something is, instead of by a capability that implementation declares?',
  ),
  yesNo(
    'dead_setting',
    'Does this change add a configuration key that nothing in the change reads?',
  ),
  yesNo(
    'mocked_git',
    'Does this change test git by replacing it with a fake, instead of against a real repository?',
  ),
  yesNo(
    'silent_failure',
    'Does this change make something able to fail without anyone being told in words what went wrong?',
  ),
  yesNo(
    'kind_fixture',
    'Does this change make a test fixture tidier or more forgiving than a real project would be?',
  ),
]

/** The question no linter can ask, and the reason a task's diff is the unit. */
export const DID_WHAT_WAS_ASKED: Question = yesNo(
  'did_what_was_asked',
  'The words the work was asked for in are in the state. Does this change do something other than what was asked for?',
)

export const SEVERITY_QUESTION: Question = {
  id: 'severity',
  kind: 'rate',
  ask: 'How bad would it be to ship this change as it stands?',
  levels: [...SEVERITY],
}

/** The whole review pack, or the part of it somebody named. */
export function reviewQuestions(only?: readonly string[] | null): Question[] {
  const all = [...HAZARDS, ...HOUSE, DID_WHAT_WAS_ASKED]
  if (!only || only.length === 0) return [...all, SEVERITY_QUESTION]
  const wanted = all.filter((one) => only.includes(one.id))
  if (wanted.length === 0) {
    throw new Error(
      `none of ${only.join(', ')} is a question in the review pack (there is ${all.map((one) => one.id).join(', ')})`,
    )
  }
  return [...wanted, SEVERITY_QUESTION]
}

// ── Reading a request ───────────────────────────────────────────────────────
//
// The six judgments `composePrompt`'s rules are written as hopes. Asking them
// again, independently, is not a better reading — it is a second one, and a
// disagreement between two readings is what says somebody should be asked.

export const REQUEST_SHAPE: Question = {
  id: 'shape',
  kind: 'pick',
  ask: 'What is being asked for, in the words below?',
  options: {
    question: 'about what is happening now; nothing to start',
    one_change: 'one piece of work for one agent',
    several: 'several pieces of work that want a plan',
    steer: 'about work an agent is already doing; it belongs to that agent',
    recurring: 'something on a clock, or something to watch for',
    setting: 'about how Tade itself is set up',
    chat: 'nothing to start: talk, thanks, an aside',
  },
}

export const REQUEST_QUESTIONS: readonly Question[] = [
  REQUEST_SHAPE,
  yesNo(
    'ambiguous_project',
    'Could what was said be about more than one of the projects listed in the state?',
  ),
  yesNo('ambiguous_work', 'Could what was said reasonably mean two different pieces of work?'),
  yesNo(
    'needs_decision',
    'Does doing what was said require a choice only the person who said it can make?',
  ),
  yesNo('underspecified', 'Is something needed to start this work missing from what was said?'),
  yesNo(
    'refers_to_running',
    'Does what was said refer to work an agent listed in the state is already doing?',
  ),
  yesNo('wants_now', 'Do they want this started now, rather than planned for later?'),
  yesNo('wants_them_present', 'Would they have to be at the keyboard while this work runs?'),
  yesNo('irreversible', 'Would doing what was said destroy something that cannot be got back?'),
]

// ── Reading a plan ──────────────────────────────────────────────────────────
//
// One request per pair of agents that could run at the same time, and one per
// agent. Never one request about "the plan": a property of a pair inside a
// plan is the indirection a judge is worst at.

/** Asked about two agents that could run at the same time. */
export function pairQuestions(first: string, second: string): Question[] {
  const two = `"${first}" and "${second}"`
  return [
    yesNo('same_files', `Would the changes described as ${two} end up editing the same file?`),
    yesNo(
      'same_behaviour',
      `Would the changes described as ${two} have to agree with each other about how something behaves for both of them to be right — an interface and what implements it, a setting and what reads it, a name and everywhere it is used?`,
    ),
    yesNo('one_job', `Are ${two} really one piece of work that has been split in two?`),
    yesNo(
      'b_needs_a',
      `Does "${second}" need "${first}" to be finished before it can be done at all?`,
    ),
    yesNo(
      'b_reviews_a',
      `Is "${second}" only worth doing if "${first}" turns out a particular way?`,
    ),
  ]
}

/** Asked about one agent in a plan. */
export function agentQuestions(name: string): Question[] {
  return [
    yesNo(
      'too_big',
      `Is the work described as "${name}" more than one agent's work as it is described?`,
    ),
    yesNo('needs_person', `Would somebody have to be at the keyboard while "${name}" runs?`),
    yesNo(
      'gate_splits',
      `Would the work described as "${name}" leave the project's own checks failing until some other change lands?`,
    ),
  ]
}

// ── Reading a queue ─────────────────────────────────────────────────────────
//
// What can be counted is counted in code — how many wait on this, how long it
// has waited, whether its base moved. What is left is what nobody can derive.

export interface QueueAsk {
  id: string
  /** What it is about the item, for the table. */
  about: string
  ask: (about: string) => string
}

export const QUEUE_ASKS: readonly QueueAsk[] = [
  {
    id: 'broken_now',
    about: 'fixes something broken now',
    ask: (about) =>
      `Does the work described as ${about} fix something that is broken for somebody right now?`,
  },
  {
    id: 'unblocks_person',
    about: 'a person is waiting on it',
    ask: (about) =>
      `Is a person waiting on the work described as ${about} before they can do anything else?`,
  },
  {
    id: 'quick',
    about: 'reads as a small change',
    ask: (about) =>
      `Does the work described as ${about} read like a small change, finished in one sitting?`,
  },
  {
    id: 'risky_together',
    about: 'risky beside what is running',
    ask: (about) =>
      `Is the work described as ${about} risky to run while the work already going, listed in the state, is going?`,
  },
  {
    id: 'needs_person',
    about: 'needs somebody awake',
    ask: (about) => `Would the work described as ${about} need somebody awake and at the keyboard?`,
  },
  {
    id: 'stale',
    about: 'may already be done',
    ask: (about) =>
      `Does the work described as ${about} read like something another piece of work in the state has already done?`,
  },
]

/** What matters more when ordering a queue, as a weight per question. */
export const QUEUE_WEIGHTS: Readonly<Record<string, number>> = {
  broken_now: 3,
  unblocks_person: 2,
  quick: 1,
  risky_together: -2,
  needs_person: -1,
  stale: -3,
}

/** A question asked once per thing in a list: `broken_now__3`. */
export function numbered(id: string, index: number): string {
  return `${id}__${index}`
}

/** The question id and the thing it was about, from an id `numbered` made. */
export function unnumbered(id: string): { id: string; index: number } {
  const [base = id, index] = id.split('__')
  return { id: base, index: Number(index ?? -1) }
}

const TITLES = new Map<string, string>(
  [...HAZARDS, ...HOUSE, DID_WHAT_WAS_ASKED, SEVERITY_QUESTION, ...REQUEST_QUESTIONS].map((one) => [
    one.id,
    one.ask,
  ]),
)

/** A question's own words, by its id: what a finding says, because nothing else can. */
export function titleOf(id: string): string {
  return TITLES.get(unnumbered(id).id) ?? id
}

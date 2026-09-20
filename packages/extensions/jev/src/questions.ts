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

// ── Reading a command ───────────────────────────────────────────────────────
//
// What the approval rules do not name. Those rules are patterns somebody
// wrote — `sudo`, a force push, `rm -rf` aimed outside the worktree — and they
// are what actually answers; this is asked beside them, about everything
// nobody wrote a pattern for: `terraform destroy`, `kubectl delete namespace`,
// `aws s3 rm --recursive`, a `dd` at a device, a `git clean -xfd` over an hour
// of somebody else's uncommitted work.
//
// Two things make this safe to put in front of an agent. It may only raise a
// tier, so a command written to argue with the judge gets, at worst, what it
// would have got with nobody reading at all. And what a person hears is
// `says` below — a clause written here, in advance, by somebody — never the
// number that fired it and never a sentence a model wrote about a command it
// was shown.

export interface CommandAsk {
  question: Question
  /** What a person reads, in Tade's own words, when this one fires. */
  says: string
  /** What it raises the call to: one word said back, or the command read back. */
  tier: 'soft' | 'hard'
}

export const COMMAND_ASKS: readonly CommandAsk[] = [
  {
    question: yesNo(
      'destroys_unrecoverable',
      'Would running this command destroy something that cannot be made again by running another command — data, the only copy of some work, the contents of a disk?',
    ),
    says: 'could destroy something that cannot be got back',
    tier: 'hard',
  },
  {
    question: yesNo(
      'wipes_uncommitted',
      'The directory this agent works in is in the state. Would this command throw away changes in it that have not been committed?',
    ),
    says: 'throws away work that is not committed',
    tier: 'hard',
  },
  {
    question: yesNo(
      'outside_worktree',
      'The directory this agent works in is in the state. Would this command change or delete something outside that directory?',
    ),
    says: 'changes something outside this agent’s own worktree',
    tier: 'hard',
  },
  {
    question: yesNo(
      'reaches_shared',
      'Would this command change something other people share — a deployed service, a database, a cloud account, a package registry, another machine — rather than only this one?',
    ),
    says: 'changes something other people share',
    tier: 'hard',
  },
  {
    question: yesNo(
      'more_than_it_looks',
      'Does this command do something beyond what its first word suggests — another command after a semicolon or a pipe, a downloaded script run as it arrives, a flag that makes it recursive or forced?',
    ),
    says: 'does more than its first word suggests',
    tier: 'soft',
  },
]

/** The strictest thing the answers say, above the bar, or nothing. */
export function cautionFrom(
  answers: Readonly<Record<string, { kind: string; probability?: number }>>,
  act: number,
): CommandAsk | null {
  const fired = COMMAND_ASKS.filter((asked) => {
    const answer = answers[asked.question.id]
    return answer?.kind === 'yes-no' && (answer.probability ?? 0) >= act
  })
  // Stricter first, and among equals the order they are written in: the list
  // is a rubric somebody argued over, not a set.
  return fired.find((asked) => asked.tier === 'hard') ?? fired[0] ?? null
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

// ── Reading a sentence somebody typed ───────────────────────────────────────
//
// Search matches letters, and a sentence is not letters to match. This is
// asked only about what is already in front of the person — one option per
// thing the window would have shown them, and one for none of them — so the
// worst answer available is a row they ignore. It can never invent something
// to do and never does anything: they still choose.

/** The letter one choice is offered under: short, so the options cost nothing. */
export function optionKey(index: number): string {
  return `c${index + 1}`
}

/** No option is the right one. Always offered, so "none of these" is sayable. */
export const NONE = 'none'

export function meantQuestion(
  said: string,
  choices: readonly { label: string; detail?: string }[],
): Question {
  return {
    id: 'meant',
    kind: 'pick',
    ask: `Somebody typed this into the search box of a tool that runs coding agents: "${said}". Which one of these is what they were asking for?`,
    options: {
      ...Object.fromEntries(
        choices.map((choice, at) => [
          optionKey(at),
          choice.detail ? `${choice.label} — ${choice.detail}` : choice.label,
        ]),
      ),
      [NONE]: 'none of these is what they meant',
    },
  }
}

/**
 * Which of the options were meant, in the order they were believed.
 *
 * A pick's probabilities are shares of one answer, so a bar written as a
 * number would mean something different with three options than with twenty.
 * This is written relative instead: whatever it believes at least half as much
 * as its best reading, in order, stopping at "none of these" — which is the
 * judge's own way of saying the answer is not here, and is therefore the end
 * of the list rather than a row in it. Three at most: a fourth "did you mean"
 * is a list nobody reads.
 */
export function meantOptions(probabilities: Readonly<Record<string, number>>): string[] {
  const ranked = Object.entries(probabilities).sort(([, a], [, b]) => b - a)
  const best = ranked[0]?.[1] ?? 0
  if (best <= 0) return []
  const meant: string[] = []
  for (const [option, share] of ranked) {
    if (option === NONE) break
    if (share < best / 2) break
    meant.push(option)
    if (meant.length === 3) break
  }
  return meant
}

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

// ── Reading what an agent has been doing ────────────────────────────────────
//
// What can be counted is counted in code, as ever: how many times the same
// call was made, how many turns ended badly, how long it has been at it. What
// is left is the judgment nothing can derive — whether doing the same thing
// again is a loop or a method — and that is one question about a list of what
// an agent did, in order.
//
// Never asked of an agent that has simply been going a long time: working for
// two hours is working. What brings it here is a repeat, and what it answers
// is whether the repeat is going anywhere.

/** How many times the same call has to come round before anybody is asked. */
export const REPEATS = 3
/** How many turns in a row may end badly before the same. */
export const BAD_TURNS = 3

export const CIRCLING: readonly Question[] = [
  yesNo(
    'in_circles',
    'Below is what an agent has done, oldest first, with how many times it did each thing. Is it repeating attempts that have already failed, rather than making progress?',
  ),
  yesNo(
    'needs_a_person',
    'Is it stuck on something only a person could give it — a credential, an account, a decision about what is wanted, something that is not on this machine?',
  ),
  yesNo(
    'nearly_there',
    'Is it repeating something because it is close to finishing it — the same test run again after a change, the same file edited again — rather than because it is stuck?',
  ),
]

/**
 * What to say about an agent, from what was answered: the sentence somebody
 * reads, or nothing. `nearly_there` is the one that takes a finding away
 * again, which is the only direction this may ever work in — it is the
 * difference between a loop and a method, and saying nothing is what Tade
 * does today.
 */
export function circlingSaid(
  answers: Readonly<Record<string, { kind: string; probability?: number }>>,
  bar: number,
): string | null {
  const at = (id: string) => {
    const answer = answers[id]
    return answer?.kind === 'yes-no' ? (answer.probability ?? 0) : 0
  }
  if (at('nearly_there') >= bar) return null
  if (at('needs_a_person') >= bar) return 'it looks stuck on something only you can give it'
  if (at('in_circles') >= bar)
    return 'it looks like it is trying the same thing that already failed'
  return null
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
  {
    id: 'runs_into_changes',
    about: 'runs into what has already changed',
    ask: (about) =>
      `Would the work described as ${about} run into the changes already made to the code, listed in the state as changed, so that what it was planned to do no longer fits?`,
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
  // Only ever later, never sooner: a reading of what has moved under queued
  // work can add caution to an order and can take none away.
  runs_into_changes: -2,
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

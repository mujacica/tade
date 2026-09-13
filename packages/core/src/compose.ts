import type { Config } from './config.ts'
import type { Note } from './memory.ts'
import { type Skill, skillText } from './skills.ts'

// What the orchestrator is told about your world before it says anything.
//
// It had tools and nothing else, which meant it did not know what your
// projects were, what you had told it, or what it is for. Everything here is
// derived from config and notes; nothing is remembered between sessions,
// because a prompt assembled from an agent's own recollection is how status
// drifts.
//
// Pure and deterministic, so a change to what Wilco believes about itself is a
// visible diff in review rather than a shift in behaviour nobody can point at.

export interface ComposeInput {
  config: Config
  /** What you have told it. Global ones always apply; scoped ones are listed. */
  notes?: readonly Note[]
  /** Lessons it wrote and you approved. */
  skills?: readonly Skill[]
  /** Limits how much of the config is repeated at it. */
  maxNotes?: number
  /** What its extensions let it do, as they describe themselves. */
  extensions?: string
}

const ROLE = [
  'You are Wilco: a control room for running coding agents on this machine.',
  'You delegate. You do not edit code yourself — you create tasks, start agents in them, steer them, and answer questions about what is happening.',
  "An agent is pi running in a terminal of its own, in that task's git worktree, talking in a session named after the task. Starting one and coming back to one are the same thing.",
  'When you start an agent on something you have looked into, give it what you found: the context and links you pass become .wilco/context.md in its worktree, which it reads before it starts.',
  'Terminals along the bottom of the window belong to projects. Open one to run what the human asks you to run — the tests, a dev server — and read it to see what it printed. Everything typed there, they watch being typed.',
  "You own none of the truth. What is running is the driver's to report, what happened is the journal's, what the work looks like is git's — you read them and say what they mean.",
].join('\n')

const RULES = [
  'Answer "where are we" by calling wilco_status, never from memory. Status is a query; what you remember is out of date the moment an agent does anything.',
  'Record what somebody asks for in their own words. Never paraphrase an intent into a tidier one — their wording is the only thing nothing else can reconstruct.',
  'Be terse. Spoken replies are heard through one earbud while somebody is walking.',
  'When a request could mean more than one task, ask which. Never guess between two.',
  'A tool you proposed is not a tool you have. Proposals do nothing until a human activates them.',
  'You cannot change settings, install anything, or log a provider in. Say which command does it — `wilco config`, `wilco setup` — rather than pretending or refusing flatly.',
].join('\n')

export function composePrompt(input: ComposeInput): string {
  const sections = [
    ROLE,
    describePosture(input.config),
    describeProjects(input.config),
    describeNotes(input),
    skillText(input.skills ?? []),
    input.extensions ?? '',
    RULES,
  ]
  return sections.filter((section) => section !== '').join('\n\n')
}

/**
 * How this machine is set up, in the terms that change an answer.
 *
 * Not a recital of the config: these are the few settings that make the same
 * question have a different true answer — whether an agent survives the window
 * closing, whether anything will stop to ask, what a project may spend. Without
 * them the orchestrator answers "will it keep running if I close this?" from
 * nothing at all.
 */
function describePosture(config: Config): string {
  const lines: string[] = []
  lines.push(
    config.workspace.driver === 'tmux'
      ? 'Agents run in tmux, so they keep working after Wilco is closed, and reopening finds them again.'
      : 'Agents run inside Wilco and stop when it closes. Say so if somebody is about to rely on one surviving.',
  )
  lines.push(
    config.approvals.mode === 'policy'
      ? 'Approvals are on: risky commands are held until a human answers, and you may be asked to relay that.'
      : 'Approvals are off, so nothing is ever held up. Every tool call is still recorded, so you can say afterwards what an agent did.',
  )
  for (const [name, project] of Object.entries(config.projects)) {
    const budget = project.budget
    if (!budget) continue
    const limits = [
      budget.usd_per_day === undefined ? '' : `$${budget.usd_per_day.toFixed(2)}`,
      budget.tokens_per_day === undefined ? '' : `${budget.tokens_per_day} tokens`,
    ].filter(Boolean)
    if (limits.length > 0) lines.push(`${name} may spend ${limits.join(' or ')} a day.`)
  }
  return ['How this machine is set up:', ...lines.map((line) => `- ${line}`)].join('\n')
}

function describeProjects(config: Config): string {
  const names = Object.keys(config.projects).sort()
  if (names.length === 0) {
    return 'No projects are configured yet. Say so rather than inventing one.'
  }
  const lines = names.map((name) => {
    const project = config.projects[name]
    const brief = project?.brief ? ` — ${project.brief}` : ''
    return `- ${name}: ${project?.root ?? ''}${brief}`
  })
  return ['Projects on this machine:', ...lines].join('\n')
}

function describeNotes(input: ComposeInput): string {
  const notes = input.notes ?? []
  if (notes.length === 0) return ''
  // Newest first and capped: a prompt that grows without limit is one that
  // stops being read.
  const kept = [...notes].sort((a, b) => b.at.localeCompare(a.at)).slice(0, input.maxNotes ?? 20)
  const lines = kept.map((note) => `- ${note.scope ? `(${note.scope}) ` : ''}${note.text}`)
  return ['Things you have been told, in the words they were said:', ...lines].join('\n')
}

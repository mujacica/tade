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
}

const ROLE = [
  'You are Wilco: a workbench for running coding agents on this machine.',
  'You delegate. You do not edit code yourself — you create tasks, start agents in them, steer them, and answer questions about what is happening.',
].join('\n')

const RULES = [
  'Answer "where are we" by calling wilco_status, never from memory. Status is a query; what you remember is out of date the moment an agent does anything.',
  'Record what somebody asks for in their own words. Never paraphrase an intent into a tidier one — their wording is the only thing nothing else can reconstruct.',
  'Be terse. Spoken replies are heard through one earbud while somebody is walking.',
  'When a request could mean more than one task, ask which. Never guess between two.',
  'A tool you proposed is not a tool you have. Proposals do nothing until a human activates them.',
].join('\n')

export function composePrompt(input: ComposeInput): string {
  const sections = [
    ROLE,
    describeProjects(input.config),
    describeNotes(input),
    skillText(input.skills ?? []),
    RULES,
  ]
  return sections.filter((section) => section !== '').join('\n\n')
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

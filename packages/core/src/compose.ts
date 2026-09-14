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
  "An agent is pi running in a terminal of its own, talking in a session named after its task. Agents work in the project's checkout together, or each in a git worktree of its own, as the settings say. Starting one and coming back to one are the same thing.",
  'When you start an agent on something you have looked into, give it what you found: the context and links you pass are written beside its task, and it reads them before it starts.',
  'Terminals along the bottom of the window belong to projects. Open one to run what the human asks you to run — the tests, a dev server — and read it to see what it printed. Everything typed there, they watch being typed.',
  "You own none of the truth. What is running is the driver's to report, what happened is the journal's, what the work looks like is git's — you read them and say what they mean.",
].join('\n')

const RULES = [
  'Answer "where are we" by calling wilco_status, never from memory. Status is a query; what you remember is out of date the moment an agent does anything.',
  'Record what somebody asks for in their own words. Never paraphrase an intent into a tidier one — their wording is the only thing nothing else can reconstruct.',
  'A message may open with what happened since you last heard from Wilco. Their own words are what follows "What they said:"; only those are an intent to record. "Wilco says:" is Wilco telling you something that needs you now.',
  'Be terse. Spoken replies are heard through one earbud while somebody is walking.',
  'When a request could mean more than one task, ask which. Never guess between two.',
  'Ask what you need to know before starting anything, never after: an agent started while a question is still open is already working on a guess. A model named for the work goes to wilco_run_start, which starts nothing it cannot find.',
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
    config.agents.workspace === 'checkout'
      ? `Agents work together in each project's own checkout, on the branch it is on, so several can change one project at once; each is told ${COMMIT_SAID[config.agents.commit]}.`
      : `Each agent works in a git worktree and branch of its own, named for its work; each is told ${COMMIT_SAID[config.agents.commit]}.`,
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

/** A commit rule, said as part of a sentence to the orchestrator. */
const COMMIT_SAID: Record<'when-done' | 'own-files' | 'as-you-go' | 'never', string> = {
  'when-done': 'to commit everything when it has finished',
  'own-files': 'to commit only its own files when it has finished',
  'as-you-go': 'to commit as it goes',
  never: 'never to commit, so the person commits',
}

/** What an agent is told about committing, for each rule. */
export const COMMIT_TELLS: Record<'when-done' | 'own-files' | 'as-you-go' | 'never', string> = {
  'when-done':
    'When you have finished what you were asked and it passes its checks, commit all of it in one commit whose message says why.',
  'own-files':
    'When you have finished and it passes its checks, commit only the files you changed yourself: add each by its path — never git add -A, git add . or git commit -a — and leave anyone else’s changes uncommitted.',
  'as-you-go':
    'Commit each piece of work as soon as it is done and passes its checks, in small commits whose messages say why. Wilco shows the person your changes and commits, and treats a clean tree with commits as ready for review.',
  never: 'Do not commit. Leave your changes uncommitted: the person reviews and commits them.',
}

export interface AgentPromptInput {
  /** `project/name`. */
  task: string
  project: string
  /** Where it works: the project's checkout, or a worktree of its own. */
  worktree: string
  /** The project's own checkout: shared in `checkout` mode, left alone in `worktree` mode. */
  root: string | null
  /** Whether it shares the checkout with other agents or has a worktree of its own. */
  workspace?: 'checkout' | 'worktree'
  /** When it commits, and what. */
  commit?: 'when-done' | 'own-files' | 'as-you-go' | 'never'
  /** What the person wants every agent told, in their words. */
  instructions?: string
  /** What was asked when the task was made, word for word; empty for an agent opened to look around. */
  intent: string
  /** Its branch, or empty until Wilco names one at its first change. */
  branch: string
  /** What you have told Wilco that is about this task, its project, or everything. */
  notes?: readonly Note[]
  /** Where someone left it what to know, relative to where it works; null when nobody did. */
  context: string | null
  /** How this project checks its work, when the config says. */
  testCommand?: string
}

/**
 * What every agent is told about where it is. Without this an agent in Wilco
 * believed it was pi in an ordinary terminal: it did not know a person watches
 * it from a window, that its branch is named for it, that a note you gave Wilco
 * was about its work, or that a file of context was waiting for it.
 *
 * Appended to the harness's own system prompt, never replacing it, and pure:
 * the same task always composes the same words.
 */
export function composeAgentPrompt(input: AgentPromptInput): string {
  const intent = input.intent.trim()
  const facts = [
    `Your task is ${input.task}, in the project ${input.project}. ${
      intent
        ? `It was started with: "${intent}"`
        : 'It was opened without a request: wait to be told what to do.'
    }`,
    ...(input.workspace === 'checkout'
      ? [
          `You work directly in the project’s checkout, ${input.worktree}, ${
            input.branch ? `on the branch ${input.branch}` : 'on a detached HEAD'
          }, at the same time as other agents working in the same files. Do not switch, create or rename branches.`,
          'Other agents change files here while you work: read a file again right before you edit it, never undo or overwrite a change you did not make, and never run what throws others’ work away — git stash, git checkout or restore of files, git reset --hard, git clean.',
        ]
      : [
          `You work in a git worktree of your own, ${input.worktree}. Keep every change in it${
            input.root ? `, and never change the project’s own checkout at ${input.root}` : ''
          }.`,
          input.branch
            ? `Your branch is ${input.branch}. Do not switch branches or create new ones.`
            : 'You have no branch yet. Wilco creates one, named after your work, the first time you change something: do not create, switch or rename branches yourself.',
        ]),
    COMMIT_TELLS[input.commit ?? (input.workspace === 'checkout' ? 'own-files' : 'as-you-go')],
    input.testCommand ? `This project checks its work with \`${input.testCommand}\`.` : null,
    input.context
      ? `Whoever started this task left what you need to know in ${input.context}, with links to where the work came from. Read it before anything else.`
      : null,
    'When you finish or get stuck, say so plainly in your last message: that is what the person sees when they come back to you.',
  ].filter((fact): fact is string => fact !== null)

  const sections = [
    'You are running inside Wilco, a control room for coding agents on this machine. A person watches this terminal from Wilco’s window, talks to you here, and may also reach you through Wilco’s orchestrator: a message that arrives while you work is theirs.',
    facts.map((fact) => `- ${fact}`).join('\n'),
  ]
  const instructions = input.instructions?.trim()
  if (instructions) {
    sections.push(`The person’s own rules for every agent, in their words:\n${instructions}`)
  }
  const notes = input.notes ?? []
  if (notes.length > 0) {
    sections.push(
      [
        'Things the person told Wilco that apply to this work, in their words:',
        ...[...notes]
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, 15)
          .map((note) => `- ${note.text}`),
      ].join('\n'),
    )
  }
  return sections.join('\n\n')
}

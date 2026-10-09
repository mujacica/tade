import { z } from 'zod'
import { OUTSIDE_IS_MATERIAL } from './compose.ts'
import { THINKING_LEVELS, type ThinkingLevel } from './config.ts'
import { DONE_RULES } from './model.ts'
import { doneFor, type Persona, PersonaDone } from './personas.ts'
import type { Plan, PlannedAgent } from './plan.ts'
import { producesPath, producesProblem } from './produces.ts'
import { joined } from './queue.ts'

// A reusable workflow: a stored `Plan` with holes in it, and the engine is the
// one that is already there.
//
// `checkPlan` is already the DAG engine — it refuses a cycle naming who waits
// on whom, refuses a plan that spans repositories where an agent left its
// project unsaid, resolves every wait to a qualified task id, refuses
// `done: committed` in a shared checkout, orders the agents topologically and
// warns on overlap. None of that is rewritten here and none of it is
// duplicated. What did not exist is *keeping* a plan, so this is the keeping:
// a file with the names, the waits and the words in it, and the holes a person
// or an intake fills.
//
// Four rules decide the shape, and each one is a thing that would otherwise go
// wrong quietly.
//
// 1. **A prompt is literal.** Nothing is substituted into it — not an input,
//    not a path, not a ticket body, and nothing ever reaches a shell. The
//    governing instruction an agent is given is byte for byte what somebody
//    published. Everything derived goes in the task's **context file**
//    instead, under a heading that says material is material. Held by a test
//    that asserts no filled value appears in any prompt.
// 2. **A template is not a transaction.** It makes tasks; the ordinary queue
//    runs them, and if one fails the rest are held with the reason and a
//    person answers. There is nothing to roll back — the commits are real.
// 3. **Every cross-repository mapping is explicit.** An agent's repository is
//    an *input* the template names, never a literal baked in and never
//    inherited silently where more than one is in play.
// 4. **A published version is immutable, and its personas are folded in.** By
//    the time a run is made, nothing outside the snapshot can change what it
//    was made from — see `templates-store.ts`, which is where that is held.
//
// Pure: a template and what filled it in, a plan or the reasons there is none
// out. Nothing here reads a file, a clock or the journal.

const NAME = /^[a-z0-9][a-z0-9._-]*$/
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** What an input is, which is what decides where its value may go. */
export const INPUT_KINDS = ['project', 'slug', 'text', 'document'] as const
export type InputKind = (typeof INPUT_KINDS)[number]

/** What each kind is for, in the words a form or a tool offers it in. */
export const INPUT_MEANS: Readonly<Record<InputKind, string>> = {
  project: 'a project, by the name the config gives it',
  slug: 'a short name, lowercase with dashes: what this one run is called',
  text: "one line, in Tade's own words: the request this is",
  document: 'what came from outside, written into every task’s context file as material',
}

/** The most a one-line input may be, so `said` stays a sentence. */
export const TEXT_LIMIT = 500

export const TemplateInput = z.strictObject({
  kind: z.enum(INPUT_KINDS),
  required: z.boolean().default(true),
  about: z.string().default(''),
})
export type TemplateInput = z.infer<typeof TemplateInput>

/** Whether an agent is expected to leave the project's own checks failing. */
export const LEAVES_CHECKS = ['green', 'red'] as const

export const TemplateAgent = z.strictObject({
  name: z.string(),
  /** The persona whose told fields fill in whatever this one does not say. */
  persona: z.string().optional(),
  /** Which persona it was, once one has been folded in. Written by publishing. */
  from_persona: z.string().optional(),
  /** That persona's content hash at the moment it was folded in. */
  from_persona_hash: z.string().optional(),
  /** Which input names the repository this one works in. */
  project_input: z.string().optional(),
  /** What its agent is told, after the persona's own words. Verbatim, always. */
  prompt: z.string().default(''),
  done: PersonaDone.optional(),
  produces: z.string().optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
  model: z.string().optional(),
  touches: z.array(z.string()).default([]),
  after: z.array(z.strictObject({ agent: z.string(), why: z.string() })).default([]),
  /**
   * Agents whose produced document this one has to read. The path goes in this
   * one's context file, so an artifact is handed over rather than described.
   */
  reads: z.array(z.string()).default([]),
  /**
   * `red` where this one is *expected* to leave the project's checks failing —
   * a reproducer, say. Declared rather than read out of a prompt, and the
   * reason it is declared is the deadlock in `templateProblems`.
   */
  leaves_checks: z.enum(LEAVES_CHECKS).default('green'),
})
export type TemplateAgent = z.infer<typeof TemplateAgent>

export const Template = z.strictObject({
  template: z.string(),
  /** Bumped on every publish, and written into every task it makes. */
  version: z.number().int().positive(),
  title: z.string(),
  about: z.string().default(''),
  /** Which input names the repository its agents work in unless one says otherwise. */
  project_input: z.string(),
  /** Which input is the request, verbatim: it becomes the plan's `said`. */
  said_input: z.string(),
  /**
   * Which input supplies the slug put on the end of every task name.
   *
   * Without one a template can be used once: a task name is never used twice,
   * so the second use is refused by `guardName` with nothing to say about why.
   */
  name_suffix: z.string().optional(),
  inputs: z.record(z.string(), TemplateInput),
  agents: z.array(TemplateAgent).min(1),
})
export type Template = z.infer<typeof Template>

/** What a template was, for the line written into every task it made. */
export interface TemplateProvenance {
  template: string
  version: number
  /** `sha256:…` of the published snapshot. Null for a draft nobody published. */
  hash: string | null
  /** One Tade ships, whose bytes are in its own source. */
  builtIn: boolean
}

/** `github-bug@3 (sha256:…)`, which is how a run says what made it. */
export function saysProvenance(one: TemplateProvenance): string {
  const what = `${one.template}@${one.version}`
  const where = one.builtIn ? ', built in' : ''
  return one.hash ? `${what} (${one.hash})${where}` : `${what} (unpublished draft)${where}`
}

export interface TemplateRead {
  problems: string[]
  warnings: string[]
}

/**
 * Whether a template holds together, before anybody fills anything in.
 *
 * This is what `tade templates check` runs and what publishing refuses on, and
 * it deliberately answers *without* a project, a tree or an input: a template
 * with a cycle in it has a cycle in every plan it will ever make, and finding
 * that out at the moment somebody uses it is finding it out too late.
 *
 * What is left for `checkPlan` is what genuinely needs the real world: whether
 * a project exists, where its agents work, what else is already changing those
 * files. Nothing here duplicates it.
 */
export function templateProblems(
  template: Template,
  context: { personas: ReadonlyMap<string, Persona> },
): TemplateRead {
  const problems: string[] = []
  const warnings: string[] = []
  const say = (text: string) => problems.push(text)

  // The same rule the file name is held to (`templateNameProblem`), because
  // the two have to agree: the name in the block must equal the file's, and a
  // name only one of them accepts is a draft that checks clean and refuses to
  // publish. Looser than an agent's name on purpose — this one becomes a path.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(template.template)) {
    say(`"${template.template}" is not a template name: lowercase letters, digits and dashes`)
  }
  if (!template.title.trim()) say('title: say what this template is for, in a line')

  // --- the inputs, and the three the template points at by name
  const inputs = Object.entries(template.inputs)
  for (const [name] of inputs) {
    if (!NAME.test(name)) say(`"${name}" is not an input name: lowercase letters, digits, - . _`)
  }
  const needs = (field: string, named: string | undefined, kind: InputKind) => {
    if (named === undefined) return
    const input = template.inputs[named]
    if (!input) {
      say(
        `${field}: there is no input called ${named}${inputs.length ? `; it takes ${joined(inputs.map(([one]) => one))}` : ''}`,
      )
      return
    }
    if (input.kind !== kind) {
      say(`${field}: ${named} is a ${input.kind} input, and this one has to be a ${kind}`)
    }
    if (!input.required) say(`${field}: ${named} has to be required — nothing can go unsaid here`)
  }
  needs('project_input', template.project_input, 'project')
  needs('said_input', template.said_input, 'text')
  needs('name_suffix', template.name_suffix, 'slug')
  if (template.name_suffix === undefined) {
    warnings.push(
      'it has no name_suffix, so it can only be used once: a second use is refused because a task name is never used twice',
    )
  }

  // --- the agents
  const seen = new Set<string>()
  const byName = new Map<string, TemplateAgent>()
  for (const agent of template.agents) {
    if (!NAME.test(agent.name)) {
      say(`"${agent.name}" is not a task name: lowercase letters, digits, - . _`)
    }
    if (seen.has(agent.name)) say(`${agent.name} is in the template twice`)
    seen.add(agent.name)
    byName.set(agent.name, agent)
    needs(`${agent.name}: project_input`, agent.project_input, 'project')
    if (agent.persona !== undefined && agent.from_persona !== undefined) {
      say(
        `${agent.name} says both persona and from_persona: a folded-in one names only from_persona`,
      )
    }
    if (agent.persona !== undefined && !context.personas.has(agent.persona)) {
      const known = [...context.personas.keys()]
      say(
        `${agent.name} wants the persona ${agent.persona}, which is not one here${known.length ? `; there are ${joined(known)}` : ''}`,
      )
    }
    const resolved = resolveAgent(agent, context.personas)
    const produces = resolved.produces === undefined ? null : producesProblem(resolved.produces)
    if (produces) say(`${agent.name} cannot produce that: ${produces}`)
    if (!resolved.prompt.trim()) {
      say(`${agent.name} tells its agent nothing: give it a prompt, or a persona that does`)
    }
    // What it says it will touch is a path inside the repository and nothing
    // else. Not a safety boundary — nothing joins these onto a path, they are
    // only ever compared against each other (`sameOrInside`) — but one that is
    // absolute or climbs out can never match anything, so the collision
    // warning this template exists to raise would silently never fire. A
    // template is written once and used a hundred times, so a `touches` that
    // means nothing is a hundred warnings nobody got.
    for (const path of resolved.touches) {
      const problem = touchesProblem(path)
      if (problem) say(`${agent.name} cannot touch "${path}": ${problem}`)
    }
    for (const dep of agent.after) {
      if (dep.agent.includes('/')) {
        say(
          `${agent.name} waits on ${dep.agent}, which is a task that exists: a template is used again and again, so it may only wait on its own agents`,
        )
        continue
      }
      if (!template.agents.some((one) => one.name === dep.agent)) {
        say(`${agent.name} waits on ${dep.agent}, which is not an agent in this template`)
      }
      if (dep.agent === agent.name) say(`${agent.name} cannot wait on itself`)
      if (!dep.why.trim()) say(`${agent.name} waits on ${dep.agent} for no reason anybody wrote`)
    }
  }

  // --- waits: a cycle here is a cycle in every plan this will ever make
  const stuck = unorderable(template)
  if (stuck.length > 0) say(`${joined(stuck)} wait on each other, so none could start`)

  // --- a document is handed over, not described
  for (const agent of template.agents) {
    for (const name of agent.reads) {
      const other = byName.get(name)
      if (!other) {
        say(`${agent.name} reads ${name}, which is not an agent in this template`)
        continue
      }
      if (!reaches(template, agent.name).has(name)) {
        say(
          `${agent.name} reads what ${name} produces but does not wait on it: add it to after, or there is nothing there yet when it starts`,
        )
      }
      if (resolveAgent(other, context.personas).produces === undefined) {
        say(`${agent.name} reads ${name}, which produces no document`)
      }
    }
  }

  // --- the deadlock, refused rather than discovered at three in the morning
  //
  // An agent that is meant to leave the checks red cannot also have to commit
  // to count as finished: a project's own commit hook is the thing it would be
  // committing through, and a reproducer that cannot commit never finishes, so
  // the fix that waits on it never starts. The two ways out are both honest —
  // hand the failing reproducer in as a document input, or make reproducing
  // and fixing one agent — and the refusal names them.
  for (const agent of template.agents) {
    if (agent.leaves_checks !== 'red') continue
    const resolved = resolveAgent(agent, context.personas)
    const commits = (['worktree', 'checkout'] as const)
      .map((where) => doneFor(resolved.done, where))
      .find((rule) => rule === 'committed' || rule === 'merged')
    if (commits) {
      say(
        `${agent.name} is expected to leave the checks red and has to be ${commits} to count as finished, which cannot both happen: a commit that cannot pass the project's own hook never lands, so nothing waiting on it ever starts. Either hand the failing reproducer in as a document input, or make reproducing and fixing one agent`,
      )
    }
    if (!template.agents.some((one) => one.after.some((dep) => dep.agent === agent.name))) {
      say(
        `${agent.name} is expected to leave the checks red and nothing waits on it, so nothing would make them green again`,
      )
    }
  }

  // --- repositories: explicit the moment there is more than one
  const used = new Set<string>([template.project_input])
  for (const agent of template.agents) if (agent.project_input) used.add(agent.project_input)
  if (used.size > 1) {
    const unsaid = template.agents.filter((agent) => !agent.project_input).map((one) => one.name)
    if (unsaid.length > 0) {
      say(
        `this template reaches into ${used.size} repositories (${joined([...used])}), so every agent has to say which input names its own: ${joined(unsaid)} ${unsaid.length === 1 ? 'does' : 'do'} not`,
      )
    }
  }

  // --- a done rule that needs worktrees, said now rather than at the fill
  const needsWorktree = template.agents.filter((agent) => {
    const done = resolveAgent(agent, context.personas).done
    return doneFor(done, 'checkout') === 'committed' || doneFor(done, 'checkout') === 'merged'
  })
  if (needsWorktree.length > 0) {
    warnings.push(
      `${joined(needsWorktree.map((one) => one.name))} can only be used in a project whose agents get a worktree each: in a shared checkout nothing is any one agent's to commit. Give a done rule per workspace to cover both`,
    )
  }
  return { problems, warnings }
}

/**
 * Why a `touches` entry is not a path in the repository, or null when it is.
 *
 * `~` is here because it is the one spelling that *looks* repository-relative
 * and is not: `~/src` is somebody's home directory and would never match
 * `src/`.
 */
function touchesProblem(path: string): string | null {
  const said = path.trim()
  if (!said) return 'name a file or a folder in the repository'
  if (said.startsWith('/') || said.startsWith('~') || /^[a-z]:[\\/]/i.test(said)) {
    return 'a path in the repository, not one of its own — nothing outside it is any agent’s to change'
  }
  if (said.split(/[\\/]/).includes('..')) return 'it climbs out of the repository'
  return null
}

/** Agents that cannot be put in an order, which means they wait in a circle. */
function unorderable(template: Template): string[] {
  const placed = new Set<string>()
  const names = new Set(template.agents.map((one) => one.name))
  for (;;) {
    const next = template.agents.find(
      (agent) =>
        !placed.has(agent.name) &&
        agent.after
          .filter((dep) => names.has(dep.agent))
          .every((dep) => placed.has(dep.agent) || dep.agent === agent.name),
    )
    if (!next) break
    placed.add(next.name)
  }
  return template.agents.filter((one) => !placed.has(one.name)).map((one) => one.name)
}

/** Everything one agent waits on, directly or through what it waits on. */
function reaches(template: Template, name: string): Set<string> {
  const byName = new Map(template.agents.map((one) => [one.name, one] as const))
  const seen = new Set<string>()
  const stack = [name]
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    for (const dep of byName.get(at)?.after ?? []) {
      if (seen.has(dep.agent)) continue
      seen.add(dep.agent)
      stack.push(dep.agent)
    }
  }
  return seen
}

/** What a persona and an agent come to together: the agent's own answer wins. */
export interface ResolvedAgent {
  prompt: string
  done?: PersonaDone
  produces?: string
  thinking?: ThinkingLevel
  model?: string
  touches: string[]
}

/**
 * One agent with its persona folded in.
 *
 * The prompt is both, in that order and nothing between but a blank line: the
 * persona is who the agent is and the agent's own words are what this step of
 * the work is. Both are verbatim.
 */
export function resolveAgent(
  agent: TemplateAgent,
  personas: ReadonlyMap<string, Persona>,
): ResolvedAgent {
  const persona = agent.persona ? personas.get(agent.persona) : undefined
  const prompt = [persona?.prompt?.trim(), agent.prompt.trim()].filter(Boolean).join('\n\n')
  const done = agent.done ?? persona?.done
  const produces = agent.produces ?? persona?.produces
  const thinking = agent.thinking ?? persona?.thinking
  const model = agent.model ?? persona?.model
  const touches = agent.touches.length > 0 ? agent.touches : (persona?.touches ?? [])
  return {
    prompt,
    ...(done !== undefined ? { done } : {}),
    ...(produces !== undefined ? { produces } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(model !== undefined ? { model } : {}),
    touches: [...touches],
  }
}

export interface FillArgs {
  /** What somebody filled in, by input name. */
  inputs: Readonly<Record<string, string>>
  /** The projects Tade has, so one it does not have is refused here and named. */
  projects: readonly string[]
  /** Where a project's agents work, which is what the done rule turns on. */
  workspace: (project: string) => 'checkout' | 'worktree'
  /** Tade's home: where a document one task hands to another actually is. */
  home: string
  /** What this was made from, written into every context file. */
  provenance: TemplateProvenance
  personas: ReadonlyMap<string, Persona>
}

export type TemplateFill =
  | {
      ok: true
      plan: Plan
      warnings: string[]
      /**
       * Which template agent each planned task came from, by the task's own
       * qualified id.
       *
       * Handed over rather than worked out again from the names, because a
       * suffix makes that ambiguous the moment one agent's name is a prefix of
       * another's — `fix` and `fix-extra` both become `fix-…-318` — and the one
       * reader is the dry run, which is the thing somebody is trusting when
       * they decide to let three agents loose.
       */
      from: ReadonlyMap<string, string>
    }
  | { ok: false; problems: string[] }

/**
 * A template and what filled it in, as a `Plan` — which is then `checkPlan`'s,
 * the queue's and nobody else's.
 *
 * Nothing is started, nothing is written and no value reaches a prompt. What
 * each agent is *told* is the template's own words; what each agent is *given*
 * is its context file, and that is where every filled value, every handed
 * document and the line saying what made this all go.
 */
export function fillTemplate(template: Template, args: FillArgs): TemplateFill {
  const structure = templateProblems(template, { personas: args.personas })
  if (structure.problems.length > 0) return { ok: false, problems: structure.problems }

  const problems: string[] = []
  const declared = Object.entries(template.inputs)
  const value = (name: string): string => (args.inputs[name] ?? '').trim()
  for (const given of Object.keys(args.inputs)) {
    if (!template.inputs[given]) {
      problems.push(
        `${template.template} has no input called ${given}; it takes ${declared.length ? joined(declared.map(([one]) => one)) : 'nothing'}`,
      )
    }
  }
  for (const [name, input] of declared) {
    const said = value(name)
    if (!said) {
      if (input.required) {
        problems.push(
          `${name} is not filled in: ${input.about || INPUT_MEANS[input.kind]}. Nothing is stamped out with an empty one`,
        )
      }
      continue
    }
    if (input.kind === 'project' && !args.projects.includes(said)) {
      problems.push(
        `${name}: there is no project called ${said}${args.projects.length ? `; there are ${joined([...args.projects])}` : ' and none is open'}`,
      )
    }
    if (input.kind === 'slug' && !SLUG.test(said)) {
      problems.push(`${name}: "${said}" is not a short name — lowercase letters, digits, - . _`)
    }
    if (input.kind === 'text' && (said.includes('\n') || said.length > TEXT_LIMIT)) {
      problems.push(
        `${name}: one line of at most ${TEXT_LIMIT} characters. What came from outside goes in a document input, not here`,
      )
    }
  }
  if (problems.length > 0) return { ok: false, problems }

  const suffix = template.name_suffix ? value(template.name_suffix) : ''
  const nameOf = (agent: TemplateAgent) => (suffix ? `${agent.name}-${suffix}` : agent.name)
  const projectOf = (agent: TemplateAgent) => value(agent.project_input ?? template.project_input)
  const said = value(template.said_input)
  // The documents that came from outside, once: every task's context file gets
  // the same material, because every agent reads its own and nothing else.
  const material = declared
    .filter(([, input]) => input.kind === 'document')
    .map(([name]) => ({ name, text: args.inputs[name] ?? '' }))
    .filter((one) => one.text.trim())

  const from = new Map<string, string>()
  const agents: PlannedAgent[] = template.agents.map((agent) => {
    const resolved = resolveAgent(agent, args.personas)
    const project = projectOf(agent)
    const done = doneFor(resolved.done, args.workspace(project))
    const handed = agent.reads.flatMap((read) => {
      const other = template.agents.find((one) => one.name === read)
      const produces = other ? resolveAgent(other, args.personas).produces : undefined
      if (!other || !produces) return []
      const task = `${projectOf(other)}/${nameOf(other)}`
      return [{ task, path: producesPath(args.home, task, produces) }]
    })
    from.set(`${project}/${nameOf(agent)}`, agent.name)
    return {
      name: nameOf(agent),
      project,
      said,
      // Verbatim, and the one thing in a task that nothing filled in.
      prompt: resolved.prompt,
      after: agent.after.map((dep) => {
        const other = template.agents.find((one) => one.name === dep.agent)
        return {
          agent: other ? `${projectOf(other)}/${nameOf(other)}` : dep.agent,
          why: dep.why,
        }
      }),
      touches: resolved.touches,
      context: contextFor({ provenance: args.provenance, said, handed, material }),
      ...(done ? { done } : {}),
      ...(resolved.produces ? { produces: resolved.produces } : {}),
      ...(resolved.model ? { model: resolved.model } : {}),
      ...(resolved.thinking ? { thinking: resolved.thinking } : {}),
    }
  })

  return {
    ok: true,
    plan: {
      project: value(template.project_input),
      said,
      // One use of a template is one change, so its tasks carry one name and
      // "how far did that ticket get" is one question. An effort is nothing
      // but the fold of the task files that name it, so this costs nothing.
      ...(suffix ? { effort: `${template.template}-${suffix}` } : {}),
      agents,
    },
    warnings: structure.warnings,
    from,
  }
}

/**
 * A task's context file: everything derived, and the one place a filled value
 * or an outside body is allowed to be.
 *
 * Tade's own words at the top — what made this, and what the request was —
 * then what was handed over, then what came from outside under the heading
 * that says it is material and not instruction. Nothing here is ever joined
 * into a prompt or a command.
 */
function contextFor(req: {
  provenance: TemplateProvenance
  said: string
  handed: readonly { task: string; path: string }[]
  material: readonly { name: string; text: string }[]
}): string {
  const lines = [
    `# ${saysProvenance(req.provenance)}`,
    '',
    `Tade made this task from the template above. What was asked for: ${req.said}`,
    '',
    'This template granted nothing. You have exactly the approvals, extensions, MCP',
    'servers and sign-in this machine already had.',
  ]
  if (req.handed.length > 0) {
    lines.push('', '## Handed to you', '')
    for (const one of req.handed) {
      lines.push(`- \`${one.path}\` — what ${one.task} produced. Read it; it is the work, not a`)
      lines.push('  summary of it.')
    }
  }
  for (const one of req.material) {
    const fence = fenceFor(one.text)
    lines.push('', `## ${one.name}`, '', OUTSIDE_IS_MATERIAL, '', fence, one.text.trimEnd(), fence)
  }
  return `${lines.join('\n')}\n`
}

/**
 * A code fence long enough that the text inside it cannot end it early.
 *
 * Fenced, and not because escaping makes a markdown file tamper-proof — it
 * does not. It is because where the outside text *ends* has to be unambiguous:
 * unfenced, a ticket body containing its own `## ` heading makes whatever
 * follows look like another of Tade's own sections, and with two document
 * inputs the first can dress the second up as a instruction from here. A fence
 * also renders it as what it is: data somebody else wrote, not prose addressed
 * to the agent. The sentence above it is still what does the actual work.
 */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** A template with its personas folded in, which is what a published one is. */
export function foldPersonas(
  template: Template,
  personas: ReadonlyMap<string, Persona>,
  hashOf: (persona: Persona) => string,
): Template {
  return {
    ...template,
    agents: template.agents.map((agent) => {
      const persona = agent.persona ? personas.get(agent.persona) : undefined
      if (!persona) return agent
      const resolved = resolveAgent(agent, personas)
      const { persona: _named, ...rest } = agent
      return {
        ...rest,
        from_persona: persona.name,
        from_persona_hash: hashOf(persona),
        prompt: resolved.prompt,
        ...(resolved.done !== undefined ? { done: resolved.done } : {}),
        ...(resolved.produces !== undefined ? { produces: resolved.produces } : {}),
        ...(resolved.thinking !== undefined ? { thinking: resolved.thinking } : {}),
        ...(resolved.model !== undefined ? { model: resolved.model } : {}),
        touches: resolved.touches,
      }
    }),
  }
}

/** The done rules a template may name, for a tool's or a form's own list. */
export const TEMPLATE_DONE_RULES = DONE_RULES

import type { Config } from './config.ts'
import type { DoneRule } from './model.ts'
import type { Persona } from './personas.ts'
import type { Plan, PlanCheck, PlannedAgent } from './plan.ts'
import { projectOf, projectsIn } from './plan.ts'
import { pushFor, workspaceFor } from './project.ts'
import { joined } from './queue.ts'
import {
  saysProvenance,
  type Template,
  type TemplateFill,
  type TemplateProvenance,
} from './templates.ts'

// What would happen, and nothing happens.
//
// This is the feature that makes a stored workflow safe to have at all. A
// template is a shape somebody wrote weeks ago against a tree that has moved
// since, filled in by somebody who has not read it, and the thing standing
// between that and three agents in three terminals is being able to ask what
// it would do and get an answer you can act on.
//
// Three rules, and the first is the only one that is load-bearing:
//
// 1. **It writes nothing and starts nothing.** There is no path from here to a
//    task, a lane, a file or a journal line. It is a pure function of facts
//    somebody else gathered, which is also what makes it testable without a
//    repository: if it could write, the test for "it wrote nothing" would be a
//    test about a mock.
// 2. **It is honest about what it could not see.** A plan window nothing could
//    read is said as "cannot tell", never as nought, and what it says about
//    money is what the journal already knows rather than a guess at what three
//    agents will cost — nothing can know that, and a number here would be
//    believed.
// 3. **It says what the template does not grant**, in as many words. A reader
//    looking at "3 tasks, worktrees, reproduce → fix → read" will fill in the
//    rest themselves, and what they fill in is usually that a template is a
//    policy. It is not: every task starts with exactly the approvals, the
//    extensions, the MCP servers and the sign-in this machine already has.
//
// Pure: facts in, rows and sentences out. No clock, no I/O, no async.

/** One task a template would make, as it would be. */
export interface DryTask {
  task: string
  project: string
  workspace: 'checkout' | 'worktree'
  /** The persona its words came from, when they came from one. */
  persona: string | null
  done: DoneRule
  produces: string | null
  touches: readonly string[]
  after: readonly { task: string; why: string }[]
  /** It is expected to leave the project's own checks failing. */
  leavesChecksRed: boolean
}

export interface DryRun {
  provenance: TemplateProvenance
  title: string
  /** Why nothing would be made. Empty when something would. */
  problems: string[]
  warnings: string[]
  tasks: DryTask[]
  /** What this grants, and what it does not. */
  permissions: string[]
  /** What bounds the work: money, parallelism, and what could not be read. */
  limits: string[]
}

/** What the limits are, as whoever gathered them found them. */
export interface LimitFacts {
  /** What a project has spent today against what it may, per project. */
  budget: readonly { project: string; said: string }[]
  /**
   * Where each sign-in stands against its plan — **null** where nothing could
   * read it, which is a different answer from "there is room" and is said as
   * one. Only the process supervising the agents can read a plan window.
   */
  plans: readonly string[] | null
}

/**
 * What a template and its inputs would make, said as rows and sentences.
 *
 * `fill` and `check` are the two existing answers — the template's own
 * validation and `checkPlan`'s — handed in rather than recomputed, so there is
 * exactly one implementation of each and a dry run can never disagree with the
 * thing that would actually refuse.
 */
export function dryRunOf(req: {
  provenance: TemplateProvenance
  template: Template
  fill: TemplateFill
  /** What `checkPlan` said, or null when there was no plan to check. */
  check: PlanCheck | null
  config: Config
  personas: ReadonlyMap<string, Persona>
  limits: LimitFacts
}): DryRun {
  const { template, fill, check, config } = req
  const problems = [
    ...(fill.ok ? [] : fill.problems),
    ...(check && !check.ok ? check.problems : []),
  ]
  const warnings = [...(fill.ok ? fill.warnings : []), ...(check?.ok ? check.warnings : [])]
  const plan = fill.ok ? fill.plan : null
  const tasks = plan && fill.ok && check?.ok ? rowsOf(plan, check, template, config, fill.from) : []
  return {
    provenance: req.provenance,
    title: template.title,
    problems,
    warnings,
    tasks,
    permissions: permissionsOf(plan, config),
    limits: limitsOf(plan, config, req.limits),
  }
}

function rowsOf(
  plan: Plan,
  check: PlanCheck & { ok: true },
  template: Template,
  config: Config,
  /** Which template agent each task came from, as the fill recorded it. */
  cameFrom: ReadonlyMap<string, string>,
): DryTask[] {
  // In the order the tasks would be made, which is the order `checkPlan`
  // worked out and not the order anybody wrote.
  return check.order.map((agent) => {
    const project = projectOf(plan, agent)
    const id = `${project}/${agent.name}`
    const named = cameFrom.get(id)
    const from = template.agents.find((one) => one.name === named)
    return {
      task: id,
      project,
      workspace: workspaceFor(config, project),
      persona: from?.from_persona ?? from?.persona ?? null,
      done: agent.done ?? 'said',
      produces: agent.produces ?? null,
      touches: agent.touches,
      after: check.waitsOn.get(id) ?? [],
      leavesChecksRed: from?.leaves_checks === 'red',
    }
  })
}

/**
 * What this grants — nothing — and where each thing it does not grant is
 * actually decided, so a reader can go and look.
 */
function permissionsOf(plan: Plan | null, config: Config): string[] {
  const said = [
    'This template grants nothing. Every task it makes starts with exactly the approvals, extensions, MCP servers and sign-in this machine already has.',
    'A persona says what an agent is told, never what it is allowed: it cannot set an account, an approval, an extension, an MCP server, a workspace, a root, a network or a key, and a file that tries is refused.',
    config.approvals.mode === 'bypass'
      ? 'Approvals: nothing is gated (approvals.mode: bypass) — the same as every other agent here. Tade still records every tool call.'
      : `Approvals: agents ask under the policy (approvals.mode: policy)${config.approvals.auto_allow.length ? `, with ${joined([...config.approvals.auto_allow])} never asking` : ''}.`,
  ]
  for (const project of plan ? projectsIn(plan) : []) {
    const workspace = workspaceFor(config, project)
    const push = pushFor(config, project, workspace)
    said.push(
      `${project}: agents work ${workspace === 'checkout' ? "in the project's own checkout, together" : 'in a worktree each'}; finished work ${push.mode === 'never' ? 'goes nowhere — nothing is pushed' : `is told to go to ${push.mode}`}. Nothing Tade runs pushes anything itself.`,
    )
  }
  return said
}

/** What bounds the work, and what could not be read — never as nought. */
function limitsOf(plan: Plan | null, config: Config, limits: LimitFacts): string[] {
  const said: string[] = []
  for (const project of plan ? projectsIn(plan) : []) {
    const most = config.projects[project]?.max_parallel
    const spend = limits.budget.find((one) => one.project === project)
    said.push(
      `${project}: ${most ? `at most ${most} agent${most === 1 ? '' : 's'} at once` : 'no limit on agents at once'}; ${spend ? spend.said : 'no daily budget is set, so nothing holds a start on money'}.`,
    )
  }
  // The honest answer, and the reason it has to be said: only the process
  // supervising the agents can read a plan window, so reading one from a
  // command line is "cannot tell" and never "there is room".
  if (limits.plans === null) {
    said.push(
      'Plan windows: cannot tell from here — only the window supervising the agents can read one. Ask it, or open the window.',
    )
  } else if (limits.plans.length === 0) {
    said.push('Plan windows: none — every sign-in here is billed rather than on a plan.')
  } else {
    for (const one of limits.plans) said.push(`Plan window: ${one}`)
  }
  if (plan) {
    said.push(
      `What this would cost is not knowable before it runs, so nothing here guesses: ${plan.agents.length} agent${plan.agents.length === 1 ? '' : 's'} would work until each is finished.`,
    )
  }
  return said
}

/** A dry run as lines to read: the rows, then what it grants, then the bounds. */
export function dryRunSays(dry: DryRun): string[] {
  const lines = [`${saysProvenance(dry.provenance)} — ${dry.title}`, '']
  if (dry.problems.length > 0) {
    lines.push('Nothing would be made:')
    for (const problem of dry.problems) lines.push(`  ${problem}`)
    lines.push('')
    lines.push('Nothing was made, and nothing was started.')
    return lines
  }
  const width = Math.max(0, ...dry.tasks.map((one) => one.task.length))
  for (const task of dry.tasks) {
    const bits = [
      task.persona ? task.persona : '—',
      task.workspace,
      `done: ${task.done}`,
      ...(task.produces ? [`produces ${task.produces}`] : []),
      ...(task.touches.length > 0 ? [`touches ${joined([...task.touches])}`] : []),
      ...(task.leavesChecksRed ? ['expected to leave the checks red'] : []),
    ]
    lines.push(`  ${task.task.padEnd(width)}  ${bits.join('  ')}`)
    for (const dep of task.after)
      lines.push(`  ${' '.repeat(width)}  after ${dep.task} — ${dep.why}`)
  }
  for (const warning of dry.warnings) lines.push('', `  warning  ${warning}`)
  lines.push('', 'What this grants:')
  for (const one of dry.permissions) lines.push(`  ${one}`)
  lines.push('', 'What bounds it:')
  for (const one of dry.limits) lines.push(`  ${one}`)
  lines.push('', 'Nothing was made, and nothing was started.')
  return lines
}

/** The one planned agent a row is about, for whoever wants the plan itself. */
export function agentFor(plan: Plan, task: string): PlannedAgent | undefined {
  return plan.agents.find((agent) => `${projectOf(plan, agent)}/${agent.name}` === task)
}

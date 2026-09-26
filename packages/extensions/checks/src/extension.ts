import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CheckLog,
  type CheckRun,
  carriedNote,
  checkLine,
  latestAt,
  RunnerError,
} from '@tade/checks-core'
import {
  type ChecksConfig,
  type Config,
  ConfigSchema,
  loadConfig,
  OVERRIDE_LIMIT_MS,
  overrideProblem,
} from '@tade/core'
import {
  type ExtensionContext,
  list,
  number,
  object,
  oneOf,
  string,
  type TadeExtension,
  type ToolContext,
} from '@tade/extensions-core'
import { checksAt, runProjectChecks } from '@tade/workbench'

// The checks a project runs on itself, as tools an agent and the orchestrator
// can call.
//
// Running them through Tade rather than typing the command in a shell is what
// makes the lock, the dedup, the record against the commit and the row in the
// window come free — four agents in one checkout do not start four suites,
// and what ran is shown to the person rather than buried in a scrollback.
//
// Nothing here reaches the network, and nothing here is clever: the plan, the
// rollup and the record are `packages/checks/*`'s, and this is the way in.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const projectInput = string(
  'project name, as configured; the one you are in when there is only one',
)

export const checksExtension: TadeExtension = {
  name: 'checks',
  title: 'Checks',
  description:
    "A project's own checks — formatting, types, tests — run here before anybody else has to look at them, and recorded against the commit they ran on.",
  workflow: [
    'Says how each check stands at the commit checked out (checks_list).',
    'Runs them here, one suite at a time (checks_run), recorded against the commit.',
    'Overruling is an act with a reason, written down (checks_override).',
    'What a project checks is read from its own CI workflows and its commit hook — nothing here is configured, and nothing is written into the repository.',
  ],
  root: ROOT,

  ready() {
    // Nothing to set up and nobody to ask: the commands are the project's own.
    return null
  },

  orchestrator() {
    return [
      'For "is this green" and "what is red", call checks_list — it reads files and asks nothing of the network.',
      'To have them run, checks_run: it takes minutes, runs one at a time per checkout, and answers with what failed.',
      'A red check is not a reason to start an agent on your own: tell the person, or hand it to the agent whose commit it is.',
      'What a project checks is read from its own CI workflows and its commit hook, so there is nothing to configure and no file to write. Where checks_list says a project says nothing, the answer is not a gate Tade invents: say what CI it is missing, and that its agents are told to work out what checking it means and run that themselves.',
    ].join(' ')
  },

  harness: {
    pi: { skills: ['skills/run-the-checks'] },
    // The same SKILL.md: both read the Agent Skills format.
    'claude-code': { skills: ['skills/run-the-checks'] },
  },

  tools: [
    {
      name: 'checks_list',
      description:
        'What this project checks, and how each check stands at the commit that is checked out: what passed, what failed, what has never run. Reads files only — no run, no network, and it works when nothing is set up.',
      parameters: object({ project: projectInput }),
      for: ['orchestrator', 'agent'],
      async run(input, ctx) {
        const where = await workingIn(input, ctx)
        const stood = await checksAt({
          config: where.config,
          project: where.project,
          worktree: where.worktree,
          commit: where.commit,
        })
        if (stood.read.checks.length === 0) {
          return {
            text: [
              `${where.project} says nothing about what checking it means, so nothing here is verified.`,
              '',
              'Tade reads a project’s checks out of its CI workflows and its commit hook. This one has neither that could be read, and Tade will not invent a gate: agents working here are told to work out what checking it means and run that themselves, and to say what they ran.',
              'A workflow that runs on `pull_request` or on a push to a branch is what would be read; so would a `pre-commit` hook. Failing both, `projects.<name>.test_command` in Tade’s own config is the one line that gives it a check.',
              ...stood.read.problems.map((problem) => `- ${problem}`),
            ].join('\n'),
            said: `${where.project} says nothing about what it checks.`,
          }
        }
        const lines = [
          `## ${where.project} — ${stood.read.checks.length} checks (read from ${stood.read.from ?? stood.read.source})`,
          '',
          `At ${where.commit ? where.commit.slice(0, 8) : 'no commit'}: **${stood.rollup.state}**.`,
          '',
        ]
        for (const check of stood.plan) {
          const run = stood.at.find((one) => one.check === check.id)
          lines.push(
            run
              ? `${checkLine(run)}${carriedNote(run, stood.carried.has(run.id))}`
              : check.skip
                ? `- – \`${check.id}\` does not run here: ${check.skip}${check.from ? ` — ${check.from}` : ''}`
                : `- ◦ \`${check.id}\` has not run at this commit${check.from ? ` — ${check.from}` : ''}`,
          )
        }
        // What CI does and Tade cannot is said every time rather than once: a
        // list that quietly holds less than CI does is how somebody comes to
        // believe a green tick here means a green tick there.
        if (stood.read.problems.length > 0) {
          lines.push('', 'Not read here:', ...stood.read.problems.map((problem) => `- ${problem}`))
        }
        lines.push(
          '',
          `The rule here: checks run before ${stood.rule.before}, and a red one ${meansRed(stood.rule)}.`,
        )
        return {
          text: lines.join('\n'),
          said: saidRollup(stood.rollup, where.project),
          data: { rollup: stood.rollup, runs: stood.at },
        }
      },
    },
    {
      name: 'checks_run',
      description:
        'Run this project’s checks here, now, and answer with what passed, what failed and the failing tail. Takes minutes. Tade runs one set at a time per checkout, so this waits rather than starting a second suite beside somebody else’s.',
      parameters: object({
        project: projectInput,
        only: list(string('a check id'), 'run only these checks; all of them when empty'),
        wait: number('seconds to wait for another run in this checkout to finish (0)'),
      }),
      for: ['orchestrator', 'agent'],
      async run(input, ctx) {
        const where = await workingIn(input, ctx)
        if (!where.commit) {
          throw new Error(`${where.worktree} has no commit to check: commit something first`)
        }
        const only = Array.isArray(input.only) ? input.only.map(String) : []
        const wait = Number(input.wait) > 0 ? Math.min(600, Number(input.wait)) * 1_000 : 0
        let ran: CheckLog[]
        try {
          ran = await runProjectChecks({
            config: where.config,
            project: where.project,
            worktree: where.worktree,
            commit: where.commit,
            by: ctx.caller.kind === 'agent' ? ctx.caller.task : ctx.caller.kind,
            home: ctx.home,
            only,
            signal: ctx.signal,
            waitMs: wait,
            onRun: (run) => {
              if (run.state === 'running') ctx.progress(`${run.check} is running`)
              if (run.state === 'passed' || run.state === 'failed') {
                ctx.progress(`${run.check} ${run.state}`)
              }
            },
          })
        } catch (err) {
          // A runner that will not run says what to do about it; being busy
          // says who has the checkout. Neither is "they passed".
          throw err instanceof RunnerError ? new Error(err.message) : err
        }
        if (ran.length === 0) {
          return {
            text: `${where.project} has no checks to run${only.length > 0 ? ` matching ${only.join(', ')}` : ''}.`,
            said: 'There is nothing to run.',
          }
        }
        const failed = ran.filter((run) => run.state === 'failed' || run.state === 'timed out')
        const lines = [
          `## ${where.project} at ${where.commit.slice(0, 8)}`,
          '',
          ...ran.map(checkLine),
        ]
        for (const run of failed) {
          lines.push(
            '',
            `### ${run.check}`,
            '',
            '```',
            run.tail.split('\n').slice(-40).join('\n').trimEnd(),
            '```',
          )
        }
        return {
          text: lines.join('\n'),
          said:
            failed.length === 0
              ? `Everything passed in ${where.project}.`
              : `${failed.map((run) => run.check).join(', ')} failed.`,
          data: ran,
        }
      },
    },
    {
      name: 'checks_log',
      description:
        'The tail of what a check printed the last time it ran here, scrubbed of anything credential-shaped. For what CI printed, use review_checks.',
      parameters: object(
        {
          check: string('the check id'),
          project: projectInput,
          lines: number('how many lines (60)'),
        },
        ['check'],
      ),
      for: ['orchestrator', 'agent'],
      async run(input, ctx) {
        const where = await workingIn(input, ctx)
        const stood = await checksAt({
          config: where.config,
          project: where.project,
          worktree: where.worktree,
          commit: where.commit,
        })
        const wanted = String(input.check)
        const run = [...stood.runs].reverse().find((one) => one.check === wanted)
        if (!run) {
          throw new Error(
            `${wanted} has never run here (this project checks ${stood.read.checks.map((one) => one.id).join(', ') || 'nothing'})`,
          )
        }
        const lines = Number(input.lines) > 0 ? Math.min(500, Number(input.lines)) : 60
        const stale =
          run.commit !== where.commit
            ? ` (at ${run.commit.slice(0, 8)}, not what is checked out)`
            : ''
        return {
          text: [
            `### ${run.check} — ${run.state}${stale}`,
            '',
            '```',
            run.tail.split('\n').slice(-lines).join('\n').trimEnd() || '(it printed nothing)',
            '```',
          ].join('\n'),
          said: `${run.check} ${run.state}`,
          data: run,
        }
      },
    },
    {
      name: 'checks_override',
      description:
        'Overrule the rule that a push needs a green run behind it, for a stated reason. An act, not a setting: it is written down with who asked and why, the person is told what you said, and the red check stays red. An agent may only ever overrule it for its own task.',
      parameters: object(
        {
          scope: oneOf(['next push', 'this task', 'this project'], 'how far it reaches'),
          reason: string('why, in your own words: what is failing and why it is not yours'),
          task: string('the task it covers; yours by default'),
          project: projectInput,
          hours: number('how long it lasts, up to 4; the next push only when left out'),
        },
        ['scope', 'reason'],
      ),
      for: ['orchestrator', 'agent'],
      async run(input, ctx) {
        const scope = String(input.scope ?? '')
        const reason = String(input.reason ?? '')
        const asked = input.task ? String(input.task) : null
        const mine = ctx.caller.kind === 'agent' ? ctx.caller.task : null
        const hours = Number(input.hours) > 0 ? Number(input.hours) : 0
        const problem = overrideProblem({
          by:
            ctx.caller.kind === 'agent'
              ? 'agent'
              : ctx.caller.kind === 'you'
                ? 'you'
                : 'orchestrator',
          askedFor: asked ?? mine ?? '',
          scope,
          task: mine,
          reason,
          forMs: hours > 0 ? hours * 3_600_000 : undefined,
        })
        if (problem) throw new Error(problem)
        const covers = asked ?? mine
        const lasts =
          hours > 0
            ? `for ${Math.min(hours, OVERRIDE_LIMIT_MS / 3_600_000)}h`
            : scope === 'next push'
              ? 'until the next push'
              : 'until it is changed'
        return {
          // The call itself is the record: it is journalled as a tool call
          // with who asked, what scope and the reason, and the gate reads it
          // back from there. Nothing edits the config behind anybody's back.
          text: `Noted: ${scope}${covers ? ` for ${covers}` : ''}, ${lasts} — "${reason}". The check stays red, and the person is told what you said.`,
          said: `Overruled for ${covers ?? scope}: ${reason}`,
          data: { scope, reason, task: covers, hours },
        }
      },
    },
  ],

  actions: [
    {
      id: 'run',
      title: 'Run the checks',
      tool: 'checks_run',
      project: true,
      heard: [/^run the checks$/i],
    },
    {
      id: 'list',
      title: "What's red here",
      tool: 'checks_list',
      project: true,
      heard: [/^what('s| is) red( here)?\??$/i],
    },
  ],
}

interface Working {
  project: string
  worktree: string
  commit: string | null
  config: Config
}

/** Where a tool works: an agent's own worktree, or a project's checkout. */
async function workingIn(input: Record<string, unknown>, ctx: ToolContext): Promise<Working> {
  const caller = ctx.caller
  const named = input.project ? String(input.project) : null
  const project = !named && caller.kind === 'agent' ? caller.project : ctx.project(named).name
  const worktree =
    !named && caller.kind === 'agent' ? caller.cwd : ctx.project(named ?? project).root
  const head = await ctx.exec('git', ['-C', worktree, 'rev-parse', 'HEAD'], { timeoutMs: 5_000 })
  return {
    project,
    worktree,
    commit: head.code === 0 ? head.stdout.trim() : null,
    config: await configOf(ctx),
  }
}

/**
 * Tade's own config, read from its home. The rule about when checks run is
 * the person's, and it lives where every other setting does — never copied
 * into `extensions.checks`, which would be a second place to change it.
 */
async function configOf(ctx: ExtensionContext): Promise<Config> {
  const loaded = await loadConfig(join(ctx.home, 'config.yaml')).catch(() => null)
  return loaded?.ok ? loaded.config : ConfigSchema.parse({})
}

function meansRed(rule: ChecksConfig): string {
  return rule.on_red === 'hold'
    ? 'holds the push that would have followed it'
    : rule.on_red === 'tell'
      ? 'is told to the person, and the push goes through'
      : 'is only written down'
}

function saidRollup(
  rollup: { state: string; failed: string[]; missing: string[] },
  project: string,
): string {
  if (rollup.state === 'pass') return `${project} is green at this commit.`
  if (rollup.state === 'fail') return `${rollup.failed.join(', ')} failed.`
  return `${rollup.missing.join(', ')} ${rollup.missing.length === 1 ? 'has' : 'have'} not run at this commit.`
}

/** What the window draws on a task's row: the rollup, in a word. */
export function rollupWord(runs: readonly CheckRun[], commit: string | null): string | null {
  const at = latestAt(runs, commit)
  if (at.length === 0) return null
  if (at.some((run) => run.state === 'failed' || run.state === 'timed out')) return 'checks red'
  if (at.some((run) => run.state === 'running' || run.state === 'queued')) return 'checks running'
  return null
}

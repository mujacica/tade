import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adoptable,
  amendChecks,
  type CheckDraft,
  type CheckLog,
  type CheckRun,
  carriedNote,
  checkLine,
  latestAt,
  MANIFEST_PATH,
  RunnerError,
  writeChecks,
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
  boolean,
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
    'Answers “is this green” without running anything (checks_list): how each check stands at the commit that is checked out — including that it has never run, which is not the same as passing.',
    'Runs them here, one suite at a time (checks_run): an agent about to push calls this rather than the shell, so four agents in one checkout never start four suites, and the run is recorded against the commit.',
    'Gives a project a gate it has not got (checks_propose): writes `.tade/checks.yaml`, adopted from what CI already runs, and `tade checks workflow` generates the CI from that same file.',
    'Overrules the rule as an act, not a setting (checks_override): who asked and why is written down, the check stays red, and the person is told what was said.',
    'What it reads from CI it does not adopt: those carry a skip and leave the rollup unknown, because a CI config holds deploys beside its tests.',
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
      'When checks_list says a project checks nothing yet, say so once and offer checks_propose — a project with no checks has no gate, and nobody finds that out until something is already merged.',
      'checks_propose writes .tade/checks.yaml. Never guess the commands: adopt what CI already runs, or read the project and say what you are proposing before you write it.',
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
        if (stood.manifest.checks.length === 0) {
          return {
            text: [
              `${where.project} has no checks written down, so nothing here is verified.`,
              '',
              '`checks_propose` writes `.tade/checks.yaml` — an id, a title and a command each — and CI can be generated from the same file with `tade checks workflow --write`.',
              ...stood.manifest.problems.map((problem) => `- ${problem}`),
            ].join('\n'),
            said: `${where.project} checks nothing yet.`,
          }
        }
        const lines = [
          `## ${where.project} — ${stood.manifest.checks.length} checks (from ${stood.manifest.from ?? stood.manifest.source})`,
          '',
          `At ${where.commit ? where.commit.slice(0, 8) : 'no commit'}: **${stood.rollup.state}**.`,
          '',
        ]
        for (const check of stood.plan) {
          const run = stood.at.find((one) => one.check === check.id)
          lines.push(
            run
              ? `${checkLine(run)}${carriedNote(run, stood.carried.has(run.id))}`
              : `- ◦ \`${check.id}\` has not run at this commit${check.skip ? ` (${check.skip})` : ''}`,
          )
        }
        if (stood.manifest.problems.length > 0) {
          lines.push('', ...stood.manifest.problems.map((problem) => `- ${problem}`))
        }
        if (stood.manifest.source === 'CI') {
          // These are a reading, not a gate: every one of them carries a
          // `skip`, so the rollup above says `unknown` and will keep saying it
          // until somebody adopts them. Offering that here is the only place
          // the orchestrator finds out it can.
          lines.push(
            '',
            `These were read from ${stood.manifest.from}, so none of them run here yet. \`checks_propose\` with \`adopt\` writes them into \`${MANIFEST_PATH}\`, and then they do.`,
          )
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
            `${wanted} has never run here (this project checks ${stood.manifest.checks.map((one) => one.id).join(', ') || 'nothing'})`,
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
      name: 'checks_propose',
      description:
        'Write what this project checks into .tade/checks.yaml. Use it when checks_list says a project checks nothing yet, or when a check should be added, changed or taken out. `adopt` takes what the project already runs in CI, which is the right first move for a project that has CI and no manifest; otherwise pass the checks yourself. Say what you are about to write before you write it, and use `dry_run` to show it. It changes one file and never any code; the project\u2019s own git is the undo.',
      parameters: object({
        project: projectInput,
        adopt: boolean(
          'write what this project already runs in CI, instead of naming checks yourself',
        ),
        checks: list(
          object(
            {
              id: string('short, lowercase, dashes: format, types, tests'),
              run: string('the command line, exactly as it would be typed in the project'),
              title: string('what it checks, as a person says it: "Formatting and lint"'),
              alone: boolean('it needs the machine to itself; nothing else of ours runs beside it'),
              minutes: number('stopped and called timed out after this long (10)'),
              required: boolean('merging waits on it (true)'),
            },
            ['id', 'run'],
          ),
          'the checks to add, or to replace where the id is already there',
        ),
        remove: list(string('a check id'), 'checks to take out of the file'),
        dry_run: boolean('show the file it would write and write nothing'),
      }),
      // The orchestrator only. An agent is judged by these checks, and a tool
      // that lets it rewrite its own gate is the wrong shape whatever it is
      // guarded with \u2014 an agent that thinks the checks are wrong is already
      // editing files and can say so in its task.
      for: ['orchestrator'],
      async run(input, ctx) {
        const where = await workingIn(input, ctx)
        const dry = input.dry_run === true
        const drafts = asDrafts(input.checks)
        const remove = Array.isArray(input.remove) ? input.remove.map(String) : []
        if (input.adopt === true) {
          if (drafts.length > 0 || remove.length > 0) {
            throw new Error(
              'adopt writes the whole file from CI, so it cannot be combined with checks or remove: adopt first, then amend.',
            )
          }
          const found = await adoptable(where.worktree)
          if (!found || found.checks.length === 0) {
            throw new Error(
              `${where.project} runs no commands in CI that could be adopted${found?.couldNotTake.length ? ` (${found.couldNotTake.join('; ')})` : ''}. Name the checks yourself instead.`,
            )
          }
          const lines = [
            `## ${dry ? 'Would write' : 'Wrote'} ${MANIFEST_PATH} for ${where.project}`,
            '',
            `${found.checks.length} checks, read from ${found.from}:`,
            ...found.checks.map((check) => `- \`${check.id}\` \u2014 ${check.run.split('\n')[0]}`),
          ]
          // What CI does and Tade cannot is said every time, not once: a
          // manifest that quietly holds less than CI does is how somebody
          // comes to believe a green tick here means a green tick there.
          if (found.couldNotTake.length > 0) {
            lines.push(
              '',
              'Not taken \u2014 only the runner can do these:',
              ...found.couldNotTake.map((why) => `- ${why}`),
            )
          }
          if (dry) {
            lines.push('', '```yaml', found.text.trimEnd(), '```')
            return {
              text: lines.join('\n'),
              said: `That would be ${found.checks.length} checks from CI.`,
            }
          }
          const written = await writeChecks(where.worktree, found.checks)
          lines.push(
            '',
            'Tell the person to read it: CI runs releases and deploys beside its tests, and Tade cannot tell which is which.',
          )
          return {
            text: lines.join('\n'),
            said: `${where.project} now checks ${written.ids.join(', ')}.`,
            data: { path: written.path, ids: written.ids },
          }
        }
        if (drafts.length === 0 && remove.length === 0) {
          throw new Error(
            'Say what to write: pass checks, or remove, or adopt to take what this project already runs in CI.',
          )
        }
        if (dry) {
          return {
            text: [
              `## Would change ${MANIFEST_PATH} for ${where.project}`,
              '',
              ...drafts.map((one) => `- \`${one.id}\` \u2014 ${one.run}`),
              ...remove.map((id) => `- remove \`${id}\``),
            ].join('\n'),
            said: 'Nothing written yet.',
          }
        }
        // `amendChecks` keeps the comments and the `ci:` block, and throws a
        // sentence naming what is wrong rather than writing a file somebody
        // then has to find and fix by hand.
        const written = await amendChecks(where.worktree, drafts, { remove })
        return {
          text: [
            `## ${written.amended ? 'Changed' : 'Wrote'} ${written.path} for ${where.project}`,
            '',
            `It now checks: ${written.ids.join(', ')}.`,
            '',
            'It is a change in the working tree, not a commit. `tade checks workflow --write` generates CI back from it.',
          ].join('\n'),
          said: `${where.project} now checks ${written.ids.join(', ')}.`,
          data: { path: written.path, ids: written.ids },
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

/** The checks a caller asked for, as drafts. Shape trouble is `amendChecks`'s to name. */
function asDrafts(value: unknown): CheckDraft[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const one = entry as Record<string, unknown>
    return [
      {
        id: String(one.id ?? ''),
        run: String(one.run ?? ''),
        ...(typeof one.title === 'string' ? { title: one.title } : {}),
        ...(one.alone === true ? { alone: true } : {}),
        ...(typeof one.minutes === 'number' ? { minutes: one.minutes } : {}),
        ...(one.required === false ? { required: false } : {}),
      },
    ]
  })
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

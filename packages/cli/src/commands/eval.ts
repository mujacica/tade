import {
  defaultConfigPath,
  loadConfig,
  printable,
  printableLines,
  type ReplayCandidate,
  replaySays,
  tadeHome,
} from '@tade/core'
import { loadExtensions } from '@tade/orchestrator'
import { REPLAY_READS, replaysOnDisk, startReplay } from '@tade/workbench'
import { readJournal } from '@tade/workbench/events'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { withWorkbench } from '../with-workbench.ts'

// Your own eval, from the command line: replay the work that landed in a
// project on a candidate model or harness (`run`), read where every replay
// stands (`show`), and ask a candidate judge the questions Jev already asked
// (`judge`).
//
// **`run` writes, so it needs the home**: with a window open it is refused and
// says to ask the orchestrator there, which is the same act (`tade_replay`).
// With none open the plan is made as queued work and the next window starts
// it by the queue's own rule — nothing starts here. Typing the command is the
// person asking, so it is theirs (`by: you`), and its own words are what the
// journal keeps as what was asked.
//
// **`show` is a question**, so it reads the journal and the entrants' trees
// directly and works with a window open. No judge is read from here, which it
// says as not read rather than as nothing found.
//
// **`judge` asks a judge**, and costs what that does: it loads the extensions
// and calls `jev_replay` as you, with your ceiling.

/** `eval-sonnet-1016-0513`: what a replay is called when nobody names it. */
function nameFor(candidate: ReplayCandidate, now: Date): string {
  const what = (candidate.model ?? candidate.harness ?? 'run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `eval-${what || 'run'}-${stamp}`
}

/** A positive number from a flag, or undefined with the reason said. */
function positive(said: string | undefined, flag: string, io: Io): number | null | undefined {
  if (said === undefined) return undefined
  const n = Number(said)
  if (!Number.isFinite(n) || n <= 0) {
    io.err(`${flag} is a number above nought, not ${said}`)
    return null
  }
  return n
}

export function registerEval(program: Command, io: Io, setExit: (code: number) => void): void {
  const evals = program
    .command('eval')
    .description(
      'Your own eval: replay the work that landed in a project on a candidate model or harness, and score it by your checks, the original’s tests, the judge and what it cost',
    )

  evals
    .command('run <project>')
    .description(
      'Replay the last tasks that landed, each at its own base with its own words, on a candidate — made as queued work a window starts',
    )
    .requiredOption('--ceiling <usd>', 'the most it may spend, in dollars')
    .option('--model <model>', 'the candidate model; each task on the harness it first ran on')
    .option(
      '--harness <harness>',
      'with --model, hold this harness and take only its tasks; alone, the candidate harness',
    )
    .option('--last <n>', 'how many landed tasks, newest first', '5')
    .option('--at <time>', 'not before this time (an ISO time): overnight, say')
    .option('--at-once <n>', 'how many run at once', '2')
    .option('--name <name>', 'what to call it; the entrants are <name>-1, <name>-2, …')
    .action(
      async (
        project: string,
        opts: {
          ceiling: string
          model?: string
          harness?: string
          last: string
          at?: string
          atOnce: string
          name?: string
        },
      ) => {
        const ceiling = positive(opts.ceiling, '--ceiling', io)
        const last = positive(opts.last, '--last', io)
        const atOnce = positive(opts.atOnce, '--at-once', io)
        if (!ceiling || last === null || atOnce === null) {
          setExit(Exit.invalidInput)
          return
        }
        const candidate: ReplayCandidate = {
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.harness ? { harness: opts.harness } : {}),
        }
        if (!candidate.model && !candidate.harness) {
          io.err('name what to replay on: --model, --harness, or both to hold that harness fixed')
          setExit(Exit.invalidInput)
          return
        }
        const at = opts.at ? new Date(opts.at) : null
        if (at && Number.isNaN(at.getTime())) {
          io.err(`--at is a time, not ${opts.at}`)
          setExit(Exit.invalidInput)
          return
        }
        const name = opts.name ?? nameFor(candidate, new Date())
        await withWorkbench(
          io,
          setExit,
          async (tade) => {
            const made = await startReplay(
              {
                home: tade.home,
                config: tade.config,
                log: tade.log,
                planTasks: (plan, by, busy) => tade.planTasks(plan, by, busy),
                now: Date.now(),
              },
              {
                project,
                name,
                // What was typed is what was asked, verbatim.
                said: [
                  'tade eval run',
                  ...process.argv.slice(process.argv.indexOf('run') + 1),
                ].join(' '),
                candidate,
                ...(last !== undefined ? { last } : {}),
                ceilingUsd: ceiling,
                ...(at ? { at: at.toISOString() } : {}),
                ...(atOnce !== undefined ? { atOnce } : {}),
                by: 'you',
              },
            )
            const ran = made.cases.filter((one) => one.task !== null)
            io.out(
              `${name}: ${ran.length} task${ran.length === 1 ? '' : 's'} to replay, queued with a $${ceiling.toFixed(2)} ceiling. A window starts them${at ? ` from ${at.toISOString()}` : ''}; \`tade eval show ${name}\` reads where it stands.`,
            )
            for (const one of made.cases.filter((c) => c.task === null)) {
              io.out(`  could not replay ${one.of}: ${printable(one.couldNot ?? '')}`)
            }
          },
          'Ask the orchestrator there to run the eval (tade_replay)',
        )
      },
    )

  evals
    .command('show [replay]')
    .description(
      'Where each replay stands: every case beside its original, and what it cost against its ceiling',
    )
    .option('--project <name>', 'only this project’s replays')
    .option('--json', 'machine-readable output')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(
      async (
        replay: string | undefined,
        opts: { project?: string; json?: boolean; config: string },
      ) => {
        const cfg = await loadConfig(opts.config)
        if (!cfg.ok) {
          io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
          setExit(Exit.invalidInput)
          return
        }
        const home = tadeHome()
        const all = await replaysOnDisk({
          home,
          config: cfg.config,
          events: await readJournal(home, { types: [...REPLAY_READS] }),
          now: Date.now(),
        })
        const shown = all.filter(
          (one) =>
            (!opts.project || one.project === opts.project) && (!replay || one.name === replay),
        )
        if (opts.json) {
          io.out(JSON.stringify({ replays: shown }, null, 2))
          return
        }
        if (shown.length === 0) {
          io.out(
            replay
              ? `there is no replay called ${replay}`
              : 'no replays yet: `tade eval run <project> --model <m> --ceiling <usd>` makes one',
          )
          if (replay) setExit(Exit.error)
          return
        }
        io.out(printableLines(shown.map((one) => replaySays(one).join('\n')).join('\n\n')))
        io.out('(the judge is not read from here: straying is said in the window, /evals)')
      },
    )

  evals
    .command('judge')
    .description(
      'Ask a candidate judge the questions Jev already asked about recorded changes, and count it beside the recorded answers and the verdicts',
    )
    .requiredOption('--ceiling <usd>', 'the most it may spend, in dollars')
    .option('--judge <name>', 'the candidate judge, by its name in Tade')
    .option('--model <version>', 'the version the candidate answers with')
    .option('--last <n>', 'how many recorded changes, newest first', '10')
    .option('--project <name>', 'only this project’s changes')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(
      async (opts: {
        ceiling: string
        judge?: string
        model?: string
        last: string
        project?: string
        config: string
      }) => {
        const ceiling = positive(opts.ceiling, '--ceiling', io)
        const last = positive(opts.last, '--last', io)
        if (!ceiling || last === null) {
          setExit(Exit.invalidInput)
          return
        }
        const cfg = await loadConfig(opts.config)
        if (!cfg.ok) {
          io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
          setExit(Exit.invalidInput)
          return
        }
        try {
          const host = await loadExtensions({ config: cfg.config, home: tadeHome() })
          const answer = await host.call(
            'jev_replay',
            {
              ceiling_usd: ceiling,
              ...(opts.judge ? { judge: opts.judge } : {}),
              ...(opts.model ? { model: opts.model } : {}),
              ...(last !== undefined ? { last } : {}),
              ...(opts.project ? { project: opts.project } : {}),
            },
            { caller: { kind: 'you' } },
          )
          // A judge's answer, and what a runner said: printed as text.
          io.out(printableLines(answer.text))
        } catch (err) {
          io.err(printable(err instanceof Error ? err.message : String(err)))
          setExit(Exit.error)
        }
      },
    )
}

import { homedir } from 'node:os'
import { glyphOf, RunnerError, readChecks } from '@tade/checks-core'
import { defaultConfigPath, loadConfig, tadeHome } from '@tade/core'
import { collectStatus, writeTests } from '@tade/status'
import { runProjectChecks } from '@tade/workbench/checks'
import { laneLivenessFromFile } from '@tade/workbench/lane-liveness'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Verifying the work, rather than believing it.
//
// An agent reporting success on broken work is the first failure mode in the
// design, which is why `review` is supposed to mean green tests and a clean
// tree, checked by something that is not the agent. This is that something —
// now the project's whole gate rather than one command, where a project says
// what its checks are, and exactly today's behaviour where it does not.

/** How much output to keep, so a failure can be explained without re-running. */
const TAIL = 4_000

export function registerCheck(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('check <task>')
    .description("Run a task's checks and record each against the commit it is on")
    .option('--only <ids>', 'run only these checks, comma-separated')
    .option('--no-record', 'run them without writing anything down')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (taskId: string, opts: { config: string; only?: string; record: boolean }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`tade config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }

      const workspace = await collectStatus({
        config: cfg.config,
        now: Date.now(),
        home: homedir(),
        cwd: process.cwd(),
        pr: false,
        liveness: await laneLivenessFromFile(tadeHome()),
      })
      const found = workspace.projects
        .flatMap((project) => project.tasks.map((task) => ({ project, task })))
        .find((entry) => entry.task.id === taskId)
      if (!found) {
        io.err(`no such task: ${taskId}`)
        setExit(Exit.invalidInput)
        return
      }
      const worktree = found.task.worktree
      const head = found.task.git?.head ?? null
      const project = found.project.name
      const test = cfg.config.projects[project]?.test_command
      const read = await readChecks({ name: project, root: worktree, test })

      if (read.checks.length === 0) {
        io.err(`${project} says nothing about what checking it means.`)
        io.err('  A workflow that runs on a change, or a pre-commit hook, is what would be read.')
        io.err(
          `  Failing both, set projects: { ${project}: { test_command: "pnpm test" } } in ${cfg.path}`,
        )
        setExit(Exit.invalidInput)
        return
      }
      if (!head) {
        io.err(`${taskId} has no commit to check`)
        setExit(Exit.error)
        return
      }

      const only = (opts.only ?? '')
        .split(',')
        .map((one) => one.trim())
        .filter(Boolean)
      let red = false
      try {
        const ran = await runProjectChecks({
          config: cfg.config,
          project,
          worktree,
          commit: head,
          by: taskId,
          home: homedir(),
          only,
          onRun: (run) => {
            if (run.state === 'running') io.err(`$ ${run.check}`)
          },
          onOutput: (_check, chunk) => io.err(chunk.trimEnd()),
        })
        red = ran.some((run) => run.state === 'failed' || run.state === 'timed out')
        for (const run of ran) {
          io.out(`${glyphOf(run.state)} ${run.check} ${run.state} at ${head.slice(0, 8)}`)
        }
        // The one record `tade check` has always written, kept for one
        // release so nobody's recorded run disappears on upgrade.
        if (opts.record) {
          await writeTests(worktree, {
            status: red ? 'fail' : 'pass',
            commit: head,
            command: ran.map((run) => run.check).join(', '),
            at: new Date().toISOString(),
            output: ran
              .flatMap((run) => (run.tail ? [`# ${run.check}`, run.tail] : []))
              .join('\n')
              .slice(-TAIL),
          })
        }
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        setExit(
          err instanceof RunnerError && err.trouble === 'unknown' ? Exit.invalidInput : Exit.error,
        )
        return
      }
      if (red) setExit(Exit.error)
    })
}

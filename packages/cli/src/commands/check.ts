import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { defaultConfigPath, loadConfig, wilcoHome } from '@wilco/core'
import { collectStatus, writeTests } from '@wilco/status'
import { laneLivenessFromFile } from '@wilco/workbench/lane-liveness'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// Verifying the work, rather than believing it.
//
// An agent reporting success on broken work is the first failure mode in the
// design, which is why `review` is supposed to mean green tests and a clean
// tree, checked by something that is not the agent. This is that something.

/** How much output to keep, so a failure can be explained without re-running. */
const TAIL = 4_000

export function registerCheck(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('check <task>')
    .description("Run a task's tests and record the result against its commit")
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (taskId: string, opts: { config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`wilco config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }

      const workspace = await collectStatus({
        config: cfg.config,
        now: Date.now(),
        home: homedir(),
        cwd: process.cwd(),
        pr: false,
        liveness: await laneLivenessFromFile(wilcoHome()),
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
      const command = cfg.config.projects[found.project.name]?.test_command ?? ''

      if (!command) {
        io.err(`${taskId.split('/')[0]} has no test_command in ${cfg.path}`)
        io.err('  projects: { <name>: { test_command: "pnpm test" } }')
        setExit(Exit.invalidInput)
        return
      }
      if (!head) {
        io.err(`${taskId} has no commit to check`)
        setExit(Exit.error)
        return
      }

      io.err(`$ ${command}`)
      const { code, output } = await run(command, worktree, io)
      await writeTests(worktree, {
        status: code === 0 ? 'pass' : 'fail',
        commit: head,
        command,
        at: new Date().toISOString(),
        output: output.slice(-TAIL),
      })
      io.out(code === 0 ? `tests pass at ${head.slice(0, 8)}` : `tests fail at ${head.slice(0, 8)}`)
      if (code !== 0) setExit(Exit.error)
    })
}

/**
 * Run the project's own command, showing it as it goes and keeping the tail.
 * A shell is used because the command comes from the config as a command line
 * ("pnpm test && pnpm lint"), not as an argument vector.
 */
async function run(
  command: string,
  cwd: string,
  io: Io,
): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(command, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: string) => {
      output += chunk
      if (output.length > TAIL * 4) output = output.slice(-TAIL * 2)
      io.err(chunk.trimEnd())
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', () => done({ code: 1, output: `${output}\ncould not run: ${command}` }))
    child.once('exit', (code) => done({ code: code ?? 1, output }))
  })
}

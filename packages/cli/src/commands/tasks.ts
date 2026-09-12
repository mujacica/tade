import { homedir } from 'node:os'
import { defaultConfigPath, loadConfig, type RunId } from '@wilco/core'
import { collectStatus } from '@wilco/probes'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { withDaemon } from '../with-daemon.ts'

// Tasks and the agents working on them. Thin over the daemon: parse, call,
// format.

export function registerTasks(program: Command, io: Io, setExit: (code: number) => void): void {
  const task = program.command('task').description('Create and remove tasks')

  task
    .command('create')
    .argument('<id>', 'task id: <project>/<name>')
    .description('Create a task: a branch, a worktree, and your intent recorded verbatim')
    .requiredOption('--intent <text>', 'what you are trying to do, in your own words')
    .option('--root <path>', 'repository root (defaults to the project in config.yaml)')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { intent: string; root?: string; json?: boolean }) => {
      const [project, slug, ...rest] = id.split('/')
      if (!project || !slug || rest.length > 0) {
        io.err(`invalid task id: ${id} (want <project>/<name>)`)
        setExit(Exit.invalidInput)
        return
      }
      await withDaemon(io, setExit, async (client) => {
        const created = await client.createTask({
          project,
          slug,
          intent: opts.intent,
          ...(opts.root ? { root: opts.root } : {}),
        })
        if (opts.json) io.out(JSON.stringify(created, null, 2))
        else io.out(`${created.id}  ${created.branch}  ${created.worktree}`)
      })
    })

  task
    .command('remove')
    .argument('<id>', 'task id')
    .description('Remove a task worktree; refuses to destroy unmerged or uncommitted work')
    .option('--force', 'remove anyway')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (id: string, opts: { force?: boolean; config: string }) => {
      const cfg = await loadConfig(opts.config)
      if (!cfg.ok) {
        io.err(`${cfg.path}: invalid config (run \`wilco config --check\`)`)
        setExit(Exit.invalidInput)
        return
      }
      // Where the task lives is a question for status, which derives it from git.
      const workspace = await collectStatus({
        config: cfg.config,
        now: Date.now(),
        home: homedir(),
        cwd: process.cwd(),
        pr: false,
      })
      const project = workspace.projects.find((p) => p.tasks.some((t) => t.id === id))
      const found = project?.tasks.find((t) => t.id === id)
      if (!project || !found) {
        io.err(`no such task: ${id}`)
        setExit(Exit.invalidInput)
        return
      }
      await withDaemon(io, setExit, async (client) => {
        const result = await client.removeTask({
          root: project.root,
          worktree: found.worktree,
          branch: found.branch,
          ...(opts.force ? { force: true } : {}),
        })
        if (result.removed) {
          io.out(`${id} removed`)
          return
        }
        io.err(`${id} kept: ${result.reason}`)
        io.err('pass --force to remove it anyway')
        setExit(Exit.error)
      })
    })

  const run = program.command('run').description('Start and steer agents working on a task')

  run
    .command('start')
    .argument('<task>', 'task id')
    .description('Start an agent in the task worktree')
    .option('--prompt <text>', 'what to tell it first', '')
    .option('--model <model>', 'model to use, e.g. anthropic/claude-opus-5')
    .option('--provider <name>', 'provider to use')
    .option('--cwd <path>', 'working directory (defaults to the task worktree)')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .option('--json', 'machine-readable output')
    .action(
      async (
        taskId: string,
        opts: {
          prompt: string
          model?: string
          provider?: string
          cwd?: string
          config: string
          json?: boolean
        },
      ) => {
        const cwd = opts.cwd ?? (await worktreeOf(taskId, opts.config))
        if (!cwd) {
          io.err(`no such task: ${taskId} (create it with \`wilco task create\`)`)
          setExit(Exit.invalidInput)
          return
        }
        await withDaemon(io, setExit, async (client) => {
          const handle = await client.startRun({
            task: taskId,
            cwd,
            prompt: opts.prompt,
            ...(opts.model
              ? { model: { id: opts.model, ...(opts.provider ? { provider: opts.provider } : {}) } }
              : {}),
          })
          if (opts.json) io.out(JSON.stringify(handle, null, 2))
          else io.out(`${handle.run}  ${handle.task}  started`)
        })
      },
    )

  run
    .command('list')
    .description('List running agents')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      await withDaemon(io, setExit, async (client) => {
        const runs = await client.runs()
        if (opts.json) {
          io.out(JSON.stringify(runs, null, 2))
          return
        }
        if (runs.length === 0) {
          io.out('no agents running')
          return
        }
        for (const r of runs) io.out(`${r.run}  ${r.task}  ${age(r.startedAt)}`)
      })
    })

  run
    .command('steer')
    .argument('<run>')
    .argument('<message...>')
    .description('Tell a running agent something without stopping it')
    .action(async (runId: string, message: string[]) => {
      await withDaemon(io, setExit, async (client) => {
        await client.steerRun(runId as RunId, message.join(' '))
        io.out(`told ${runId}`)
      })
    })

  run
    .command('stop')
    .argument('<run>')
    .description('Stop an agent')
    .action(async (runId: string) => {
      await withDaemon(io, setExit, async (client) => {
        await client.stopRun(runId as RunId)
        io.out(`${runId} stopped`)
      })
    })

  program
    .command('approvals')
    .description('Commands agents are waiting to run')
    .option('--task <task>', 'only this task')
    .option('--json', 'machine-readable output')
    .action(async (opts: { task?: string; json?: boolean }) => {
      await withDaemon(io, setExit, async (client) => {
        const pending = await client.pendingApprovals(opts.task)
        if (opts.json) {
          io.out(JSON.stringify(pending, null, 2))
          return
        }
        if (pending.length === 0) {
          io.out('nothing waiting')
          return
        }
        for (const p of pending) {
          io.out(`${p.run}  ${p.requestId}  ${p.tier.padEnd(4)}  ${p.summary}`)
        }
      })
    })

  program
    .command('approve')
    .argument('<run>')
    .argument('<request>')
    .description('Let a waiting command run')
    .action(async (runId: string, request: string) => {
      await withDaemon(io, setExit, async (client) => {
        await client.decideApproval(runId as RunId, request, { allow: true })
        io.out(`approved ${request}`)
      })
    })

  program
    .command('deny')
    .argument('<run>')
    .argument('<request>')
    .description('Refuse a waiting command')
    .option('--reason <text>', 'what to tell the agent instead')
    .action(async (runId: string, request: string, opts: { reason?: string }) => {
      await withDaemon(io, setExit, async (client) => {
        await client.decideApproval(runId as RunId, request, {
          allow: false,
          ...(opts.reason ? { reason: opts.reason } : {}),
        })
        io.out(`denied ${request}`)
      })
    })
}

/** Find a task's worktree the same way status does: from git. */
async function worktreeOf(taskId: string, configPath: string): Promise<string | null> {
  const cfg = await loadConfig(configPath)
  if (!cfg.ok) return null
  const workspace = await collectStatus({
    config: cfg.config,
    now: Date.now(),
    home: homedir(),
    cwd: process.cwd(),
    pr: false,
  })
  for (const project of workspace.projects) {
    const task = project.tasks.find((t) => t.id === taskId)
    if (task) return task.worktree
  }
  return null
}

function age(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

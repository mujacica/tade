import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  adoptable,
  carriedNote,
  carryOver,
  type FromCi,
  glyphOf,
  latestAt,
  MANIFEST_PATH,
  planFor,
  RunnerError,
  readChecks,
  readRuns,
  rollup,
  WORKFLOW_PATH,
  whereOf,
  workflowFor,
  workflowMatches,
  writeChecks,
} from '@tade/checks-core'
import { checksFor, defaultConfigPath, expandHome, loadConfig } from '@tade/core'
import { git } from '@tade/status'
import { runProjectChecks } from '@tade/workbench/checks'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// The checks, from a terminal: what this project checks, how it stands, and
// running them — all of it with the window open or closed, because a question
// you cannot ask while Tade is running is a question people stop asking.

interface Where {
  project: string
  root: string
  test: string | undefined
  /** This project's answer to `checks.from_ci`, so the CLI reads what the window reads. */
  fromCi: FromCi
}

export function registerChecks(program: Command, io: Io, setExit: (code: number) => void): void {
  const checks = program
    .command('checks')
    .description("A project's own checks: what they are, how they stand, and running them here")

  checks
    .command('list', { isDefault: true })
    .description('What this project checks and how each stands at the commit checked out')
    .option('-p, --project <name>', 'project name, as configured')
    .option('--json', 'machine-readable output')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { project?: string; json?: boolean; config: string }) => {
      const where = await locate(opts, io, setExit)
      if (!where) return
      const manifest = await readChecks({
        name: where.project,
        root: where.root,
        test: where.test,
        fromCi: where.fromCi,
      })
      const head = await headOf(where.root)
      const plan = planFor(manifest.checks)
      const runs = await readRuns(where.root)
      // A run recorded just before a commit that holds exactly what it read
      // still stands at that commit: it is the same bytes.
      const covering = await carryOver(where.root, runs, head)
      const at = latestAt(runs, covering)
      const said = rollup(plan, runs, covering)
      if (opts.json) {
        io.out(
          JSON.stringify(
            {
              project: where.project,
              source: manifest.source,
              commit: head,
              checks: plan,
              at,
              rollup: said,
            },
            null,
            2,
          ),
        )
        return
      }
      if (plan.length === 0) {
        io.out(`${where.project} has no checks configured.`)
        io.out(`  Write ${'.tade/checks.yaml'}, and CI can be generated from it.`)
        for (const problem of manifest.problems) io.err(`  ${problem}`)
        return
      }
      io.out(
        `${where.project} — ${manifest.from ?? manifest.source} · ${said.state} at ${short(head)}`,
      )
      for (const check of plan) {
        const run = at.find((one) => one.check === check.id)
        io.out(
          run
            ? `  ${glyphOf(run.state)} ${check.id.padEnd(10)} ${run.state.padEnd(10)} ${whereOf(run)}${run.summary ? ` — ${run.summary}` : ''}${carriedNote(run, covering.carried?.has(run.id) ?? false)}`
            : `  ◦ ${check.id.padEnd(10)} has not run at this commit`,
        )
      }
      for (const problem of manifest.problems) io.err(`  ${problem}`)
    })

  checks
    .command('run [ids...]')
    .description('Run them here, one set at a time per checkout, and record each against HEAD')
    .option('-p, --project <name>', 'project name, as configured')
    .option('--wait <seconds>', 'wait this long for another run in this checkout to finish', '0')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (ids: string[], opts: { project?: string; wait: string; config: string }) => {
      const where = await locate(opts, io, setExit)
      if (!where) return
      const loaded = await loadConfig(opts.config)
      if (!loaded.ok) return
      const head = await headOf(where.root)
      if (!head) {
        io.err(`${where.root} has no commit to check`)
        setExit(Exit.error)
        return
      }
      try {
        const ran = await runProjectChecks({
          config: loaded.config,
          project: where.project,
          worktree: where.root,
          commit: head,
          by: 'you',
          home: homedir(),
          only: ids,
          waitMs: Math.max(0, Number(opts.wait) || 0) * 1_000,
          onRun: (run) => {
            if (run.state === 'running') io.err(`$ ${run.check}`)
          },
          onOutput: (_check, chunk) => io.err(chunk.trimEnd()),
        })
        for (const run of ran) {
          io.out(
            `${glyphOf(run.state)} ${run.check} ${run.state}${run.summary ? ` — ${run.summary}` : ''}`,
          )
        }
        if (ran.some((run) => run.state === 'failed' || run.state === 'timed out')) {
          setExit(Exit.error)
        }
      } catch (err) {
        io.err(err instanceof Error ? err.message : String(err))
        setExit(
          err instanceof RunnerError && err.trouble === 'unknown' ? Exit.invalidInput : Exit.error,
        )
      }
    })

  checks
    .command('adopt')
    .description('Write .tade/checks.yaml from what this project already runs in CI')
    .option('-p, --project <name>', 'project name, as configured')
    .option('--write', 'write the file; without it, print what it would write')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { project?: string; write?: boolean; config: string }) => {
      const where = await locate(opts, io, setExit)
      if (!where) return
      const already = await readChecks({
        name: where.project,
        root: where.root,
        test: where.test,
        fromCi: where.fromCi,
      })
      if (already.source === 'manifest') {
        io.err(
          `${where.project} already has ${MANIFEST_PATH} — edit it rather than adopting over it`,
        )
        setExit(Exit.invalidInput)
        return
      }
      const found = await adoptable(where.root)
      if (!found || found.checks.length === 0) {
        io.err(`${where.project} runs no commands in CI that could be adopted`)
        for (const why of found?.couldNotTake ?? []) io.err(`  ${why}`)
        setExit(Exit.invalidInput)
        return
      }
      // Named before the file is written, not after: what CI does and Tade
      // cannot is the whole reason adoption is a person's decision.
      for (const why of found.couldNotTake) io.err(`  not taken — ${why}`)
      if (!opts.write) {
        io.out(found.text.trimEnd())
        io.out('')
        io.out(`# ${found.checks.length} checks from ${found.from}. Write them with --write.`)
        return
      }
      const written = await writeChecks(where.root, found.checks)
      io.out(`wrote ${written.path}: ${written.ids.join(', ')}`)
      io.out('  Read it before you trust it — CI runs deploys beside its tests.')
      io.out('  Then `tade checks workflow --write` generates CI back from it.')
    })

  checks
    .command('workflow')
    .description(`Print, write or verify ${WORKFLOW_PATH} from the checks manifest`)
    .option('-p, --project <name>', 'project name, as configured')
    .option('--write', 'write it')
    .option('--check', 'exit non-zero when the file on disk differs')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(
      async (opts: { project?: string; write?: boolean; check?: boolean; config: string }) => {
        const where = await locate(opts, io, setExit)
        if (!where) return
        const manifest = await readChecks({
          name: where.project,
          root: where.root,
          test: where.test,
          fromCi: where.fromCi,
        })
        if (manifest.source !== 'manifest') {
          io.err(`${where.project} has no .tade/checks.yaml to generate a workflow from`)
          setExit(Exit.invalidInput)
          return
        }
        const wanted = workflowFor(manifest)
        const path = join(where.root, WORKFLOW_PATH)
        if (opts.check) {
          const onDisk = await readFile(path, 'utf8').catch(() => '')
          if (workflowMatches(onDisk, manifest)) {
            io.out(`${WORKFLOW_PATH} is what .tade/checks.yaml says.`)
            return
          }
          io.err(`${WORKFLOW_PATH} differs from .tade/checks.yaml: regenerate it with`)
          io.err('  tade checks workflow --write')
          setExit(Exit.error)
          return
        }
        if (opts.write) {
          await writeFile(path, wanted)
          io.out(`wrote ${WORKFLOW_PATH}`)
          return
        }
        io.out(wanted.trimEnd())
      },
    )
}

/** The project a command works on: the one named, the only one, or where you are. */
async function locate(
  opts: { project?: string; config: string },
  io: Io,
  setExit: (code: number) => void,
): Promise<Where | null> {
  const loaded = await loadConfig(opts.config)
  if (!loaded.ok) {
    io.err(`${loaded.path}: invalid config (run \`tade config --check\`)`)
    setExit(Exit.invalidInput)
    return null
  }
  const projects = Object.entries(loaded.config.projects)
  if (opts.project) {
    const found = projects.find(([name]) => name === opts.project)
    if (!found) {
      io.err(
        `there is no project called ${opts.project} (there is ${projects.map(([name]) => name).join(', ') || 'none'})`,
      )
      setExit(Exit.invalidInput)
      return null
    }
    return {
      project: found[0],
      root: expandHome(found[1].root),
      test: found[1].test_command,
      fromCi: checksFor(loaded.config, found[0]).from_ci,
    }
  }
  const here = process.cwd()
  const inside = projects.find(([, project]) => here.startsWith(expandHome(project.root)))
  if (inside) {
    return {
      project: inside[0],
      root: expandHome(inside[1].root),
      test: inside[1].test_command,
      fromCi: checksFor(loaded.config, inside[0]).from_ci,
    }
  }
  const only = projects.length === 1 ? projects[0] : undefined
  if (only) {
    return {
      project: only[0],
      root: expandHome(only[1].root),
      test: only[1].test_command,
      fromCi: checksFor(loaded.config, only[0]).from_ci,
    }
  }
  // Not in a configured project: the directory you are in is what you meant.
  const root = await git(here, ['rev-parse', '--show-toplevel'])
  if (!root.ok) {
    io.err('say which project with --project: this is not one, and not a git repository either')
    setExit(Exit.invalidInput)
    return null
  }
  const path = root.stdout.trim()
  return {
    project: path.split('/').at(-1) ?? 'project',
    root: path,
    test: undefined,
    fromCi: loaded.config.checks.from_ci,
  }
}

async function headOf(root: string): Promise<string | null> {
  const head = await git(root, ['rev-parse', 'HEAD'])
  return head.ok ? head.stdout.trim() : null
}

function short(commit: string | null): string {
  return commit ? commit.slice(0, 8) : 'no commit'
}

/** What the rule says here, for anyone printing it. */
export { checksFor }

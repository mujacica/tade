import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'

// Builds REAL git repositories in tmp dirs with scripted histories.
// Never mock git: mocked git teaches you nothing about --porcelain=v2.

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Wilco Test',
  GIT_AUTHOR_EMAIL: 'test@wilco.invalid',
  GIT_COMMITTER_NAME: 'Wilco Test',
  GIT_COMMITTER_EMAIL: 'test@wilco.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

export function tmp(prefix = 'wilco-'): string {
  // realpath: macOS tmpdir is a symlink, and git reports resolved paths.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: 'pipe' })
}

export interface TaskOptions {
  project: string
  intent?: string
  /** Write `.wilco/task.yaml` verbatim instead of generating it. */
  rawTaskYaml?: string
  parked?: boolean
}

export interface Repo {
  root: string
  git(...args: string[]): string
  write(files: Record<string, string>, dir?: string): void
  commit(message: string, files?: Record<string, string>, dir?: string): string
  head(dir?: string): string
  /** Create `wilco/<name>` as a worktree with a task.yaml. Returns the worktree path. */
  addTask(name: string, opts: TaskOptions): string
}

export function mkrepo(opts: { remote?: boolean } = {}): Repo & { remote: string | null } {
  const base = tmp('wilco-repo-')
  const root = join(base, 'repo')
  mkdirSync(root)
  // Deliberately NOT excluding `.wilco/`: a real repository doesn't, and
  // pretending otherwise hides bugs in how Wilco handles its own files.
  runGit(root, 'init', '-q', '-b', 'main')

  const repo: Repo & { remote: string | null } = {
    root,
    remote: null,
    git: (...args) => runGit(root, ...args),
    write(files, dir = root) {
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, content)
      }
    },
    commit(
      message,
      files = { [`f-${Math.random().toString(36).slice(2)}.txt`]: message },
      dir = root,
    ) {
      repo.write(files, dir)
      runGit(dir, 'add', '-A')
      runGit(dir, 'commit', '-q', '-m', message)
      return repo.head(dir)
    },
    head: (dir = root) => runGit(dir, 'rev-parse', 'HEAD').trim(),
    addTask(name, t) {
      const path = join(base, 'worktrees', `${t.project}-${name}`)
      const baseSha = repo.head()
      runGit(root, 'worktree', 'add', '-q', '-b', `wilco/${name}`, path, 'main')
      mkdirSync(join(path, '.wilco'), { recursive: true })
      const yaml =
        t.rawTaskYaml ??
        stringify({
          id: `${t.project}/${name}`,
          project: t.project,
          intent_spoken: t.intent ?? `do ${name}`,
          created: '2026-09-11T09:14:22Z',
          base: baseSha,
          parked: t.parked ?? false,
        })
      writeFileSync(join(path, '.wilco', 'task.yaml'), yaml)
      return path
    },
  }

  repo.commit('initial', { 'README.md': '# fixture\n' })

  if (opts.remote) {
    const remote = join(base, 'remote.git')
    runGit(base, 'init', '-q', '--bare', '-b', 'main', remote)
    runGit(root, 'remote', 'add', 'origin', remote)
    runGit(root, 'push', '-q', '-u', 'origin', 'main')
    repo.remote = remote
  }
  return repo
}

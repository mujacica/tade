import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'

// Builds REAL git repositories in tmp dirs with scripted histories.
// Never mock git: mocked git teaches you nothing about --porcelain=v2.

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Tade Test',
  GIT_AUTHOR_EMAIL: 'test@tade.invalid',
  GIT_COMMITTER_NAME: 'Tade Test',
  GIT_COMMITTER_EMAIL: 'test@tade.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

/**
 * The environment the fixture's own git runs in: an identity of its own, and
 * none of the machine's configuration.
 *
 * Exported because a test that spawns git itself has to commit in it too. The
 * identity is the fixture's rather than the machine's for the same reason the
 * config is: a Linux runner has no `user.name` at all, so a commit that falls
 * back to whatever git finds works on a laptop and fails with `empty ident
 * name` in CI — a test that passes because of how the machine it ran on
 * happened to be set up. What it is not is a repository with no identity:
 * that is a real failure path of Tade's own commands, and one they answer
 * themselves (`-c user.name=Tade`), never by borrowing this.
 */
export const gitEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...ENV, ...extra })

export function tmp(prefix = 'tade-'): string {
  // realpath: macOS tmpdir is a symlink, and git reports resolved paths.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: 'pipe' })
}

export interface TaskOptions {
  project: string
  intent?: string
  /** Write the task file verbatim instead of generating it. */
  rawTaskYaml?: string
  parked?: boolean
}

export interface Repo {
  root: string
  /**
   * Tade's home for this fixture: where task files, check runs and everything
   * else Tade writes about this project goes. Pass it as `TADE_HOME`, or as
   * `tadeHome` to anything that reads them.
   */
  home: string
  git(...args: string[]): string
  write(files: Record<string, string>, dir?: string): void
  commit(message: string, files?: Record<string, string>, dir?: string): string
  head(dir?: string): string
  /** Create `tade/<name>` as a worktree with a task.yaml. Returns the worktree path. */
  addTask(name: string, opts: TaskOptions): string
}

export function mkrepo(
  opts: { remote?: boolean; home?: string } = {},
): Repo & { remote: string | null } {
  const base = tmp('tade-repo-')
  const root = join(base, 'repo')
  mkdirSync(root)
  // No ignore rules of any kind, and none are ever added: nothing Tade writes
  // is in a checkout, so a repository Tade has worked in for a year looks
  // exactly like this one. A fixture that had to be told to ignore something
  // would be a fixture kinder than reality in the one place that used to bite.
  // One home may be shared by several fixture repositories, the way one Tade
  // home holds several projects.
  const home = opts.home ?? join(base, 'tade-home')
  mkdirSync(home, { recursive: true })
  runGit(root, 'init', '-q', '-b', 'main')

  const repo = repoAt(base, root, home)
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

/**
 * Another repository exactly like `template`, made by copying its folder
 * rather than by building it again: the same history, the same branches, the
 * same worktrees and the same task files, at a path of its own.
 *
 * For a file whose every test starts from the same repository. Building one
 * is a dozen git processes — init, the commits, a worktree each — and the
 * window's tests built one per test, 392 times: about half a second each on a
 * loaded laptop, which was the biggest part of most of those tests. A copy is
 * one: what a copied worktree and its repository point at is an absolute path,
 * the template's, so `git worktree repair` points them at each other again,
 * and the result is what `git worktree add` would have made here. Nothing is
 * left to a hand-written `.git` file, so the fixture is no kinder than one
 * built from scratch.
 *
 * The template's home must be its own (no `home` given to `mkrepo`), since a
 * shared one would be shared by every copy too, and it must have no remote,
 * which every copy would push to.
 */
export function copyRepo(template: Repo & { remote?: string | null }): Repo & {
  remote: null
} {
  const from = dirname(template.root)
  if (template.home !== join(from, 'tade-home')) {
    throw new Error('copyRepo copies a repository whose home is its own, and this one shares one')
  }
  if (template.remote) throw new Error('copyRepo copies a repository with no remote')
  const base = tmp('tade-repo-')
  cpSync(from, base, { recursive: true })
  const root = join(base, 'repo')
  const worktrees = join(base, 'worktrees')
  const moved = existsSync(worktrees)
    ? readdirSync(worktrees).map((name) => join(worktrees, name))
    : []
  if (moved.length > 0) runGit(root, 'worktree', 'repair', ...moved)
  return { ...repoAt(base, root, join(base, 'tade-home')), remote: null }
}

/** The fixture's handle on a repository already made at `root`, with its worktrees under `base`. */
function repoAt(base: string, root: string, home: string): Repo & { remote: string | null } {
  const repo: Repo & { remote: string | null } = {
    root,
    home,
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
      runGit(root, 'worktree', 'add', '-q', '-b', `tade/${name}`, path, 'main')
      // Where a task's file actually is: Tade's home, under its project —
      // never the worktree, which is only the work.
      const dir = join(home, 'projects', t.project, 'tasks', name)
      mkdirSync(dir, { recursive: true })
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
      writeFileSync(join(dir, 'task.yaml'), yaml)
      return path
    },
  }
  return repo
}

import { spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { type Config, ConfigSchema, setupLine, taskDir } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { prepareWorktree, setupBefore, setupLogPath, setupTold } from '../src/prepare.ts'
import { createTask } from '../src/tasks.ts'

// What a new worktree is given, against real repositories: the ignored files a
// project lists, brought across from its checkout, and its setup command kept
// with the task and run in the agent's lane before the agent.

/** A repository that ignores its secrets, lists them, and installs with npm. */
function project() {
  const repo = mkrepo()
  repo.commit('a project', {
    '.gitignore': '.env\n.env.local\ncerts/\n',
    '.worktreeinclude': '.env\n.env.local\ncerts/*.pem\nnotes.txt\n',
    'package.json': '{"name": "app"}',
    'package-lock.json': '{}',
  })
  repo.write({
    '.env': 'SECRET=1\n',
    'certs/local.pem': 'PEM\n',
    // Untracked but not ignored: somebody's work in progress, not the project's to hand out.
    'notes.txt': 'mine\n',
  })
  return repo
}

const task = (repo: ReturnType<typeof project>, slug: string, extra = {}) =>
  createTask({
    home: repo.home,
    project: 'app',
    root: repo.root,
    slug,
    intent: 'make it work',
    worktreeRoot: tmp('tade-worktrees-'),
    ...extra,
  })

describe('preparing a new worktree', () => {
  it('brings the ignored files the project lists, and only those', async () => {
    const repo = project()
    const made = await task(repo, 'refunds')
    expect(made.prepared?.files).toEqual(['.env', 'certs/local.pem'])
    expect(readFileSync(join(made.worktree, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(readFileSync(join(made.worktree, 'certs/local.pem'), 'utf8')).toBe('PEM\n')
    expect(existsSync(join(made.worktree, 'notes.txt'))).toBe(false)
    // A copy: changing it in the worktree leaves the checkout's alone.
    writeFileSync(join(made.worktree, '.env'), 'SECRET=2\n')
    expect(readFileSync(join(repo.root, '.env'), 'utf8')).toBe('SECRET=1\n')
    // Still ignored where it landed, so nothing brought can be committed by accident.
    expect(repo.git('-C', made.worktree, 'status', '--porcelain').trim()).toBe('')
  })

  it('keeps the setup it read in the task file, so the task keeps what it was made with', async () => {
    const repo = project()
    const made = await task(repo, 'setup')
    expect(made.prepared?.setup).toEqual({
      command: 'npm ci',
      from: 'package-lock.json',
      deadline_s: 600,
    })
    const file = parse(readFileSync(join(taskDir(repo.home, made.id), 'task.yaml'), 'utf8'))
    expect(file.setup).toEqual({ command: 'npm ci', from: 'package-lock.json', deadline_s: 600 })
  })

  it('links instead of copying, and never over a file the worktree has', async () => {
    const repo = project()
    // Tracked although ignored: added by force, the way somebody does.
    repo.write({ '.env.local': 'TRACKED\n' })
    repo.git('add', '-f', '.env.local')
    repo.git('commit', '-q', '-m', 'a tracked env.local')
    const made = await task(repo, 'links', {
      prepare: { files: ['.env', '.env.local'], link: true },
    })
    expect(made.prepared?.files).toEqual(['.env'])
    expect(lstatSync(join(made.worktree, '.env')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(made.worktree, '.env'))).toBe(join(repo.root, '.env'))
    // Tracked, so the worktree already has it; never listed, never touched.
    expect(readFileSync(join(made.worktree, '.env.local'), 'utf8')).toBe('TRACKED\n')
  })

  it('says what it could not read, and still makes the worktree', async () => {
    const repo = project()
    repo.commit('a container', {
      '.devcontainer/devcontainer.json': '{"postCreateCommand": "sudo apt-get install -y jq"}',
      'yarn.lock': '',
    })
    const made = await task(repo, 'unread')
    expect(made.prepared?.setup).toBeNull()
    expect(made.prepared?.said).toEqual([
      '.devcontainer/devcontainer.json: postCreateCommand installs a program on the machine, which a container may do and this machine is not asked to',
      'lockfiles for npm and yarn and no packageManager to say which',
    ])
    expect(existsSync(made.worktree)).toBe(true)
  })

  it('never writes through a link the worktree has into somewhere else', async () => {
    const outside = tmp('tade-outside-')
    const repo = mkrepo()
    repo.commit('ignore', { '.gitignore': 'certs/\n', '.worktreeinclude': 'certs/*.pem\n' })
    // The base commit tracks `certs` as a link out of the repository; the
    // checkout is on a branch where it is a real, ignored folder of secrets.
    repo.git('branch', 'dev')
    symlinkSync(outside, join(repo.root, 'certs'))
    repo.git('add', '-f', 'certs')
    repo.git('commit', '-q', '-m', 'a link')
    repo.git('checkout', '-q', '-f', 'dev')
    rmSync(join(repo.root, 'certs'), { force: true })
    repo.write({ 'certs/local.pem': 'PEM\n' })
    const made = await task(repo, 'escape', { base: 'main' })
    expect(made.prepared?.files).toEqual([])
    expect(made.prepared?.said).toEqual([
      'certs/local.pem would land outside the worktree through a link in it, so it was not brought',
    ])
    expect(readdirSync(outside)).toEqual([])
  })

  it('refuses more files than a worktree is given, rather than bringing some of them', async () => {
    const repo = mkrepo()
    repo.commit('ignore', { '.gitignore': 'cache/\n' })
    repo.write(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`cache/${i}.bin`, 'x'])))
    const worktree = join(tmp('tade-wt-'), 'w')
    repo.git('worktree', 'add', '-q', '--detach', worktree, 'main')
    const prepared = await prepareWorktree({
      root: repo.root,
      worktree,
      configured: { files: ['cache/'] },
    })
    expect(prepared.files).toEqual([])
    expect(prepared.said[0]).toContain('more than 200 files')
  })

  it('prepares nothing for a task in the checkout itself', async () => {
    const repo = project()
    const made = await task(repo, 'shared', { workspace: 'checkout' })
    expect(made.prepared).toBeUndefined()
  })
})

describe('the setup before a new agent', () => {
  const configOf = (root: string): Config => ConfigSchema.parse({ projects: { app: { root } } })

  it('is for a new agent only, and tells it where the output went', async () => {
    const repo = project()
    const made = await task(repo, 'first')
    const config = configOf(repo.root)
    expect(await setupBefore(repo.home, config, made.id, true)).toEqual({
      before: {
        setup: { command: 'npm ci', from: 'package-lock.json', deadline_s: 600 },
        log: setupLogPath(repo.home, made.id),
        root: repo.root,
      },
    })
    // Coming back to a conversation never prepares the worktree again.
    expect(await setupBefore(repo.home, config, made.id, false)).toEqual({})
    expect(await setupTold(repo.home, made.id)).toEqual({
      setup: { command: 'npm ci', log: setupLogPath(repo.home, made.id) },
    })
    expect(await setupBefore(repo.home, config, 'app/nobody', true)).toEqual({})
  })
})

describe('the setup line, run', () => {
  const run = (command: string, deadline_s: number, agent: string) => {
    const dir = tmp('tade-setup-')
    const log = join(dir, 'setup.log')
    const line = setupLine({
      setup: { command, from: 'a test', deadline_s },
      log,
      root: dir,
      node: process.execPath,
      line: { command: '/bin/sh', args: ['-c', agent] },
    })
    return new Promise<{ ran: { exitCode: number | null; stdout: string }; log: string }>(
      (done) => {
        const child = spawn(line.command, line.args, { cwd: dir })
        let stdout = ''
        child.stdout.on('data', (b: Buffer) => {
          stdout += b.toString()
        })
        child.on('exit', (exitCode) =>
          done({ ran: { exitCode, stdout }, log: readFileSync(log, 'utf8') }),
        )
      },
    )
  }

  it('shows the command, runs it, writes what it printed, then starts the agent', async () => {
    const { ran, log } = await run(
      'echo installing from $ROOT_WORKTREE_PATH; exit 3',
      60,
      'echo agent ran; exit 7',
    )
    // The agent is the lane's process at the end: its exit is the lane's.
    expect(ran.exitCode).toBe(7)
    const out = String(ran.stdout)
    expect(out).toContain('$ echo installing from $ROOT_WORKTREE_PATH; exit 3')
    expect(out.indexOf('installing from')).toBeLessThan(out.indexOf('agent ran'))
    expect(log).toContain('installing from /')
    expect(log).toContain('failed: exit 3; the agent starts now.')
    expect(log).not.toContain('agent ran')
  })

  it('stops the whole of a setup that runs past its deadline, and the agent starts anyway', async () => {
    const dir = tmp('tade-setup-pid-')
    const pidFile = join(dir, 'pid')
    // A child of the command, which only a group kill reaches.
    const { ran, log } = await run(`sleep 60 & echo $! > ${pidFile}; wait`, 1, 'echo agent ran')
    expect(String(ran.stdout)).toContain('agent ran')
    expect(log).toContain('stopped: it ran past 1s; the agent starts now.')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    let gone = false
    for (let i = 0; i < 50 && !gone; i++) {
      try {
        process.kill(pid, 0)
        await new Promise((r) => setTimeout(r, 100))
      } catch {
        gone = true
      }
    }
    expect(gone).toBe(true)
  })
})

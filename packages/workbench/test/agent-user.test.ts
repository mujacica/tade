import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentShare,
  ConfigSchema,
  type LaneId,
  producesPath,
  shareTask,
  taskDir,
  taskFolder,
} from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { PtyDriver } from '@tade/drivers-pty'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  type AgentUser,
  bringDocumentHome,
  closeHome,
  contextFor,
  homeOf,
  rootsOf,
  sandboxProofs,
  sandboxWrites,
  sharedDocument,
  shareReady,
} from '../src/agent-user.ts'
import { EventLog } from '../src/events.ts'
import { proveALane } from '../src/prove.ts'
import { LaneRegistry } from '../src/registry.ts'
import { Workbench } from '../src/workbench.ts'

// Agents run as a user of their own (`agents.user`). Becoming another user
// needs root to set up, so `sudo` here is a stand-in that becomes nobody new
// but is otherwise as strict as the real one: it resets the environment to
// what `--preserve-env` names and nothing else, and runs the rest as whoever
// ran it. What is left to see is everything Tade does — the line it builds,
// what crosses, what it keeps, the proof — and the container proof in
// `set-up-the-machine` is the rest.

const PATH = process.env.PATH
const UMASK = process.umask()
let bin: string

beforeAll(() => {
  bin = tmp('tade-agent-bin-')
  writeFileSync(
    join(bin, 'sudo'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const at = args.indexOf('--')
const said = args.slice(0, at).find((a) => a.startsWith('--preserve-env=')) ?? '--preserve-env='
const env = { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/', TERM: process.env.TERM ?? 'dumb' }
for (const name of said.slice('--preserve-env='.length).split(',').filter(Boolean)) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}
const [command, ...rest] = args.slice(at + 1)
process.exit(spawnSync(command, rest, { stdio: 'inherit', env }).status ?? 1)
`,
  )
  chmodSync(join(bin, 'sudo'), 0o755)
  process.env.PATH = `${bin}:${PATH}`
})

afterAll(() => {
  process.env.PATH = PATH
})

afterEach(() => {
  // A workbench whose agents run as another user narrows this process's umask.
  process.umask(UMASK)
})

describe('finding the user and its share', () => {
  it('reads a user’s home from the password file, and nobody it does not hold', async () => {
    const passwd = join(tmp('tade-agent-etc-'), 'passwd')
    writeFileSync(
      passwd,
      'root:x:0:0:root:/root:/bin/bash\ntade-agent:x:1001:1001::/home/tade-agent:/bin/bash\n',
    )
    expect(await homeOf('tade-agent', passwd)).toBe('/home/tade-agent')
    expect(await homeOf('tade-nobody-here', passwd)).toBeNull()
  })

  it('refuses a launch whose share Tade cannot write in, with what to do', async () => {
    const home = tmp('tade-agent-home-')
    const user: AgentUser = { name: 'tade-agent', home, share: agentShare(home) }
    await expect(shareReady(user)).rejects.toThrow(/tade setup makes it/)
    mkdirSync(user.share)
    await expect(shareReady(user)).resolves.toBeUndefined()
  })

  it('tries the sandbox of each harness agents start in, where it has one to prove here', () => {
    const config = ConfigSchema.parse({
      workers: {
        default: 'a',
        routes: { a: { harness: 'claude-code' }, b: { harness: 'pi' }, c: { harness: 'codex' } },
      },
    })
    const linux = sandboxProofs(config, tmp('tade-agent-home-'), 'linux')
    expect(linux.map((one) => one.harness)).toEqual(['claude-code', 'codex'])
    expect(linux[0]?.proof.args.join(' ')).toContain('bwrap')
    expect(linux[1]?.proof.args).toEqual(['sandbox', 'true'])
    // A Mac's is built in: nothing to prove.
    expect(sandboxProofs(config, tmp('tade-agent-home-'), 'darwin')).toEqual([])
  })

  it('names the roots of the projects whose agents run as that user, and no others', () => {
    const config = ConfigSchema.parse({
      agents: { user: 'tade-agent' },
      projects: {
        app: { root: '/srv/app' },
        web: { root: '/srv/web', user: 'tade-web' },
        own: { root: '/srv/own', user: 'tade' },
      },
    })
    expect(rootsOf(config, 'tade-agent', 'tade')).toEqual(['/srv/app'])
    expect(rootsOf(config, 'tade-web', 'tade')).toEqual(['/srv/web'])
  })
})

describe('what an agent of its own user is handed', () => {
  it('closes Tade’s home to everybody else, once, and never widens it', async () => {
    const home = tmp('tade-agent-home-')
    chmodSync(home, 0o755)
    expect(await closeHome(home)).toBe(true)
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(await closeHome(home)).toBe(false)
  })

  it('copies its context into its share, with the attachments it names', async () => {
    const home = tmp('tade-agent-home-')
    const share = agentShare(tmp('tade-agent-user-'))
    const task = 'app/refunds'
    const folder = taskDir(home, task)
    mkdirSync(join(folder, 'attachments'), { recursive: true })
    writeFileSync(join(folder, 'attachments', 'shot.png'), 'png')
    writeFileSync(
      join(folder, 'context.md'),
      `Read ${join(folder, 'attachments', 'shot.png')} first.\n`,
    )
    const copy = await contextFor(home, task, { name: 'tade-agent', home: '/home/x', share })
    const there = shareTask(share, taskFolder(task))
    expect(copy).toBe(join(there, 'context.md'))
    expect(readFileSync(copy ?? '', 'utf8')).toBe(
      `Read ${join(there, 'attachments', 'shot.png')} first.\n`,
    )
    expect(readFileSync(join(there, 'attachments', 'shot.png'), 'utf8')).toBe('png')
    expect(
      await contextFor(home, 'app/none', { name: 'tade-agent', home: '/home/x', share }),
    ).toBeNull()
  })

  it('brings the document it wrote in its share home, and only a name Tade would have written', async () => {
    const home = tmp('tade-agent-home-')
    const user: AgentUser = {
      name: 'tade-agent',
      home: '/home/x',
      share: agentShare(tmp('tade-agent-user-')),
    }
    const task = 'app/plan'
    expect(await bringDocumentHome(home, task, user, 'PLAN.md')).toBe(false)
    const there = sharedDocument(task, user, 'PLAN.md')
    mkdirSync(join(there, '..'), { recursive: true })
    writeFileSync(there, '# the plan\n')
    expect(await bringDocumentHome(home, task, user, 'PLAN.md')).toBe(true)
    expect(readFileSync(producesPath(home, task, 'PLAN.md'), 'utf8')).toBe('# the plan\n')
    expect(await bringDocumentHome(home, task, user, '../../escape.md')).toBe(false)
  })

  it('lets its sandbox write the repository’s git folder where the worktree’s is elsewhere', async () => {
    const repo = mkrepo()
    const user: AgentUser = { name: 'tade-agent', home: '/home/tade-agent', share: '/s' }
    const inside = await sandboxWrites(repo.root, user)
    expect(inside).toEqual([
      '/home/tade-agent/.cache',
      '/home/tade-agent/.npm',
      '/home/tade-agent/.local/share/pnpm',
    ])
    const tree = join(tmp('tade-agent-tree-'), 'wt')
    runGit(repo.root, 'worktree', 'add', '-q', '-b', 'tade/refunds', tree)
    expect((await sandboxWrites(tree, user))[0]).toBe(join(repo.root, '.git'))
  })
})

describe('a lane run as another user', () => {
  let home: string
  let log: EventLog
  let registry: LaneRegistry | null = null

  beforeAll(async () => {
    home = tmp('tade-agent-reg-')
    log = await EventLog.open({ path: join(home, 'events.jsonl') })
  })

  afterAll(async () => {
    await registry?.shutdown().catch(() => {})
    await log.close().catch(() => {})
  })

  it('goes through sudo at every launch, carries what the launch named and no key from Tade’s shell, keeps the agent’s own line, and remembers whose it is', async () => {
    process.env.TADE_TEST_EXPORTED_KEY = 'sk-from-the-shell'
    const task = 'app/refunds'
    mkdirSync(taskDir(home, task), { recursive: true })
    writeFileSync(join(taskDir(home, task), 'task.yaml'), `id: ${task}\n`)
    registry = await LaneRegistry.open({
      driver: new PtyDriver(),
      log,
      home,
      path: join(home, 'lanes.json'),
    })
    const lane = 'app/refunds/agent' as LaneId
    const record = await registry.spawn({
      id: lane,
      task,
      kind: 'agent',
      cwd: home,
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write(['umask=' + process.umask().toString(8), 'run=' + process.env.TADE_RUN_ID, 'key=' + (process.env.TADE_TEST_EXPORTED_KEY ?? 'none')].join(' ')); setTimeout(() => {}, 60000)",
      ],
      env: { TADE_RUN_ID: lane },
      user: 'tade-agent',
    })
    await until(async () => (await registry!.capture(lane, 20)).includes('umask='))
    delete process.env.TADE_TEST_EXPORTED_KEY
    // Its group's to write, nobody else's: what the agent makes, Tade can change.
    const said = await registry.capture(lane, 20)
    expect(said).toContain('umask=7')
    expect(said).toContain(`run=${lane}`)
    // A key exported where Tade runs is the way out `KEYS_AND_AGENTS` offers,
    // and it must not reach an agent kept apart from Tade's keys.
    expect(said).toContain('key=none')
    expect(record.user).toBe('tade-agent')
    expect(record.spec.command).toBe(process.execPath)
    const opened = (await log.read({ types: ['lane_opened'] })).at(-1)
    expect(opened?.detail?.command).toBe('sudo')
    expect(JSON.parse(readFileSync(join(home, 'lanes.json'), 'utf8')).lanes[0].user).toBe(
      'tade-agent',
    )
  })
})

describe('proving it', () => {
  it('passes only where the lane comes back as that user and Tade’s config stays shut', async () => {
    const home = tmp('tade-agent-prove-')
    const config = join(home, 'config.yaml')
    writeFileSync(config, 'agents:\n  user: tade-agent\n')
    const self = (await import('node:os')).userInfo().username
    const open = await proveALane({ driver: 'pty', home, cwd: home, as: { user: self, config } })
    expect(open.ok).toBe(false)
    expect(open.says).toContain(`${self} can read ${config}`)
    chmodSync(config, 0o000)
    const shut = await proveALane({ driver: 'pty', home, cwd: home, as: { user: self, config } })
    expect(shut).toMatchObject({
      ok: true,
      says: `opened a lane under pty as ${self}, which cannot read ${config}`,
    })
    const other = await proveALane({
      driver: 'pty',
      home,
      cwd: home,
      as: { user: 'tade-agent', config },
    })
    expect(other.says).toContain(`meant to run as tade-agent ran as ${self}`)
  })
})

describe('a workbench whose agents run as another user', () => {
  let bench: Workbench | null = null
  afterEach(async () => {
    await bench?.close().catch(() => {})
    bench = null
  })

  async function open(user: string) {
    const repo = mkrepo()
    const home = tmp('tade-agent-bench-')
    chmodSync(home, 0o755)
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  user: ${user}\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    bench = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    return { bench, home }
  }

  it('closes its home, and starts no agent as Tade where the user’s share is not there', async () => {
    // `nobody` is on every machine, and its home has no share in it.
    const { bench, home } = await open('nobody')
    expect(statSync(home).mode & 0o077).toBe(0)
    const closed = (await bench.events({ types: ['warning'] })).map((e) =>
      String(e.detail?.message),
    )
    expect(closed.some((said) => said.includes('closed') && said.includes(home))).toBe(true)
    const task = await bench.createTask({ project: 'app', slug: 'refunds', intent: 'fix it' })
    await expect(
      bench.startAgent({ task: task.id, cwd: task.worktree, prompt: 'go' }),
    ).rejects.toThrow(/run as nobody, and .*tade-share is not there for Tade to write in/)
    expect(bench.lanes()).toEqual([])
  }, 60_000)

  it('starts no agent as Tade where the user named is not on this machine', async () => {
    const { bench } = await open('tade-nobody-here')
    const task = await bench.createTask({ project: 'app', slug: 'refunds', intent: 'fix it' })
    await expect(
      bench.startAgent({ task: task.id, cwd: task.worktree, prompt: 'go' }),
    ).rejects.toThrow(/there is no user tade-nobody-here here: tade setup makes one/)
  }, 60_000)
})

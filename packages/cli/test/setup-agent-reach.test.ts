import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { join } from 'node:path'
import type { Ui } from '@tade/app'
import {
  AGENT_USER,
  type AgentUserSeen,
  agentAccountDir,
  agentReachTrouble,
  ConfigSchema,
  GITHUB_HOST_KEYS,
  PUSH_TRIED,
} from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { lookAtReach } from '@tade/workbench/agent-user'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { gitEnv, mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import { offerPush, setUpReach } from '../src/commands/setup-agent-reach.ts'

// What an agent user's agents need besides the user: each sign-in, run as that
// user in front of the person and asked again after, and a key of its own to
// push with, its public half shown with where it goes. Becoming another user
// needs root, so `sudo` here becomes nobody new — it gives the command that
// user's home and only the environment `--preserve-env` names, as the real
// one's reset does — and `claude` answers `auth status` by whether a folder
// was signed in, so no real harness is asked about a real home.

const PATH = process.env.PATH
let bin: string
let userHome: string
let home: string
const before = process.env.TADE_HOME

beforeAll(() => {
  bin = tmp('tade-reach-bin-')
  writeFileSync(
    join(bin, 'sudo'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const env = { PATH: '/usr/bin:/bin', HOME: process.env.TADE_TEST_USER_HOME, TERM: 'dumb' }
let i = 0
for (; i < args.length; i++) {
  const a = args[i]
  if (a === '--') { i++; break }
  if (a === '-u') { i++; continue }
  if (a.startsWith('--preserve-env=')) {
    for (const name of a.slice(15).split(',')) if (process.env[name] !== undefined) env[name] = process.env[name]
    continue
  }
  if (!a.startsWith('-')) break
}
const [command, ...rest] = args.slice(i)
process.exit(spawnSync(command, rest, { stdio: 'inherit', env }).status ?? 1)
`,
  )
  chmodSync(join(bin, 'sudo'), 0o755)
  writeFileSync(
    join(bin, 'claude'),
    '#!/bin/sh\ndir=$CLAUDE_CONFIG_DIR\n[ -n "$dir" ] || dir=$HOME/.claude\n[ "$1 $2" = "auth status" ] && [ -f "$dir/signed-in" ]\n',
  )
  chmodSync(join(bin, 'claude'), 0o755)
  process.env.PATH = `${bin}:${PATH}`
})

afterAll(() => {
  process.env.PATH = PATH
})

beforeEach(() => {
  home = tmp('tade-reach-home-')
  userHome = tmp('tade-reach-user-')
  process.env.TADE_HOME = home
  process.env.TADE_TEST_USER_HOME = userHome
})

afterEach(() => {
  if (before === undefined) delete process.env.TADE_HOME
  else process.env.TADE_HOME = before
  delete process.env.TADE_TEST_USER_HOME
})

/**
 * A person at the keyboard: says yes to everything, really runs what makes
 * things, and does the sign-ins themselves — the one thing a test cannot — by
 * leaving behind what the harness would. Trying a remote is answered `tries`.
 */
function person(tries = 1): Ui & { said: string[]; ran: string[] } {
  const said: string[] = []
  const ran: string[] = []
  return {
    said,
    ran,
    say: (text: string) => said.push(text),
    context: () => {},
    ask: async (_q: string, fallback = '') => fallback,
    confirm: async () => true,
    choose: async () => 0,
    pause: async () => {},
    async run(_title: string, _command: string, args: string[]) {
      const line = args[1] ?? ''
      ran.push(line)
      if (line.includes(' push --dry-run ')) return tries
      if (line.includes('auth login')) {
        const folder = /CLAUDE_CONFIG_DIR=(\S+)/.exec(line)?.[1] ?? join(userHome, '.claude')
        mkdirSync(folder, { recursive: true })
        writeFileSync(join(folder, 'signed-in'), '')
        return 0
      }
      return spawnSync('/bin/sh', ['-c', line], { stdio: 'ignore' }).status ?? 1
    },
  }
}

const seen = (): AgentUserSeen => ({
  user: AGENT_USER,
  home: userHome,
  inGroup: true,
  groupHeld: true,
  sudo: true,
  share: true,
  git: true,
  homeClosed: true,
  roots: [],
  sandboxes: [],
})

describe('signing an agent user in, and giving it a key', () => {
  it('makes what it needs as that user, signs each in on a press, and asks each again after', async () => {
    const repo = mkrepo()
    const origin = join(tmp('tade-reach-gone-'), 'nowhere.git')
    runGit(repo.root, 'remote', 'add', 'origin', origin)
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'workers:',
        '  routes:',
        '    default:',
        '      harness: claude-code',
        'accounts:',
        '  work:',
        '    harness: claude-code',
        'agents:',
        `  user: ${AGENT_USER}`,
        'projects:',
        '  app:',
        `    root: ${repo.root}`,
        '',
      ].join('\n'),
    )
    const ui = person()
    await setUpReach(ui, seen(), 'tade')
    const said = ui.said.join('\n')
    // The account's folder and the key, made as that user, in its home.
    expect(existsSync(agentAccountDir(userHome, 'work'))).toBe(true)
    expect(existsSync(join(userHome, '.ssh', 'id_ed25519.pub'))).toBe(true)
    // Each sign-in through that user's own login, said before it ran.
    const signIns = ui.ran.filter((line) => line.includes('auth login'))
    expect(signIns).toEqual([
      `sudo -iu ${AGENT_USER} ${join(bin, 'claude')} auth login --claudeai`,
      `sudo -iu ${AGENT_USER} env CLAUDE_CONFIG_DIR=${agentAccountDir(userHome, 'work')} ${join(bin, 'claude')} auth login --claudeai`,
    ])
    expect(ui.ran.every((line) => ui.said.some((one) => one.includes(line)))).toBe(true)
    expect(said).toContain(`${AGENT_USER} is signed in to claude-code\n`)
    expect(said).toContain(`${AGENT_USER} is signed in to claude-code's account work`)
    // The key's public half shown, and the remote tried in front of the person.
    expect(said).toContain('ssh-ed25519 ')
    expect(ui.ran.at(-1)).toBe(
      `sudo -iu ${AGENT_USER} git -C ${repo.root} push --dry-run --no-verify ${origin} '${PUSH_TRIED}'`,
    )
    expect(said).toContain(`${AGENT_USER} cannot push to ${origin} yet`)
  }, 60_000)

  it('says a sign-in that did not take, rather than ticking it', async () => {
    writeFileSync(
      join(home, 'config.yaml'),
      'workers:\n  routes:\n    default:\n      harness: claude-code\n',
    )
    const ui = person()
    ui.run = async (_t, _c, args) => {
      ui.ran.push(args[1] ?? '')
      return 0
    }
    await setUpReach(ui, seen(), 'tade')
    expect(ui.said.join('\n')).toContain(
      `${AGENT_USER} is still not signed in to claude-code: run the line above yourself`,
    )
  }, 60_000)

  it('waits for a user Tade cannot become yet, and asks nothing', async () => {
    const ui = person()
    await setUpReach(ui, { ...seen(), sudo: false }, 'tade')
    expect(ui.ran).toEqual([])
    expect(ui.said.join('\n')).toContain('wait until tade can run things as it')
  })

  it('shows GitHub’s own pages for the key, and where ssh will ask, before trying', async () => {
    const ui = person(0)
    await offerPush(ui, AGENT_USER, 'ssh-ed25519 AAAA tade-agent@box', [
      {
        root: '/srv/app',
        url: 'git@github.com:acme/app.git',
        repository: 'github.com/acme/app',
        reached: false,
        problem: 'Permission denied (publickey).',
      },
      {
        root: '/srv/lib',
        url: 'git@git.example.org:acme/lib.git',
        repository: 'git.example.org/acme/lib',
        reached: false,
        problem: 'Permission denied (publickey).',
      },
    ])
    const said = ui.said.join('\n')
    expect(said).toContain('ssh-ed25519 AAAA tade-agent@box')
    expect(said).toContain('https://github.com/settings/ssh/new')
    expect(said).toContain('github.com/acme/app: https://github.com/acme/app/settings/keys/new')
    expect(said).toContain('git.example.org/acme/lib: wherever its forge takes an SSH key')
    expect(said).toContain(GITHUB_HOST_KEYS)
    expect(ui.ran).toEqual([
      `sudo -iu ${AGENT_USER} git -C /srv/app push --dry-run --no-verify git@github.com:acme/app.git '${PUSH_TRIED}'`,
      `sudo -iu ${AGENT_USER} git -C /srv/lib push --dry-run --no-verify git@git.example.org:acme/lib.git '${PUSH_TRIED}'`,
    ])
    expect(said).toContain(`${AGENT_USER} can push to github.com/acme/app`)
  })

  it('takes a remote it may read and not write for one it cannot push to, and sends nothing to one it may', async () => {
    // `git daemon` serves reads and refuses every push, as a forge refuses a
    // read-only deploy key — or any key on a public repository it may not
    // write to: `git ls-remote` gets through, and a push does not.
    const served = tmp('tade-reach-served-')
    const seed = mkrepo()
    runGit(seed.root, 'commit', '-q', '--allow-empty', '-m', 'first')
    runGit(seed.root, 'clone', '-q', '--bare', seed.root, join(served, 'app.git'))
    const port = await freePort()
    const daemon = spawn(
      'git',
      [
        'daemon',
        '--reuseaddr',
        '--listen=127.0.0.1',
        `--port=${port}`,
        `--base-path=${served}`,
        '--export-all',
        served,
      ],
      { stdio: 'ignore', env: gitEnv() },
    )
    try {
      const readOnly = `git://127.0.0.1:${port}/app.git`
      const read = () => spawnSync('git', ['ls-remote', readOnly, 'HEAD'], { env: gitEnv() })
      await until(() => read().status === 0, { timeout: 15_000 })
      const app = mkrepo()
      runGit(app.root, 'remote', 'add', 'origin', readOnly)
      // One it may write to, whose project refuses every push in its own
      // `pre-push` — which a dry run runs too, and which is not the forge's answer.
      const writable = join(served, 'lib.git')
      runGit(seed.root, 'clone', '-q', '--bare', seed.root, writable)
      const lib = mkrepo()
      runGit(lib.root, 'remote', 'add', 'origin', writable)
      const hooks = join(lib.root, '.git', 'hooks')
      mkdirSync(hooks, { recursive: true })
      writeFileSync(
        join(hooks, 'pre-push'),
        `#!/bin/sh
touch "${join(lib.root, 'hook-ran')}"
exit 1
`,
      )
      chmodSync(join(hooks, 'pre-push'), 0o755)
      const refs = runGit(writable, 'for-each-ref')
      const config = ConfigSchema.parse({
        agents: { user: AGENT_USER },
        projects: { app: { root: app.root }, lib: { root: lib.root } },
      })
      mkdirSync(join(userHome, '.ssh'))
      writeFileSync(join(userHome, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA tade-agent@box\n')
      const { push } = await lookAtReach(seen(), config, 'tade')
      const [refused, pushed] = push?.remotes ?? []
      expect(refused).toMatchObject({ root: app.root, url: readOnly, reached: false })
      expect(refused?.problem).toContain('access denied')
      expect(pushed).toMatchObject({ root: lib.root, url: writable, reached: true, problem: null })
      expect(runGit(writable, 'for-each-ref')).toBe(refs)
      expect(existsSync(join(lib.root, 'hook-ran'))).toBe(false)
      expect(agentReachTrouble({ ...seen(), push })).toEqual([
        `${AGENT_USER} cannot push to ${refused?.repository ?? readOnly} with its own key: ${refused?.problem}`,
      ])
    } finally {
      daemon.kill()
    }
  }, 60_000)
})

/** A port nothing listens on, as the kernel hands one out. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

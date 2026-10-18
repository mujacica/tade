import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_USER,
  type AgentRemote,
  type AgentUserSeen,
  agentAccountDir,
  agentCommands,
  agentReachTrouble,
  agentShare,
  agentsKeptAs,
  agentsKeptOut,
  agentUserOf,
  agentUsers,
  agentUserTrouble,
  asAgent,
  keyPages,
  lsRemoteLine,
  reachCommands,
  SUDO,
  signInLine,
  sshRemote,
  sudoersRule,
  triedAt,
} from '../src/agent-user.ts'
import { ConfigSchema } from '../src/config.ts'
import { settingReach } from '../src/reach.ts'
import { readiness } from '../src/readiness.ts'
import { KEYS_AND_AGENTS, keysKeptFromAgents, SEEN_BY_AGENTS } from '../src/secrets.ts'
import { settingsOf } from '../src/settings.ts'

const config = (raw: Record<string, unknown>) => ConfigSchema.parse(raw)

/** Everything done, for a user, so each test takes one fact away. */
const made = (over: Partial<AgentUserSeen> = {}): AgentUserSeen => ({
  user: AGENT_USER,
  home: `/home/${AGENT_USER}`,
  inGroup: true,
  groupHeld: true,
  sudo: true,
  share: true,
  git: true,
  homeClosed: true,
  roots: [],
  sandboxes: [],
  ...over,
})

describe('who a project’s agents run as', () => {
  it('is the project’s user over the machine’s, and nobody where neither says', () => {
    const both = config({
      agents: { user: 'tade-agent' },
      projects: { app: { root: '/src/app', user: 'tade-app' }, web: { root: '/src/web' } },
    })
    expect(agentUserOf(both, 'app', 'tade')).toBe('tade-app')
    expect(agentUserOf(both, 'web', 'tade')).toBe('tade-agent')
    expect(agentUserOf(config({}), 'web', 'tade')).toBeNull()
    expect(agentUsers(both, 'tade')).toEqual(['tade-agent', 'tade-app'])
  })

  it('reads Tade’s own user as nobody, since becoming who it already is changes nothing', () => {
    const own = config({ agents: { user: 'tade' }, projects: { app: { root: '/a' } } })
    expect(agentUserOf(own, 'app', 'tade')).toBeNull()
    expect(agentUsers(own, 'tade')).toEqual([])
  })

  it('says every agent is kept out only where none of them runs as Tade', () => {
    const apart = config({ agents: { user: 'tade-agent' }, projects: { app: { root: '/a' } } })
    expect(agentsKeptOut(apart, 'tade')).toBe(true)
    expect(agentsKeptAs(apart, 'tade')).toBe('tade-agent')
    // One project back on Tade's own user is every key readable again.
    const one = config({
      agents: { user: 'tade-agent' },
      projects: { app: { root: '/a', user: 'tade' } },
    })
    expect(agentsKeptOut(one, 'tade')).toBe(false)
    expect(agentsKeptAs(one, 'tade')).toBeNull()
    // A project of its own is still kept out, and the sentence says users.
    const each = config({
      agents: { user: 'tade-agent' },
      projects: { app: { root: '/a', user: 'tade-app' } },
    })
    expect(agentsKeptAs(each, 'tade')).toBe('users of their own')
    // Only projects naming users, and none for the machine: a project opened
    // tomorrow would run as Tade, so nothing is promised.
    const loose = config({ projects: { app: { root: '/a', user: 'tade-app' } } })
    expect(agentsKeptOut(loose, 'tade')).toBe(false)
  })

  it('refuses a name that could be read as anything but one word', () => {
    for (const bad of ['Tade', 'tade agent', 'tade;rm', '-tade', '', 'a'.repeat(33)]) {
      expect(ConfigSchema.safeParse({ agents: { user: bad } }).success, bad).toBe(false)
    }
    expect(() => asAgent({ command: 'x', args: [] }, 'tade;rm', [], '/bin')).toThrow(
      /not a user name/,
    )
  })

  it('is a person’s to set, never the orchestrator’s, and stays on this machine', () => {
    expect(settingReach('agents.user').reach).toBe('never')
    expect(settingReach('projects.app.user').reach).toBe('never')
  })
})

describe('the launch, as another user', () => {
  it('goes through sudo that never asks, carries named variables and none of their values', () => {
    const line = asAgent(
      { command: '/usr/bin/node', args: ['pi', '--session-id', 'x'] },
      'tade-agent',
      ['TADE_RUN_SOCKET', 'TADE_RUN_ID', 'not a name', 'TADE_RUN_ID'],
      '/opt/node/bin:/usr/bin',
    )
    expect(line.command).toBe(SUDO)
    const dashes = line.args.indexOf('--')
    expect(line.args.slice(0, dashes)).toEqual([
      '-n',
      '-H',
      '-u',
      'tade-agent',
      '--preserve-env=TADE_RUN_SOCKET,TADE_RUN_ID',
    ])
    expect(line.args.slice(-4)).toEqual(['/usr/bin/node', 'pi', '--session-id', 'x'])
    expect(line.args.join(' ')).not.toContain('/tmp/s.sock')
  })

  it('runs the agent with a umask that keeps what it makes its group’s, on the PATH it was handed', () => {
    // A stand-in `sudo` that becomes nobody new: it drops its own flags up to
    // `--` and runs the rest, so what is left to see is the script after it.
    const dir = mkdtempSync(join(tmpdir(), 'tade-agent-user-'))
    const sudo = join(dir, 'sudo')
    writeFileSync(sudo, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n')
    chmodSync(sudo, 0o755)
    const line = asAgent(
      { command: '/bin/sh', args: ['-c', 'umask; echo "$PATH"; echo "$TADE_SEEN"'] },
      'tade-agent',
      ['TADE_SEEN'],
      '/opt/somewhere/bin:/usr/bin:/bin',
    )
    const ran = spawnSync(sudo, line.args, {
      env: { PATH: '/usr/bin:/bin', TADE_SEEN: 'carried' },
      encoding: 'utf8',
    })
    expect(ran.status).toBe(0)
    const [umask, path, seen] = ran.stdout.trim().split('\n')
    expect(umask).toMatch(/^0*07$/)
    expect(path).toBe('/opt/somewhere/bin:/usr/bin:/bin')
    expect(seen).toBe('carried')
  })
})

describe('making the user, on a press', () => {
  it('says every command a machine with nothing needs, in the order they have to run', () => {
    const commands = agentCommands(
      made({
        home: null,
        inGroup: false,
        groupHeld: false,
        sudo: false,
        share: false,
        git: false,
        roots: ['/srv/app'],
      }),
      'tade',
      { name: 'Ada Lovelace', email: 'ada@example.com' },
    )
    const lines = commands.map((c) => c.line)
    expect(lines[0]).toBe(
      'sudo useradd --create-home --user-group --shell /bin/bash tade-agent && sudo chmod 0750 /home/tade-agent',
    )
    expect(lines[1]).toBe('sudo usermod --append --groups tade-agent tade')
    expect(lines[2]).toContain(
      'sudo visudo -cf "$t" && sudo install -m 0440 -o root -g root "$t" /etc/sudoers.d/tade-tade-agent',
    )
    expect(lines[3]).toBe(
      `sudo install -d -o tade-agent -g tade-agent -m 2770 ${agentShare('/home/tade-agent')}`,
    )
    // Run through a shell with a `sudo` that drops its flags and a `git` that
    // says what it was handed: the quoting has to come out as these words.
    const bin = mkdtempSync(join(tmpdir(), 'tade-agent-git-'))
    writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nwhile [ "$1" != sh ]; do shift; done\nexec "$@"\n')
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf "%s|" "$@"; echo\n')
    chmodSync(join(bin, 'sudo'), 0o755)
    chmodSync(join(bin, 'git'), 0o755)
    // Run from a folder the agent's user may not enter, as setup's terminal is.
    const git = spawnSync('/bin/sh', ['-c', lines[4] ?? ''], {
      cwd: '/',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin },
      encoding: 'utf8',
    })
    expect(git.stdout.trim().split('\n')).toEqual([
      'config|--global|user.name|Ada Lovelace|',
      'config|--global|user.email|ada@example.com|',
      'config|--global|--add|safe.directory|*|',
    ])
    expect(lines[5]).toContain('git -C /srv/app config core.sharedRepository group')
    for (const command of commands) expect(command.says.trim()).not.toBe('')
  })

  it('puts exactly the rule where sudo reads it, after visudo has passed it', () => {
    const visudo = ['/usr/sbin/visudo', '/usr/bin/visudo'].find((path) => existsSync(path))
    if (!visudo) return
    const [line] = agentCommands(made({ sudo: false }), 'tade', { name: null, email: null }).map(
      (c) => c.line,
    )
    // `sudo` runs what it is handed as you, `install` says what it would put
    // where: the real `visudo` is what decides whether it gets that far.
    const bin = mkdtempSync(join(tmpdir(), 'tade-agent-sudoers-'))
    writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n')
    writeFileSync(join(bin, 'visudo'), `#!/bin/sh\nexec ${visudo} "$@"\n`)
    writeFileSync(
      join(bin, 'install'),
      '#!/bin/sh\nfor a; do last="$a"; done\necho "to $last"; for a; do case "$a" in /*tmp*) cat "$a";; esac; done\n',
    )
    for (const name of ['sudo', 'visudo', 'install']) chmodSync(join(bin, name), 0o755)
    const ran = spawnSync('/bin/sh', ['-c', line ?? ''], {
      env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: mkdtempSync(join(tmpdir(), 'tade-agent-t-')) },
      encoding: 'utf8',
    })
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.stdout).toContain('to /etc/sudoers.d/tade-tade-agent')
    expect(ran.stdout).toContain(`${sudoersRule('tade', 'tade-agent')}\n`)
  })

  it('says nothing for a user with nothing left to do', () => {
    expect(agentCommands(made(), 'tade', { name: null, email: null })).toEqual([])
    expect(agentUserTrouble(made(), 'tade')).toEqual([])
  })

  it('writes a rule visudo accepts, letting Tade become the agent and nothing else', () => {
    const rule = sudoersRule('tade', 'tade-agent')
    expect(rule).toBe('tade ALL=(tade-agent) NOPASSWD:SETENV: ALL')
    const visudo = ['/usr/sbin/visudo', '/usr/bin/visudo'].find((path) => existsSync(path))
    if (!visudo) return
    const file = join(mkdtempSync(join(tmpdir(), 'tade-agent-rule-')), 'rule')
    writeFileSync(file, `${rule}\n`)
    const checked = spawnSync(visudo, ['-cf', file], { encoding: 'utf8' })
    expect(checked.status, checked.stderr).toBe(0)
  })

  it('says a harness whose own sandbox will not start as that user, with what it needs', () => {
    const boxed = made({
      sandboxes: [
        { harness: 'claude-code', needs: 'bubblewrap and socat' },
        { harness: 'codex', needs: null },
      ],
    })
    expect(agentUserTrouble(boxed, 'tade')).toEqual([
      "claude-code's own sandbox will not start as tade-agent here: it needs bubblewrap and socat",
    ])
  })

  it('says a group not yet held as a login away, not as missing', () => {
    expect(agentUserTrouble(made({ groupHeld: false }), 'tade')).toEqual([
      "tade is in tade-agent's group from a new login: log in again — and where Tade runs as a service, restart the service manager it takes its groups from, `sudo systemctl restart user@$(id -u).service`, which stops every service of yours, or log out of every session",
    ])
  })
})

describe('signing in and pushing, as that user', () => {
  const work = agentAccountDir('/home/tade-agent', 'work')
  const signIn = (over: Record<string, unknown> = {}) => ({
    harness: 'claude-code',
    account: null,
    folder: null,
    signedIn: true,
    problem: null,
    launch: { command: '/usr/local/bin/claude', args: ['auth', 'login', '--claudeai'], env: {} },
    how: 'Claude Code prints a link',
    ...over,
  })
  const remote = (over: Partial<AgentRemote> = {}): AgentRemote => ({
    root: '/srv/app',
    url: 'git@github.com:acme/app.git',
    repository: 'github.com/acme/app',
    reached: true,
    problem: null,
    ...over,
  })

  it('signs in through that user’s own login, naming only the folder an account is kept in', () => {
    expect(signInLine('tade-agent', signIn().launch)).toBe(
      'sudo -iu tade-agent /usr/local/bin/claude auth login --claudeai',
    )
    expect(
      signInLine('tade-agent', {
        command: 'codex',
        args: ['login', '--device-auth'],
        env: { CODEX_HOME: '/home/tade agent/tade-accounts/work' },
      }),
    ).toBe(
      "sudo -iu tade-agent env CODEX_HOME='/home/tade agent/tade-accounts/work' codex login --device-auth",
    )
    expect(() => signInLine('tade agent; rm -rf /', signIn().launch)).toThrow('not a user name')
  })

  it('says each sign-in still to do, and one it could not ask about as that, never as signed out', () => {
    const seen = made({
      signIns: [
        signIn({ signedIn: false }),
        signIn({ account: 'work', folder: { path: work, made: true }, signedIn: false }),
        signIn({ harness: 'codex', signedIn: null, problem: 'codex cannot be run as tade-agent' }),
        signIn({ harness: 'pi' }),
      ],
      push: { key: 'ssh-ed25519 AAAA', remotes: [remote()] },
    })
    expect(agentUserTrouble(seen, 'tade')).toEqual([
      'tade-agent is not signed in to claude-code',
      "tade-agent is not signed in to claude-code's account work",
      'cannot tell whether tade-agent is signed in to codex: codex cannot be run as tade-agent',
    ])
  })

  it('makes an account’s folder as that user only where it is not made, and nothing as a user Tade cannot become', () => {
    const seen = made({
      signIns: [
        signIn({ account: 'work', folder: { path: work, made: false } }),
        signIn({
          account: 'home',
          folder: { path: agentAccountDir('/home/tade-agent', 'home'), made: true },
        }),
      ],
    })
    expect(reachCommands(seen).map((c) => c.line)).toEqual([
      `sudo -u tade-agent -H sh -c 'mkdir -p -m 0750 /home/tade-agent/tade-accounts && mkdir -p -m 0700 ${work}'`,
    ])
    expect(reachCommands({ ...seen, sudo: false })).toEqual([])
  })

  it('makes it a key of its own only where it has none and cannot reach every remote, and sends https pushes over SSH', () => {
    const none = made({
      push: {
        key: null,
        remotes: [
          remote({ reached: false, problem: 'Permission denied (publickey).' }),
          remote({
            root: '/srv/web',
            url: 'https://github.com/acme/web.git',
            repository: 'github.com/acme/web',
          }),
          remote({
            root: '/srv/api',
            url: 'https://github.com/acme/api',
            repository: 'github.com/acme/api',
          }),
        ],
      },
    })
    const lines = reachCommands(none).map((c) => c.line)
    expect(lines).toEqual([
      `sudo -u tade-agent -H sh -c 'cd && mkdir -p -m 0700 .ssh && ssh-keygen -q -t ed25519 -N "" -f .ssh/id_ed25519'`,
      `sudo -u tade-agent -H sh -c 'cd && git config --global --add url.git@github.com:.pushInsteadOf https://github.com/'`,
    ])
    expect(agentReachTrouble(none)).toEqual([
      'tade-agent has no key of its own to push with',
      'tade-agent cannot reach github.com/acme/app with its own key: Permission denied (publickey).',
      "tade-agent's pushes to github.com/acme/web go over https, where it has nothing to sign in with",
      "tade-agent's pushes to github.com/acme/api go over https, where it has nothing to sign in with",
    ])
    // A key it already pushes with, by whatever name, is not replaced.
    expect(reachCommands(made({ push: { key: null, remotes: [remote()] } }))).toEqual([])
    expect(
      agentReachTrouble(made({ push: { key: 'ssh-ed25519 AAAA', remotes: [remote()] } })),
    ).toEqual([])
  })

  it('makes the key it says, where it says, when the line is run', () => {
    const keygen = ['/usr/bin/ssh-keygen', '/bin/ssh-keygen'].find((path) => existsSync(path))
    if (!keygen) return
    const line = reachCommands(made({ push: { key: null, remotes: [] } }))[0]?.line ?? ''
    // A sudo that becomes nobody new, and runs the rest in this test's home.
    const bin = mkdtempSync(join(tmpdir(), 'tade-agent-bin-'))
    const home = mkdtempSync(join(tmpdir(), 'tade-agent-home-'))
    writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nwhile [ "$1" != sh ]; do shift; done\nexec "$@"\n')
    chmodSync(join(bin, 'sudo'), 0o755)
    const ran = spawnSync('/bin/sh', ['-c', line], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
    })
    expect(ran.status, ran.stderr).toBe(0)
    expect(existsSync(join(home, '.ssh', 'id_ed25519.pub'))).toBe(true)
  })

  it('tries a remote where its pushes go, over SSH, and shows the person GitHub’s pages for its key', () => {
    expect(sshRemote('github.com/acme/app')).toBe('git@github.com:acme/app.git')
    expect(triedAt(remote({ url: 'https://github.com/acme/app.git' }))).toBe(
      'git@github.com:acme/app.git',
    )
    expect(triedAt(remote({ url: 'ssh://git@example.org/x.git', repository: null }))).toBe(
      'ssh://git@example.org/x.git',
    )
    expect(lsRemoteLine('tade-agent', remote())).toBe(
      'sudo -iu tade-agent git ls-remote git@github.com:acme/app.git HEAD',
    )
    expect(keyPages('github.com/acme/app')).toEqual({
      account: 'https://github.com/settings/ssh/new',
      deploy: 'https://github.com/acme/app/settings/keys/new',
    })
    expect(keyPages('gitlab.com/acme/app')).toBeNull()
  })
})

describe('what is said about keys, where somebody is deciding', () => {
  const secret = [
    { path: 'extensions.jev.key', title: 'Key', value: '', from: null, means: '', placeholder: '' },
  ]

  it('is the first sentence where agents run as you, and the second where none can', () => {
    const asYou = settingsOf(config({}), secret)
    expect(asYou.find((g) => g.id === 'credentials')?.about).toContain(KEYS_AND_AGENTS)
    expect(asYou.find((g) => g.id === 'agents')?.keys).toBe(KEYS_AND_AGENTS)
    const apart = settingsOf(config({ agents: { user: 'tade-agent' } }), secret, {}, null, 'tade')
    const keys = apart.find((g) => g.id === 'credentials')
    expect(keys?.about).toContain(keysKeptFromAgents('tade-agent'))
    expect(keys?.settings[0]?.means).not.toContain(SEEN_BY_AGENTS)
    expect(keysKeptFromAgents('tade-agent')).toContain('its own harness’s sign-in')
  })

  it('has a row for it, which says what it does not fix', () => {
    const row = settingsOf(config({}))
      .flatMap((g) => g.settings)
      .find((s) => s.path === 'agents.user')
    expect(row?.means).toContain('its own harness’s sign-in')
    expect(row?.fallback).toBe('you')
  })

  it('offers the step on a server, and says what is left of a user that is half made', () => {
    const base = {
      configExists: true,
      projects: ['app'],
      cwd: '/src/app',
      cwdIsRepo: true,
      loggedIn: true,
      apiKeys: [],
      orchestratorModel: null,
      driver: 'tmux',
      driverOk: true,
      driverReason: null,
      driverChosen: true,
      talkChosen: true,
      micOk: true,
      speechOk: true,
      speechReason: null,
      judgeKey: true,
      judgeChosen: true,
    }
    const none = readiness({ ...base, agents: { self: 'tade', seen: [] } }).find(
      (s) => s.id === 'agents',
    )
    expect(none?.done).toBe(false)
    expect(none?.required).toBe(false)
    expect(none?.detail).toContain(AGENT_USER)
    const half = readiness({ ...base, agents: { self: 'tade', seen: [made({ sudo: false })] } })
    expect(half.find((s) => s.id === 'agents')?.detail).toBe(
      'tade cannot run things as tade-agent without a password',
    )
    expect(readiness(base).some((s) => s.id === 'agents')).toBe(false)
    // A look that could not be made is said, never read as nothing to do.
    const blind = readiness({ ...base, agents: { self: 'tade', seen: [], problem: 'EIO' } })
    expect(blind.find((s) => s.id === 'agents')).toMatchObject({
      done: false,
      detail: 'could not look: EIO',
    })
  })
})

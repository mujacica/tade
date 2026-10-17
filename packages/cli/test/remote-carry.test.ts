import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, personaDirs, writeSetting } from '@tade/core'
import type { LinkOptions, RemoteLink } from '@tade/remotes-core'
import { type FarEnd, startFarEnd } from '@tade/remotes-core/far'
import { readDevices } from '@tade/web'
import { readJournal } from '@tade/workbench/events'
import { lockHome } from '@tade/workbench/lock'
import { REMOTE_LINKS } from '@tade/workbench/remotes'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  type Asking,
  addRemote,
  carryRemote,
  type Place,
  ttyAsking,
} from '../src/commands/remote-guide.ts'

// `tade remote add` as the guided way a remote is set up, against a fresh far
// end — a real away view in a home of its own, reached by the scripted link —
// so what is held is what lands there: this machine's preferences, personas and
// templates carried, its keys only on a press, each machine's own never, and
// nothing anywhere that a harness signed in with.

const TOKEN = 'sk-ant-oat01-NEVER-LEAVES-THIS-MACHINE'
const JEV_KEY = 'jev-0123456789abcdef0123'

/** The scripted link, from the registry, with a table of far ends it reaches. */
interface Identity {
  fingerprints: readonly string[]
  known: 'known' | 'new' | 'changed'
}
const makeScriptedLink = REMOTE_LINKS.scripted as unknown as (
  options: LinkOptions & { remotes: ReadonlyMap<string, FarEnd & { identity: Identity }> },
) => RemoteLink

const PERSONA = `---
persona: reviewer
title: Reviewer
done: said
---

Read the change before you say anything about it.
`

describe('tade remote add, carrying this machine’s setup', () => {
  let home: string
  let far: FarEnd
  let identity: Identity
  let out: string[]
  let err: string[]
  let exit: number
  let sent: unknown[]
  let answers: { asked: string; yes: boolean }[]

  const asking = (answer: (question: string) => boolean | null): Asking => ({
    interactive: true,
    ask: async (question) => {
      const yes = answer(question) ?? false
      answers.push({ asked: question, yes })
      return yes
    },
    run: async () => 0,
  })
  const nobody: Asking = { interactive: false, ask: async () => false, run: async () => 0 }

  const place = (ask: Asking = nobody, over: Partial<RemoteLink> = {}): Place => {
    const link = makeScriptedLink({
      home,
      remotes: new Map([['far', Object.assign(far, { identity })]]),
    })
    // Every body this machine sends there, as sent.
    const recording: RemoteLink = Object.assign(Object.create(link) as RemoteLink, {
      call: (remote: Parameters<RemoteLink['call']>[0], path: string, body: unknown) => {
        sent.push(body)
        return link.call(remote, path, body)
      },
      ...over,
    })
    return {
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
      setExit: (code) => {
        exit = code
      },
      home,
      configPath: join(home, 'config.yaml'),
      linkFor: () => recording,
      asking: ask,
      now: Date.now,
    }
  }
  const there = async () => {
    const loaded = await loadConfig(join(far.home, 'config.yaml'))
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues))
    return loaded.config
  }
  const add = (ask?: Asking, more: Record<string, unknown> = {}, over: Partial<RemoteLink> = {}) =>
    addRemote(place(ask, over), 'vps', { ssh: 'far', tade: 'tade', label: 'mac', ...more })

  beforeEach(async () => {
    home = tmp('tade-carry-home-')
    far = await startFarEnd()
    far.signIns = [
      { harness: 'claude-code', account: null, signedIn: false, until: null, problem: null },
      {
        harness: 'codex',
        account: null,
        signedIn: true,
        until: Date.now() + 20 * 86_400_000,
        problem: null,
      },
    ]
    identity = { fingerprints: ['ED25519 SHA256:far'], known: 'known' }
    out = []
    err = []
    exit = 0
    sent = []
    answers = []
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'agents:',
        '  commit: as-you-go',
        '  workspace: worktree',
        'approvals:',
        '  auto_allow: [read]',
        'orchestrator:',
        '  harness: claude-code',
        'workers:',
        '  routes:',
        '    default:',
        '      harness: codex',
        'surfaces:',
        '  voice:',
        '    attention:',
        "      quiet: '22:00-08:00'",
        'workspace:',
        '  driver: tmux',
        'projects:',
        '  app:',
        '    root: /src/app',
        'telemetry:',
        '  dsn: https://abc@o1.ingest.sentry.io/2',
        'extensions:',
        '  jev:',
        '    enabled: true',
        `    key: ${JEV_KEY}`,
        'accounts:',
        '  work:',
        '    harness: claude-code',
        '',
      ].join('\n'),
    )
    mkdirSync(personaDirs(home).active, { recursive: true })
    writeFileSync(join(personaDirs(home).active, 'reviewer.md'), PERSONA)
    // A sign-in kept in Tade's own home, the way an added account keeps one.
    mkdirSync(join(home, 'accounts', 'work'), { recursive: true })
    writeFileSync(
      join(home, 'accounts', 'work', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: TOKEN, expiresAt: 1 } }),
    )
  })

  afterEach(async () => {
    await far.close()
  })

  it('leaves a fresh remote with this machine’s preferences, and none of its own', async () => {
    await add()
    expect(exit, err.join('\n')).toBe(0)
    const config = await there()
    expect(config.agents.commit).toBe('as-you-go')
    expect(config.approvals.auto_allow).toEqual(['read'])
    expect(config.orchestrator.harness).toBe('claude-code')
    expect(config.surfaces.voice.attention.quiet).toBe('22:00-08:00')
    expect(config.extensions.jev?.enabled).toBe(true)
    expect(config.accounts.work?.harness).toBe('claude-code')
    expect(readFileSync(join(personaDirs(far.home).active, 'reviewer.md'), 'utf8')).toBe(PERSONA)
    // Each machine's own, never carried.
    expect(config.projects).toEqual({})
    expect(config.agents.workspace).toBe('checkout')
    expect(config.workspace.driver).toBe('pty')
    // And what waits on a press has not left.
    expect(config.extensions.jev?.key).toBeUndefined()
    expect(config.telemetry.dsn).toBe('')
    expect(out.join('\n')).toContain('waiting on a press: telemetry.dsn, extensions.jev.key')
    // The checklist: what is left, said with the command that does it.
    expect(out.join('\n')).toContain('claude-code needs you to sign in there')
    expect(out.join('\n')).toContain('ssh -t far tade accounts sign-in claude-code')
    expect(out.join('\n')).toContain('codex is signed in there: 20 days left')
    expect(out.join('\n')).toContain(
      "each machine's own, never carried: agents.workspace, workspace, projects, remotes",
    )
    // No terminal there through this link, so nothing about mosh.
    expect(out.join('\n')).not.toContain('for mosh')
    // The lines there say each was carried, and from where.
    expect(far.lines.find((one) => one.detail?.path === 'agents.commit')?.detail).toMatchObject({
      carried: 'mac',
    })
  })

  it('sends a key only on the person’s press, saying first what that means, and writes it down on both machines', async () => {
    await add(asking(() => false))
    expect(answers.map((one) => one.asked)).toContain('Send them to vps now?')
    expect(err.join('\n')).toContain('written 0600 there')
    expect((await there()).extensions.jev?.key).toBeUndefined()

    await addRemote(place(asking((q) => q.startsWith('Send'))), 'box', {
      ssh: 'far',
      tade: 'tade',
      label: 'mac',
    })
    expect(exit, err.join('\n')).toBe(0)
    const config = await there()
    expect(config.extensions.jev?.key).toBe(JEV_KEY)
    expect(config.telemetry.dsn).toBe('https://abc@o1.ingest.sentry.io/2')
    expect(statSync(join(far.home, 'config.yaml')).mode & 0o777).toBe(0o600)
    expect(out.join('\n')).toContain('sent on your press: extensions.jev.key')
    // Both journals say it was sent, and by whom, and neither says what.
    const mine = await readJournal(home, { types: ['remote_carried'] })
    expect(mine.at(-1)?.detail).toMatchObject({
      remote: 'box',
      by: 'cli',
      sent: 'telemetry.dsn extensions.jev.key',
    })
    expect(JSON.stringify(mine)).not.toContain(JEV_KEY)
    const theirs = far.lines.filter((one) => one.detail?.path === 'extensions.jev.key')
    expect(theirs.at(-1)?.detail).toMatchObject({ now: 'set', carried: 'mac' })
    expect(JSON.stringify(far.lines)).not.toContain(JEV_KEY)
  })

  it('never sends a harness’s sign-in, in anything', async () => {
    await add(asking(() => true))
    expect(exit, err.join('\n')).toBe(0)
    expect(sent.length).toBeGreaterThan(0)
    expect(JSON.stringify(sent)).not.toContain(TOKEN)
    expect(JSON.stringify(sent)).not.toContain('.credentials')
    expect(readFileSync(join(far.home, 'config.yaml'), 'utf8')).not.toContain(TOKEN)
  })

  it('meets a machine never met only on the person’s word, and sends nothing before', async () => {
    identity = { fingerprints: ['ED25519 SHA256:far'], known: 'new' }
    await add()
    expect(exit).toBe(1)
    expect(err.join('\n')).toContain('a machine this one has never connected to')
    expect(err.join('\n')).toContain('ED25519 SHA256:far')
    expect(err.join('\n')).toContain('--accept-key')
    expect((await readDevices(far.home)).devices).toEqual([])
    expect(sent).toEqual([])

    exit = 0
    await add(asking((q) => q.startsWith('Is that far?')))
    expect(exit).toBe(0)
    expect(identity.known).toBe('known')
    expect((await readDevices(far.home)).devices).toHaveLength(1)
  })

  it('takes a fingerprint given ahead only where it is what the machine offers', async () => {
    identity = { fingerprints: ['ED25519 SHA256:far'], known: 'new' }
    await add(nobody, { acceptKey: ['ED25519 SHA256:other'] })
    expect(exit).toBe(1)
    expect(err.join('\n')).toContain('not what it offers')
    exit = 0
    await add(nobody, { acceptKey: ['ED25519 SHA256:far'] })
    expect(exit).toBe(0)
  })

  it('carries again later: leaves what that machine changed itself until told, and sends keys when told', async () => {
    await add()
    // Somebody on the server changes one of the carried preferences there.
    writeSetting(join(far.home, 'config.yaml'), 'agents.commit', 'never')
    far.lines.push({
      type: 'config_changed',
      detail: { path: 'agents.commit', was: 'as-you-go', now: 'never', by: 'window' },
    })
    out = []
    await carryRemote(place(), 'vps', {})
    expect(out.join('\n')).toContain(
      'changed there, so left as it is: agents.commit (there: never; here: as-you-go)',
    )
    expect((await there()).agents.commit).toBe('never')
    await carryRemote(place(), 'vps', { ours: ['agents.commit'] })
    expect((await there()).agents.commit).toBe('as-you-go')
    // Nobody to ask and no press given: nothing goes.
    await carryRemote(place(), 'vps', { keys: true })
    expect((await there()).extensions.jev?.key).toBeUndefined()
    await carryRemote(place(), 'vps', { keys: true, yes: true })
    expect((await there()).extensions.jev?.key).toBe(JEV_KEY)
    expect(err.join('\n')).toContain('written 0600 there')
    expect(exit, err.join('\n')).toBe(0)
    out = []
    await carryRemote(place(), 'nope', {})
    expect(exit).toBe(2)
    expect(err.at(-1)).toBe('there is no remote called nope')
  })

  it('walks each harness not signed in there through its own sign-in, in this terminal, and reads how it stands after', async () => {
    const ran: string[][] = []
    const terminals = {
      capabilities: { pairs: true, identifies: true, terminals: true },
      terminal: (_remote: unknown, words: readonly string[]) => ({
        command: 'ssh',
        args: ['-t', '--', 'far', ['tade', ...words].join(' ')],
      }),
    }
    const signing: Asking = {
      ...asking((q) => q.startsWith('claude-code is not signed in')),
      run: async (command, args) => {
        ran.push([command, ...args])
        // What the harness's own sign-in does there: it is signed in after.
        far.signIns = far.signIns.map((one) =>
          one.harness === 'claude-code'
            ? { ...one, signedIn: true, until: Date.now() + 20 * 86_400_000 }
            : one,
        )
        return 0
      },
    }
    await add(signing, {}, terminals as Partial<RemoteLink>)
    expect(exit, err.join('\n')).toBe(0)
    expect(ran).toEqual([['ssh', '-t', '--', 'far', 'tade accounts sign-in claude-code']])
    expect(err.join('\n')).toContain('what you type goes there and nowhere else')
    expect(out.join('\n')).toContain('claude-code is signed in there: 20 days left')
    expect(out.join('\n')).not.toContain('needs you to sign in')
    // A link that opens terminals there names what mosh needs open, as a step nothing requires.
    expect(out.join('\n')).toContain(
      'optional, for mosh: open UDP 60000–61000 on far — `sudo ufw allow 60000:61000/udp`',
    )
  })

  it('goes on where it cannot look at a host first, because ssh still refuses one it does not know', async () => {
    await add(nobody, {}, {
      identify: () => Promise.reject(new Error('ssh -G said nothing')),
    } as Partial<RemoteLink>)
    expect(exit, err.join('\n')).toBe(0)
    expect(err.join('\n')).toContain('could not look at far’s host key first'.replace('’', "'"))
    expect((await readDevices(far.home)).devices).toHaveLength(1)
  })

  it('says why a machine could not be trusted, and adds nothing', async () => {
    identity = { fingerprints: ['ED25519 SHA256:far'], known: 'new' }
    await add(
      asking(() => true),
      {},
      {
        trust: () => Promise.reject(new Error('it offered another key by the time you answered')),
      } as Partial<RemoteLink>,
    )
    expect(exit).toBe(1)
    expect(err.join('\n')).toContain('it offered another key by the time you answered')
    expect((await readDevices(far.home)).devices).toEqual([])
  })

  it('sends no key while a window holds this home’s journal, and says where they are sent from', async () => {
    const lock = await lockHome(home)
    try {
      await add(asking((q) => q.startsWith('Send')))
    } finally {
      await lock.release()
    }
    expect(err.join('\n')).toContain('the window open on this home holds its journal')
    expect((await there()).extensions.jev?.key).toBeUndefined()
  })

  it('refuses what it cannot add, before anything is sent', async () => {
    await addRemote(place(), 'VPS', { ssh: 'far', tade: 'tade' })
    expect(exit).toBe(2)
    expect(err.at(-1)).toContain('a remote’s name')
    exit = 0
    await addRemote({ ...place(), linkFor: () => undefined }, 'vps', { ssh: 'far', tade: 'tade' })
    expect(exit).toBe(1)
    expect(err.at(-1)).toBe('there is no link here that reaches a remote over SSH')
    exit = 0
    await addRemote(place(), 'vps', { ssh: 'nowhere', tade: 'tade' })
    expect(exit).toBe(1)
    expect(err.join('\n')).toContain('could not pair with nowhere')
    exit = 0
    await add()
    const carried = sent.length
    await add()
    expect(exit).toBe(2)
    expect(err.at(-1)).toContain('tade remote remove vps')
    writeFileSync(join(home, 'config.yaml'), 'agents: [not, a, section]\n')
    exit = 0
    await add()
    expect(exit).toBe(1)
    expect(err.at(-1)).toContain('tade config --check')
    // Only the add that was made sent anything.
    expect(sent).toHaveLength(carried)
  })

  it('takes back a session it cannot keep, rather than leaving it half made', async () => {
    const pair = () =>
      Promise.resolve({ device: 'ab12cd34', cookie: 'ab12cd34.short', csrf: 't', host: 'x' })
    await add(nobody, {}, { pair } as Partial<RemoteLink>)
    expect(exit).toBe(1)
    expect(err.join('\n')).toContain('printed a session this Tade cannot keep')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('ab12cd34')
  })

  it('answers --json with the remote and its checklist, and never the session', async () => {
    await add(nobody, { json: true })
    const answer = JSON.parse(out.join('\n')) as Record<string, unknown>
    expect(answer).toMatchObject({ name: 'vps', ssh: 'far', window: false })
    expect((answer.checklist as { waiting: string[] }).waiting).toEqual([
      'telemetry.dsn',
      'extensions.jev.key',
    ])
    const session = /session: (\S+)/.exec(readFileSync(join(home, 'config.yaml'), 'utf8'))?.[1]
    expect(session).toBeDefined()
    expect(out.join('\n')).not.toContain(session)
    expect(answer).not.toHaveProperty('csrf')
    out = []
    await carryRemote(place(), 'vps', { json: true })
    expect(JSON.parse(out.join('\n'))).toMatchObject({ remote: 'vps', unreached: null })
  })

  it('says nothing could be carried where the remote does not answer, and exits so', async () => {
    await add()
    await far.close()
    out = []
    await carryRemote(place(), 'vps', {})
    expect(exit).toBe(1)
    expect(out[0]).toMatch(/^nothing carried to vps yet: /)
    exit = 0
    await carryRemote({ ...place(), linkFor: () => undefined }, 'vps', {})
    expect(exit).toBe(1)
    expect(err.at(-1)).toBe('there is no link here that reaches vps')
    writeFileSync(join(home, 'config.yaml'), 'agents: [not, a, section]\n')
    await carryRemote(place(), 'vps', {})
    expect(err.at(-1)).toContain('tade config --check')
  })

  it('asks nobody where nobody is at a terminal', () => {
    // The suite's own process: no terminal to answer, and --json never asks.
    expect(ttyAsking(true).interactive).toBe(false)
    expect(ttyAsking(false).interactive).toBe(
      process.stdin.isTTY === true && process.stderr.isTTY === true,
    )
  })

  it('stops at a machine whose key changed, and says so plainly', async () => {
    identity = { fingerprints: ['ED25519 SHA256:else'], known: 'changed' }
    await add(asking(() => true))
    expect(exit).toBe(1)
    expect(err.join('\n')).toContain('is not what this machine met before')
    expect(answers).toEqual([])
    expect(sent).toEqual([])
  })
})

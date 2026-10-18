import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  BACKUP_SERVICE,
  BACKUP_START,
  BACKUP_TIMER,
  BRANCHES_ARE_THE_WORK,
  type Config,
  KEEP_THE_PASSWORD,
  parseConfig,
  type RunResult,
  resolveCommand,
} from '@tade/core'
import type { Restic } from '@tade/workbench/backup'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  type BackupDeps,
  initBackup,
  listBackups,
  mintPassword,
  notPushedLines,
  offerTimer,
  resticHere,
  restoreBackup,
  restoredLines,
  takeBackup,
  takenLines,
  timerHere,
} from '../src/commands/host-backup.ts'
import type { Asker } from '../src/commands/host-service.ts'

// `tade host backup` and `tade host restore`, as a person at the terminal
// meets them: what is said, what is asked, what is written and what is run.
// The steps are driven here in-process against restic's answers as restic
// gives them; that restic keeps and gives back what Tade hands it is
// `@tade/workbench`'s backup test, which runs the real one.

interface Recorder extends Asker {
  said: string[]
  asked: string[]
  ran: string[]
}

function recorder(answers: boolean[] = [], code = 0): Recorder {
  const said: string[] = []
  const asked: string[] = []
  const ran: string[] = []
  const queue = [...answers]
  return {
    said,
    asked,
    ran,
    say: (text) => said.push(text),
    async confirm(question, fallback) {
      asked.push(question)
      return queue.shift() ?? fallback
    },
    async run(_title, command, args) {
      ran.push(command === '/bin/sh' && args[0] === '-c' ? (args[1] ?? '') : command)
      return code
    },
  }
}

const OK: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }

/** restic's answers, by its subcommand, and every run written down. */
function answering(by: Record<string, Partial<RunResult>>): { restic: Restic; ran: string[][] } {
  const ran: string[][] = []
  return {
    ran,
    restic: async (args, env) => {
      ran.push([...args, `RESTIC_REPOSITORY=${env.RESTIC_REPOSITORY ?? ''}`])
      return { ...OK, ...(by[args[0] ?? ''] ?? {}) }
    },
  }
}

function configOf(text: string): Config {
  const parsed = parseConfig(text)
  if (!parsed.ok) throw new Error(parsed.issues.map((one) => one.message).join('; '))
  return parsed.config
}

const SUMMARY = JSON.stringify({
  message_type: 'summary',
  snapshot_id: '4f2a9c1d00ff',
  files_new: 12,
  files_changed: 3,
  files_unmodified: 1204,
  data_added_packed: 2_202_009,
  total_bytes_processed: 90 * 1024 * 1024,
  total_duration: 14.2,
})

function deps(opts: {
  config?: string
  restic: Restic
  ask?: Recorder
  asking?: boolean
  env?: Record<string, string>
  held?: number | null
}): BackupDeps & { lines: string[]; ask: Recorder; home: string } {
  const home = join(tmp('tade-host-backup-'), '.tade')
  mkdirSync(home, { recursive: true })
  const configPath = join(home, 'config.yaml')
  writeFileSync(configPath, opts.config ?? '')
  const lines: string[] = []
  const ask = opts.ask ?? recorder()
  return {
    ask,
    asking: opts.asking ?? false,
    place: { config: configOf(opts.config ?? ''), home, env: opts.env ?? {}, restic: opts.restic },
    configPath,
    out: (line) => lines.push(line),
    held: async () => opts.held ?? null,
    unrecorded: (said) => ask.say(said),
    lines,
    home,
  }
}

const SET = 'backup:\n  repository: sftp:u1@box:/tade\n  password: pw\n'

describe('taking a backup', () => {
  it('says where to name one, and runs nothing, where there is nowhere to back up to', async () => {
    const { restic, ran } = answering({})
    const d = deps({ restic })
    expect(await takeBackup(d, false)).toBe(2)
    expect(d.ask.said.join(' ')).toContain('tade host backup --init <repository>')
    expect(ran).toEqual([])
  })

  it('says what it reads and where to, then what it came to and what it does not hold', async () => {
    const { restic, ran } = answering({ backup: { stdout: `${SUMMARY}\n` } })
    const d = deps({ config: SET, restic })
    expect(await takeBackup(d, false)).toBe(0)
    expect(d.ask.said[0]).toContain('to sftp:u1@box:/tade (its password from config.yaml)')
    expect(d.lines[0]).toBe(
      '✓ snapshot 4f2a9c1d: 12 new, 3 changed, 1204 unchanged — 2.1 MiB sent of 90 MiB read, in 14 s',
    )
    expect(d.lines.at(-1)).toBe(BRANCHES_ARE_THE_WORK)
    // The repository goes in restic's environment, never on its command line.
    expect(ran[0]?.at(-1)).toBe('RESTIC_REPOSITORY=sftp:u1@box:/tade')
    expect(ran[0]?.slice(0, -1).join(' ')).not.toContain('sftp:')
  })

  it('fails loudly where some files could not be read, naming them, and where restic failed', async () => {
    const error = (item: string) =>
      JSON.stringify({ message_type: 'error', error: { message: 'permission denied' }, item })
    const unread = Array.from({ length: 7 }, (_, at) => error(`/home/agent/.claude/projects/${at}`))
    const partial = answering({
      backup: { code: 3, stdout: [...unread, SUMMARY].join('\n') },
    })
    const d = deps({ config: SET, restic: partial.restic })
    expect(await takeBackup(d, false)).toBe(1)
    expect(d.lines).toContain('▲ 7 could not be read, so are not in it:')
    expect(d.lines).toContain('    and 2 more')

    const failed = answering({ backup: { code: 1, stderr: 'Fatal: unable to open repository\n' } })
    const f = deps({ config: SET, restic: failed.restic })
    expect(await takeBackup(f, false)).toBe(1)
    expect(f.lines).toEqual(['✗ no backup: Fatal: unable to open repository'])
  })

  it('answers as JSON with what it came to and what is not pushed', async () => {
    const { restic } = answering({ backup: { stdout: SUMMARY } })
    const d = deps({ config: SET, restic })
    expect(await takeBackup(d, true)).toBe(0)
    const read = JSON.parse(d.lines.join('\n'))
    expect(read.summary.snapshot).toBe('4f2a9c1d')
    expect(read.notPushed).toEqual([])
    expect(read.manifest.home).toBe(d.home)
  })

  it('says work on this machine alone a line each', () => {
    expect(
      notPushedLines([
        { project: 'app', path: '/srv/app', branch: 'main', ahead: 0, changed: true },
        { project: 'app', path: '/srv/wt', branch: null, ahead: 2, changed: false },
        { project: 'app', path: '/srv/x', branch: 'x', ahead: null, changed: true },
      ]),
    ).toEqual([
      '▲ app: /srv/app (main) — changes not committed',
      '▲ app: /srv/wt — 2 commits on no remote',
      '▲ app: /srv/x (x) — changes not committed',
    ])
    expect(
      takenLines({ ok: false, summary: null, errors: [], said: 'nope', manifest: null }),
    ).toEqual(['✗ no backup: nope'])
  })
})

describe('naming where backups go', () => {
  it('refuses what is not a repository', async () => {
    const { restic, ran } = answering({})
    const d = deps({ restic })
    expect(await initBackup(d, '  ')).toBe(2)
    expect(await initBackup(d, 'a\nb')).toBe(2)
    expect(ran).toEqual([])
  })

  it('writes the repository, mints a password, makes it there and prints the password once', async () => {
    const { restic, ran } = answering({})
    const d = deps({ restic })
    expect(await initBackup(d, '/mnt/backup/tade', () => 'minted-password')).toBe(0)
    expect(d.lines).toEqual(['minted-password'])
    const written = configOf(readFileSync(d.configPath, 'utf8')).backup
    expect(written).toEqual({ repository: '/mnt/backup/tade', password: 'minted-password' })
    expect(ran.map((one) => one[0])).toEqual(['init'])
    const said = d.ask.said.join('\n')
    expect(said).toContain(KEEP_THE_PASSWORD)
    expect(said).toContain('Made /mnt/backup/tade.')
    expect(said).not.toContain('minted-password')
  })

  it('mints nothing where restic’s own variable holds the password, and says so', async () => {
    const { restic } = answering({})
    const d = deps({ restic, env: { RESTIC_PASSWORD_FILE: '/root/pw' } })
    expect(await initBackup(d, '/mnt/b', () => 'never')).toBe(0)
    expect(d.lines).toEqual([])
    expect(configOf(readFileSync(d.configPath, 'utf8')).backup.password).toBe('')
    expect(d.ask.said).toContain('Its password is the one from $RESTIC_PASSWORD_FILE.')
  })

  it('takes a repository that is there already where this password opens it, and says what it replaced', async () => {
    const there = answering({ init: { code: 1, stderr: 'Fatal: config file already exists\n' } })
    const d = deps({
      config: 'backup:\n  repository: /old\n  password: pw\n',
      restic: there.restic,
    })
    expect(await initBackup(d, '/new')).toBe(0)
    expect(d.ask.said).toContain('backup.repository is /new now, in place of /old')
    expect(d.ask.said).toContain('/new is a repository already, and this password opens it.')
    expect(there.ran.map((one) => one[0])).toEqual(['init', 'snapshots'])
  })

  it('still prints a password it minted where the repository could not be made', async () => {
    const neither = answering({
      init: { code: 1, stderr: 'Fatal: sftp: no route to host\n' },
      snapshots: { code: 1, stderr: 'Fatal: sftp: no route to host\n' },
    })
    const d = deps({ restic: neither.restic })
    expect(await initBackup(d, 'sftp:u1@box:/tade', () => 'kept-anyway')).toBe(1)
    expect(d.lines).toEqual(['kept-anyway'])
    expect(d.ask.said[0]).toBe(
      '✗ sftp:u1@box:/tade could not be made: Fatal: sftp: no route to host',
    )
  })

  it('mints a password with nothing in it to misread', () => {
    const one = mintPassword()
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(mintPassword()).not.toBe(one)
  })
})

describe('listing the backups', () => {
  const listed = JSON.stringify([
    { short_id: 'aaaa1111', time: '2026-10-17T10:00:00Z', hostname: 'vps', paths: [] },
    { short_id: 'bbbb2222', time: '2026-10-18T10:00:00Z', hostname: 'vps', paths: [] },
  ])

  it('lists them newest first, as text or JSON, and says when there are none', async () => {
    const { restic, ran } = answering({ snapshots: { stdout: listed } })
    const d = deps({ config: SET, restic })
    expect(await listBackups(d, false)).toBe(0)
    expect(d.lines.map((line) => line.split(' ')[0])).toEqual(['bbbb2222', 'aaaa1111'])
    expect(ran[0]?.slice(0, 4)).toEqual(['snapshots', '--json', '--tag', 'tade'])
    const j = deps({ config: SET, restic })
    expect(await listBackups(j, true)).toBe(0)
    expect(JSON.parse(j.lines.join('\n'))[0].id).toBe('bbbb2222')
    const none = deps({ config: SET, restic: answering({ snapshots: { stdout: '[]' } }).restic })
    expect(await listBackups(none, false)).toBe(0)
    expect(none.lines).toEqual(['No backups there yet: `tade host backup` takes one.'])
  })

  it('says what restic said where it could not list them', async () => {
    const d = deps({
      config: SET,
      restic: answering({ snapshots: { code: 12, stderr: 'Fatal: wrong password\n' } }).restic,
    })
    expect(await listBackups(d, false)).toBe(1)
    expect(d.ask.said).toEqual(['✗ Fatal: wrong password'])
  })
})

describe('restoring', () => {
  it('asks where from on a machine whose config does not say', async () => {
    const d = deps({ restic: answering({}).restic })
    expect(await restoreBackup(d, 'latest', { yes: true })).toBe(2)
    expect(d.ask.said[0]).toContain('--from <repository>')
  })

  it('puts a snapshot under a folder to look at, and says why where it could not', async () => {
    const { restic, ran } = answering({})
    const d = deps({ config: SET, restic })
    expect(await restoreBackup(d, 'bbbb2222', { to: '/tmp/look', yes: false })).toBe(0)
    expect(ran[0]?.slice(0, 4)).toEqual(['restore', 'bbbb2222', '--target', '/tmp/look'])
    expect(d.lines[0]).toContain('is under /tmp/look')
    const failed = deps({
      config: SET,
      restic: answering({ restore: { code: 1, stderr: 'Fatal: no snapshot\n' } }).restic,
    })
    expect(await restoreBackup(failed, 'x', { to: '/tmp/look', yes: false })).toBe(1)
    expect(failed.lines).toEqual(['✗ not restored: Fatal: no snapshot'])
  })

  it('restores in place only on a press: none from a pipe, and a no is a no', async () => {
    const { restic, ran } = answering({})
    const piped = deps({ config: SET, restic })
    expect(await restoreBackup(piped, 'latest', { yes: false })).toBe(2)
    expect(piped.ask.said[0]).toContain('`--yes` to do it without asking')
    const declined = deps({ config: SET, restic, asking: true, ask: recorder([false]) })
    expect(await restoreBackup(declined, 'latest', { yes: false })).toBe(0)
    expect(declined.ask.asked[0]).toContain(', moving what is there aside?')
    expect(declined.ask.said).toEqual(['  not restored'])
    expect(ran).toEqual([])
  })

  it('says a home something holds is refused, with how to free it', async () => {
    const d = deps({ config: SET, restic: answering({}).restic, held: 777 })
    expect(await restoreBackup(d, 'latest', { yes: true })).toBe(1)
    expect(d.lines[0]).toContain('(pid 777)')
  })

  it('says what a restore put where, what it left and what to clone', () => {
    const lines = restoredLines(
      {
        ok: true,
        said: '',
        movedAside: '/home/you/.tade.before-restore-x',
        manifest: {
          version: 1,
          home: '/home/old/.tade',
          records: [],
          projects: [],
          tade: '0.2.3',
          machine: 'vps',
          at: '2026-10-18T00:00:00.000Z',
        },
        records: [
          {
            harness: 'pi',
            user: null,
            from: '/a',
            to: '/home/you/.pi/agent/sessions',
            left: 2,
            why: null,
          },
          {
            harness: 'codex',
            user: 'tade-agent',
            from: '/b',
            to: null,
            left: 0,
            why: 'nothing here keeps codex’s conversations for tade-agent',
          },
        ],
        staging: '/home/you/.tade-restore-1',
        cut: [{ path: '/home/you/.tade/events.jsonl', bytes: 21 }],
        missing: [
          { name: 'app', root: '/srv/app', remote: 'git@github.com:me/app.git' },
          { name: 'local', root: '/srv/local', remote: null },
        ],
        links: ['/home/you/.tade/extensions'],
      },
      '/home/you/.tade',
    )
    expect(lines).toEqual([
      '✓ restored /home/you/.tade, as vps had it at 2026-10-18T00:00:00.000Z under Tade 0.2.3',
      '  what was there is at /home/you/.tade.before-restore-x',
      '  pi’s conversations into /home/you/.pi/agent/sessions, leaving 2 this machine already had',
      '▲ codex as tade-agent’s conversations stayed where restic put them: nothing here keeps codex’s conversations for tade-agent',
      '  cut a torn last line (21 bytes) off /home/you/.tade/events.jsonl',
      '▲ 1 links it held were not put back, since a link may point anywhere:',
      '    /home/you/.tade/extensions',
      '▲ not placed, and left in /home/you/.tade-restore-1',
      'Projects whose checkout is not on this machine:',
      '  git clone git@github.com:me/app.git /srv/app',
      '  local: /srv/local, which had no remote — its work was on the old machine alone',
      BRANCHES_ARE_THE_WORK,
      'Then `tade setup --check` looks at this machine, and Tade opens on what was kept.',
    ])
    expect(
      restoredLines(
        {
          ok: false,
          said: 'nope',
          movedAside: null,
          manifest: null,
          records: [],
          staging: '/s',
          cut: [],
          missing: [],
          links: [],
        },
        '/h',
      ),
    ).toEqual(['✗ not restored: nope', '  what restic put back is in /s'])
  })
})

describe('the hourly timer', () => {
  const env = (config: string) => ({
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    XDG_CONFIG_HOME: config,
  })

  it('prints both units whole, each under where it goes, and writes nothing where systemd does not run', async () => {
    const config = tmp('tade-timer-')
    const units = timerHere(env(config), '/opt/tade/packages/cli/src/bin.ts')
    expect(units.timer.path).toBe(join(config, 'systemd', 'user', BACKUP_TIMER))
    expect(units.service.path).toBe(join(config, 'systemd', 'user', BACKUP_SERVICE))
    expect(units.service.text).toContain('Environment=LANG=en_US.UTF-8')
    const d = deps({ config: SET, restic: answering({}).restic })
    expect(await offerTimer(d, units, { write: false, systemd: false })).toBe(0)
    expect(d.lines[0]).toBe(`# ${units.service.path}`)
    expect(d.lines).toContain(`# ${units.timer.path}`)
    expect(d.ask.said.join(' ')).toContain('cron or launchd')
    expect(existsSync(units.timer.path)).toBe(false)
    expect(await offerTimer(d, units, { write: true, systemd: false })).toBe(1)
  })

  it('wants a repository first, says how to write it from a pipe, and writes it on a press', async () => {
    const config = tmp('tade-timer-')
    const units = timerHere(env(config), '/opt/tade/bin.ts')
    const none = deps({ restic: answering({}).restic })
    expect(await offerTimer(none, units, { write: false, systemd: true })).toBe(2)
    const piped = deps({ config: SET, restic: answering({}).restic })
    expect(await offerTimer(piped, units, { write: false, systemd: true })).toBe(0)
    expect(piped.ask.said).toEqual(['`tade host backup --timer --write` writes them.'])

    const ask = recorder([true, true])
    const pressed = deps({ config: SET, restic: answering({}).restic, asking: true, ask })
    expect(await offerTimer(pressed, units, { write: false, systemd: true })).toBe(0)
    expect(readFileSync(units.timer.path, 'utf8')).toBe(units.timer.text)
    expect(readFileSync(units.service.path, 'utf8')).toBe(units.service.text)
    expect(ask.ran).toEqual([BACKUP_START])
    expect(ask.said.at(-1)).toContain('list-timers')

    // Written already: said, and with --write the start is said and not run.
    const again = recorder()
    const scripted = deps({ config: SET, restic: answering({}).restic, ask: again })
    expect(await offerTimer(scripted, units, { write: true, systemd: true })).toBe(0)
    expect(again.said[0]).toContain('already says this')
    expect(again.said[1]).toBe(`  to start it, now and at every boot: \`${BACKUP_START}\``)
    expect(again.ran).toEqual([])
  })

  it('says a start that failed, with where to read why, and a declined write as such', async () => {
    const config = tmp('tade-timer-')
    const units = timerHere(env(config), '/opt/tade/bin.ts')
    const no = recorder([false])
    const declined = deps({ config: SET, restic: answering({}).restic, asking: true, ask: no })
    expect(await offerTimer(declined, units, { write: false, systemd: true })).toBe(0)
    expect(no.said).toEqual(['  not written'])
    const failing = recorder([true, true], 1)
    const failed = deps({ config: SET, restic: answering({}).restic, asking: true, ask: failing })
    expect(await offerTimer(failed, units, { write: false, systemd: true })).toBe(1)
    expect(failing.said.at(-1)).toContain(`journalctl --user -u ${BACKUP_TIMER}`)
  })
})

describe('restic in this terminal', () => {
  const PATH = process.env.PATH
  afterEach(() => {
    process.env.PATH = PATH
  })

  /** A `restic` on PATH that prints what restic prints and exits as told, until the test ends. */
  function onPath(script: string): void {
    const bin = tmp('tade-restic-bin-')
    const path = join(bin, 'restic')
    writeFileSync(path, `#!/bin/sh\n${script}\n`)
    chmodSync(path, 0o755)
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  }

  it('reads what it prints, draws its progress on one line, and passes on what it says', async () => {
    onPath(
      [
        `printf '%s\\n' '{"message_type":"status","percent_done":0.42,"total_bytes":2147483648}'`,
        `printf 'warning: one file changed while it was read\\n' >&2`,
        `printf '%s\\n' '{"message_type":"status","percent_done":0.9}'`,
        `printf '%s\\n' '${SUMMARY}'`,
        `[ "$RESTIC_REPOSITORY" = /here ] || exit 9`,
        'exit 3',
      ].join('\n'),
    )
    const written: string[] = []
    const err = { isTTY: true, write: (text: string) => written.push(text) }
    const ran = await resticHere(err as unknown as NodeJS.WriteStream)(['backup', '--json'], {
      RESTIC_REPOSITORY: '/here',
    })
    expect(ran.code).toBe(3)
    expect(ran.missing).toBe(false)
    expect(ran.stdout).toContain('"snapshot_id"')
    expect(ran.stderr).toBe('warning: one file changed while it was read\n')
    expect(written).toContain('\r  42% of 2.0 GiB   ')
    expect(written).toContain('warning: one file changed while it was read\n')
  })

  it('says restic is missing where nothing on PATH answers to it', async () => {
    process.env.PATH = tmp('tade-empty-path-')
    const ran = await resticHere({
      isTTY: false,
      write: () => true,
    } as unknown as NodeJS.WriteStream)(['version'], {})
    expect(ran.missing).toBe(true)
  })
})

describe('the binary', () => {
  const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
  const run = promisify(execFile)
  const RESTIC = resolveCommand('restic', { PATH: process.env.PATH ?? '' })

  async function tade(args: string[], env: Record<string, string>) {
    try {
      const { stdout, stderr } = await run(process.execPath, [bin, ...args], {
        env: { ...process.env, ...env },
      })
      return { code: 0, stdout, stderr }
    } catch (err) {
      const said = err as { code?: number; stdout?: string; stderr?: string }
      return { code: said.code ?? 1, stdout: said.stdout ?? '', stderr: said.stderr ?? '' }
    }
  }

  function machine(): Record<string, string> {
    const user = tmp('tade-host-backup-bin-')
    return { HOME: user, TADE_HOME: join(user, '.tade') }
  }

  it('says where to name a repository, and exits 2, where none is named', async () => {
    const env = machine()
    const ran = await tade(['host', 'backup'], env)
    expect(ran.code).toBe(2)
    expect(ran.stderr).toContain('tade host backup --init <repository>')
    expect(ran.stdout).toBe('')
  })

  it.skipIf(RESTIC === null)(
    `names a repository, backs up, lists and restores through restic${RESTIC === null ? ' (restic is not installed here)' : ''}`,
    async () => {
      const env = machine()
      mkdirSync(env.TADE_HOME ?? '', { recursive: true })
      const opened = {
        seq: 1,
        ts: '2026-10-18T00:00:00.000Z',
        type: 'tade_opened',
        urgency: 'notable',
        task: null,
        lane: null,
        run: null,
        detail: {},
      }
      writeFileSync(join(env.TADE_HOME ?? '', 'events.jsonl'), `${JSON.stringify(opened)}\n`)
      const repository = join(tmp('tade-host-backup-repo-'), 'r')
      const made = await tade(['host', 'backup', '--init', repository], env)
      expect(made.code).toBe(0)
      const password = made.stdout.trim()
      expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/)

      const taken = await tade(['host', 'backup', '--json'], env)
      expect(taken.code).toBe(0)
      const snapshot = JSON.parse(taken.stdout).summary.snapshot as string
      const listed = await tade(['host', 'backup', '--list', '--json'], env)
      expect(JSON.parse(listed.stdout).map((one: { id: string }) => one.id)).toEqual([snapshot])

      // Another machine, with nothing of this one's but the repository and its password.
      const other = machine()
      const restored = await tade(['host', 'restore', '--from', repository, '--yes'], {
        ...other,
        RESTIC_PASSWORD: password,
      })
      expect(restored.code).toBe(0)
      expect(restored.stdout).toContain('✓ restored')
      // The journal as it was backed up: the line it had, and `--init`'s own `config_changed`.
      const journal = readFileSync(join(env.TADE_HOME ?? '', 'events.jsonl'), 'utf8')
      expect(journal).toContain('"config_changed"')
      // A key is never in the journal: the password was written down as set, and nothing of it.
      expect(journal).not.toContain(password)
      expect(readFileSync(join(other.TADE_HOME ?? '', 'events.jsonl'), 'utf8')).toBe(journal)
      // Its config came with it, so the next backup there goes where this one's did.
      const config = configOf(readFileSync(join(other.TADE_HOME ?? '', 'config.yaml'), 'utf8'))
      expect(config.backup.repository).toBe(repository)
    },
  )
})

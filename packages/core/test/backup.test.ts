import { describe, expect, it } from 'vitest'
import {
  BACKUP_TAG,
  backupExcludes,
  backupPaths,
  backupSaid,
  bytesSaid,
  LEFT_OUT,
  manifestOf,
  PASSWORD_VARIABLES,
  passwordFor,
  placeable,
  RESTIC,
  resticBackup,
  shownRepository,
  snapshotsSaid,
} from '../src/backup.ts'
import { carryOf } from '../src/carry.ts'
import { parseConfig } from '../src/config-file.ts'
import { declarationProblems } from '../src/programs.ts'
import { settingReach } from '../src/reach.ts'

// What a backup of this machine's Tade keeps and leaves out, the arguments
// restic is handed, and what is read back out of what it prints. That restic
// keeps and gives back exactly this is `@tade/workbench`'s backup test, which
// runs it.

const HOME = '/home/you/.tade'

describe('what a backup keeps', () => {
  it('is the whole home less a named list, each with why', () => {
    // The two the task names: the derived index and the worktrees.
    const paths = LEFT_OUT.map((one) => one.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'events.jsonl.db',
        'events.jsonl.db-wal',
        'events.jsonl.db-shm',
        'worktrees',
        'runs',
        'tade.lock',
      ]),
    )
    for (const one of LEFT_OUT) expect(one.why.length, one.path).toBeGreaterThan(10)
    // The truth is never on it.
    for (const kept of [
      'events.jsonl',
      'memory.jsonl',
      'schedules.jsonl',
      'config.yaml',
      'projects',
    ]) {
      expect(paths).not.toContain(kept)
    }
  })

  it('reads the home, then each records folder not already inside it or another', () => {
    const records = [
      { harness: 'claude-code', user: null, path: '/home/you/.claude/projects' },
      // An account's own folder is in the home already.
      { harness: 'claude-code', user: null, path: `${HOME}/accounts/work/projects` },
      { harness: 'pi', user: null, path: '/home/you/.pi/agent/sessions' },
      { harness: 'pi', user: null, path: '/home/you/.pi/agent/sessions/inner' },
      { harness: 'codex', user: 'tade-agent', path: '/home/tade-agent/.codex/sessions' },
      { harness: 'other', user: null, path: '/home/you/.claude/projects' },
    ]
    expect(backupPaths(HOME, records)).toEqual([
      HOME,
      '/home/you/.claude/projects',
      '/home/you/.pi/agent/sessions',
      '/home/tade-agent/.codex/sessions',
    ])
    // A folder whose name only begins like the home's is not inside it.
    expect(backupPaths(HOME, [{ harness: 'pi', user: null, path: `${HOME}-old/x` }])).toEqual([
      HOME,
      `${HOME}-old/x`,
    ])
  })

  it('leaves out each named path absolutely, with the home’s own glob characters taken as they are', () => {
    expect(backupExcludes(`${HOME}/`)).toContain(`${HOME}/events.jsonl.db`)
    expect(backupExcludes(HOME)).toContain(`${HOME}/projects/*/mirror.git`)
    expect(backupExcludes('/home/[me]*?/.tade')).toContain('/home/\\[me]\\*\\?/.tade/worktrees')
  })

  it('hands restic the tag, --json and the excludes before the paths', () => {
    const args = resticBackup(HOME, [{ harness: 'pi', user: null, path: '/p' }])
    expect(args.slice(0, 4)).toEqual(['backup', '--json', '--tag', BACKUP_TAG])
    expect(args.slice(-2)).toEqual([HOME, '/p'])
    expect(args.filter((one) => one === '--exclude')).toHaveLength(LEFT_OUT.length)
  })

  it('declares restic as an optional program with an install for each platform', () => {
    expect(declarationProblems([RESTIC])).toEqual([])
    expect(RESTIC.optional).toBe(true)
    expect(RESTIC.versionArgs).toEqual(['version'])
  })
})

describe('what restic says', () => {
  it('reads the summary and every file it could not read, in either spelling of an error', () => {
    const said = [
      '{"message_type":"status","percent_done":0.5}',
      'not json at all',
      '{"message_type":"error","error":{"message":"open /x: permission denied"},"during":"archival","item":"/x"}',
      '{"message_type":"error","error":"lstat /y: no such file","item":"/y"}',
      '{"message_type":"error","item":"/z"}',
      '{"message_type":"summary","files_new":3,"files_changed":1,"files_unmodified":9,"data_added":900,"data_added_packed":400,"total_bytes_processed":5000,"total_duration":1.5,"snapshot_id":"01c0df335cecda11eccb"}',
    ].join('\n')
    expect(backupSaid(said)).toEqual({
      summary: {
        snapshot: '01c0df33',
        filesNew: 3,
        filesChanged: 1,
        filesUnmodified: 9,
        bytesAdded: 400,
        bytesProcessed: 5000,
        seconds: 1.5,
      },
      errors: [
        { item: '/x', said: 'open /x: permission denied' },
        { item: '/y', said: 'lstat /y: no such file' },
        { item: '/z', said: 'could not be read' },
      ],
    })
    expect(backupSaid('')).toEqual({ summary: null, errors: [] })
    // Before restic packed what it added, the unpacked figure is what was sent.
    expect(
      backupSaid('{"message_type":"summary","snapshot_id":"abcdef0123","data_added":77}').summary
        ?.bytesAdded,
    ).toBe(77)
  })

  it('lists snapshots newest first, and nothing out of what is not a list', () => {
    const listed = JSON.stringify([
      { short_id: 'aaaa1111', time: '2026-10-17T10:00:00Z', hostname: 'vps', paths: [HOME, 3] },
      { id: 'bbbb2222cccc', time: '2026-10-18T10:00:00Z', hostname: 'vps', paths: [] },
      { short_id: 'nope' },
    ])
    expect(snapshotsSaid(listed)).toEqual([
      { id: 'bbbb2222', at: '2026-10-18T10:00:00Z', machine: 'vps', paths: [] },
      { id: 'aaaa1111', at: '2026-10-17T10:00:00Z', machine: 'vps', paths: [HOME] },
    ])
    expect(snapshotsSaid('{}')).toEqual([])
    expect(snapshotsSaid('Fatal: nothing')).toEqual([])
  })
})

describe('the repository and its password', () => {
  it('never says a password a repository’s URL carries', () => {
    expect(shownRepository('rest:https://me:secret@backup.example.com:8000/tade')).toBe(
      'rest:https://me:…@backup.example.com:8000/tade',
    )
    expect(shownRepository('sftp:u1@u1.your-storagebox.de:/tade')).toBe(
      'sftp:u1@u1.your-storagebox.de:/tade',
    )
    expect(shownRepository('/mnt/backup/tade')).toBe('/mnt/backup/tade')
  })

  it('takes restic’s own variables over the config, and hands the config’s over only where none is set', () => {
    for (const variable of PASSWORD_VARIABLES) {
      expect(passwordFor({ [variable]: 'x' }, 'written')).toEqual({ from: `$${variable}`, env: {} })
    }
    expect(passwordFor({ RESTIC_PASSWORD: '  ' }, ' written ')).toEqual({
      from: 'config.yaml',
      env: { RESTIC_PASSWORD: 'written' },
    })
    expect(passwordFor({}, '')).toBeNull()
  })

  it('is a section of its own in the config, empty by default, one line at most', () => {
    const empty = parseConfig('')
    expect(empty.ok && empty.config.backup).toEqual({ repository: '', password: '' })
    const set = parseConfig('backup:\n  repository: sftp:u1@box:/tade\n  password: pw\n')
    expect(set.ok && set.config.backup.repository).toBe('sftp:u1@box:/tade')
    const broken = parseConfig('backup:\n  repository: "a\\nb"\n')
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.issues[0]?.path).toBe('backup.repository')
    const typo = parseConfig('backup:\n  repo: x\n')
    expect(typo.ok).toBe(false)
  })

  it('is a person’s to set, and this machine’s own', () => {
    for (const path of ['backup.repository', 'backup.password']) {
      expect(settingReach(path).reach, path).toBe('never')
      expect(carryOf(path).carry, path).toBe('here')
    }
  })
})

describe('the manifest a backup writes into the home', () => {
  const written = {
    version: 1,
    home: HOME,
    records: [
      { harness: 'pi', user: null, path: '/home/you/.pi/agent/sessions' },
      { harness: 'codex', user: 'tade-agent', path: '/home/tade-agent/.codex/sessions' },
      { harness: 'claude-code', user: null, path: 'relative/is/not/one' },
      { harness: '', path: '/x' },
    ],
    projects: [{ name: 'app', root: '/srv/app', remote: 'git@github.com:me/app.git' }, { root: 1 }],
    tade: '0.2.3',
    machine: 'vps',
    at: '2026-10-18T00:00:00.000Z',
  }

  it('is read back as it was written, dropping rows that are not rows', () => {
    expect(manifestOf(written)).toEqual({
      ...written,
      records: written.records.slice(0, 2),
      projects: [written.projects[0]],
      // A row whose path is not one to look for is counted, so a restore says it.
      unplaceable: 1,
    })
  })

  it('looks for a path only in its plain absolute form: never `..`, `.`, `//` or NUL', () => {
    expect(placeable('/home/you/.pi/agent/sessions')).toBe(true)
    expect(placeable('/home/you/.tade/')).toBe(true)
    for (const path of [
      'home/you',
      '/home/you/../../etc',
      '/..',
      '/home/./you',
      '/home//you',
      '/home/you\0/x',
      '',
    ]) {
      expect(placeable(path), path).toBe(false)
    }
    expect(manifestOf({ ...written, home: '/home/you/../../etc' })).toBeNull()
  })

  it('is no manifest where its shape or its home is not one', () => {
    expect(manifestOf(null)).toBeNull()
    expect(manifestOf('x')).toBeNull()
    expect(manifestOf({ ...written, version: 2 })).toBeNull()
    expect(manifestOf({ ...written, home: '.tade' })).toBeNull()
    expect(manifestOf({ version: 1, home: HOME })).toEqual({
      version: 1,
      home: HOME,
      records: [],
      projects: [],
      tade: 'an unknown Tade',
      machine: 'an unknown machine',
      at: '',
    })
  })
})

describe('a size, as a person reads one', () => {
  it('climbs units and keeps a decimal only where it is small', () => {
    expect(bytesSaid(512)).toBe('512 B')
    expect(bytesSaid(1536)).toBe('1.5 KiB')
    expect(bytesSaid(81 * 1024 * 1024)).toBe('81 MiB')
    expect(bytesSaid(2.6 * 1024 ** 3)).toBe('2.6 GiB')
    expect(bytesSaid(3 * 1024 ** 5)).toBe('3072 TiB')
  })
})

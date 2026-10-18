import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Config, MANIFEST, parseConfig, resolveCommand, runProgram } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../test/fixtures/mkrepo.ts'
import {
  backUp,
  cutTornTail,
  initRepository,
  notPushed,
  type Restic,
  recordsFolders,
  recordsHere,
  restoreInto,
  restoreTo,
  snapshotsIn,
} from '../src/backup.ts'
import { readJournal } from '../src/events.ts'
import { Memory } from '../src/memory.ts'
import { Workbench } from '../src/workbench.ts'

// A backup of this machine's Tade, and a restore of it — against a real
// restic, real files, a real journal and a real workbench opened on what came
// back, because a backup nobody restored is a hope (REMOTE-TADE.md §7.5).
//
// restic is a program this machine may not have: CI installs it (`ci.yml`'s
// `restic` step), and where it is missing the restore half says so in its
// title and is skipped, rather than failing a suite on a laptop that has
// never been asked to keep a backup.

const RESTIC = resolveCommand('restic', { PATH: process.env.PATH ?? '' })

const shut: Workbench[] = []
afterEach(async () => {
  for (const one of shut) await one.close()
  shut.length = 0
})

function configOf(text: string): Config {
  const parsed = parseConfig(text)
  if (!parsed.ok) throw new Error(parsed.issues.map((one) => one.message).join('; '))
  return parsed.config
}

/** A machine with Tade's home in it, opened and closed by a real workbench. */
async function machine() {
  const origin = mkrepo()
  origin.commit('first')
  const user = tmp('tade-user-')
  const root = join(user, 'code', 'app')
  runGit(user, 'clone', '-q', origin.root, root)
  const home = join(user, '.tade')
  const repository = join(tmp('tade-repo-'), 'restic')
  mkdirSync(home, { recursive: true })
  const text = [
    'projects:',
    '  app:',
    `    root: ${root}`,
    '    workspace: worktree',
    'backup:',
    `  repository: ${repository}`,
    '  password: correct horse battery staple',
    '',
  ].join('\n')
  writeFileSync(join(home, 'config.yaml'), text)
  const client = await Workbench.open({ home })
  const task = await client.createTask({ project: 'app', slug: 'kept', intent: 'keep this' })
  Memory.open(home).remember('the backup keeps what I said', null, 'person')
  await client.close()
  // A harness's conversations, where pi keeps them for this user.
  const config = configOf(text)
  const pi = (await recordsFolders({ config, home })).find((one) => one.harness === 'pi')
  if (!pi) throw new Error('pi names no records folder')
  const session = join(pi.path, '--app--', 'one.jsonl')
  mkdirSync(dirname(session), { recursive: true })
  writeFileSync(session, '{"type":"session"}\n')
  return { home, root, repository, config, task: task.id, session, origin: origin.root }
}

describe('cutting a torn last line', () => {
  const file = (content: string | Buffer) => {
    const path = join(tmp('tade-torn-'), 'events.jsonl')
    writeFileSync(path, content)
    return path
  }

  it('leaves a file that ends in a whole line as it is', async () => {
    const path = file('{"a":1}\n{"b":2}\n')
    expect(await cutTornTail(path)).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n{"b":2}\n')
    expect(await cutTornTail(file(''))).toBe(0)
  })

  it('cuts back to the last whole line, however far back it is', async () => {
    const path = file('{"a":1}\n{"b":')
    expect(await cutTornTail(path)).toBe(5)
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n')
    // Torn past more than one look back.
    const long = file(Buffer.concat([Buffer.from('{"a":1}\n'), Buffer.alloc(200_000, 0x78)]))
    expect(await cutTornTail(long)).toBe(200_000)
    expect(readFileSync(long, 'utf8')).toBe('{"a":1}\n')
  })

  it('empties a file whose only line is torn', async () => {
    const path = file('{"half":')
    expect(await cutTornTail(path)).toBe(8)
    expect(readFileSync(path, 'utf8')).toBe('')
  })
})

describe('where the harnesses keep conversations here', () => {
  it('names each registered harness’s folder, and keeps only the ones that are there', async () => {
    const home = tmp('tade-records-')
    const place = { config: configOf(''), home }
    const all = await recordsFolders(place)
    expect(all.map((one) => one.harness)).toEqual(
      expect.arrayContaining(['pi', 'claude-code', 'codex']),
    )
    for (const one of all) {
      expect(one.path.startsWith('/')).toBe(true)
      expect(one.user).toBeNull()
    }
    const pi = all.find((one) => one.harness === 'pi')?.path ?? ''
    expect(pi.startsWith(homedir())).toBe(true)
    mkdirSync(pi, { recursive: true })
    const here = await recordsHere(place)
    expect(here.map((one) => one.path)).toContain(pi)
    for (const one of here) expect(existsSync(one.path)).toBe(true)
  })
})

describe('work on this machine alone', () => {
  it('is a worktree with commits on no remote, or a checkout with changes not committed', async () => {
    const origin = mkrepo()
    origin.commit('first')
    const base = tmp('tade-pushed-')
    const root = join(base, 'app')
    runGit(base, 'clone', '-q', origin.root, root)
    const config = configOf(`projects:\n  app:\n    root: ${root}\n`)
    expect(await notPushed(config)).toEqual([])

    const tree = join(base, 'wt')
    runGit(root, 'worktree', 'add', '-q', '-b', 'tade/x', tree)
    writeFileSync(join(tree, 'new.txt'), 'new')
    runGit(tree, 'add', 'new.txt')
    runGit(tree, 'commit', '-q', '-m', 'wip')
    // An untracked file is somebody's scratch, not work: only a tracked one changed counts.
    writeFileSync(join(root, 'scratch.txt'), '')
    appendFileSync(join(root, runGit(root, 'ls-files').split('\n')[0] ?? ''), 'changed')

    const found = await notPushed(config)
    expect(found).toEqual([
      { project: 'app', path: root, branch: 'main', ahead: 0, changed: true },
      { project: 'app', path: tree, branch: 'tade/x', ahead: 1, changed: false },
    ])
  })

  it('is nothing for a project whose checkout is not there', async () => {
    const config = configOf(`projects:\n  gone:\n    root: ${join(tmp('tade-gone-'), 'nope')}\n`)
    expect(await notPushed(config)).toEqual([])
  })
})

describe('asking for a backup with nothing set', () => {
  it('says where to name one, and what is missing, without running restic', async () => {
    const ran: string[][] = []
    const restic: Restic = async (args) => {
      ran.push([...args])
      return { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }
    }
    const home = tmp('tade-unset-')
    const none = await backUp({ config: configOf(''), home, restic, env: {} })
    expect(none.ok).toBe(false)
    expect(none.said).toContain('tade host backup --init')
    const nopass = await backUp({
      config: configOf('backup:\n  repository: /somewhere\n'),
      home,
      restic,
      env: {},
    })
    expect(nopass.said).toContain('has no password here')
    expect(ran).toEqual([])
    expect(existsSync(join(home, MANIFEST))).toBe(false)
  })

  it('says restic is not installed where it is not', async () => {
    const home = tmp('tade-norestic-')
    const config = configOf('backup:\n  repository: /somewhere\n  password: pw\n')
    const restic: Restic = async () => ({
      code: 127,
      stdout: '',
      stderr: '',
      timedOut: false,
      missing: true,
    })
    const taken = await backUp({ config, home, restic, env: {} })
    expect(taken.ok).toBe(false)
    expect(taken.said).toContain('restic is not installed here')
  })
})

/**
 * restic's restore as it lays a snapshot out — each path kept, under
 * `--target`, at the path it had — standing in for restic where the question
 * is what Tade does with what it restored, not whether restic restores. The
 * "snapshot" is a copy of those paths made when it is asked to back up.
 */
function standIn(): { restic: Restic; ran: string[][]; kept: string } {
  const kept = tmp('tade-kept-')
  const ran: string[][] = []
  const ok = { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }
  const restic: Restic = async (args) => {
    ran.push([...args])
    if (args[0] === 'backup') {
      rmSync(kept, { recursive: true, force: true })
      for (const path of args.slice(args.lastIndexOf('--exclude') + 2)) {
        cpSync(path, join(kept, path), { recursive: true })
      }
      const summary = { message_type: 'summary', snapshot_id: 'standin0', files_new: 1 }
      return { ...ok, stdout: `${JSON.stringify(summary)}\n` }
    }
    if (args[0] === 'restore') {
      cpSync(kept, args[args.indexOf('--target') + 1] ?? '', { recursive: true })
      return ok
    }
    return { ...ok, code: 1, stderr: `Fatal: the stand-in does not ${args[0]}` }
  }
  return { restic, ran, kept }
}

describe('putting a backup back', () => {
  it('writes over nothing: a held home and one with a journal are refused, a bare one moved aside', async () => {
    const box = await machine()
    const { restic } = standIn()
    const place = { config: box.config, home: box.home, env: {}, restic }
    expect((await backUp(place)).ok).toBe(true)

    const busy = await restoreInto(place, 'latest', { held: 4242 })
    expect(busy.ok).toBe(false)
    expect(busy.said).toContain('pid 4242')
    const kept = await restoreInto(place, 'latest', { held: null })
    expect(kept.ok).toBe(false)
    expect(kept.said).toContain('has a journal already')

    // A new machine where setup has written a config and nothing else, and
    // a session pi already has there under the same name.
    rmSync(box.home, { recursive: true, force: true })
    mkdirSync(box.home)
    writeFileSync(join(box.home, 'config.yaml'), 'workspace:\n  driver: pty\n')
    writeFileSync(box.session, '{"type":"newer"}\n')
    const restored = await restoreInto(place, 'latest', { held: null }, 1_800_000_000_000)
    expect(restored.said).toBe('')
    expect(restored.ok).toBe(true)
    expect(restored.movedAside).toBe(`${box.home}.before-restore-2027-01-15T08-00-00-000Z`)
    expect(readFileSync(join(restored.movedAside ?? '', 'config.yaml'), 'utf8')).toContain(
      'driver: pty',
    )
    expect(readFileSync(join(box.home, 'config.yaml'), 'utf8')).toContain('backup:')
    // The file this machine had stays; the restored copy waits beside the home.
    expect(readFileSync(box.session, 'utf8')).toBe('{"type":"newer"}\n')
    expect(restored.records).toEqual([
      expect.objectContaining({ harness: 'pi', to: dirname(dirname(box.session)), left: 1 }),
    ])
    expect(restored.staging).not.toBeNull()
    expect(readFileSync(join(restored.staging ?? '', box.session), 'utf8')).toBe(
      '{"type":"session"}\n',
    )
  })

  it('says which checkouts to clone where they are not on this machine', async () => {
    const box = await machine()
    const { restic } = standIn()
    const place = { config: box.config, home: box.home, env: {}, restic }
    expect((await backUp(place)).ok).toBe(true)
    rmSync(box.home, { recursive: true, force: true })
    rmSync(box.root, { recursive: true, force: true })
    rmSync(dirname(dirname(box.session)), { recursive: true, force: true })
    const restored = await restoreInto(place, 'latest', { held: null })
    expect(restored.ok).toBe(true)
    expect(restored.missing).toEqual([{ name: 'app', root: box.root, remote: box.origin }])
    expect(restored.staging).toBeNull()
  })

  it('leaves records nothing here keeps where they were restored, and says where', async () => {
    const box = await machine()
    const { restic } = standIn()
    const place = { config: box.config, home: box.home, env: {}, restic }
    expect((await backUp(place)).ok).toBe(true)
    // As if it came from a machine whose agents ran as a user this one has not got.
    const manifest = JSON.parse(readFileSync(join(box.home, MANIFEST), 'utf8'))
    manifest.records = manifest.records.map((one: object) => ({ ...one, user: 'nobody-here' }))
    writeFileSync(join(box.home, MANIFEST), JSON.stringify(manifest))
    await restic(['backup', '--exclude', 'x', box.home, dirname(dirname(box.session))], {})
    rmSync(box.home, { recursive: true, force: true })
    const restored = await restoreInto(place, 'latest', { held: null })
    expect(restored.ok).toBe(true)
    expect(restored.records).toEqual([expect.objectContaining({ harness: 'pi', to: null })])
    expect(restored.staging).not.toBeNull()
  })

  // A backup is outside input: whoever can write to the repository can write
  // the manifest. Each of these is a snapshot written to reach somewhere a
  // restore was never asked to touch — a folder of the person's own, here
  // `victim` — and each leaves it as it was.
  async function tampered() {
    const box = await machine()
    const stand = standIn()
    const place = { config: box.config, home: box.home, env: {}, restic: stand.restic }
    expect((await backUp(place)).ok).toBe(true)
    const victim = tmp('tade-victim-')
    writeFileSync(join(victim, 'mine.txt'), 'the person’s own')
    const manifestAt = join(stand.kept, box.home, MANIFEST)
    const manifest = JSON.parse(readFileSync(manifestAt, 'utf8'))
    const write = (changed: object) =>
      writeFileSync(manifestAt, JSON.stringify({ ...manifest, ...changed }))
    rmSync(box.home, { recursive: true, force: true })
    rmSync(dirname(dirname(box.session)), { recursive: true, force: true })
    const untouched = () => {
      expect(readFileSync(join(victim, 'mine.txt'), 'utf8')).toBe('the person’s own')
      expect(readdirSync(victim)).toEqual(['mine.txt'])
    }
    return { box, place, stand, victim, manifest, write, untouched }
  }

  it('looks for nothing a `../` path in the manifest names, and says how many it would not', async () => {
    const t = await tampered()
    const climb = `${'/..'.repeat(20)}${t.victim}`
    t.write({
      records: [
        ...t.manifest.records,
        { harness: 'pi', user: null, path: climb },
        { harness: 'pi', user: null, path: `${t.victim}/./x` },
        { harness: 'pi', user: null, path: 'relative/x' },
      ],
    })
    const restored = await restoreInto(t.place, 'latest', { held: null })
    expect(restored.ok).toBe(true)
    t.untouched()
    expect(restored.manifest?.unplaceable).toBe(3)
    // The one real folder it held went where pi keeps sessions, and only that.
    expect(restored.records.map((one) => one.from)).toEqual([dirname(dirname(t.box.session))])
    expect(readdirSync(dirname(dirname(t.box.session)))).toEqual(['--app--'])
  })

  it('refuses a manifest whose home has `..` in it, and moves nothing at all', async () => {
    const t = await tampered()
    t.write({ home: `${t.box.home}/../..${t.victim}` })
    const restored = await restoreInto(t.place, 'latest', { held: null })
    expect(restored.ok).toBe(false)
    expect(restored.said).toContain('not a backup Tade took')
    expect(existsSync(t.box.home)).toBe(false)
    t.untouched()
  })

  it('moves nothing through a link the snapshot holds, nor a link inside a folder it moves', async () => {
    const t = await tampered()
    // Where pi's sessions were, a link to the person's folder; and a link to
    // it inside the home, which goes with the home and is never followed.
    const sessions = join(t.stand.kept, dirname(dirname(t.box.session)))
    rmSync(sessions, { recursive: true, force: true })
    symlinkSync(t.victim, sessions)
    symlinkSync(t.victim, join(t.stand.kept, t.box.home, 'projects', 'app', 'link'))
    const restored = await restoreInto(t.place, 'latest', { held: null })
    expect(restored.ok).toBe(true)
    t.untouched()
    expect(restored.records).toEqual([
      expect.objectContaining({ harness: 'pi', to: null, why: 'its path goes through a link' }),
    ])
    expect(existsSync(dirname(dirname(t.box.session)))).toBe(false)
    // The home came back without its link, which waits in the restore's folder, said.
    const link = join(t.box.home, 'projects', 'app', 'link')
    expect(restored.links).toEqual([link])
    expect(() => lstatSync(link)).toThrow(/ENOENT/)
    expect(existsSync(join(t.box.home, 'projects', 'app', 'tasks'))).toBe(true)
    expect(restored.staging).not.toBeNull()
  })

  it('leaves a link inside a records folder where restic put it', async () => {
    const t = await tampered()
    symlinkSync(t.victim, join(t.stand.kept, dirname(t.box.session), 'link'))
    const restored = await restoreInto(t.place, 'latest', { held: null })
    expect(restored.ok).toBe(true)
    expect(restored.records).toEqual([expect.objectContaining({ harness: 'pi', left: 1 })])
    expect(existsSync(join(dirname(t.box.session), 'link'))).toBe(false)
    expect(readFileSync(t.box.session, 'utf8')).toBe('{"type":"session"}\n')
    t.untouched()
  })

  it('decides where records go by this machine’s config, never the one restored', async () => {
    const t = await tampered()
    // The snapshot's config says agents run as a user whose home it would like
    // the conversations put in; this machine's config says nothing of it.
    const config = join(t.stand.kept, t.box.home, 'config.yaml')
    writeFileSync(config, `${readFileSync(config, 'utf8')}agents:\n  user: root\n`)
    t.write({ records: t.manifest.records.map((one: object) => ({ ...one, user: 'root' })) })
    const restored = await restoreInto(t.place, 'latest', { held: null })
    expect(restored.ok).toBe(true)
    expect(restored.records).toEqual([
      expect.objectContaining({ user: 'root', to: null, why: expect.stringContaining('for root') }),
    ])
  })

  it('refuses a snapshot that is not one Tade took, and leaves what came back to look at', async () => {
    const box = await machine()
    const { restic } = standIn()
    const place = { config: box.config, home: box.home, env: {}, restic }
    const other = tmp('tade-other-')
    writeFileSync(join(other, 'file'), 'somebody else’s')
    await restic(['backup', '--exclude', 'x', other], {})
    rmSync(box.home, { recursive: true, force: true })
    const restored = await restoreInto(place, 'latest', { held: null })
    expect(restored.ok).toBe(false)
    expect(restored.said).toContain('not a backup Tade took')
    expect(existsSync(join(restored.staging ?? '', other, 'file'))).toBe(true)
    expect(existsSync(box.home)).toBe(false)
  })

  it('says restic’s own words where it could not restore, and takes away what it began', async () => {
    const box = await machine()
    const place = {
      config: box.config,
      home: box.home,
      env: {},
      restic: (async () => ({
        code: 12,
        stdout: '',
        stderr: 'Fatal: wrong password or no key found\n',
        timedOut: false,
        missing: false,
      })) satisfies Restic,
    }
    rmSync(box.home, { recursive: true, force: true })
    const refused = await restoreInto(place, 'latest', { held: null })
    expect(refused).toEqual(expect.objectContaining({ ok: false, staging: null }))
    expect(refused.said).toBe('Fatal: wrong password or no key found')
    expect(readdirSync(dirname(box.home)).filter((n) => n.startsWith('.tade-restore-'))).toEqual([])
    expect(await initRepository(place)).toEqual({
      ok: false,
      said: 'Fatal: wrong password or no key found',
    })
    expect(await restoreTo(place, 'latest', tmp('tade-look-'))).toEqual({
      ok: false,
      said: 'Fatal: wrong password or no key found',
    })
    expect(await snapshotsIn(place)).toEqual({
      ok: false,
      said: 'Fatal: wrong password or no key found',
    })
  })
})

describe.skipIf(RESTIC === null)(
  `a backup, restored${RESTIC === null ? ' (restic is not installed here)' : ''}`,
  () => {
    it('keeps the truth and none of what is derived, and puts it back as it was', async () => {
      const box = await machine()
      const place = { config: box.config, home: box.home, env: {} }
      expect((await initRepository(place)).ok).toBe(true)
      const events = await readJournal(box.home)
      // What the workbench made beside the truth, which a backup leaves out.
      expect(existsSync(join(box.home, 'events.jsonl.db'))).toBe(true)
      expect(existsSync(join(box.home, 'worktrees'))).toBe(true)

      const taken = await backUp(place)
      expect(taken.said).toBe('')
      expect(taken.ok).toBe(true)
      expect(taken.errors).toEqual([])
      expect(taken.manifest?.projects).toEqual([
        { name: 'app', root: box.root, remote: box.origin },
      ])
      const listed = await snapshotsIn(place)
      expect(listed.ok && listed.snapshots.map((one) => one.id)).toEqual([taken.summary?.snapshot])

      // What the snapshot holds, asked of restic itself.
      const ls = await runProgram('restic', ['ls', 'latest'], {
        env: {
          ...process.env,
          RESTIC_REPOSITORY: box.repository,
          RESTIC_PASSWORD: 'correct horse battery staple',
        },
      })
      const held = ls.stdout.split('\n')
      for (const kept of ['events.jsonl', 'memory.jsonl', 'config.yaml', MANIFEST]) {
        expect(held, kept).toContain(join(box.home, kept))
      }
      expect(held).toContain(box.session)
      for (const left of ['events.jsonl.db', 'tade.lock', 'worktrees', 'runs']) {
        expect(held, left).not.toContain(join(box.home, left))
      }
      expect(held.some((line) => line.startsWith(join(box.home, 'worktrees')))).toBe(false)

      // The machine is lost, and so is pi's record of it.
      rmSync(box.home, { recursive: true, force: true })
      rmSync(dirname(dirname(box.session)), { recursive: true, force: true })

      const restored = await restoreInto(place, 'latest', { held: null })
      expect(restored.said).toBe('')
      expect(restored.ok).toBe(true)
      expect(restored.staging).toBeNull()
      expect(restored.movedAside).toBeNull()
      expect(restored.missing).toEqual([])
      expect(restored.records).toEqual([
        expect.objectContaining({ harness: 'pi', to: dirname(dirname(box.session)), left: 0 }),
      ])
      expect(readFileSync(box.session, 'utf8')).toBe('{"type":"session"}\n')
      expect(existsSync(join(box.home, 'events.jsonl.db'))).toBe(false)
      expect(existsSync(join(box.home, 'tade.lock'))).toBe(false)
      // Nothing of the restore is left beside the home.
      expect(
        readdirSync(dirname(box.home)).filter((name) => name.startsWith('.tade-restore-')),
      ).toEqual([])

      // Tade opens on what came back: the journal it had, its index built
      // again, the task and the note.
      const again = await Workbench.open({ home: box.home })
      shut.push(again)
      const after = await readJournal(box.home)
      expect(after.slice(0, events.length)).toEqual(events)
      expect(existsSync(join(box.home, 'events.jsonl.db'))).toBe(true)
      expect(
        Memory.open(box.home)
          .all()
          .map((one) => one.text),
      ).toContain('the backup keeps what I said')
      const file = join(box.home, 'projects', 'app', 'tasks', 'kept', 'task.yaml')
      expect(readFileSync(file, 'utf8')).toContain(`id: ${box.task}`)
    })

    it('cuts a journal line the backup caught half-written, so the next one parses', async () => {
      const box = await machine()
      const place = { config: box.config, home: box.home, env: {} }
      await initRepository(place)
      const half = '{"seq":99999,"type":"half'
      appendFileSync(join(box.home, 'events.jsonl'), half)
      expect((await backUp(place)).ok).toBe(true)
      rmSync(box.home, { recursive: true, force: true })
      const restored = await restoreInto(place, 'latest', { held: null })
      expect(restored.cut).toEqual([{ path: join(box.home, 'events.jsonl'), bytes: half.length }])
      const again = await Workbench.open({ home: box.home })
      shut.push(again)
      await again.close()
      shut.pop()
      const lines = readFileSync(join(box.home, 'events.jsonl'), 'utf8').trim().split('\n')
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    })

    it('restores a snapshot holding a `../` path inside its own folder, and places nothing of it', async () => {
      const box = await machine()
      const place = { config: box.config, home: box.home, env: {} }
      await initRepository(place)
      // Written as restic takes anything from standard input, by a name that climbs.
      execFileSync('restic', ['backup', '--stdin', '--stdin-filename', '../../escaped.txt'], {
        input: 'escaped',
        env: {
          ...process.env,
          RESTIC_REPOSITORY: box.repository,
          RESTIC_PASSWORD: 'correct horse battery staple',
        },
        stdio: ['pipe', 'ignore', 'ignore'],
      })
      rmSync(box.home, { recursive: true, force: true })
      const restored = await restoreInto(place, 'latest', { held: null })
      expect(restored.ok).toBe(false)
      expect(restored.said).toContain('not a backup Tade took')
      // restic kept it inside the folder it was given, and Tade moved none of it.
      expect(readFileSync(join(restored.staging ?? '', 'escaped.txt'), 'utf8')).toBe('escaped')
      for (let up = dirname(box.home); up !== '/'; up = dirname(up)) {
        expect(existsSync(join(up, 'escaped.txt')), up).toBe(false)
      }
      expect(existsSync(box.home)).toBe(false)
    })

    it('puts a snapshot under a folder to look at, moving nothing, and says restic’s words when it fails', async () => {
      const box = await machine()
      const place = { config: box.config, home: box.home, env: {} }
      await initRepository(place)
      expect((await backUp(place)).ok).toBe(true)
      const folder = tmp('tade-look-')
      expect((await restoreTo(place, 'latest', folder)).ok).toBe(true)
      expect(existsSync(join(folder, box.home, 'events.jsonl'))).toBe(true)
      const wrong = { ...place, env: { RESTIC_PASSWORD: 'not the password' } }
      const refused = await snapshotsIn(wrong)
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.said.length).toBeGreaterThan(0)
      expect((await restoreInto(wrong, 'latest', { held: null })).ok).toBe(false)
      // A repository made twice is refused the second time, by restic.
      expect((await initRepository(place)).ok).toBe(false)
    })
  },
)

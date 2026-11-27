import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConfigSchema,
  feedDir,
  machineLabel,
  mirrorDir,
  mirrorMachine,
  mirrorRef,
  NOT_A_REMOTE,
  parseConfig,
  travels,
  writeSetting,
} from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { heldIn } from '@tade/workbench/config-changes'
import {
  keptInventoryPath,
  machineFolder,
  ownInventoryPath,
  readInventory,
} from '@tade/workbench/inventory'
import { readTaskFile } from '@tade/workbench/tasks'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkrepo, runGit, tmp } from '../../../../test/fixtures/mkrepo.ts'
import rehearsalIntake from '../../../../test/fixtures/rehearsal/extension.ts'
import {
  STAND_IN,
  startStandIn,
  writeStandInModels,
} from '../../../../test/fixtures/stand-in-model.ts'
import { recordFromShell } from '../../../cli/src/config-write.ts'
import { makeSshLink, pathsFor } from '../../../remotes/ssh/src/index.ts'
import { startSshd } from '../../../remotes/ssh/test/sshd.ts'
import type { App } from '../../src/app.ts'
import { type FakeTerminal, SPAWNING_MS, screenOf, until, windowUnderTest } from './harness.ts'

// The remote story, end to end, as far as it runs on one machine with no
// root — the half of the rehearsal CI can hold. Its other half needs a box of
// its own (systemd, Caddy, a public name) and is `scripts/rehearse-remote.sh`.
//
// Two machines that stand for two VPSes, each the real `tade serve` holding a
// home of its own with a project in it, reached through a real `sshd`; their
// pi pointed at the stand-in model (`stand-in-model.ts`), so each one's
// orchestrator starts work when asked and each agent does it and says it is
// done. This machine pairs with both as an owner through the real `tade
// remote add`, and its window — the one under test — holds both links. Then,
// in order: a project on each drawn here; an agent started on each from that
// machine's tab and seen working and finished from here; the window closed
// while more work finishes there, and opened again on "since you were here"
// and the notes taken there; a task here handed to one of them; and what
// each says of itself — status, documents, checks — read from here.
//
// And the project's branch kept in step across them: a VPS whose checkout is a
// clone of the Mac's, a commit the Mac never pushed to origin handed into that
// VPS's mirror over the same sshd, and that VPS's own `tade serve`
// fast-forwarding its checkout to it with nobody there.
//
// And the settings kept in step both ways: a change made on each while the
// window here was shut, the later of the two standing on both and said as a
// conflict on both, a setting only the box had coming back here, the box's
// own staying its own, and a section it pinned staying as it was.
//
// And each machine's journal kept on the other: the box's lines here and this
// Mac's there, each a copy of what travels exactly as written, the two said to
// be in step on both, and `tade machines` saying so from the files.
//
// And work waiting on work across them: queued work here after a task on the
// box, held while that task works, held while the cable is cut and it finishes
// there, and started once its `task_done` has come back over the link; and a
// plan's work for later placed on the box, the hub, and started there with
// this Mac shut.
//
// And one repository open on both, watched from exactly one of them
// (`duties.ts`): the Mac, whose setting says here, looking while it is linked;
// the box taking the watch over within the lease once the cable is cut, with
// what the Mac had found; the Mac taking it back once the cable is in again,
// with what the box had found — and every request found once, on one machine.
//
// And one reload of every machine (`fleet-reload.ts`), pressed here with one
// box's cable cut: the other asked over the real sshd what it runs and to
// restart through its own door, a `tade serve` nothing keeps saying so in its
// own words and left running, the cut one said as not reached, and this
// window reloaded last. The service's restart and `tade host upgrade` moving
// a box that is behind need systemd and a box, so they are the script's.

const bin = fileURLToPath(new URL('../../../cli/src/bin.ts', import.meta.url))
const sshd = await startSshd()
const model = await startStandIn({ workSeconds: 2 })
afterAll(async () => {
  await model.close()
  if (typeof sshd !== 'string') await sshd.stop()
})

const TOMORROW = new Date(Date.now() + 24 * 3_600_000).toISOString()

/** A port the machine has just said is free. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const address = server.address()
  await new Promise<void>((done) => server.close(() => done()))
  return typeof address === 'object' && address !== null ? address.port : 0
}

/** One machine standing for a VPS: a home, a project, and `tade serve` holding it. */
interface Box {
  name: string
  home: string
  root: string
  /** The command that is Tade there, one word, as a remote shell reads it. */
  tade: string
  journal(): string
  serving: ChildProcess
}

const started: ChildProcess[] = []
afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null) child.kill('SIGTERM')
})

/**
 * One box, its checkout a fresh repository or, given `from`, a clone of the
 * checkout there; its pi pointed at `standIn`, the shared stand-in unless named.
 */
async function box(
  name: string,
  project: string,
  dir: string,
  from?: string,
  standIn = model.url,
  sync?: 'ff',
  /** What else is in its home before its `tade serve` starts. */
  prepare?: (home: string) => void,
): Promise<Box> {
  const repo = mkrepo()
  repo.commit('first')
  let root = repo.root
  if (from === undefined) {
    // One repository, as GitHub names it, on this box and (for `app`) the Mac.
    runGit(root, 'remote', 'add', 'origin', `git@github.com:acme/${project}.git`)
  } else {
    root = join(tmp('tade-clone-'), 'repo')
    runGit(repo.root, 'clone', '-q', from, root)
    runGit(root, 'remote', 'set-url', 'origin', `git@github.com:acme/${project}.git`)
  }
  const pi = join(repo.home, 'pi')
  writeStandInModels(pi, standIn)
  writeFileSync(
    join(repo.home, 'config.yaml'),
    [
      'projects:',
      `  ${project}:`,
      `    root: ${root}`,
      ...(sync ? [`    sync: ${sync}`] : []),
      'surfaces:',
      '  web:',
      '    enabled: true',
      `    port: ${await freePort()}`,
      'orchestrator:',
      `  model: ${STAND_IN.provider}/${STAND_IN.model}`,
      '',
    ].join('\n'),
  )
  prepare?.(repo.home)
  const env = { TADE_HOME: repo.home, HOME: repo.home, PI_CODING_AGENT_DIR: pi }
  const tade = join(dir, `tade-${name}`)
  const exported = Object.entries(env)
    .map(([key, value]) => `${key}='${value}'`)
    .join(' ')
  writeFileSync(tade, `#!/bin/sh\n${exported} exec '${process.execPath}' '${bin}' "$@"\n`)
  chmodSync(tade, 0o755)
  const serving = spawn(process.execPath, [bin, 'serve'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  started.push(serving)
  let said = ''
  serving.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    said += chunk
  })
  await until(
    `${name}'s tade serve to hold its home`,
    () => said.includes('with no screen.'),
    60_000,
  )
  return {
    name,
    home: repo.home,
    root,
    tade,
    serving,
    journal: () => readFileSync(join(repo.home, 'events.jsonl'), 'utf8'),
  }
}

/** A setting changed from a terminal on one home, the way `tade config` writes one and its line. */
async function changedFromShell(home: string, writes: { key: string; value: unknown }[]) {
  const path = join(home, 'config.yaml')
  const before = heldIn(path)
  for (const one of writes) writeSetting(path, one.key, one.value as never)
  await recordFromShell(
    path,
    before,
    writes as never,
    (said) => {
      throw new Error(said)
    },
    home,
  )
}

/** A home's notes file, or nothing where no note has been written there yet. */
function notesIn(home: string): string {
  const path = join(home, 'memory.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

const cannot = typeof sshd === 'string' ? sshd : null

describe.skipIf(cannot !== null)(
  `two VPSes and a Mac, the whole story${cannot ? ` (${cannot})` : ''}`,
  () => {
    let terminal: FakeTerminal
    const wired = windowUnderTest((one) => {
      terminal = one.terminal
    })
    const rows = () => screenOf(terminal.written)
    const shown = (text: string) => rows().some((row) => row.includes(text))
    /** The lower pane's row of tabs: the one that starts the strip and names the orchestrator. */
    const tabs = () => rows().findLast((row) => row.startsWith('━') && row.includes('orchestrator'))
    function tab(label: string): void {
      const lines = rows()
      const at = lines.findLastIndex((row) => row.startsWith('━') && row.includes('orchestrator'))
      const col = lines[at]?.indexOf(` ${label} `) ?? -1
      if (col < 0) throw new Error(`no tab "${label}" on ${lines[at]}`)
      wired.click(col + 1, at)
    }
    /** Type a sentence on the tab that is in front, as a person would. */
    async function say(machine: string, sentence: string): Promise<void> {
      tab(machine)
      await until(`${machine}'s tab`, () =>
        shown(`what you type here goes to the orchestrator on ${machine}`),
      )
      for (const char of sentence) terminal.press(char)
      terminal.press('\r')
    }

    /**
     * `tade remote add`, the real command, for each box: ssh is the real one,
     * told where this run's sshd and keys are. What it wrote is the remotes.
     */
    function pair(sshd: { dir: string; config: string }, boxes: readonly Box[]) {
      const shims = join(wired.home, 'shims')
      mkdirSync(shims, { recursive: true })
      const ssh = spawnSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).stdout.trim()
      writeFileSync(join(shims, 'ssh'), `#!/bin/sh\nexec '${ssh}' -F '${sshd.config}' "$@"\n`)
      chmodSync(join(shims, 'ssh'), 0o755)
      for (const one of boxes) {
        const added = spawnSync(
          process.execPath,
          [bin, 'remote', 'add', one.name, '--ssh', 'far', '--tade', one.tade, '--json'],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              TADE_HOME: wired.home,
              HOME: wired.home,
              TADE_NO_GH: '1',
              PATH: `${shims}:${process.env.PATH}`,
            },
            timeout: 90_000,
          },
        )
        expect(added.status, added.stderr).toBe(0)
        expect(JSON.parse(added.stdout)).toMatchObject({ name: one.name, ssh: 'far' })
      }
      const written = parseConfig(readFileSync(join(wired.home, 'config.yaml'), 'utf8'))
      if (!written.ok) throw new Error('remote add wrote a config that does not read')
      return written.config.remotes
    }

    it('pairs with both, starts and sees their work, comes back to what happened, hands work over and reads them', async () => {
      if (typeof sshd === 'string') return
      const vps1 = await box('vps1', 'app', sshd.dir)
      const vps2 = await box('vps2', 'site', sshd.dir)

      const remotes = pair(sshd, [vps1, vps2])
      expect(Object.keys(remotes).sort()).toEqual(['vps1', 'vps2'])

      // This Mac's window, holding both links over ssh.
      runGit(wired.repo.root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
      terminal.rows = 50
      terminal.columns = 160
      const open = (): Promise<App> =>
        wired.start({
          config: ConfigSchema.parse({
            projects: { app: { root: wired.repo.root } },
            remotes,
          }),
          remoteLinks: { ssh: (options) => makeSshLink({ ...options, args: ['-F', sshd.config] }) },
          thinker: { ask: async () => 'ok', tell: async () => {} },
        })
      let window = await open()

      // 1. A project on each, under its machine along the top.
      await until(
        'both machines’ projects along the top',
        () => /vps1\]?\s+app/.test(rows()[0] ?? '') && /vps2\]?\s+site/.test(rows()[0] ?? ''),
        60_000,
      )

      // 2. An agent started on each from its own tab, seen finished from here.
      await say('vps1', 'start app/refunds: fix refunds double-charge')
      await say('vps2', 'start site/landing: write the landing page')
      await until(
        'both agents finished, drawn here',
        () => /vps1\]?\s+app ✓/.test(rows()[0] ?? '') && /vps2\]?\s+site ✓/.test(rows()[0] ?? ''),
        120_000,
      )
      expect(vps1.journal()).toContain('"task":"app/refunds"')
      expect(vps2.journal()).toContain('"type":"person_present"')
      // Each knows this Mac is up: its link beats there, and the first beat is a line.
      expect(vps1.journal()).toMatch(/"type":"machine_seen"[^\n]*"way":"from","state":"up"/)

      // 2b. A question passed on by this machine's orchestrator is answered here with vps1's words.
      await wired.client.log.append({
        type: 'said',
        detail: { text: 'ask vps1 to start the audit' },
      })
      const answer = await window.remoteTools().tell({
        machine: 'vps1',
        said: 'start app/audit: audit the refunds log',
        asked: 'ask vps1 to start the audit',
      })
      expect(answer).toContain('The orchestrator on vps1 answered')
      expect(vps1.journal()).toContain('"task":"app/audit"')

      // 3. The window closed while more work finishes there, and a note is
      // taken on vps2; opened again, each says what happened since.
      await say('vps1', 'start app/ledger: reconcile the ledger nightly')
      await until('vps1 to start it', () => vps1.journal().includes('"task":"app/ledger"'), 60_000)
      await window.stop()
      // The window said goodbye as it quit: closed there, within a beat, and not lost.
      await until(
        'vps1 to know this Mac closed',
        () => /"type":"machine_seen"[^\n]*"way":"from","state":"closed"/.test(vps1.journal()),
        10_000,
      )
      expect(vps1.journal()).not.toMatch(/"type":"machine_seen"[^\n]*"state":"lost"/)
      const noted = spawnSync(vps2.tade, ['remember', 'the faq answers come from support'], {
        encoding: 'utf8',
      })
      expect(noted.status, noted.stderr).toBe(0)
      await until(
        'the ledger finished with nobody here',
        () => /"type":"task_done"[^\n]*"task":"app\/ledger"/.test(vps1.journal()),
        60_000,
      )
      terminal = wired.newTerminal()
      terminal.rows = 50
      terminal.columns = 160
      window = await open()
      await until('vps1, since you were here', () => shown('vps1, since you were here'), 60_000)
      await until(
        'the note taken on vps2, here',
        () => notesIn(wired.home).includes('the faq answers come from support'),
        60_000,
      )

      // 4. Work queued here, handed to vps1, where the same repository is a project.
      await wired.client.createTask({
        project: 'app',
        slug: 'pricing',
        intent: 'add the pricing page, the way we said',
        by: 'you',
        start: { after: [], prompt: 'Build the pricing page.', touches: [], at: TOMORROW },
      })
      await until('the queued work in the side', () => shown('pricing'), 30_000)
      const row = wired.find('pricing')
      wired.click(row.col, row.row)
      await until('Start on vps1 on its card', () => shown('Start on vps1'), 30_000)
      const button = wired.find('Start on vps1')
      wired.click(button.col + 1, button.row)
      await until(
        'vps1 took it',
        async () => (await readTaskFile(vps1.home, 'app/pricing')) !== null,
        60_000,
      )
      await until(
        'gone from this queue',
        async () => (await readTaskFile(wired.home, 'app/pricing')) === null,
      )
      expect(vps1.journal()).toContain('"type":"task_taken"')

      // 5. What each says of itself, read from here.
      const tools = window.remoteTools()
      const status = JSON.parse(await tools.status('vps1')) as Record<string, unknown>
      expect(JSON.stringify(status)).toContain('app/refunds')
      expect(await tools.documents({ machine: 'vps2' })).toContain(
        'No document was produced there.',
      )
      const checks = await tools.tool({ machine: 'vps1', tool: 'checks_list', input: {} })
      expect(checks).toContain('app')
      expect(tabs()).toBeDefined()

      // 6. vps2's Tade closes: this machine hears its goodbye, and a window
      // opened while it is closed still draws what it last said, as of then.
      vps2.serving.kill('SIGTERM')
      await until(
        'vps2 known closed here',
        () =>
          /"type":"machine_seen"[^\n]*"machine":"vps2","way":"to","state":"closed"/.test(
            readFileSync(join(wired.home, 'events.jsonl'), 'utf8'),
          ),
        30_000,
      )
      await window.stop()
      expect(existsSync(join(wired.home, 'machines', 'vps2', 'projection.json'))).toBe(true)
      terminal = wired.newTerminal()
      terminal.rows = 50
      terminal.columns = 160
      window = await open()
      await until(
        'vps2 drawn from what it last said, marked down',
        () => /○ vps2\]?\s+site/.test(rows()[0] ?? ''),
        60_000,
      )
      await window.stop()
    }, 480_000)

    it('hands the Mac’s commit into a VPS’s mirror over ssh, and that VPS keeps its checkout in step by itself', async () => {
      if (typeof sshd === 'string') return
      // One repository on both: the VPS's checkout a clone of the Mac's, then
      // a commit on the Mac that never went to origin.
      runGit(wired.repo.root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
      // `ff` said there: by default a commit only another machine has waits for the person.
      const vps = await box('vps', 'app', sshd.dir, wired.repo.root, model.url, 'ff')
      const was = runGit(vps.root, 'rev-parse', 'HEAD').trim()
      const mine = wired.repo.commit('only on the Mac', { 'pricing.ts': 'never pushed\n' })
      const remotes = pair(sshd, [vps])
      const before = runGit(wired.repo.root, 'for-each-ref')

      const window = await wired.start({
        config: ConfigSchema.parse({ projects: { app: { root: wired.repo.root } }, remotes }),
        remoteLinks: { ssh: (options) => makeSshLink({ ...options, args: ['-F', sshd.config] }) },
        thinker: { ask: async () => 'ok', tell: async () => {} },
      })
      // Handed over the link into the mirror the VPS named, under this Mac's name.
      const as = mirrorMachine(machineLabel())
      const theirs = mirrorDir(vps.home, 'app')
      await until(
        'the Mac’s main in the VPS’s mirror',
        () => {
          const held = spawnSync(
            'git',
            ['-C', theirs, 'rev-parse', '--verify', '--quiet', mirrorRef(as, 'main')],
            { encoding: 'utf8' },
          )
          return held.stdout.trim() === mine
        },
        90_000,
      )
      // Then the VPS's heart, on its own beat: its checkout fast-forwarded, written down.
      await until(
        'the VPS’s checkout moved to the Mac’s commit',
        () => /"type":"project_synced"/.test(vps.journal()),
        120_000,
      )
      expect(runGit(vps.root, 'rev-parse', 'HEAD').trim()).toBe(mine)
      expect(readFileSync(join(vps.root, 'pricing.ts'), 'utf8')).toBe('never pushed\n')
      const synced = vps
        .journal()
        .split('\n')
        .filter((line) => line.includes('"type":"project_synced"'))
        .map((line) => JSON.parse(line) as { detail: Record<string, unknown> })
      expect(synced).toHaveLength(1)
      expect(synced[0]?.detail).toMatchObject({
        project: 'app',
        branch: 'main',
        from: as,
        was,
        now: mine,
        files: ['pricing.ts'],
      })
      // Nothing written into the Mac's checkout by handing it over.
      expect(runGit(wired.repo.root, 'for-each-ref')).toBe(before)
      expect(wired.repo.head()).toBe(mine)
      await window.stop()
    }, 300_000)

    it('reads what a VPS has over ssh and keeps a copy, and tells that VPS what this Mac has', async () => {
      if (typeof sshd === 'string') return
      const vps = await box('vps', 'app', sshd.dir)
      const remotes = pair(sshd, [vps])
      const window = await wired.start({
        config: ConfigSchema.parse({ projects: { app: { root: wired.repo.root } }, remotes }),
        remoteLinks: { ssh: (options) => makeSshLink({ ...options, args: ['-F', sshd.config] }) },
        thinker: { ask: async () => 'ok', tell: async () => {} },
      })
      // One machine stands for both here, so each copy is told from the other
      // by when it was looked at: the moment each machine kept for itself.
      const ownAt = async (home: string) =>
        (await readInventory(ownInventoryPath(home)))?.inventory.at

      // What the VPS has, read over `/api/machine` through the real sshd: a
      // column of its own in what the orchestrator reads, and a copy kept here.
      const tools = window.inventoryTools()
      const column = async () => {
        const read = JSON.parse(await tools.read()) as {
          machines: { machine: string; asOf: string | null; said: string | null }[]
        }
        return read.machines.find((one) => one.machine === 'vps')
      }
      await until(
        'what the VPS has, read here',
        async () => (await column())?.asOf != null,
        150_000,
      )
      expect((await column())?.said).toBeNull()
      const here = keptInventoryPath(wired.home, 'vps')
      if (here === null) throw new Error('vps has no folder here')
      await until(
        'a copy of what the VPS has, kept here',
        async () => (await readInventory(here)) !== null,
      )
      const read = await readInventory(here)
      expect(read?.inventory.at).toBe(await ownAt(vps.home))

      // What this Mac has, told the VPS over `/api/inventory` once it answered
      // with an inventory of its own, and kept in the VPS's home under this Mac's name.
      const mac = machineFolder(machineLabel())
      const there = mac === null ? null : keptInventoryPath(vps.home, mac)
      if (there === null) throw new Error('this Mac has no folder name')
      await until(
        'what this Mac has, kept on the VPS',
        async () => (await readInventory(there)) !== null,
        150_000,
      )
      const told = await readInventory(there)
      expect(told?.inventory.machine).toBe(machineLabel())
      expect(told?.inventory.at).toBe(await ownAt(wired.home))
      await window.stop()
    }, 360_000)

    it('keeps settings in step both ways: the later of two changes made apart stands on both, and is said', async () => {
      if (typeof sshd === 'string') return
      const vps = await box('vps', 'app', sshd.dir)
      const remotes = pair(sshd, [vps])
      const configOf = (home: string) => {
        const read = parseConfig(readFileSync(join(home, 'config.yaml'), 'utf8'))
        if (!read.ok) throw new Error(`${home}'s config does not read`)
        return read.config
      }
      // On the box, with the window here shut: a preference changed, one this
      // Mac never had, and its checks pinned to itself.
      await changedFromShell(vps.home, [
        { key: 'queue.holds', value: 'ask' },
        { key: 'notes.keep_days', value: 9 },
        { key: 'machine.pinned', value: ['checks'] },
        { key: 'checks.before', value: 'commit' },
      ])
      await until(
        'the box to write down what its terminal changed',
        () => (vps.journal().match(/"type":"config_changed"/g) ?? []).length >= 4,
        60_000,
      )
      // Then here, later: the same preference another way, the checks, and this machine's own driver.
      await changedFromShell(wired.home, [
        { key: 'queue.holds', value: 'orchestrator' },
        { key: 'checks.before', value: 'push' },
        { key: 'workspace.driver', value: 'tmux' },
      ])
      const window = await wired.start({
        config: ConfigSchema.parse({ remotes }),
        remoteLinks: { ssh: (options) => makeSshLink({ ...options, args: ['-F', sshd.config] }) },
        thinker: { ask: async () => 'ok', tell: async () => {} },
      })
      await until(
        'the later change on the box, and the box’s own setting here',
        () =>
          configOf(vps.home).queue.holds === 'orchestrator' &&
          configOf(wired.home).notes.keep_days === 9,
        120_000,
      )
      // One conflict, written on both and said here; nothing else is one.
      const conflicts = (journal: string) =>
        journal
          .split('\n')
          .filter((line) => line.includes('"type":"settings_conflict"'))
          .map((line) => (JSON.parse(line) as { detail: Record<string, string> }).detail)
      const here = () => readFileSync(join(wired.home, 'events.jsonl'), 'utf8')
      // Written once what came back is taken, so waited for rather than read at once.
      await until(
        'the conflict written down on both machines',
        () => conflicts(here()).length > 0 && conflicts(vps.journal()).length > 0,
        60_000,
      )
      expect(conflicts(here())).toEqual([
        expect.objectContaining({ path: 'queue.holds', kept: 'orchestrator', lost: 'ask' }),
      ])
      expect(conflicts(vps.journal())).toEqual([
        expect.objectContaining({ path: 'queue.holds', kept: 'orchestrator', lost: 'ask' }),
      ])
      // Said here: in what the window said, and its end drawn as the strip's latest words.
      // Not its first words on screen: the strip is four rows, and a long sentence's
      // start may have scrolled above them — said all the same. Read as a person reads
      // wrapped text, rows joined, since where it wraps is the terminal's to say.
      const said = () =>
        (
          window as unknown as { wire: { state: { transcript: { entries: { text?: string }[] } } } }
        ).wire.state.transcript.entries.filter((one) =>
          one.text?.startsWith('Changed on both vps and here: queue.holds: '),
        )
      const strip = () => {
        const lines = rows()
        const top = lines.findLastIndex(
          (row) => row.startsWith('━') && row.includes('orchestrator'),
        )
        const end = lines.findIndex((row, at) => at > top && row.startsWith('─'))
        return lines
          .slice(top + 1, end)
          .map((row) => row.replace(/[▕█]\s*$/, '').trim())
          .filter((row) => row !== '')
          .join(' ')
      }
      await until('the conflict said here', () => said().length > 0 && strip().endsWith('’s kept.'))
      expect(said()).toHaveLength(1)
      // Each side as the person names it: both are this host, so a host name would be both.
      expect(said()[0]?.text).toMatch(
        /^Changed on both vps and here: queue\.holds: vps set ask at \d\d:\d\d, this machine set orchestrator at \d\d:\d\d; this machine’s kept\./,
      )
      // The box's own stays its own, and so does what it pinned.
      expect(configOf(vps.home).workspace.driver).toBe('pty')
      expect(configOf(vps.home).checks.before).toBe('commit')
      // And it settles: carried again, nothing more is taken or said.
      expect(configOf(wired.home).queue.holds).toBe('orchestrator')
      await window.stop()
    }, 300_000)

    it('keeps each machine’s journal on the other, line for line, says they are in step, and `tade machines` says so', async () => {
      if (typeof sshd === 'string') return
      const vps = await box('vps', 'app', sshd.dir)
      const remotes = pair(sshd, [vps])
      const window = await wired.start({
        config: ConfigSchema.parse({ projects: { app: { root: wired.repo.root } }, remotes }),
        remoteLinks: { ssh: (options) => makeSshLink({ ...options, args: ['-F', sshd.config] }) },
        thinker: { ask: async () => 'ok', tell: async () => {} },
      })
      const idOf = (home: string) =>
        (JSON.parse(readFileSync(join(home, 'machine.json'), 'utf8')) as { id: string }).id
      const linesOf = (path: string) =>
        existsSync(path)
          ? readFileSync(path, 'utf8')
              .split('\n')
              .filter((one) => one !== '')
          : []
      const copyHere = () => linesOf(join(feedDir(wired.home, idOf(vps.home)), 'events.jsonl'))
      const copyThere = () => linesOf(join(feedDir(vps.home, idOf(wired.home)), 'events.jsonl'))
      await until(
        'the box’s journal kept here, and this Mac’s kept on the box',
        () => copyHere().length > 0 && copyThere().length > 0,
        150_000,
      )
      // A copy is the origin's own lines that travel, in order, exactly as written.
      const travelling = (journal: string) =>
        journal
          .split('\n')
          .filter((one) => one !== '' && travels((JSON.parse(one) as { type: string }).type))
      const kept = copyHere()
      expect(travelling(vps.journal()).slice(0, kept.length)).toEqual(kept)
      expect(kept.some((one) => one.includes('"type":"tade_opened"'))).toBe(true)
      expect(kept.some((one) => one.includes('"type":"output"'))).toBe(false)
      // Where the two stand, written down on both once they are in step.
      const inStep = (journal: string) =>
        journal
          .split('\n')
          .filter((one) => one.includes('"type":"remote_synced"'))
          .some(
            (one) => (JSON.parse(one) as { detail: { word: string } }).detail.word === 'in step',
          )
      const here = () => readFileSync(join(wired.home, 'events.jsonl'), 'utf8')
      await until(
        'in step, written down here and on the box',
        () => inStep(here()) && inStep(vps.journal()),
        150_000,
      )
      const machines = spawnSync(process.execPath, [bin, 'machines', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, TADE_HOME: wired.home, HOME: wired.home },
        timeout: 60_000,
      })
      expect(machines.status, machines.stderr).toBe(0)
      const fleet = JSON.parse(machines.stdout) as {
        window: boolean
        rows: {
          name: string
          way: string
          id: string | null
          state: string | null
          sync: { word: string } | null
        }[]
      }
      expect(fleet.window).toBe(true)
      expect(fleet.rows).toEqual([
        expect.objectContaining({
          name: 'vps',
          way: 'to',
          id: idOf(vps.home),
          state: 'up',
          sync: expect.anything(),
        }),
      ])
      await window.stop()
    }, 360_000)

    it('holds work here after a task on the box while it works and while the cable is cut, and starts it once its task_done comes back', async () => {
      if (typeof sshd === 'string') return
      // The box's agent works long enough to be waited on, cut off, and finish apart.
      const slow = await startStandIn({ workSeconds: 45 })
      try {
        const vps = await box('vps', 'app', sshd.dir, undefined, slow.url)
        const remotes = pair(sshd, [vps])
        // No hub: the box, the one machine linked, would be it, and the hub's
        // tab folds into this strip (`sharesWith`) — A is typed on its own tab.
        // In the file too, which the window reads again.
        writeSetting(join(wired.home, 'config.yaml'), 'machine.hub', NOT_A_REMOTE)
        // The link's own ssh config, so the cable can be cut and put back.
        const cable = join(wired.home, 'ssh_config')
        copyFileSync(sshd.config, cable)
        terminal.rows = 50
        terminal.columns = 160
        const window = await wired.start({
          config: ConfigSchema.parse({
            projects: { app: { root: wired.repo.root } },
            remotes,
            machine: { hub: NOT_A_REMOTE },
          }),
          remoteLinks: { ssh: (options) => makeSshLink({ ...options, args: ['-F', cable] }) },
          thinker: { ask: async () => 'ok', tell: async () => {} },
        })
        const idOf = (home: string) =>
          (JSON.parse(readFileSync(join(home, 'machine.json'), 'utf8')) as { id: string }).id
        const copy = () => {
          const path = join(feedDir(wired.home, idOf(vps.home)), 'events.jsonl')
          return existsSync(path) ? readFileSync(path, 'utf8') : ''
        }
        const done = /"type":"task_done"[^\n]*"task":"app\/migrate"/
        const started = async () =>
          (await wired.client.log.read({ types: ['queue_started'], task: 'app/billing' })).length >
          0

        // A on the box, started from its tab; B here, after it, once the copy
        // of the box's journal kept here says A was made.
        await say('vps', 'start app/migrate: migrate the schema')
        await until(
          'the box’s journal here, with the migration made',
          () => /"type":"task_created"[^\n]*"task":"app\/migrate"/.test(copy()),
          150_000,
        )
        await wired.client.createTask({
          project: 'app',
          slug: 'billing',
          intent: 'billing, once the migration on vps is in',
          by: 'you',
          start: {
            after: [{ task: 'vps:app/migrate', why: 'it needs the new table' }],
            prompt: 'Build billing.',
            touches: [],
          },
        })
        await until('billing waits on the box', async () =>
          (await window.queueTools().describe()).includes('app/billing — after vps:app/migrate'),
        )
        expect(vps.journal()).not.toMatch(done)
        expect(await started()).toBe(false)

        // The cable cut: the master ended, and ssh pointed where nothing answers.
        writeFileSync(
          cable,
          readFileSync(sshd.config, 'utf8').replace(/Port \d+/, `Port ${await freePort()}`),
        )
        const ended = spawnSync(
          'ssh',
          ['-F', cable, '-S', pathsFor(wired.home, 'vps', 0).control, '-O', 'exit', 'far'],
          { encoding: 'utf8', timeout: 15_000 },
        )
        expect(ended.status, ended.stderr).toBe(0)
        await until('the migration finished on the box', () => done.test(vps.journal()), 180_000)
        // Looks go by with the copy behind, and billing stays where it is.
        await window.queueTools().advance()
        await window.queueTools().advance()
        expect(copy()).not.toMatch(done)
        expect(await started()).toBe(false)
        expect(await window.queueTools().describe()).toContain('vps last heard')

        // The cable put back: the box's task_done comes over it, and billing starts.
        copyFileSync(sshd.config, cable)
        await until('the migration’s task_done in the copy here', () => done.test(copy()), 150_000)
        await until('billing started by the queue', started, SPAWNING_MS)
        const [first] = await wired.client.log.read({
          types: ['queue_started'],
          task: 'app/billing',
        })
        expect(first?.detail.after).toEqual(['vps:app/migrate'])
        await window.stop()
      } finally {
        await slow.close()
      }
    }, 600_000)

    it('watches the repository both have from one of them, hands it over when the cable is cut and back when it is in, and finds each request once', async () => {
      if (typeof sshd === 'string') return
      runGit(wired.repo.root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
      const fixture = fileURLToPath(
        new URL('../../../../test/fixtures/rehearsal/extension.ts', import.meta.url),
      )
      const schedule = {
        id: 'rehearsal-requests',
        name: 'Rehearsal requests',
        project: 'app',
        said: 'watch the rehearsal requests',
        when: { every: '1h' },
        does: {
          kind: 'watch',
          watch: 'rehearsal-intake.requests',
          input: {},
          found: 'ask',
          most: 5,
        },
        missed: 'once',
        by: 'you',
        created: new Date().toISOString(),
      }
      const vps = await box(
        'vps',
        'app',
        sshd.dir,
        wired.repo.root,
        model.url,
        undefined,
        (home) => {
          // The scripted source in the box's own extensions, on, with its watch turned on.
          const folder = join(home, 'extensions', 'rehearsal-intake')
          mkdirSync(folder, { recursive: true })
          copyFileSync(fixture, join(folder, 'extension.ts'))
          appendFileSync(
            join(home, 'config.yaml'),
            'extensions:\n  rehearsal-intake:\n    enabled: true\n',
          )
          writeFileSync(
            join(home, 'schedules.jsonl'),
            `${JSON.stringify({ op: 'set', schedule, by: 'you', at: schedule.created })}\n`,
          )
        },
      )
      const remotes = pair(sshd, [vps])
      const cable = join(wired.home, 'ssh_config')
      copyFileSync(sshd.config, cable)
      const requests = (root: string, ids: readonly string[]) =>
        writeFileSync(
          join(root, 'REQUESTS.json'),
          JSON.stringify(ids.map((id) => ({ id, title: `request ${id}` }))),
        )
      requests(wired.repo.root, ['req-1'])
      const app = { root: wired.repo.root, watches: 'here' }
      const extensions = await ExtensionHost.load({
        builtin: [rehearsalIntake as never],
        config: { extensions: {}, projects: { app } },
        home: wired.home,
      })
      const window = await wired.start({
        config: ConfigSchema.parse({ projects: { app }, remotes }),
        remoteLinks: { ssh: (options) => makeSshLink({ ...options, args: ['-F', cable] }) },
        extensions,
        thinker: { ask: async () => 'ok', tell: async () => {} },
      })
      const foundIn = (journal: string) =>
        journal
          .split('\n')
          .filter((line) => line.includes('"type":"watch_found"'))
          .map((line) => (JSON.parse(line) as { detail: { key: string } }).detail.key)
      const foundHere = async () =>
        (await wired.client.events({ types: ['watch_found'] })).map((one) => one.detail.key)
      const duties = () =>
        (
          window as unknown as {
            heart: { duties: { standing(): { duty: string; mine: boolean }[] } }
          }
        ).heart.duties.standing()
      const watchDuty = (mine: boolean) =>
        duties().some(
          (one) => one.duty.startsWith('watch github.com/acme/app') && one.mine === mine,
        )

      // Linked: the Mac's setting says here, so the watch is the Mac's, granted by the box.
      const tools = window.queueTools()
      await tools.schedule({
        name: 'Rehearsal requests',
        project: 'app',
        said: 'watch the rehearsal requests',
        watch: 'rehearsal-intake.requests',
        by: 'you',
      })
      await tools.change({ schedule: 'rehearsal-requests', change: 'start', by: 'you' })
      await until('req-1 found here', async () => (await foundHere()).includes('req-1'), 60_000)
      await until('the box granted the watch to this Mac', () => watchDuty(true), 120_000)

      // The cable cut: the box takes it over within the lease, with what the Mac found.
      requests(vps.root, ['req-1', 'req-2'])
      writeFileSync(
        cable,
        readFileSync(sshd.config, 'utf8').replace(/Port \d+/, `Port ${await freePort()}`),
      )
      const ended = spawnSync(
        'ssh',
        ['-F', cable, '-S', pathsFor(wired.home, 'vps', 0).control, '-O', 'exit', 'far'],
        { encoding: 'utf8', timeout: 15_000 },
      )
      expect(ended.status, ended.stderr).toBe(0)
      await until('the Mac let go of it', () => watchDuty(false), 120_000)
      await until('req-2 found on the box', () => foundIn(vps.journal()).includes('req-2'), 240_000)
      expect(foundIn(vps.journal())).toEqual(['req-2'])
      expect(vps.journal()).toMatch(/"type":"watch_checked"[^\n]*"handed":\["req-1"\]/)

      // The cable in again: the Mac takes it back once the box lets go, with what the box found.
      requests(wired.repo.root, ['req-1', 'req-2', 'req-3'])
      copyFileSync(sshd.config, cable)
      await until('req-3 found here', async () => (await foundHere()).includes('req-3'), 240_000)
      expect(await foundHere()).toEqual(['req-1', 'req-3'])
      expect(foundIn(vps.journal())).toEqual(['req-2'])
      const handedBack = (await wired.client.events({ types: ['watch_checked'] })).filter(
        (one) => Array.isArray(one.detail.handed) && one.detail.handed.includes('req-2'),
      )
      expect(handedBack).toHaveLength(1)
      await window.stop()
    }, 900_000)

    it('places a plan’s work for later on the box, the hub, and the box starts it with this Mac shut', async () => {
      if (typeof sshd === 'string') return
      runGit(wired.repo.root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
      const vps = await box('vps', 'app', sshd.dir)
      const remotes = pair(sshd, [vps])
      const window = await wired.start({
        config: ConfigSchema.parse({ projects: { app: { root: wired.repo.root } }, remotes }),
        remoteLinks: { ssh: (options) => makeSshLink({ ...options, args: ['-F', sshd.config] }) },
        thinker: { ask: async () => 'ok', tell: async () => {} },
      })
      // Placed on the box only once it has said which of its projects is this repository.
      await until(
        'the box has said which project is this repository',
        async () =>
          (
            await window.queueTools().plan({
              project: 'app',
              said: 'a probe',
              agents: [
                {
                  name: `probe-${Date.now()}`,
                  said: 'probe',
                  prompt: 'probe',
                  after: [],
                  touches: [],
                  at: TOMORROW,
                },
              ],
            })
          ).includes('went to vps'),
        150_000,
      )
      const answer = await window.queueTools().plan({
        project: 'app',
        said: 'the nightly report, tonight',
        agents: [
          {
            name: 'nightly',
            said: 'the nightly report',
            prompt: 'Build the nightly report.',
            after: [],
            touches: [],
            at: new Date(Date.now() + 40_000).toISOString(),
          },
        ],
      })
      expect(answer).toContain('app/nightly went to vps')
      expect(await readTaskFile(wired.home, 'app/nightly')).toBeNull()
      await window.stop()

      // This Mac shut, the box starts it when its time comes, and its agent finishes there.
      const closed = /"type":"machine_seen"[^\n]*"way":"from","state":"closed"/
      const began = /"type":"queue_started"[^\n]*"task":"app\/nightly"/
      await until('the box started it', () => began.test(vps.journal()), 120_000)
      await until(
        'and its agent finished there',
        () => /"type":"task_done"[^\n]*"task":"app\/nightly"/.test(vps.journal()),
        180_000,
      )
      const lines = vps.journal().split('\n')
      const shut = lines.findIndex((one) => closed.test(one))
      expect(shut).toBeGreaterThanOrEqual(0)
      expect(lines.findIndex((one) => began.test(one))).toBeGreaterThan(shut)
      const taken = lines.find(
        (one) => one.includes('"type":"task_taken"') && one.includes('"task":"app/nightly"'),
      )
      expect(
        (JSON.parse(taken ?? '{}') as { detail?: { placed?: string } }).detail?.placed,
      ).toContain(`placed on vps from ${machineLabel()}: it waits for later and nothing ties it to`)
    }, 480_000)

    it('reloads every machine from here: each asked through its own door over ssh, one nothing keeps saying so and left running, one cut said, then this window', async () => {
      if (typeof sshd === 'string') return
      const vps1 = await box('vps1', 'app', sshd.dir)
      const vps2 = await box('vps2', 'site', sshd.dir)
      const remotes = pair(sshd, [vps1, vps2])
      terminal.rows = 50
      terminal.columns = 160
      // This window's own reload is the last step, counted rather than re-execed.
      let reloaded = 0
      const window = await wired.start({
        config: ConfigSchema.parse({ projects: { app: { root: wired.repo.root } }, remotes }),
        remoteLinks: { ssh: (options) => makeSshLink({ ...options, args: ['-F', sshd.config] }) },
        thinker: { ask: async () => 'ok', tell: async () => {} },
        reloadWindow: async () => {
          reloaded += 1
        },
      })
      await until(
        'both machines’ projects along the top',
        () => /vps1\]?\s+app/.test(rows()[0] ?? '') && /vps2\]?\s+site/.test(rows()[0] ?? ''),
        60_000,
      )
      const reach = (name: string) =>
        (
          window as unknown as { remotes: { reachFor(name: string): { live: boolean } | null } }
        ).remotes.reachFor(name)
      const said = () =>
        (
          window as unknown as { wire: { state: { transcript: { entries: { text?: string }[] } } } }
        ).wire.state.transcript.entries.flatMap((one) => (one.text ? [one.text] : []))
      const here = () => readFileSync(join(wired.home, 'events.jsonl'), 'utf8')

      // vps2's cable cut: its Tade goes, and this window knows the link is not up.
      vps2.serving.kill('SIGTERM')
      await until(
        'vps2 known closed here, its link not up',
        () =>
          /"type":"machine_seen"[^\n]*"machine":"vps2","way":"to","state":"closed"/.test(here()) &&
          reach('vps2')?.live !== true,
        30_000,
      )
      expect(reach('vps1')?.live).toBe(true)
      const opened = (journal: string) => (journal.match(/"type":"tade_opened"/g) ?? []).length
      const openedOnVps1 = opened(vps1.journal())

      // The orchestrator's `tade_reload`, on the person's words: every machine first, by name.
      await wired.client.log.append({ type: 'said', detail: { text: 'reload everything' } })
      expect(await window.updateTools().reload({ said: 'reload everything' })).toContain(
        'Reloading in a moment: vps1 and vps2 first',
      )
      await until('this window reloaded, last', () => reloaded === 1, 120_000)

      // Each machine said in words: vps1 answered its own door, from its own
      // `tade serve`, that nothing would start it again; vps2 was not reached.
      const lines = said()
      const began = lines.findIndex((one) =>
        one.startsWith('Reloading every machine: vps1 and vps2 first'),
      )
      const one = lines.findIndex((line) => line.startsWith('vps1 was not reloaded: '))
      const two = lines.findIndex((line) =>
        line.startsWith('vps2 could not be reached, so it was not reloaded'),
      )
      const last = lines.findIndex((line) => line.endsWith(' reloads now.'))
      expect(began, lines.join('\n')).toBeGreaterThanOrEqual(0)
      expect(one, lines.join('\n')).toBeGreaterThan(began)
      expect(two, lines.join('\n')).toBeGreaterThan(began)
      expect(last).toBeGreaterThan(Math.max(one, two))
      expect(lines[one]).toContain('no window and no service keeping it')
      // Same Tade on both sides, so nothing was updated first.
      expect(lines.some((line) => line.includes('updating it to'))).toBe(false)

      // And nothing there restarted: the same `tade serve`, opened once, no restart written down.
      expect(vps1.serving.exitCode).toBeNull()
      expect(opened(vps1.journal())).toBe(openedOnVps1)
      expect(vps1.journal()).not.toMatch(/"type":"web_did"[^\n]*"verb":"restart"/)
      // Nothing came back, so nothing is left for the window that comes back to check.
      expect(existsSync(join(wired.home, 'reload-check.json'))).toBe(false)
      await window.stop()
    }, 300_000)
  },
)

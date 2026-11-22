import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ConfigSchema,
  machineLabel,
  mirrorDir,
  mirrorMachine,
  mirrorRef,
  parseConfig,
  writeSetting,
} from '@tade/core'
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
import {
  STAND_IN,
  startStandIn,
  writeStandInModels,
} from '../../../../test/fixtures/stand-in-model.ts'
import { recordFromShell } from '../../../cli/src/config-write.ts'
import { makeSshLink } from '../../../remotes/ssh/src/index.ts'
import { startSshd } from '../../../remotes/ssh/test/sshd.ts'
import type { App } from '../../src/app.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

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

/** One box, its checkout a fresh repository or, given `from`, a clone of the checkout there. */
async function box(name: string, project: string, dir: string, from?: string): Promise<Box> {
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
  writeStandInModels(pi, model.url)
  writeFileSync(
    join(repo.home, 'config.yaml'),
    [
      'projects:',
      `  ${project}:`,
      `    root: ${root}`,
      'surfaces:',
      '  web:',
      '    enabled: true',
      `    port: ${await freePort()}`,
      'orchestrator:',
      `  model: ${STAND_IN.provider}/${STAND_IN.model}`,
      '',
    ].join('\n'),
  )
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
      const vps = await box('vps', 'app', sshd.dir, wired.repo.root)
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
      await until('the conflict said here', () => shown('Changed on both vps and here'))
      // The box's own stays its own, and so does what it pinned.
      expect(configOf(vps.home).workspace.driver).toBe('pty')
      expect(configOf(vps.home).checks.before).toBe('commit')
      // And it settles: carried again, nothing more is taken or said.
      expect(configOf(wired.home).queue.holds).toBe('orchestrator')
      await window.stop()
    }, 300_000)
  },
)

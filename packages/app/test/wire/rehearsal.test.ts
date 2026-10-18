import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema, parseConfig } from '@tade/core'
import { readTaskFile } from '@tade/workbench/tasks'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkrepo, runGit } from '../../../../test/fixtures/mkrepo.ts'
import {
  STAND_IN,
  startStandIn,
  writeStandInModels,
} from '../../../../test/fixtures/stand-in-model.ts'
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

async function box(name: string, project: string, dir: string): Promise<Box> {
  const repo = mkrepo()
  repo.commit('first')
  // One repository, as GitHub names it, on this box and (for `app`) the Mac.
  runGit(repo.root, 'remote', 'add', 'origin', `git@github.com:acme/${project}.git`)
  const pi = join(repo.home, 'pi')
  writeStandInModels(pi, model.url)
  writeFileSync(
    join(repo.home, 'config.yaml'),
    [
      'projects:',
      `  ${project}:`,
      `    root: ${repo.root}`,
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
    root: repo.root,
    tade,
    serving,
    journal: () => readFileSync(join(repo.home, 'events.jsonl'), 'utf8'),
  }
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

    it('pairs with both, starts and sees their work, comes back to what happened, hands work over and reads them', async () => {
      if (typeof sshd === 'string') return
      const vps1 = await box('vps1', 'app', sshd.dir)
      const vps2 = await box('vps2', 'site', sshd.dir)

      // `tade remote add`, the real command, for each: ssh is the real one,
      // told where this run's sshd and keys are.
      const shims = join(wired.home, 'shims')
      mkdirSync(shims, { recursive: true })
      const ssh = spawnSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).stdout.trim()
      writeFileSync(join(shims, 'ssh'), `#!/bin/sh\nexec '${ssh}' -F '${sshd.config}' "$@"\n`)
      chmodSync(join(shims, 'ssh'), 0o755)
      for (const one of [vps1, vps2]) {
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
      expect(Object.keys(written.config.remotes).sort()).toEqual(['vps1', 'vps2'])

      // This Mac's window, holding both links over ssh.
      runGit(wired.repo.root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
      terminal.rows = 50
      terminal.columns = 160
      const open = (): Promise<App> =>
        wired.start({
          config: ConfigSchema.parse({
            projects: { app: { root: wired.repo.root } },
            remotes: written.config.remotes,
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

      // 3. The window closed while more work finishes there, and a note is
      // taken on vps2; opened again, each says what happened since.
      await say('vps1', 'start app/ledger: reconcile the ledger nightly')
      await until('vps1 to start it', () => vps1.journal().includes('"task":"app/ledger"'), 60_000)
      await window.stop()
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
    }, 420_000)
  },
)

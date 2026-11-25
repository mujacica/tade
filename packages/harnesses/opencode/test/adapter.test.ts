import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { until } from '@tade/drivers-core/conformance'
import { TOOLS_PATH } from '@tade/harnesses-acp'
import type { WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { OpenCodeAdapter, PLUGIN_DIR, runSocket } from '../src/adapter.ts'
import { sessionIdFor } from '../src/record.ts'

// The OpenCode adapter against a stand-in `opencode`: a script that answers
// what the real one answered in OpenCode 2.4.1 — `auth list`, `session
// export`, `session list`, `models`, `api …` — from files, and writes down
// every way it was run. What the real one does with a run is the live test's;
// this holds the line Tade writes, the environment it runs in, and what the
// adapter makes of what OpenCode says, on a machine without OpenCode.

const run = promisify(execFile)
const FIXTURES = fileURLToPath(
  new URL('../../../../test/fixtures/transcripts/opencode/2.4.1/', import.meta.url),
)

/** A stand-in `opencode`, and the folder it answers from and writes down in. */
function standIn(): { bin: string; dir: string; ran: () => string[] } {
  const dir = tmp('tade-opencode-stand-')
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  const bin = join(dir, 'opencode')
  writeFileSync(
    bin,
    `#!/bin/sh
here="${dir}"
printf '%s\\n' "$* | data=\${XDG_DATA_HOME:-} opening=\${TADE_OPENCODE_OPENING:-} key=\${OPENCODE_API_KEY:-} content=\${OPENCODE_CONFIG_CONTENT:+set}" >> "$here/ran"
case "$1 $2" in
  "--version "*) cat "$here/version" 2>/dev/null || echo "opencode v2.4.1"; exit 0 ;;
  "auth list") cat "$here/auth.json" 2>/dev/null || echo "[]"; exit 0 ;;
  "auth logout") exit 0 ;;
  "api session.create") [ -f "$here/refuse" ] && { echo "the database is locked" >&2; exit 1; }; exit 0 ;;
  "session export") [ -f "$here/sessions/$3.json" ] && { cat "$here/sessions/$3.json"; exit 0; }; echo "Session not found: $3" >&2; exit 1 ;;
  "session list") cat "$here/list.json" 2>/dev/null || echo "[]"; exit 0 ;;
  "session import") id=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).info.id)' "$3"); cp "$3" "$here/sessions/$id.json"; exit 0 ;;
  "models --standalone") cat "$here/models.txt" 2>/dev/null; exit 0 ;;
esac
exit 0
`,
  )
  chmodSync(bin, 0o755)
  return {
    bin,
    dir,
    ran: () =>
      existsSync(join(dir, 'ran')) ? readFileSync(join(dir, 'ran'), 'utf8').trim().split('\n') : [],
  }
}

const AUTH = JSON.stringify([
  {
    id: 'openai',
    name: 'OpenAI',
    connections: [{ type: 'credential', id: 'cred_1', label: 'me@example.com', method: 'oauth' }],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    connections: [{ type: 'credential', id: 'cred_2', label: 'Anthropic', method: 'key' }],
  },
])

/** What an adapter was made with: the socket folder and the program it runs. */
const optsOf = (one: OpenCodeAdapter) =>
  (one as unknown as { opts: { socketDir: string; bin: string } }).opts

describe('the OpenCode adapter', () => {
  const made: OpenCodeAdapter[] = []
  const sockets: Socket[] = []
  afterEach(async () => {
    for (const one of sockets.splice(0)) one.destroy()
    for (const one of made.splice(0)) await one.shutdown()
  })

  function adapter(
    bin: string,
    over: Partial<ConstructorParameters<typeof OpenCodeAdapter>[0]> = {},
  ): OpenCodeAdapter {
    const one = new OpenCodeAdapter({
      runDir: tmp('tade-opencode-runs-'),
      socketDir: tmp('tade-oc-s-'),
      home: tmp('tade-opencode-home-'),
      bin,
      env: { PATH: process.env.PATH ?? '', XDG_DATA_HOME: '/home/me/.data' },
      ...over,
    })
    made.push(one)
    return one
  }

  const spec = (cwd: string, over: Record<string, unknown> = {}) => ({
    run: 'app/fix/agent',
    task: 'app/fix',
    cwd,
    prompt: 'fix the login test',
    model: { provider: 'openai', id: 'gpt-5.5' },
    called: 'Fix the login test',
    ...over,
  })

  describe('the line it writes', () => {
    it('makes the session first with the task’s model and name, then opens the TUI on it, handing the plugin the opening', async () => {
      const stand = standIn()
      const account = tmp('tade-opencode-acct-')
      const keyFile = join(tmp('tade-opencode-key-'), 'key')
      writeFileSync(keyFile, 'sk-oc-123')
      const one = adapter(stand.bin, {
        account: { name: 'work', dir: account, kind: 'api-key', key: `cat ${keyFile}` },
      })
      const cwd = tmp('tade-opencode-cwd-')
      const launch = one.launchSpec(spec(cwd))
      // The key is read by the command that prints it, never written on the line.
      expect(launch.args.join(' ')).not.toContain('sk-oc-123')
      expect(launch.opening).toEqual(['--tade-opening', 'fix the login test'])
      await run(launch.command, [...launch.args, ...(launch.opening ?? [])], {
        cwd,
        env: { ...process.env, ...launch.env },
      })
      const [create, tui] = stand.ran()
      const session = sessionIdFor('app/fix')
      expect(create).toContain(
        `api session.create --standalone -d {"id":"${session}","title":"Fix the login test","model":{"providerID":"openai","id":"gpt-5.5"}}`,
      )
      // The session is made by a server that loads none of the run.
      expect(create).toMatch(/content=$/)
      expect(create).toContain('opening= ')
      expect(tui).toBe(
        `--standalone -s ${session} --auto | data=${join(account, 'data')} opening=fix the login test key=sk-oc-123 content=set`,
      )
    })

    it('is the line that comes back, saying nothing, and says so where it could not make the session', async () => {
      const stand = standIn()
      writeFileSync(join(stand.dir, 'refuse'), '')
      const one = adapter(stand.bin, { approvals: 'policy' })
      const cwd = tmp('tade-opencode-cwd-')
      const launch = one.launchSpec(spec(cwd, { prompt: '' }))
      expect(launch.opening).toBeUndefined()
      const said = await run(launch.command, launch.args, {
        cwd,
        env: { ...process.env, ...launch.env },
      })
      expect(said.stderr).toContain('so its plugin will: the database is locked')
      const tui = stand.ran().at(-1)
      // Under approvals nothing is approved for it: Tade's plugin answers each one.
      expect(tui).toContain(`--standalone -s ${sessionIdFor('app/fix')} |`)
      expect(tui).toContain('opening= ')
    })

    it('hands the run Tade’s plugin, tool server and instructions, and the account’s folders only to OpenCode', () => {
      const stand = standIn()
      const account = tmp('tade-opencode-acct-')
      const one = adapter(stand.bin, {
        approvals: 'policy',
        account: { name: 'work', dir: account, kind: 'subscription' },
      })
      void one.prepareAccount(false)
      const launch = one.launchSpec(
        spec(tmp('tade-opencode-cwd-'), {
          extras: { instructions: 'You run in Tade.', skills: ['/skills/review'] },
          title: 'Mended',
        }),
      )
      const env = launch.env
      expect(env.XDG_DATA_HOME).toBe(join(account, 'data'))
      expect(env.XDG_STATE_HOME).toBe(join(account, 'state'))
      expect(env.OPENCODE_CONFIG_DIR).toBe(join(account, 'config'))
      expect(env.TADE_OPENCODE_SESSION).toBe(sessionIdFor('app/fix'))
      expect(env.TADE_OPENCODE_MODEL).toBe('openai/gpt-5.5')
      expect(env.TADE_TITLE).toBe('Mended')
      expect(env.TADE_RUN_SOCKET).toBe(runSocket(optsOf(one).socketDir, 'app/fix/agent'))
      // What the agent's own commands see of them: as they were, or not set.
      expect(JSON.parse(env.TADE_OPENCODE_SHELL_ENV ?? '')).toEqual({
        XDG_DATA_HOME: '/home/me/.data',
        XDG_STATE_HOME: null,
        OPENCODE_CONFIG_DIR: null,
      })
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '') as Record<string, unknown>
      expect(config.plugins).toEqual([PLUGIN_DIR])
      expect(existsSync(join(PLUGIN_DIR, 'index.ts'))).toBe(true)
      expect(config.mcp).toEqual({
        servers: {
          tade: { type: 'local', command: [process.execPath, TOOLS_PATH], codemode: false },
        },
      })
      expect(config.permissions).toEqual([{ action: '*', resource: '*', effect: 'ask' }])
      expect(config.skills).toEqual(['/skills/review'])
      const instructions = (config.instructions as string[])[0] ?? ''
      expect(readFileSync(instructions, 'utf8')).toBe('You run in Tade.\n')
    })

    it('leaves OpenCode’s own sign-in in the person’s own folders', () => {
      const one = adapter(standIn().bin)
      const env = one.launchSpec(spec(tmp('tade-opencode-cwd-'))).env
      expect(env.XDG_DATA_HOME).toBeUndefined()
      expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
      expect(JSON.parse(env.TADE_OPENCODE_SHELL_ENV ?? '')).toEqual({})
      expect(one.records()).toEqual(['/home/me/.data/opencode'])
      expect(one.signIn({ browser: true })?.launch).toEqual({
        command: optsOf(one).bin,
        args: ['auth', 'login', '--standalone'],
        env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
      })
    })
  })

  describe('supervising', () => {
    /** The plugin's end of the run's socket, as the plugin speaks it. */
    async function plugin(one: OpenCodeAdapter, run: string) {
      const socket = connect(runSocket(optsOf(one).socketDir, run))
      sockets.push(socket)
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
      const heard: string[] = []
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => heard.push(...chunk.trim().split('\n')))
      return {
        say: (signal: Record<string, unknown>) =>
          socket.write(`${JSON.stringify({ run, at: Date.now(), ...signal })}\n`),
        heard: () => heard.map((line) => JSON.parse(line) as Record<string, unknown>),
      }
    }

    it('says what a plan paid for on each turn, and keeps a plan’s nought out of the money', async () => {
      const stand = standIn()
      writeFileSync(join(stand.dir, 'auth.json'), AUTH)
      const one = adapter(stand.bin)
      const cwd = tmp('tade-opencode-cwd-')
      const signals: WorkerSignal[] = []
      one.onSignal('app/fix/agent', (signal) => signals.push(signal))
      await one.supervise(spec(cwd))
      const agent = await plugin(one, 'app/fix/agent')
      agent.say({ type: 'started', sessionId: sessionIdFor('app/fix'), model: 'openai/gpt-5.5' })
      const step = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, tokens: 15 }
      agent.say({ type: 'usage', model: 'openai/gpt-5.5', usd: 0, ...step })
      agent.say({ type: 'usage', model: 'anthropic/claude-sonnet-5', usd: 0.02, ...step })
      agent.say({ type: 'turn_done', status: 'ok' })
      await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 10_000 })
      expect(signals.map((s) => s.type)).toEqual(['started', 'usage', 'usage', 'turn_done'])
      expect(signals[1]).toMatchObject({ plan: true, usd: 0 })
      expect(signals[2]).toMatchObject({ plan: false, usd: 0.02 })
      expect(await one.modelOf('app/fix/agent')).toEqual({
        provider: 'anthropic',
        id: 'claude-sonnet-5',
      })
    })

    it('holds what is said before the plugin is there, and says it once it is', async () => {
      const one = adapter(standIn().bin)
      await one.supervise(spec(tmp('tade-opencode-cwd-')))
      await one.steer('app/fix/agent', 'look at the tests too')
      await one.prompt('app/fix/agent', 'then commit', [], { whenBusy: 'queue' })
      await expect(one.name('app/fix/agent', 'x')).rejects.toThrow(/not connected/)
      await expect(
        one.setModel('app/fix/agent', { provider: 'openai', id: 'gpt-5.5' }),
      ).rejects.toThrow(/not connected/)
      const agent = await plugin(one, 'app/fix/agent')
      agent.say({ type: 'started', sessionId: null, model: null })
      await until(() => agent.heard().length === 2, { timeout: 10_000 })
      expect(agent.heard()).toEqual([
        { type: 'steer', message: 'look at the tests too' },
        { type: 'queue', message: 'then commit' },
      ])
      await one.name('app/fix/agent', '  Fix   the login ')
      await one.setModel('app/fix/agent', { provider: 'anthropic', id: 'claude-sonnet-5#high' })
      await one.decide('app/fix/agent', 'r1', { allow: false, reason: 'no' })
      await one.answer('app/fix/agent', 'c1', { ok: true, text: 'done' })
      await one.abort('app/fix/agent')
      await until(() => agent.heard().length === 7, { timeout: 10_000 })
      expect(agent.heard().slice(2)).toEqual([
        { type: 'name', title: 'Fix the login' },
        { type: 'model', provider: 'anthropic', id: 'claude-sonnet-5#high' },
        { type: 'decision', requestId: 'r1', allow: false, reason: 'no' },
        { type: 'extension_result', callId: 'c1', ok: true, text: 'done' },
        { type: 'abort' },
      ])
      await expect(one.setThinking('app/fix/agent', 'high')).rejects.toThrow(/variant/)
      await expect(one.compact('app/fix/agent')).rejects.toThrow(/compact/)
      await expect(one.start(spec(tmp('tade-opencode-cwd-')))).rejects.toThrow(/lane/)
      await one.stop('app/fix/agent')
      expect(await one.list()).toEqual([])
    })
  })

  describe('its record and its accounts', () => {
    it('reads a task’s conversation, spend and sessions out of what OpenCode exports and lists', async () => {
      const stand = standIn()
      const session = sessionIdFor('app/fix')
      const record = readFileSync(join(FIXTURES, 'refused.json'), 'utf8').replaceAll(
        'ses_tadea20eccef1e6ee46db3a091',
        session,
      )
      writeFileSync(join(stand.dir, 'sessions', `${session}.json`), record)
      const cwd = tmp('tade-opencode-cwd-')
      writeFileSync(
        join(stand.dir, 'list.json'),
        JSON.stringify([
          { id: 'ses_other', title: 'Elsewhere', updated: 9, created: 1, directory: '/else' },
          { id: session, title: 'Fix the login test', updated: 5, created: 1, directory: cwd },
          // The same folder as macOS also names it.
          {
            id: 'ses_mine',
            title: 'By hand',
            updated: 7,
            created: 1,
            directory: cwd.startsWith('/private/')
              ? cwd.slice('/private'.length)
              : `/private${cwd}`,
          },
        ]),
      )
      const one = adapter(stand.bin)
      expect(await one.hasConversation('app/fix', cwd)).toBe(true)
      expect(await one.hasConversation('app/other', cwd)).toBe(false)
      expect(await one.spent('app/fix', cwd)).toMatchObject({ tokens: 2100, messages: 2 })
      expect((await one.history('app/fix', cwd, { limit: 10 })).items).toHaveLength(3)
      expect(await one.callAnswer('app/fix', cwd, 'call_1')).toEqual({
        ok: false,
        result: 'not today',
      })
      expect(await one.sessions(cwd, ['app/fix'])).toEqual([
        { id: 'ses_mine', at: 7, first: 'By hand', task: null },
        { id: session, at: 5, first: 'Fix the login test', task: 'app/fix' },
      ])
      // Carried into another task: a copy under that task's id, the first left as it was.
      expect(await one.carrySession(session, 'app/next', cwd)).toBe(true)
      expect(await one.hasConversation('app/next', cwd)).toBe(true)
      expect(await one.carrySession('ses_nobody', 'app/later', cwd)).toBe(false)
      // Never over a conversation a task already has.
      expect(await one.carrySession(session, 'app/next', cwd)).toBe(false)
    })

    it('carries a conversation to another account’s database', async () => {
      const from = standIn()
      const to = standIn()
      const session = sessionIdFor('app/fix')
      writeFileSync(
        join(from.dir, 'sessions', `${session}.json`),
        readFileSync(join(FIXTURES, 'stopped.json'), 'utf8').replaceAll(
          'ses_tadea20eccef1e6ee46db3a091',
          session,
        ),
      )
      const mine = adapter(from.bin)
      const theirs = adapter(to.bin, {
        account: { name: 'other', dir: tmp('tade-opencode-acct-'), kind: 'subscription' },
      })
      const cwd = tmp('tade-opencode-cwd-')
      expect(await mine.carryConversation('app/fix', cwd, theirs)).toBe(true)
      expect(existsSync(join(to.dir, 'sessions', `${session}.json`))).toBe(true)
      expect(await mine.carryConversation('app/none', cwd, theirs)).toBe(false)
      expect(await mine.carryConversation('app/fix', cwd, mine)).toBe(false)
    })

    it('says who it is signed in as, what it runs, and signs out of each provider', async () => {
      const stand = standIn()
      writeFileSync(join(stand.dir, 'auth.json'), AUTH)
      writeFileSync(
        join(stand.dir, 'models.txt'),
        'openai/gpt-5.5\nanthropic/claude-sonnet-5\nnot a model\nopenai/gpt-5.5\n',
      )
      const one = adapter(stand.bin)
      expect(await one.account()).toMatchObject({
        signedIn: true,
        who: 'me@example.com',
        plan: 'ChatGPT',
      })
      expect(await one.probe()).toEqual({ ok: true, version: '2.4.1', problems: [] })
      expect((await one.models()).map((model) => model.id)).toEqual([
        'openai/gpt-5.5',
        'anthropic/claude-sonnet-5',
      ])
      expect(await one.resolveModel('anthropic/claude-sonnet-5 high')).toEqual({
        ok: true,
        provider: 'anthropic',
        id: 'claude-sonnet-5#high',
      })
      expect((await one.resolveModel('opus 5')).ok).toBe(false)
      await one.signOut()
      expect(stand.ran().filter((line) => line.startsWith('auth logout'))).toEqual([
        expect.stringMatching(/^auth logout openai cred_1 --standalone/),
        expect.stringMatching(/^auth logout anthropic cred_2 --standalone/),
      ])
    })

    it('says what is wrong when it is version 1, or connected to nothing', async () => {
      const stand = standIn()
      const one = adapter(stand.bin)
      const none = await one.probe()
      expect(none.ok).toBe(false)
      expect(none.problems[0]).toContain('auth login --standalone')
      writeFileSync(join(stand.dir, 'version'), '1.19.6\n')
      const old = await one.probe()
      expect(old).toMatchObject({ ok: false, version: '1.19.6' })
      expect(old.problems[0]).toContain('@opencode/cli')
      const keyed = adapter(stand.bin, {
        account: { name: 'paid', dir: tmp('tade-opencode-acct-'), kind: 'api-key' },
      })
      expect(await keyed.account()).toMatchObject({ signedIn: false, method: 'api-key' })
      expect(keyed.signIn()).toBeNull()
    })
  })
})

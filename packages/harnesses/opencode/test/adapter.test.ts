import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * One `opencode run` of the stand-in, as Tade's plugin inside it speaks: it
 * dials the run's socket, says it is there — `idle` too, as the plugin does
 * on every connect — and answers its message. With `hold` in its folder it
 * waits to be told something first: a steer ends the turn well, an abort
 * ends it stopped. With `crash` it says what went wrong and never connects.
 * What it was run with is written down, and what it heard.
 */
function turnOf(dir: string): string {
  return `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
const here = ${JSON.stringify(dir)}
const env = process.env
writeFileSync(here + '/env.json', JSON.stringify({ config: env.OPENCODE_CONFIG_CONTENT, approvals: env.TADE_APPROVALS, home: env.TADE_HOME }))
if (existsSync(here + '/crash')) {
  process.stderr.write('starting\\nthe model is not connected\\n')
  process.exit(3)
}
const message = process.argv.at(-1)
const socket = connect(env.TADE_RUN_SOCKET)
const say = (signal) => socket.write(JSON.stringify({ run: env.TADE_RUN_ID, at: Date.now(), ...signal }) + '\\n')
const end = (status) => {
  say({ type: 'turn_done', status })
  say({ type: 'idle' })
  socket.end(() => process.exit(0))
}
socket.on('connect', () => {
  say({ type: 'started', sessionId: env.TADE_OPENCODE_SESSION, model: 'openai/gpt-5.5', thinking: null })
  say({ type: 'idle' })
  say({ type: 'turn_started' })
  say({ type: 'message', text: 'heard: ' + message })
  if (!existsSync(here + '/hold')) end('ok')
})
socket.setEncoding('utf8')
socket.on('data', (chunk) => {
  for (const line of chunk.trim().split('\\n')) {
    appendFileSync(here + '/heard', line + '\\n')
    const command = JSON.parse(line)
    if (command.type === 'steer') end('ok')
    if (command.type === 'abort') end('aborted')
  }
})
`
}

/**
 * The stand-in's `opencode serve`, as a compaction sees one: it says where it
 * listens, and its plugin says what the real one says of a compaction — its
 * execution starting and ending, which is not a turn, and how full the
 * context is after. With `serve-crash` in its folder it never comes up. It
 * runs until it is ended, and writes down the password it was given.
 */
function serveOf(dir: string): string {
  return `import { existsSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
const here = ${JSON.stringify(dir)}
const env = process.env
writeFileSync(here + '/serve-env.json', JSON.stringify({ password: env.OPENCODE_PASSWORD, config: env.OPENCODE_CONFIG_CONTENT, approvals: env.TADE_APPROVALS }))
if (existsSync(here + '/serve-crash')) {
  process.stderr.write('port in use\\n')
  process.exit(3)
}
process.stdout.write('server listening on http://127.0.0.1:4096\\n')
const socket = connect(env.TADE_RUN_SOCKET)
const say = (signal) => socket.write(JSON.stringify({ run: env.TADE_RUN_ID, at: Date.now(), ...signal }) + '\\n')
socket.on('connect', () => {
  say({ type: 'started', sessionId: env.TADE_OPENCODE_SESSION, model: 'openai/gpt-5.5', thinking: null })
  say({ type: 'idle' })
  say({ type: 'turn_started' })
  say({ type: 'context', tokens: 120, percent: 1 })
  say({ type: 'turn_done', status: 'ok' })
  say({ type: 'idle' })
})
socket.on('error', () => {})
setInterval(() => {}, 1000)
`
}

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
  "--standalone run") exec "${process.execPath}" "$here/turn.mjs" "$@" ;;
  "serve --hostname") exec "${process.execPath}" "$here/serve.mjs" "$@" ;;
  "api --server")
    printf '%s' "\${OPENCODE_PASSWORD:-}" > "$here/asked-with"
    case "$4" in
      session.compact) [ -f "$here/busy" ] && { echo "Session is busy" >&2; exit 1; }; echo '{"data":{"id":"msg_compact","type":"compaction","delivery":"steer"}}' ;;
    esac
    exit 0 ;;
esac
exit 0
`,
  )
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'turn.mjs'), turnOf(dir))
  writeFileSync(join(dir, 'serve.mjs'), serveOf(dir))
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
      await expect(one.start(spec(tmp('tade-opencode-cwd-')))).rejects.toThrow(/already/)
      await one.stop('app/fix/agent')
      expect(await one.list()).toEqual([])
    })
  })

  describe('headless', () => {
    const RUN = 'app/fix/agent'

    /** What the stand-in's last turn was run with, and everything said in this run. */
    function watch(one: OpenCodeAdapter, dir: string) {
      const signals: WorkerSignal[] = []
      one.onSignal(RUN, (signal) => signals.push(signal))
      return {
        signals,
        types: () => signals.map((s) => s.type),
        idles: () => signals.filter((s) => s.type === 'idle').length,
        heard: () =>
          existsSync(join(dir, 'heard'))
            ? readFileSync(join(dir, 'heard'), 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as Record<string, unknown>)
            : [],
        env: () =>
          JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8')) as {
            config: string
            approvals: string
            home?: string
          },
      }
    }

    it('is a turn a process on the task’s session, ungated, with Tade’s own tools as it was handed them', async () => {
      const stand = standIn()
      const one = adapter(stand.bin, { approvals: 'policy' })
      const servers = join(tmp('tade-opencode-mcp-'), 'tools.mcp.json')
      writeFileSync(
        servers,
        JSON.stringify({
          mcpServers: { tade: { type: 'stdio', command: 'node', args: ['tools'] } },
        }),
      )
      const seen = watch(one, stand.dir)
      const cwd = tmp('tade-opencode-cwd-')
      await one.start({
        ...spec(cwd, { prompt: '-a message that starts like a flag' }),
        extras: { mcp: [servers] },
        env: { TADE_HOME: '/home/me/.tade' },
      })
      await until(() => seen.idles() === 1, { timeout: 15_000 })
      // Its turn is Tade's to begin and end: the plugin's `idle` on connecting,
      // before the turn had begun, is not the end of it.
      expect(seen.types()).toEqual([
        'started',
        'turn_started',
        'started',
        'message',
        'turn_done',
        'idle',
      ])
      expect(seen.signals.find((s) => s.type === 'message')).toMatchObject({
        text: 'heard: -a message that starts like a flag',
      })
      const session = sessionIdFor('app/fix')
      // What it ran for the turns, past asking what pays for them.
      const turns = () => stand.ran().filter((line) => !line.startsWith('auth list'))
      const [create, turn] = turns()
      expect(create).toContain(`api session.create --standalone -d {"id":"${session}"`)
      expect(turn).toMatch(
        new RegExp(`^--standalone run --format json -s ${session} --auto -- -a message`),
      )
      // Nothing of the thing you talk to is gated, and its own tool server is
      // the one it was handed — never an agent's in its place.
      const env = seen.env()
      expect(env.approvals).toBe('bypass')
      expect(env.home).toBe('/home/me/.tade')
      const config = JSON.parse(env.config) as Record<string, unknown>
      expect(config.permissions).toBeUndefined()
      expect(config.mcp).toEqual({
        servers: { tade: { type: 'local', command: ['node', 'tools'], codemode: false } },
      })

      // The next thing said is the next turn, on a session already made.
      await one.prompt(RUN, 'and then')
      await until(() => seen.idles() === 2, { timeout: 15_000 })
      expect(turns().slice(2)).toEqual([expect.stringMatching(/ --auto -- and then \|/)])
      expect(await one.list()).toHaveLength(1)
      await one.stop(RUN)
      expect(await one.list()).toEqual([])
    })

    it('steers the turn that is running, keeps what is queued for the next, and says a turn that ended without a word', async () => {
      const stand = standIn()
      const one = adapter(stand.bin)
      const seen = watch(one, stand.dir)
      const hold = join(stand.dir, 'hold')
      writeFileSync(hold, '')
      await one.start(spec(tmp('tade-opencode-cwd-'), { prompt: 'first' }))
      await until(() => seen.signals.filter((s) => s.type === 'started').length === 2, {
        timeout: 15_000,
      })
      await one.prompt(RUN, 'after it', [], { whenBusy: 'queue' })
      rmSync(hold)
      await one.prompt(RUN, 'also this')
      // The steer went into the turn; what was queued became the next one,
      // with no `idle` between them.
      await until(() => seen.signals.filter((s) => s.type === 'turn_done').length === 2, {
        timeout: 15_000,
      })
      await until(() => seen.idles() === 1, { timeout: 15_000 })
      expect(seen.heard()).toEqual([{ type: 'steer', message: 'also this' }])
      expect(stand.ran().at(-1)).toMatch(/ --auto -- after it \|/)
      expect(seen.types().slice(-3)).toEqual(['message', 'turn_done', 'idle'])

      writeFileSync(join(stand.dir, 'crash'), '')
      await one.prompt(RUN, 'break')
      await until(() => seen.idles() === 2, { timeout: 15_000 })
      expect(seen.signals.filter((s) => s.type === 'turn_done').at(-1)).toMatchObject({
        status: 'error',
        reason: 'the model is not connected',
      })
    })

    it('stops a turn through its plugin, and holds a name and a model for the next one', async () => {
      const stand = standIn()
      const one = adapter(stand.bin)
      const seen = watch(one, stand.dir)
      writeFileSync(join(stand.dir, 'hold'), '')
      await one.start(spec(tmp('tade-opencode-cwd-'), { prompt: '' }))
      expect(seen.types()).toEqual(['started', 'idle'])
      // Between turns there is no plugin to tell: the next turn's hears it.
      await one.name(RUN, 'Mend the login')
      await one.setModel(RUN, { provider: 'anthropic', id: 'claude-sonnet-5' })
      await one.prompt(RUN, 'think for a long while')
      await until(() => seen.heard().length === 2, { timeout: 15_000 })
      expect(seen.heard()).toEqual([
        { type: 'name', title: 'Mend the login' },
        { type: 'model', provider: 'anthropic', id: 'claude-sonnet-5' },
      ])
      await one.abort(RUN)
      await until(() => seen.idles() === 2, { timeout: 15_000 })
      expect(seen.heard().at(-1)).toEqual({ type: 'abort' })
      expect(seen.signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'aborted' })
      // Nothing running, nothing to stop.
      await one.abort(RUN)
      expect(seen.idles()).toBe(2)
    })

    /** The stand-in's record of the task's session, with a compaction under `msg_compact`. */
    function compacted(dir: string, compaction: Record<string, unknown>): void {
      const id = sessionIdFor('app/fix')
      writeFileSync(
        join(dir, 'sessions', `${id}.json`),
        JSON.stringify({
          info: { id },
          messages: [
            { id: 'msg_1', type: 'user', text: 'first' },
            { id: 'msg_compact', type: 'compaction', ...compaction },
            { id: 'msg_2', type: 'idle', outcome: 'succeeded' },
          ],
        }),
      )
    }

    it('compacts between turns in a server of its own, says how full it is, and makes what was said meanwhile the next turn', async () => {
      const stand = standIn()
      const one = adapter(stand.bin)
      const seen = watch(one, stand.dir)
      await one.start(spec(tmp('tade-opencode-cwd-'), { prompt: 'first' }))
      await until(() => seen.idles() === 1, { timeout: 15_000 })
      compacted(stand.dir, { status: 'completed', summary: '## Objective' })
      const before = seen.signals.length

      const compacting = one.compact(RUN)
      // Said while it compacts: waits for it, and is not said into it.
      await one.prompt(RUN, 'meanwhile')
      await compacting
      await until(() => seen.idles() === 2, { timeout: 15_000 })
      const since = seen.signals.slice(before)
      // Its execution ending is not a turn's: the one turn is what was said meanwhile.
      expect(since.map((s) => s.type)).toEqual([
        'started',
        'context',
        'turn_started',
        'started',
        'message',
        'turn_done',
        'idle',
      ])
      expect(since.find((s) => s.type === 'message')).toMatchObject({ text: 'heard: meanwhile' })

      const session = sessionIdFor('app/fix')
      const ran = stand.ran()
      expect(ran).toContainEqual(
        expect.stringMatching(/^serve --hostname 127\.0\.0\.1 --port 0 \|/),
      )
      expect(ran).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^api --server http://127\\.0\\.0\\.1:4096 session\\.compact -d \\{\\} --param sessionID=${session} \\|`,
          ),
        ),
      )
      expect(ran).toContainEqual(
        expect.stringContaining(`experimental.session.wait --param sessionID=${session}`),
      )
      // The server runs the run's config, ungated, behind a password made for
      // it, which is asked with and never written on a line.
      const served = JSON.parse(readFileSync(join(stand.dir, 'serve-env.json'), 'utf8')) as {
        password: string
        config: string
        approvals: string
      }
      expect(served.password.length).toBeGreaterThanOrEqual(32)
      expect(readFileSync(join(stand.dir, 'asked-with'), 'utf8')).toBe(served.password)
      expect(ran.some((line) => line.includes(served.password))).toBe(false)
      expect(served.approvals).toBe('bypass')
      expect((JSON.parse(served.config) as { plugins: string[] }).plugins).toEqual([PLUGIN_DIR])
    })

    it('says why it could not compact, in OpenCode’s words, and never across a turn', async () => {
      const stand = standIn()
      const one = adapter(stand.bin)
      const seen = watch(one, stand.dir)
      writeFileSync(join(stand.dir, 'hold'), '')
      await one.start(spec(tmp('tade-opencode-cwd-'), { prompt: 'first' }))
      await until(() => seen.signals.filter((s) => s.type === 'started').length === 2, {
        timeout: 15_000,
      })
      await expect(one.compact(RUN)).rejects.toThrow(/middle of a turn/)
      await one.abort(RUN)
      await until(() => seen.idles() === 1, { timeout: 15_000 })

      compacted(stand.dir, {
        status: 'failed',
        error: { type: 'compaction.unavailable', message: 'Nothing to compact yet' },
      })
      await expect(one.compact(RUN)).rejects.toThrow(
        'OpenCode could not compact: Nothing to compact yet',
      )
      writeFileSync(join(stand.dir, 'busy'), '')
      await expect(one.compact(RUN)).rejects.toThrow('OpenCode would not compact: Session is busy')
      writeFileSync(join(stand.dir, 'serve-crash'), '')
      await expect(one.compact(RUN)).rejects.toThrow(
        'OpenCode could not start a server to compact in: port in use',
      )
      // None of it was a turn, and the next thing said still is one.
      expect(seen.idles()).toBe(1)
      rmSync(join(stand.dir, 'hold'))
      await one.prompt(RUN, 'carry on')
      await until(() => seen.idles() === 2, { timeout: 15_000 })
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

import { execFile, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../packages/core/src/config.ts'
import { extensionsRoot, tadeHome } from '../packages/core/src/home.ts'
import { ClaudeAdapter } from '../packages/harnesses/claude/src/adapter.ts'
import { CodexAdapter } from '../packages/harnesses/codex/src/adapter.ts'
import { WORKER_ENV, type WorkerSpec } from '../packages/harnesses/core/src/port.ts'
import { PiAdapter } from '../packages/harnesses/pi/src/adapter.ts'
import { toolEnv } from '../packages/orchestrator/src/launch.ts'
import { tmp } from './fixtures/mkrepo.ts'
import {
  forgetPersonsTadeSpawns,
  HANDED_DOWN,
  inPersonsTade,
  personsTadeSpawns,
} from './own-home.ts'

// `own-home.ts`, held to its word: no test reaches the Tade home of whoever
// runs the suite. It once did on every workbench open — `recordAuthored` ran
// `git add -A` in the real `~/.tade/extensions`, because the config's default
// named that folder whatever the home — and nothing failed, because the folder
// was empty and `recordAuthored` never throws.

const persons = join(userInfo().homedir, '.tade')

/** The guard records the attempt as well as refusing it; take it back after each check. */
async function tries(what: () => unknown): Promise<readonly string[]> {
  try {
    await what()
  } catch {
    // Refused is the point. What was tried is read from the record.
  }
  const tried = personsTadeSpawns()
  forgetPersonsTadeSpawns()
  return tried
}

describe("a test never reaches the person's own Tade home", () => {
  it('runs in a home, a Tade home and a folder of tools that are not theirs', () => {
    expect(inPersonsTade(homedir())).toBe(false)
    expect(inPersonsTade(tadeHome())).toBe(false)
    const unset = ConfigSchema.parse({}).orchestrator.extensions
    expect(inPersonsTade(extensionsRoot(tadeHome(), unset))).toBe(false)
    expect(inPersonsTade(join(tadeHome(), 'skills'))).toBe(false)
    for (const name of ['TADE_HOME', 'TADE_EXTENSIONS', 'TADE_SKILLS'])
      expect(process.env[name]).toBeUndefined()
  })

  it('runs without the way back to the agent or the window that started the suite', () => {
    // Everything a launch could say, so every name it can hand down is in it.
    const spec: WorkerSpec = {
      run: 'app/refunds/agent',
      task: 'app/refunds',
      cwd: tmp('tade-handed-cwd-'),
      prompt: '',
      title: 'Refunds',
      called: 'refunds',
      extras: { tools: join(tmp('tade-handed-tools-'), 'tools.json') },
    }
    const claudeDir = tmp('tade-handed-claude-')
    writeFileSync(join(claudeDir, 'settings.json'), '{"statusLine":{"command":"theirs"}}')
    const launches = {
      claude: new ClaudeAdapter({ runDir: tmp('tcc-'), configDir: claudeDir, home: tmp() }),
      codex: new CodexAdapter({ runDir: tmp('tcx-'), codexHome: tmp(), home: tmp() }),
      pi: new PiAdapter({ runDir: tmp('tade-pi-'), env: {} }),
    }
    const handed = new Set<string>(Object.values(WORKER_ENV))
    for (const adapter of Object.values(launches))
      for (const name of Object.keys(adapter.launchSpec(spec).env ?? {})) handed.add(name)
    const tools = toolEnv({
      home: tmp(),
      socket: '/run/tade.sock',
      runDir: tmp(),
      env: {},
      extensions: { prompt: '', extras: { tools: spec.extras?.tools ?? '' } },
    })
    for (const name of Object.keys(tools)) handed.add(name)

    const tade = [...handed].filter((name) => name.startsWith('TADE_')).sort()
    expect(tade).toContain('TADE_RUN_SOCKET')
    expect(tade).toContain('TADE_CLAUDE_STATUSLINE')
    expect(tade).toContain('TADE_SOCKET')
    expect(tade.filter((name) => !(HANDED_DOWN as readonly string[]).includes(name))).toEqual([])
    for (const name of HANDED_DOWN) expect(process.env[name], name).toBeUndefined()
  })

  it('refuses a process started there, by its folder or by git -C', async () => {
    const extensions = join(persons, 'extensions')
    expect(await tries(() => spawn('git', ['add', '-A'], { cwd: extensions }))).toEqual([
      `git add -A in ${extensions}`,
    ])
    expect(await tries(() => spawn('git', ['-C', extensions, 'status']))).toHaveLength(1)
    expect(
      await tries(() => new Promise((done) => execFile('git', ['status'], { cwd: persons }, done))),
    ).toHaveLength(1)
  })

  it('leaves the suite its own checkout, even where that is kept under the home', () => {
    // Tade's batched full checks run the suite in a tree under its home.
    const roots = [join(persons)]
    expect(inPersonsTade(join(persons, 'projects', 'tade', 'batch'), roots)).toBe(true)
    expect(inPersonsTade(process.cwd(), [process.cwd()])).toBe(false)
    expect(inPersonsTade(join(persons, '..', '.tade-elsewhere'), roots)).toBe(false)
  })
})

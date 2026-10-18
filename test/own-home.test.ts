import { execFile, spawn } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../packages/core/src/config.ts'
import { extensionsRoot, tadeHome } from '../packages/core/src/home.ts'
import { forgetPersonsTadeSpawns, inPersonsTade, personsTadeSpawns } from './own-home.ts'

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

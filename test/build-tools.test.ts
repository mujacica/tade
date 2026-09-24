import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs script, and it ships as one: it is the package's
// `preinstall`, and it runs on a machine where nothing has been built yet.
import * as script from '../scripts/check-build-tools.mjs'

// The sentence somebody gets instead of forty lines of node-gyp.
//
// node-pty ships prebuilds for darwin and win32 and for no Linux, so on Linux
// it is always compiled — and `npm i -g tade-sh` on a machine with no
// toolchain ended in `gyp ERR! find Python` and a working directory nobody
// chose. This is what refuses first, and the whole of what it may do is refuse
// where node-gyp would have failed anyway.

// The shape it is used at, written once: a `.mjs` has no types of its own, and
// three lambdas each saying `one: string` says less than this does.
type Env = Record<string, string | undefined>
const missingFor = script.missingFor as (
  platform: string,
  env: Env,
  here: (name: string) => boolean,
) => string[]
const onPath = script.onPath as (env: Env, name: string) => boolean
const trouble = script.trouble as (missing: readonly string[]) => string | null

const SCRIPT = fileURLToPath(new URL('../scripts/check-build-tools.mjs', import.meta.url))

const nothing = (): boolean => false
const everything = (): boolean => true

describe('what compiling node-pty needs', () => {
  it('is asked for on Linux and nowhere else, because everywhere else has a prebuild', () => {
    expect(missingFor('darwin', {}, nothing)).toEqual([])
    expect(missingFor('win32', {}, nothing)).toEqual([])
    expect(missingFor('linux', {}, nothing)).toHaveLength(3)
  })

  it('takes any of the names node-gyp would accept', () => {
    // Generous on purpose: refusing where node-gyp would have succeeded is the
    // one way this can be worse than not existing.
    expect(missingFor('linux', {}, (one) => ['python', 'clang++', 'gmake'].includes(one))).toEqual(
      [],
    )
    expect(missingFor('linux', {}, (one) => ['python3', 'cc', 'ninja'].includes(one))).toEqual([])
  })

  it('takes the environment variables node-gyp reads before it looks at all', () => {
    const env = { PYTHON: '/opt/py/bin/python3', CXX: '/opt/llvm/bin/clang++', MAKE: '/opt/make' }
    expect(missingFor('linux', env, nothing)).toEqual([])
    // Set to nothing is not set: an empty variable is what a shell leaves
    // behind, and node-gyp would go looking too.
    expect(missingFor('linux', { PYTHON: '', CXX: '', MAKE: '' }, nothing)).toHaveLength(3)
  })

  it('names each missing thing on its own line, with what installs them', () => {
    const said = trouble(missingFor('linux', {}, (one) => one !== 'python3' && one !== 'python'))
    expect(said).toContain('\n  python3\n')
    expect(said).not.toContain('C++ compiler')
    expect(said).toContain('sudo apt-get install -y build-essential python3')
    expect(said).toContain('Nothing has been installed.')
  })

  it('says nothing at all when there is nothing to say', () => {
    expect(trouble(missingFor('linux', {}, everything))).toBeNull()
  })
})

describe('the script npm runs', () => {
  it('is silent and exits 0 on a machine that can build, which is this one', () => {
    // It runs as `preinstall` on every install of the published package, so a
    // throw or a stray line here is everybody's install. `pnpm check` runs on
    // macOS and on ubuntu-latest, and both have a toolchain.
    const out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    expect(out).toBe('')
  })

  it('looks along PATH for something runnable, and finds nothing where there is nothing', () => {
    expect(onPath(process.env, 'node')).toBe(true)
    expect(onPath({ PATH: '' }, 'node')).toBe(false)
    expect(onPath(process.env, 'a-program-nobody-has')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { nativeTrouble } from '../src/native.ts'

// The sentence somebody gets instead of a stack trace out of Node's module
// loader. Every case here is one an install can really land in.

const withCode = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code })

describe('a dependency that did not load', () => {
  it('names the module and what to do when the binary is missing', () => {
    const said = nativeTrouble(
      withCode('ERR_DLOPEN_FAILED', "Could not locate the bindings file 'node-pty'"),
    )
    expect(said).toContain('node-pty')
    expect(said).toContain('native module')
    // Nothing is compiled on install any more, so no toolchain is the answer.
    expect(said).toContain('ready-built')
    expect(said).toContain('glibc 2.28')
    expect(said).not.toContain('build-essential')
  })

  it('says it is native even where the message quotes no package', () => {
    // What dlopen says is a path and nothing else, and a path read as a name
    // used to send somebody the advice for a dependency that failed to
    // download rather than one whose binary would not load.
    const said = nativeTrouble(
      withCode(
        'ERR_DLOPEN_FAILED',
        'dlopen(/x/node-pty/prebuilds/linux-x64/pty.node): no such file',
      ),
    )
    expect(said).toContain('node-pty')
    expect(said).toContain('ready-built')
    expect(said).not.toContain('install that did not finish')
  })

  it("answers node-pty's own way of saying it", () => {
    const said = nativeTrouble(new Error('Failed to load native module: pty.node, checked: …'))
    expect(said).toContain('Tade could not load @lydell/node-pty.')
  })

  it('answers a module built against another Node', () => {
    const said = nativeTrouble(
      new Error("The module 'better-sqlite3' was compiled against a different NODE_MODULE_VERSION"),
    )
    expect(said).toContain('better-sqlite3')
  })

  it('says the install did not finish for something that is not native', () => {
    const said = nativeTrouble(
      withCode('ERR_MODULE_NOT_FOUND', "Cannot find package 'commander' imported from …"),
    )
    expect(said).toContain('commander')
    expect(said).toContain('npm install -g tade-sh')
    expect(said).not.toContain('build-essential')
  })

  // Neither native module has an install script, so a package manager that
  // holds one (npm 12, pnpm, bun) is never the reason, and saying it was would
  // send somebody to approve something that is not there.
  it('names no gate on install scripts, because there is no script to hold', () => {
    const said = nativeTrouble(withCode('ERR_DLOPEN_FAILED', "dlopen 'node-pty'"))
    expect(said).not.toContain('approve-builds')
    expect(said).not.toContain('--allow-scripts')
    expect(said).not.toContain('npm 11')
    expect(said).toContain('npm install -g tade-sh')
    // bun builds better-sqlite3 over its prebuilds unless told to run nothing.
    expect(said).toContain('bun add -g --ignore-scripts tade-sh')
  })

  it("answers @lydell/node-pty's own error for a platform package that is not there", () => {
    // A plain Error with no code, thrown by the wrapper at import.
    const said = nativeTrouble(
      new Error(
        'The @lydell/node-pty package supports your platform (linux-x64), but it could not find the platform-specific package for it: @lydell/node-pty-linux-x64',
      ),
    )
    expect(said).toContain('Tade could not load @lydell/node-pty.')
    expect(said).toContain('native module')
  })

  it('names the npx cache entry to forget where Tade runs out of one', () => {
    const said = nativeTrouble(
      withCode('ERR_DLOPEN_FAILED', 'dlopen(/x/@lydell/node-pty-linux-x64/pty.node)'),
      '/home/x/.npm/_npx/9a8b7c6d5e4f3a2b/node_modules/tade-sh/packages/cli/src/native.js',
    )
    expect(said).toContain('npm cache npx rm 9a8b7c6d5e4f3a2b && npx tade-sh')
    expect(said).not.toContain('npm install -g')
  })

  it("keeps quiet about a relative file, which is Tade's own bug", () => {
    // Dressing this up as somebody's install problem sends them off to fix a
    // machine that is fine, and hides the real error.
    expect(
      nativeTrouble(
        withCode('ERR_MODULE_NOT_FOUND', "Cannot find module './commands/app.js' imported from …"),
      ),
    ).toBeNull()
  })

  it('keeps quiet about anything else, so the real error is thrown', () => {
    expect(nativeTrouble(new TypeError('x is not a function'))).toBeNull()
    expect(nativeTrouble('a string nobody threw on purpose')).toBeNull()
  })
})

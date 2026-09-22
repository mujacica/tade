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
    expect(said).toContain('xcode-select --install')
    expect(said).toContain('build-essential')
  })

  it('says it is native even where the message quotes no package', () => {
    // What dlopen says is a path and nothing else, and a path read as a name
    // used to send somebody the advice for a dependency that failed to
    // download rather than one that failed to build.
    const said = nativeTrouble(
      withCode(
        'ERR_DLOPEN_FAILED',
        'dlopen(/x/node-pty/prebuilds/linux-x64/pty.node): no such file',
      ),
    )
    expect(said).toContain('node-pty')
    expect(said).toContain('build-essential')
    expect(said).not.toContain('install that did not finish')
  })

  it("answers node-pty's own way of saying it", () => {
    const said = nativeTrouble(new Error('Failed to load native module: pty.node, checked: …'))
    expect(said).toContain('node-pty')
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

  it('names the gate that holds an install script rather than running it', () => {
    const said = nativeTrouble(withCode('ERR_DLOPEN_FAILED', "dlopen 'node-pty'"))
    expect(said).toContain('pnpm approve-builds')
    expect(said).toContain('--allow-scripts=')
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

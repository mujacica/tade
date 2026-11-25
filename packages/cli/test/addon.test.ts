import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Addon, builtForAnotherNode, linksLibnode, npmBeside, ptyAddon } from '../src/addon.ts'

// The other half of the door. A node-pty that Ubuntu's node-gyp compiled names
// `libnode.so.127`, and an official Node of the same ABI loads it, runs the
// command and aborts on exit with 134 — so it is turned away before loading.

const NPM = '/opt/node/bin/npm'

/** Bytes shaped like an ELF's dynamic strings, with or without the shared runtime. */
function addon(...needed: string[]): Addon {
  const bytes = Buffer.from(`\x7fELF\0${needed.join('\0')}\0pty_spawn\0`, 'latin1')
  return { path: '/x/node-pty/build/Release/pty.node', bytes, root: '/x/node-pty' }
}

describe('a node-pty compiled for another Node', () => {
  it('is turned away under a static Node, with the rebuild that fixes it', () => {
    const said = builtForAnotherNode(addon('libnode.so.127', 'libc.so.6'), false, 'v22.23.5', NPM)
    expect(said).toContain('node-pty was compiled for another Node')
    expect(said).toContain('/x/node-pty/build/Release/pty.node')
    expect(said).toContain('v22.23.5')
    expect(said).toContain(`cd /x/node-pty && ${NPM} run install`)
  })

  it('is let through by the shared Node it was built for', () => {
    expect(builtForAnotherNode(addon('libnode.so.127', 'libc.so.6'), true, 'v22.22.1', NPM)).toBe(
      null,
    )
  })

  it('lets through an addon that needs no libnode, under either Node', () => {
    // Built by an official Node, it loads under Ubuntu's too: only one
    // direction crashes, so only one is stopped.
    expect(builtForAnotherNode(addon('libstdc++.so.6', 'libc.so.6'), false, 'v22.23.5', NPM)).toBe(
      null,
    )
    expect(builtForAnotherNode(addon('libstdc++.so.6'), true, 'v22.22.1', NPM)).toBe(null)
  })

  it('stops nobody when there is no binary to read', () => {
    expect(builtForAnotherNode(null, false, 'v22.23.5', NPM)).toBe(null)
  })

  it('reads the linked library by name', () => {
    expect(linksLibnode(addon('libnode.so.127').bytes)).toBe(true)
    expect(linksLibnode(addon('libnodes.txt').bytes)).toBe(false)
  })
})

describe('finding the binary', () => {
  it('finds the node-pty this checkout would load', () => {
    const found = ptyAddon()
    expect(found).not.toBeNull()
    expect(found?.path.endsWith('pty.node')).toBe(true)
    expect(existsSync(found?.path ?? '')).toBe(true)
    expect(found?.bytes.byteLength).toBeGreaterThan(0)
  })

  it('names the npm beside this Node, or plain npm where there is none', () => {
    expect(npmBeside('/nowhere/bin/node')).toBe('npm')
    const beside = npmBeside(process.execPath)
    expect(beside === 'npm' || beside.endsWith('/npm')).toBe(true)
  })
})

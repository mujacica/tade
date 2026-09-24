import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { nodeTooOld } from '../src/node.ts'

// The door. `engines` is a warning npm prints once and installs over, so this
// is the only thing between somebody on Node 20 and a TypeError out of a
// dependency's module body.

const WHERE = '/usr/local/bin/node'

describe('a Node too old to run Tade', () => {
  it('says which Node it needs, which this is, and where this one is', () => {
    const said = nodeTooOld('20.20.2', '>=22.19', WHERE)
    expect(said).toContain('Tade needs Node 22.19 or newer, and this is Node 20.20.2.')
    expect(said).toContain(WHERE)
  })

  it('says why it is not a preference, and how to get a newer one', () => {
    const said = nodeTooOld('18.20.4', '>=22.19', WHERE) ?? ''
    expect(said).toContain('no build step')
    expect(said).toContain('nvm install 22')
    expect(said).toContain('https://nodejs.org/en/download')
  })

  it('compares numbers, because 22.9 is only above 22.19 in a dictionary', () => {
    expect(nodeTooOld('22.9.0', '>=22.19', WHERE)).not.toBeNull()
    expect(nodeTooOld('22.19.0', '>=22.19', WHERE)).toBeNull()
    expect(nodeTooOld('22.20.1', '>=22.19', WHERE)).toBeNull()
    expect(nodeTooOld('100.0.0', '>=22.19', WHERE)).toBeNull()
  })

  it('reads what Node calls itself, prerelease and all', () => {
    expect(nodeTooOld('v20.0.0', '>=22.19', WHERE)).not.toBeNull()
    expect(nodeTooOld('23.0.0-nightly20240101', '>=22.19', WHERE)).toBeNull()
  })

  it('refuses nothing on a range it cannot read, or none at all', () => {
    // It may only ever stop somebody, so what it half-understands it leaves
    // alone: the error they would otherwise get at least has a cause in it.
    expect(nodeTooOld('20.20.2', '^22.19', WHERE)).toBeNull()
    expect(nodeTooOld('20.20.2', null, WHERE)).toBeNull()
    expect(nodeTooOld('20.20.2', '', WHERE)).toBeNull()
  })
})

describe('the floor it is checked against', () => {
  it('is the one the manifest declares, and this Node is above it', () => {
    // Two numbers would drift, and the one that drifted would be the one
    // nobody runs. `needsNode` reads `engines.node`; this is the same file.
    const root = fileURLToPath(new URL('../../../package.json', import.meta.url))
    const engines = (JSON.parse(readFileSync(root, 'utf8')) as { engines: { node: string } })
      .engines
    expect(engines.node.startsWith('>=')).toBe(true)
    expect(nodeTooOld(process.versions.node, engines.node, process.execPath)).toBeNull()
  })
})

import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { forgetRunFiles, runFolderName } from '../src/forget.ts'
import type { RunId } from '../src/port.ts'

const run = (name: string) => name as RunId

/** A run's folder with a file in it, as an adapter writes one. */
function folderFor(root: string, name: string): string {
  const dir = join(root, runFolderName(name))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), '{}')
  return dir
}

describe('a run’s files', () => {
  it('are named the same for a run every time, and differently for another', () => {
    expect(runFolderName('shop/refunds/agent')).toBe(runFolderName('shop/refunds/agent'))
    expect(runFolderName('shop/refunds/agent')).not.toBe(runFolderName('shop/returns/agent'))
    expect(runFolderName('shop/refunds/agent')).toMatch(/^[0-9a-f]{12}$/)
  })

  it('go for the runs asked about, and only those, saying which had any', async () => {
    const root = tmp('tade-runs-')
    const over = folderFor(root, 'shop/refunds/agent')
    const kept = folderFor(root, 'shop/returns/agent')
    const launch = join(root, `${runFolderName('shop/refunds/agent')}.launch.json`)
    writeFileSync(launch, '{}')

    const gone = await forgetRunFiles(
      root,
      [run('shop/refunds/agent'), run('shop/never-ran/agent')],
      (one) => [runFolderName(one), `${runFolderName(one)}.launch.json`],
    )
    expect(gone).toEqual(['shop/refunds/agent'])
    expect(existsSync(over)).toBe(false)
    expect(existsSync(launch)).toBe(false)
    expect(existsSync(join(kept, 'settings.json'))).toBe(true)
  })

  it('are nothing to take away where none was ever written', async () => {
    const root = join(tmp('tade-runs-'), 'claude')
    expect(
      await forgetRunFiles(root, [run('shop/refunds/agent')], (one) => [runFolderName(one)]),
    ).toEqual([])
  })

  it('say a folder it could not empty, rather than calling it tidied', async () => {
    const root = tmp('tade-runs-')
    const over = folderFor(root, 'shop/refunds/agent')
    chmodSync(over, 0o500)
    try {
      await expect(
        forgetRunFiles(root, [run('shop/refunds/agent')], (one) => [runFolderName(one)]),
      ).rejects.toThrow(/EACCES/)
    } finally {
      chmodSync(over, 0o700)
    }
    expect(existsSync(join(over, 'settings.json'))).toBe(true)
  })
})

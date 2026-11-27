import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { ExtensionContext } from '@tade/extensions-core'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { judgeFor } from '../src/ask.ts'
import { keptIn, keptPath } from '../src/kept.ts'
import { typesafe } from './harness.ts'

// The version that last answered, in Tade's home, so the first look after a
// restart whose list of versions cannot be read still has one to ask with.

describe('the version kept past a restart', () => {
  it('is written in Tade home, read back, and forgotten', async () => {
    const { home } = mkrepo()
    const kept = keptIn(home)
    expect(await kept.read('a')).toBeNull()
    await kept.write('a', 'jev-latest')
    await kept.write('b', 'jev-1.14.0')
    expect(await keptIn(home).read('a')).toBe('jev-latest')
    expect(statSync(keptPath(home)).mode & 0o777).toBe(0o600)
    await kept.write('a', null)
    expect(JSON.parse(readFileSync(keptPath(home), 'utf8'))).toEqual({ b: 'jev-1.14.0' })
  })

  it('says a file cut short rather than reading it as nothing kept, and writes it whole again', async () => {
    const { home } = mkrepo()
    const kept = keptIn(home)
    await kept.write('a', 'jev-latest')
    writeFileSync(keptPath(home), '{"a": "jev-lat')
    await expect(kept.read('a')).rejects.toThrow(/version\.json is not what Tade wrote/)
    await kept.write('a', 'jev-latest')
    expect(await kept.read('a')).toBe('jev-latest')
  })

  it('throws where the file cannot be read at all, and never writes over it blind', async () => {
    const { home } = mkrepo()
    mkdirSync(keptPath(home), { recursive: true })
    await expect(keptIn(home).read('a')).rejects.toThrow(/EISDIR/)
    await expect(keptIn(home).write('a', 'jev-latest')).rejects.toThrow(/EISDIR/)
  })

  it('is what the extension hands its judge, so an answer is kept there', async () => {
    const repo = mkrepo()
    // Only what judgeFor reads of a context.
    const ctx = {
      settings: {},
      home: repo.home,
      fetch: typesafe({ one: 0.2 }),
      secret: () => ({ value: 'k', from: 'config.yaml' }),
    } as unknown as ExtensionContext
    await judgeFor(ctx).ask({
      state: 'x',
      questions: [{ id: 'one', kind: 'yes-no', ask: 'is it?' }],
    })
    expect(Object.values(JSON.parse(readFileSync(keptPath(repo.home), 'utf8')))).toHaveLength(1)
  })
})

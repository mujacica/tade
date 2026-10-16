import { describe, expect, it } from 'vitest'
import { askFindings } from '../src/findings.ts'
import type { ExtensionContext, JudgeFinding, TadeExtension } from '../src/port.ts'

const ctx = {} as ExtensionContext

const one: JudgeFinding = {
  key: 'app/x:test_missing',
  question: 'test_missing',
  project: 'app',
  tasks: ['app/x'],
  at: 1,
  probability: 0.9,
  file: 'src/x.ts',
  stillThere: true,
  account: null,
  verdict: null,
}

function judge(name: string, findings: TadeExtension['findings']): TadeExtension {
  return { name, title: name, description: name, ...(findings ? { findings } : {}) }
}

describe('what every judge found', () => {
  it('gathers each extension’s findings, and asks nothing of one that keeps none', async () => {
    const asked = await askFindings([
      { extension: judge('jev', async () => [one]), ctx },
      { extension: judge('quiet', undefined), ctx },
    ])
    expect(asked).toEqual({ findings: [one], problems: [], asked: 1 })
  })

  it('says which could not answer, rather than drawing its silence as nothing found', async () => {
    const asked = await askFindings(
      [
        { extension: judge('broken', async () => Promise.reject(new Error('no record'))), ctx },
        { extension: judge('late', () => new Promise(() => {})), ctx },
        { extension: judge('odd', async () => 'nope' as unknown as JudgeFinding[]), ctx },
        { extension: judge('jev', async () => [one]), ctx },
      ],
      20,
    )
    expect(asked.findings).toEqual([one])
    expect(asked.asked).toBe(4)
    expect(asked.problems.sort()).toEqual([
      'broken: no record',
      'late: it did not answer in time',
      'odd: it answered something that is not a list',
    ])
  })
})

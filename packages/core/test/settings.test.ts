import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/config.ts'
import { applySetting, describeSetting, parseSetting, settingsOf } from '../src/settings.ts'

// The settings worth putting in front of somebody, and what writing one back
// does to the file they wrote by hand.

const config = (over: Record<string, unknown> = {}) => ConfigSchema.parse(over)
const find = (path: string, over: Record<string, unknown> = {}) => {
  const found = settingsOf(config(over))
    .flatMap((group) => group.settings)
    .find((setting) => setting.path === path)
  if (!found) throw new Error(`no setting called ${path}`)
  return found
}

describe('what there is to change', () => {
  it('says what each one is now', () => {
    expect(find('workspace.driver', { workspace: { driver: 'tmux' } }).value).toBe('tmux')
  })

  it('shows the default in brackets when nothing is set', () => {
    // A blank where a value should be reads as broken. What it will do
    // instead, marked as not-your-choice, reads as a default.
    expect(describeSetting(find('orchestrator.model'))).toContain('(the harness decides)')
  })

  it('says what changing it does, not just what it is called', () => {
    // "workspace.driver: pty" answers nothing for somebody deciding.
    expect(find('workspace.driver').means).toContain('after you close Tade')
    expect(find('approvals.mode').means).toContain('never interrupts')
  })

  it('offers only values the schema would accept', () => {
    const driver = find('workspace.driver')
    expect(driver.type).toEqual({ kind: 'choice', options: ['pty', 'tmux'] })
    for (const option of ['pty', 'tmux']) {
      expect(() => config({ workspace: { driver: option } })).not.toThrow()
    }
  })
})

describe('writing one back', () => {
  it('puts it where the schema expects it', () => {
    const file: Record<string, unknown> = {}
    applySetting(file, 'surfaces.voice.attention.quiet', '22:00-08:00')
    expect(file).toEqual({ surfaces: { voice: { attention: { quiet: '22:00-08:00' } } } })
    // And the result is something the config will actually accept.
    expect(() => config(file)).not.toThrow()
  })

  it('leaves everything else in the file exactly as it was', () => {
    const file: Record<string, unknown> = {
      projects: { app: { root: '/src/app' } },
      workspace: { driver: 'tmux', adopt: false },
    }
    applySetting(file, 'workspace.driver', 'pty')
    expect(file).toEqual({
      projects: { app: { root: '/src/app' } },
      workspace: { driver: 'pty', adopt: false },
    })
  })

  it('removes the key when the value is cleared, rather than writing a blank', () => {
    const file: Record<string, unknown> = { orchestrator: { model: 'claude-opus-5' } }
    applySetting(file, 'orchestrator.model', undefined)
    // Back to the default, which is not the same as "set to empty" — the
    // schema would reject one and silently honour the other.
    expect(file).toEqual({ orchestrator: {} })
  })
})

describe('reading what was typed', () => {
  it('takes yes and no for a flag', () => {
    const flag = find('workspace.adopt')
    expect(parseSetting(flag, 'yes')).toBe(true)
    expect(parseSetting(flag, 'n')).toBe(false)
  })

  it('refuses a number that is not one', () => {
    const budget = find('surfaces.voice.attention.budget')
    expect(parseSetting(budget, '12')).toBe(12)
    // Rejected rather than coerced: `NaN` written to the config would be a
    // setting that fails validation the next time Tade opens.
    expect(parseSetting(budget, 'lots')).toBeUndefined()
    expect(parseSetting(budget, '-3')).toBeUndefined()
  })

  it('treats an empty answer as clearing it', () => {
    expect(parseSetting(find('orchestrator.model'), '   ')).toBeUndefined()
  })
})

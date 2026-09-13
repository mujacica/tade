import { describe, expect, it } from 'vitest'
import { isSkillName, loadableSkills, SKILL_LIMIT, skillDirs, skillText } from '../src/skills.ts'

// A skill is a lesson the orchestrator wrote and a human approved. These are
// the rules about which ones count and how much of one reaches the prompt.

describe('skillDirs', () => {
  it('keeps proposed, active and rejected apart', () => {
    const dirs = skillDirs('/home/me/.wilco/skills')
    expect(dirs.proposed).toBe('/home/me/.wilco/skills/proposed')
    expect(dirs.active).toBe('/home/me/.wilco/skills/active')
    // Kept, so the same lesson is not proposed again next week.
    expect(dirs.rejected).toBe('/home/me/.wilco/skills/rejected')
  })
})

describe('loadableSkills', () => {
  it('takes markdown and nothing else', () => {
    expect(loadableSkills(['a.md', 'b.ts', 'notes.txt', 'c.md'])).toEqual(['a.md', 'c.md'])
  })

  it('ignores drafts and editor leftovers', () => {
    expect(loadableSkills(['_draft.md', '.swp.md', 'real.md'])).toEqual(['real.md'])
  })

  it('is sorted, so the prompt is the same every time', () => {
    expect(loadableSkills(['z.md', 'a.md'])).toEqual(['a.md', 'z.md'])
  })
})

describe('isSkillName', () => {
  it('refuses anything that would escape the directory', () => {
    expect(isSkillName('run-tests-before-pr')).toBe(true)
    for (const bad of ['../escape', 'a/b', '.hidden', 'Caps', '']) {
      expect(isSkillName(bad)).toBe(false)
    }
  })
})

describe('skillText', () => {
  it('says nothing when nothing has been learned', () => {
    expect(skillText([])).toBe('')
  })

  it('names each lesson and gives its text', () => {
    const text = skillText([{ name: 'payments', text: 'Run the integration suite first.' }])
    expect(text).toContain('What you have learned here:')
    expect(text).toContain('- payments: Run the integration suite first.')
  })

  it('flattens a lesson onto one line', () => {
    // Markdown paragraphs turn into a wall in the middle of a prompt.
    const text = skillText([{ name: 'x', text: 'First line.\n\nSecond line.' }])
    expect(text).toContain('- x: First line. Second line.')
  })

  it('caps a long one, because ten of them would crowd out everything else', () => {
    // Context bloat is indistinguishable from having no skills at all.
    const long = 'a'.repeat(SKILL_LIMIT * 2)
    const text = skillText([{ name: 'x', text: long }])
    expect(text.length).toBeLessThan(SKILL_LIMIT + 100)
    expect(text.endsWith('…')).toBe(true)
  })
})

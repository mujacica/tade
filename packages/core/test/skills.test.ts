import { describe, expect, it } from 'vitest'
import {
  isSkillName,
  livingSkills,
  loadableSkills,
  SKILL_LIMIT,
  type Skill,
  skillAbout,
  skillDirs,
  skillStanding,
  skillText,
} from '../src/skills.ts'

// A skill is a lesson the orchestrator wrote and a human approved. These are
// the rules about which ones count and how much of one reaches the prompt.

describe('skillDirs', () => {
  it('keeps proposed, active and rejected apart', () => {
    const dirs = skillDirs('/home/me/.tade/skills')
    expect(dirs.proposed).toBe('/home/me/.tade/skills/proposed')
    expect(dirs.active).toBe('/home/me/.tade/skills/active')
    // Kept, so the same lesson is not proposed again next week.
    expect(dirs.rejected).toBe('/home/me/.tade/skills/rejected')
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

// Lessons that stop applying.
//
// A skill about a project nobody has touched in a month is noise in every
// prompt from then on, so it stops being said. Nothing is moved or deleted:
// the day that project moves again the lesson is back, which is why this is
// derived rather than filed.

describe('which lessons still apply', () => {
  const NOW = Date.parse('2026-09-13T12:00:00Z')
  const DAY = 24 * 60 * 60 * 1000
  const skill = (name: string, about?: string): Skill => ({
    name,
    text: about ? `about: ${about}\n\nAlways run the integration suite.` : 'Prefer small commits.',
    ...(about ? { about } : {}),
  })

  it('keeps a lesson about something that is still moving', () => {
    const standing = skillStanding(
      [skill('payments-suite', 'checkout')],
      { lastSeenAt: { checkout: NOW - 2 * DAY }, known: ['checkout'] },
      NOW,
    )
    expect(standing[0]).toMatchObject({ dormant: false, reason: '' })
  })

  it('stops saying one about a project that has gone quiet', () => {
    const standing = skillStanding(
      [skill('payments-suite', 'checkout')],
      { lastSeenAt: { checkout: NOW - 45 * DAY }, known: ['checkout'] },
      NOW,
    )
    expect(standing[0]?.dormant).toBe(true)
    // The reason has to be actable: "45 days" is, "dormant" is not.
    expect(standing[0]?.reason).toContain('45 days')
  })

  it('keeps a lesson about the project alive when any of its tasks moves', () => {
    const standing = skillStanding(
      [skill('payments-suite', 'checkout')],
      { lastSeenAt: { checkout: NOW - 2 * DAY, 'checkout/refunds': NOW }, known: ['checkout'] },
      NOW,
    )
    expect(standing[0]?.dormant).toBe(false)
  })

  it('drops one about a project that is not a project any more', () => {
    const standing = skillStanding(
      [skill('old-rule', 'legacy')],
      { lastSeenAt: { legacy: NOW }, known: ['checkout'] },
      NOW,
    )
    expect(standing[0]).toMatchObject({ dormant: true, reason: expect.stringContaining('legacy') })
  })

  it('never decays a lesson about working here in general', () => {
    // There is nothing that could have gone quiet, so there is nothing to
    // decide: a general lesson is said forever or turned down by a human.
    const standing = skillStanding([skill('small-commits')], { lastSeenAt: {}, known: [] }, NOW)
    expect(standing[0]?.dormant).toBe(false)
  })

  it('treats a subject nothing has ever happened in as quiet', () => {
    const standing = skillStanding(
      [skill('payments-suite', 'checkout')],
      { lastSeenAt: {}, known: ['checkout'] },
      NOW,
    )
    expect(standing[0]?.dormant).toBe(true)
  })

  it('hands the prompt only what still applies', () => {
    const living = livingSkills(
      [skill('live', 'checkout'), skill('quiet', 'archive-me'), skill('general')],
      { lastSeenAt: { checkout: NOW }, known: ['checkout', 'archive-me'] },
      NOW,
    )
    expect(living.map((s) => s.name)).toEqual(['live', 'general'])
  })
})

describe('reading what a lesson is about', () => {
  it('takes the subject off the line the model wrote it on', () => {
    expect(skillAbout('about: checkout/refunds\n\nRun the suite.')).toBe('checkout/refunds')
    expect(skillAbout('# Title\nabout: checkout\n\nRun the suite.')).toBe('checkout')
  })

  it('is about everything when it says nothing', () => {
    expect(skillAbout('Prefer small commits.')).toBeUndefined()
    // Deep in the body is prose, not a header: a lesson that mentions the word
    // in passing is not thereby scoped to whatever followed it.
    expect(skillAbout(`${'filler\n'.repeat(10)}about: checkout\n`)).toBeUndefined()
  })

  it('keeps the lesson when the subject is unreadable', () => {
    // Written by a model, read by a human: neither should have to get this
    // exactly right for the lesson itself to survive.
    expect(skillAbout('about: {{ project }}\n')).toBeUndefined()
  })
})

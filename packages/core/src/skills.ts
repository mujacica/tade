import { join } from 'node:path'

// Lessons, in the orchestrator's own words.
//
// A skill is something the model noticed and wrote down: "every time a task
// touched payments you made me run the integration suite first". The judgement
// about what was learned belongs to the thing doing the work, not to a rule we
// could write here — so Wilco proposes, and a human decides.
//
// Same three-directory shape as extensions, for the same reason: a proposal is
// inert until somebody reads it, and a turned-down one is kept so the same idea
// is not proposed twice.

export interface SkillDirs {
  root: string
  active: string
  proposed: string
  rejected: string
}

export interface Skill {
  name: string
  /** Markdown, as written. Shown to the model verbatim. */
  text: string
}

export function skillDirs(root: string): SkillDirs {
  return {
    root,
    active: join(root, 'active'),
    proposed: join(root, 'proposed'),
    rejected: join(root, 'rejected'),
  }
}

/** Which files are skills, in a stable order. */
export function loadableSkills(files: readonly string[]): string[] {
  return files
    .filter((name) => name.endsWith('.md'))
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
    .sort((a, b) => a.localeCompare(b))
}

export function isSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
}

/**
 * How much of a skill reaches the prompt. Long enough to be useful, short
 * enough that ten of them do not crowd out everything else — context bloat is
 * indistinguishable from having no skills at all.
 */
export const SKILL_LIMIT = 600

export function skillText(skills: readonly Skill[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((skill) => {
    const text = skill.text.trim()
    const short = text.length > SKILL_LIMIT ? `${text.slice(0, SKILL_LIMIT).trimEnd()}…` : text
    return `- ${skill.name}: ${short.replace(/\s*\n\s*/g, ' ')}`
  })
  return ['What you have learned here:', ...lines].join('\n')
}

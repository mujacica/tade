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
  /**
   * The task or project it is about, if it is about one. This is what lets a
   * lesson go quiet when its subject does: a rule about a project nobody has
   * touched in a month is noise in every prompt until it is.
   */
  about?: string
}

/**
 * Read the subject off a lesson, written as `about: <task or project>` on a
 * line of its own near the top.
 *
 * Hand-read rather than parsed as frontmatter because the file is written by a
 * model and read by a human, and neither should have to get YAML right for the
 * lesson itself to survive. Anything unfamiliar simply means "about
 * everything", which is the safe answer: it keeps the lesson.
 */
export function skillAbout(text: string): string | undefined {
  for (const line of text.split('\n', 8)) {
    const found = /^\s*about:\s*([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?)\s*$/i.exec(line)
    if (found) return found[1]?.toLowerCase()
  }
  return undefined
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

/** How long a lesson's subject can lie untouched before it stops being said. */
export const DORMANT_AFTER_MS = 30 * 24 * 60 * 60 * 1000

export interface SkillStanding {
  skill: Skill
  dormant: boolean
  /** Why, in words a human can act on. Empty when it is in use. */
  reason: string
}

/** What has happened lately, per project and per task. Keys are ids. */
export interface SkillActivity {
  /** Wall-clock ms of the last thing that happened, by project or task id. */
  lastSeenAt: Record<string, number>
  /** Projects that still exist. A lesson about a deleted one can never apply. */
  known: readonly string[]
}

/**
 * Which lessons still apply, and which have gone quiet.
 *
 * Decay is derived, not filed: a lesson about a project nobody has touched in a
 * month is not *said* — it is skipped when the prompt is composed — but nothing
 * is moved or deleted, and the day that project moves again the lesson is back
 * without anyone doing anything. Sorting files into an archive directory would
 * mean the same information with an extra thing to get out of step, and would
 * turn "it stopped mentioning that" into a change you cannot undo by working.
 *
 * A lesson with no subject is about working here in general, and never decays:
 * there is nothing that could have gone quiet.
 *
 * Pure: skills and what has happened in, standing out, `now` passed.
 */
export function skillStanding(
  skills: readonly Skill[],
  activity: SkillActivity,
  now: number,
): SkillStanding[] {
  return skills.map((skill) => {
    const about = skill.about?.trim()
    if (!about) return { skill, dormant: false, reason: '' }

    const project = about.split('/')[0] ?? about
    if (!activity.known.includes(project)) {
      return { skill, dormant: true, reason: `${project} is not a project any more` }
    }
    // A task's own activity counts for a lesson about that task; a lesson about
    // the project is kept alive by anything in it.
    const seen = Math.max(activity.lastSeenAt[about] ?? 0, activity.lastSeenAt[project] ?? 0)
    const idle = now - seen
    if (seen === 0 || idle > DORMANT_AFTER_MS) {
      return { skill, dormant: true, reason: `nothing has happened in ${about} for ${days(idle)}` }
    }
    return { skill, dormant: false, reason: '' }
  })
}

/** The lessons worth saying, which is what reaches the prompt. */
export function livingSkills(
  skills: readonly Skill[],
  activity: SkillActivity,
  now: number,
): Skill[] {
  return skillStanding(skills, activity, now)
    .filter((standing) => !standing.dormant)
    .map((standing) => standing.skill)
}

function days(ms: number): string {
  const whole = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (!Number.isFinite(whole) || whole <= 0) return 'a while'
  return whole === 1 ? 'a day' : `${whole} days`
}

export function skillText(skills: readonly Skill[]): string {
  if (skills.length === 0) return ''
  const lines = skills.map((skill) => {
    const text = skill.text.trim()
    const short = text.length > SKILL_LIMIT ? `${text.slice(0, SKILL_LIMIT).trimEnd()}…` : text
    return `- ${skill.name}: ${short.replace(/\s*\n\s*/g, ' ')}`
  })
  return ['What you have learned here:', ...lines].join('\n')
}

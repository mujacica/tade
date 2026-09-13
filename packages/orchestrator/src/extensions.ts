import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  extensionDirs,
  loadable,
  loadableSkills,
  type Skill,
  skillAbout,
  skillDirs,
} from '@wilco/core'

// Finding the tools Wilco wrote for itself. The rules about which files count
// are in core and tested there; this is the part that touches the disk.

/**
 * Absolute paths of the extensions that should load, in a stable order.
 * Never throws: no extensions directory is the normal case, not an error.
 */
export function activeExtensions(root: string): string[] {
  const dirs = extensionDirs(root)
  try {
    return loadable(readdirSync(dirs.active)).map((name) => join(dirs.active, name))
  } catch {
    return []
  }
}

/** Lessons a human has approved. Never throws. */
export function activeSkills(root: string): Skill[] {
  return skillsIn(skillDirs(root).active)
}

/** Lessons waiting to be read, so the brief can raise one. Never throws. */
export function proposedSkills(root: string): Skill[] {
  return skillsIn(skillDirs(root).proposed)
}

function skillsIn(dir: string): Skill[] {
  try {
    return loadableSkills(readdirSync(dir)).map((file) => {
      const text = readFileSync(join(dir, file), 'utf8')
      const about = skillAbout(text)
      return { name: basename(file, '.md'), text, ...(about ? { about } : {}) }
    })
  } catch {
    // No skills directory is the normal case, not an error.
    return []
  }
}

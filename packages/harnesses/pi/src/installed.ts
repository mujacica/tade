import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// What pi loads by itself, whoever runs it: extensions and skills in its own
// folders, and packages installed with `pi install`. Wilco does not run these
// — pi does, in every agent — but they change what an agent can do, so the
// window lists them beside Wilco's own.
//
// The files are pi's and may change shape; anything unfamiliar is left out.

export interface HarnessPiece {
  name: string
  /** Where it comes from, as you would look for it. */
  where: string
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}

/** pi's own extensions, skills and packages: yours everywhere, and the project's. */
export function installedPieces(home = homedir(), project?: string): HarnessPiece[] {
  const out: HarnessPiece[] = []
  const agent = join(home, '.pi', 'agent')
  for (const name of entries(join(agent, 'extensions'))) {
    out.push({ name: name.replace(/\.(ts|js|mjs)$/, ''), where: '~/.pi/agent/extensions' })
  }
  for (const name of entries(join(agent, 'skills'))) out.push({ name, where: '~/.pi/agent/skills' })
  try {
    const settings = JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8')) as {
      packages?: unknown
    }
    for (const one of Array.isArray(settings.packages) ? settings.packages : []) {
      const source = typeof one === 'string' ? one : (one as { source?: unknown })?.source
      if (typeof source === 'string') out.push({ name: source, where: 'pi install' })
    }
  } catch {
    // No settings, or not ones we can read.
  }
  if (project) {
    for (const name of entries(join(project, '.pi', 'extensions'))) {
      out.push({ name: name.replace(/\.(ts|js|mjs)$/, ''), where: `${project}/.pi/extensions` })
    }
    for (const name of entries(join(project, '.pi', 'skills'))) {
      out.push({ name, where: `${project}/.pi/skills` })
    }
  }
  return out
}

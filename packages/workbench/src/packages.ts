import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type Config, expandHome, type Plan, projectOf } from '@tade/core'

// Which folders a plan names are a package of their own, so `checkPlan` — pure,
// and never at the tree — can say so of an agent that says it touches all of
// one. Looked up rather than guessed from the shape of a path: `src/mail` is a
// folder in one repository and `packages/drivers/pty` a package in another.

/** What makes a folder a package of its own. */
const MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml']

/**
 * The packages the plan's `touches` name, by project, relative to its root:
 * each folder as said, the folder above one ending in `src` or `lib`, and the
 * folders directly inside one — which is how `packages` is found to hold all
 * of them. Never deeper than that, and a folder that cannot be looked at
 * holds no package.
 */
export async function packagesOf(
  config: Config,
  plan: Plan,
): Promise<(project: string) => readonly string[]> {
  const found = new Map<string, string[]>()
  for (const agent of plan.agents) {
    const project = projectOf(plan, agent)
    const configured = config.projects[project]
    if (!configured) continue
    const root = expandHome(configured.root)
    const have = found.get(project) ?? []
    found.set(project, have)
    for (const path of agent.touches) {
      const folder = path.replace(/^\.(\/|$)/, '').replace(/\/+$/, '')
      // Never outside the repository, whatever a plan says it touches.
      if (folder.startsWith('/') || folder.split('/').includes('..')) continue
      const inside = await readdir(join(root, folder), { withFileTypes: true }).then(
        (entries) =>
          entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => (folder ? `${folder}/${entry.name}` : entry.name)),
        () => [],
      )
      for (const one of new Set([folder, folder.replace(/(^|\/)(src|lib)$/, ''), ...inside])) {
        if (!have.includes(one) && (await holdsManifest(join(root, one)))) have.push(one)
      }
    }
  }
  return (project) => found.get(project) ?? []
}

async function holdsManifest(folder: string): Promise<boolean> {
  for (const manifest of MANIFESTS) {
    if (
      await access(join(folder, manifest)).then(
        () => true,
        () => false,
      )
    ) {
      return true
    }
  }
  return false
}

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Which models this machine can actually reach.
//
// The harness keeps a catalog of what each provider offers and a record of
// which providers you are logged in to. Reading them means the model question
// can be a list you pick from rather than a name you have to remember exactly
// — and a name typed from memory is the sort of thing that fails later, in a
// lane, as an error nobody connects back to a typo in setup.
//
// Both files are the harness's and may change shape. Anything unfamiliar means
// an empty list, which falls back to typing a name: worse, and never broken.

export interface AvailableModel {
  /** What to put in the config: `provider/id`. */
  id: string
  provider: string
  /** The human name, where the catalog gives one. */
  name: string
}

function piHome(home = homedir()): string {
  return join(home, '.pi', 'agent')
}

/** Every model the harness knows about, newest catalogs first. */
export async function availableModels(home = homedir()): Promise<AvailableModel[]> {
  const raw = await readJson(join(piHome(home), 'models-store.json'))
  if (!raw || typeof raw !== 'object') return []
  const out: AvailableModel[] = []
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    const models = (value as { models?: unknown })?.models
    if (!Array.isArray(models)) continue
    for (const model of models) {
      const id = (model as { id?: unknown })?.id
      if (typeof id !== 'string' || id === '') continue
      const name = (model as { name?: unknown })?.name
      out.push({ id: `${provider}/${id}`, provider, name: typeof name === 'string' ? name : id })
    }
  }
  return out
}

/** The providers with credentials on this machine. */
export async function loggedInProviders(home = homedir()): Promise<string[]> {
  const raw = await readJson(join(piHome(home), 'auth.json'))
  if (!raw || typeof raw !== 'object') return []
  return Object.keys(raw as Record<string, unknown>)
}

/**
 * Models you can use right now, which is what the question is really asking:
 * a catalog entry for a provider you have no credentials for is a name that
 * will fail the first time an agent tries to use it.
 */
export async function usableModels(home = homedir()): Promise<AvailableModel[]> {
  const [models, providers] = await Promise.all([availableModels(home), loggedInProviders(home)])
  if (providers.length === 0) return models
  const usable = models.filter((model) => providers.includes(model.provider))
  return usable.length > 0 ? usable : models
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

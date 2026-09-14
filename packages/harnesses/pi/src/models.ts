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
 * How a provider is paid for, as far as anyone can tell from here: signed in
 * through the provider (a subscription, usually), an API key the harness keeps,
 * or a key in the environment. The difference is what a bill looks like, which
 * is why the window says it next to the model.
 */
export type CredentialKind = 'signed-in' | 'api-key' | 'env-key'

/** Where the harness looks in the environment for each provider's key. */
const ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  huggingface: ['HF_TOKEN'],
  zai: ['ZAI_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
}

/**
 * Each provider with credentials, and what kind. What the harness stored wins
 * over the environment, because that is the order the harness itself asks in.
 */
export async function credentials(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, CredentialKind>> {
  const out: Record<string, CredentialKind> = {}
  for (const [provider, keys] of Object.entries(ENV_KEYS)) {
    if (keys.some((key) => (env[key] ?? '') !== '')) out[provider] = 'env-key'
  }
  const raw = await readJson(join(piHome(home), 'auth.json'))
  if (raw && typeof raw === 'object') {
    for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
      const type = (value as { type?: unknown })?.type
      out[provider] = type === 'api_key' ? 'api-key' : 'signed-in'
    }
  }
  return out
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

export type ModelChoice = { ok: true; provider: string; id: string } | { ok: false; reason: string }

/**
 * The exact model a configured name means, among the ones you can use.
 *
 * A bare name like `claude-opus-5` is offered by several providers, and the
 * harness refuses to guess between them — it exits before reading a word,
 * which looked like an orchestrator that never answered. And with no name at
 * all it takes whatever model was used last anywhere, which is an agent's
 * choice leaking into the orchestrator. So the choice is made here, once,
 * from what you are signed in to: an exact id first, then one a provider
 * offers under its vendor's name (`openrouter`'s `anthropic/claude-opus-5`).
 *
 * Null when nothing was asked for, so the caller decides what that means.
 * With no catalog to check against, the name is passed on as it was given.
 */
export function chooseModel(
  wanted: { provider?: string | undefined; model?: string | undefined },
  usable: readonly AvailableModel[],
): ModelChoice | null {
  const model = wanted.model?.trim()
  if (!model) return null
  const split = (entry: AvailableModel) => ({
    provider: entry.provider,
    id: entry.id.slice(entry.provider.length + 1),
  })
  if (wanted.provider) return { ok: true, provider: wanted.provider, id: model }
  if (usable.length === 0) {
    const [provider, ...rest] = model.split('/')
    return rest.length > 0 && provider
      ? { ok: true, provider, id: rest.join('/') }
      : { ok: false, reason: `${model} needs a provider: pick the model again in Settings` }
  }
  const named = usable.find((entry) => entry.id === model)
  if (named) return { ok: true, ...split(named) }
  const exact = usable.filter((entry) => split(entry).id === model)
  const vendor = usable.filter((entry) => split(entry).id.endsWith(`/${model}`))
  const found = exact[0] ?? vendor[0]
  if (found) return { ok: true, ...split(found) }
  const providers = [...new Set(usable.map((entry) => entry.provider))].join(', ')
  return {
    ok: false,
    reason: `${model} is not offered by anything you are signed in to (${providers}): pick one in Settings`,
  }
}

/**
 * The model someone meant by what they said — "opus 5", "kimi k2.6", "sonnet" —
 * among the ones you can use. Words are compared without spaces, dashes or
 * dots, a whole name beats part of one, and of equals the plainest wins (no
 * `:batch`). When two different models fit equally, it says which, rather than
 * picking one for you.
 */
export function findModel(
  said: string,
  usable: readonly AvailableModel[],
): { ok: true; provider: string; id: string } | { ok: false; reason: string } {
  const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const wanted = squash(said.replace(/^(the\s+)?/i, '').replace(/\s+model$/i, ''))
  if (!wanted) return { ok: false, reason: 'which model?' }
  const scored = usable
    .map((model) => {
      const id = model.id.slice(model.provider.length + 1)
      const tail = squash(id.split('/').at(-1) ?? id)
      const name = squash(model.name)
      const score =
        tail === wanted || name === wanted || squash(model.id) === wanted
          ? 3
          : tail.endsWith(wanted) || name.endsWith(wanted)
            ? 2
            : tail.includes(wanted) || name.includes(wanted)
              ? 1
              : 0
      return { model, id, score }
    })
    .filter((one) => one.score > 0)
    .sort((a, b) => b.score - a.score || a.id.length - b.id.length)
  const [best, next] = scored
  if (!best) {
    return { ok: false, reason: `nothing you are signed in to offers a model like "${said}"` }
  }
  const base = (id: string) =>
    id
      .replace(/:[\w-]+$/, '')
      .split('/')
      .at(-1) ?? id
  if (next && next.score === best.score && base(next.id) !== base(best.id)) {
    const options = [
      ...new Set(scored.filter((one) => one.score === best.score).map((one) => base(one.id))),
    ]
    return { ok: false, reason: `"${said}" could be ${options.slice(0, 5).join(', ')}: say which` }
  }
  return { ok: true, provider: best.model.provider, id: best.id }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

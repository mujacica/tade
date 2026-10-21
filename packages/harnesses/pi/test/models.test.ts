import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeProviderExtension } from '../../../../test/fixtures/fake-model.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { exitReason, PiAdapter } from '../src/adapter.ts'
import {
  type AvailableModel,
  availableModels,
  chooseModel,
  credentials,
  findModel,
  listedModels,
  loggedInProviders,
  usableModels,
} from '../src/models.ts'

// Which model a configured name means. A bare name the harness would find in
// four catalogs made it exit before reading a word, and no name at all took
// whatever an agent had used last.

const usable: AvailableModel[] = [
  { id: 'openrouter/moonshotai/kimi-k2.6', provider: 'openrouter', name: 'Kimi K2.6' },
  { id: 'openrouter/anthropic/claude-opus-5', provider: 'openrouter', name: 'Claude Opus 5' },
]

describe('choosing a model', () => {
  it('finds a bare name under the vendor a provider offers it as', () => {
    expect(chooseModel({ model: 'claude-opus-5' }, usable)).toEqual({
      ok: true,
      provider: 'openrouter',
      id: 'anthropic/claude-opus-5',
    })
  })

  it('takes provider/id as written, and a provider given separately as given', () => {
    expect(chooseModel({ model: 'openrouter/moonshotai/kimi-k2.6' }, usable)).toEqual({
      ok: true,
      provider: 'openrouter',
      id: 'moonshotai/kimi-k2.6',
    })
    expect(chooseModel({ provider: 'anthropic', model: 'claude-opus-5' }, usable)).toEqual({
      ok: true,
      provider: 'anthropic',
      id: 'claude-opus-5',
    })
  })

  it('says what you are signed in to when nothing there offers it', () => {
    const chosen = chooseModel({ model: 'gpt-9' }, usable)
    expect(chosen?.ok).toBe(false)
    expect(chosen && !chosen.ok ? chosen.reason : '').toContain('openrouter')
  })

  it('leaves the choice to the caller when nothing was asked for', () => {
    expect(chooseModel({}, usable)).toBeNull()
  })

  it('passes a provider/id on untouched when there is no catalog to check', () => {
    expect(chooseModel({ model: 'anthropic/claude-opus-5' }, [])).toEqual({
      ok: true,
      provider: 'anthropic',
      id: 'claude-opus-5',
    })
    expect(chooseModel({ model: 'claude-opus-5' }, [])?.ok).toBe(false)
  })
})

describe('why pi went away', () => {
  it("is pi's own error line, without its colour or prefix", () => {
    const stderr = '\x1b[31mError: Model "claude-opus-5" is ambiguous across providers\x1b[39m\n'
    expect(exitReason(1, stderr)).toBe('Model "claude-opus-5" is ambiguous across providers')
  })

  it('falls back to the exit code when it said nothing', () => {
    expect(exitReason(3, '')).toBe('pi exited with code 3')
    expect(exitReason(null, '')).toBe('pi was stopped')
  })
})

describe('the catalog', () => {
  it('says what each model costs, and nothing it cannot read', async () => {
    const home = tmp('pi-home-')
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
    // Shaped the way pi keeps it: per provider, per model, dollars per million tokens.
    writeFileSync(
      join(home, '.pi', 'agent', 'models-store.json'),
      JSON.stringify({
        openrouter: {
          models: [
            {
              id: 'moonshotai/kimi-k2.6',
              name: 'Kimi K2.6',
              cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
              contextWindow: 262144,
            },
            { id: 'auto', name: 'Auto Router', cost: { input: 'depends', output: 0 } },
          ],
        },
      }),
    )
    expect(await availableModels(home)).toEqual([
      {
        id: 'openrouter/moonshotai/kimi-k2.6',
        provider: 'openrouter',
        name: 'Kimi K2.6',
        price: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
        contextWindow: 262144,
      },
      { id: 'openrouter/auto', provider: 'openrouter', name: 'Auto Router' },
    ])
  })

  it('and the sign-ins are read wherever PI_CODING_AGENT_DIR puts pi’s agent directory', async () => {
    // pi keeps both there and never in the home, and so does an adapter
    // whose pi is launched with it.
    const home = tmp('pi-home-')
    const moved = tmp('pi-agent-')
    writeFileSync(
      join(moved, 'models-store.json'),
      JSON.stringify({
        openrouter: { models: [{ id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6' }] },
        anthropic: { models: [{ id: 'claude-opus-5', name: 'Claude Opus 5' }] },
      }),
    )
    writeFileSync(join(moved, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key' } }))
    const env = { PI_CODING_AGENT_DIR: moved }
    expect((await usableModels(home, env)).map((model) => model.id)).toEqual([
      'openrouter/moonshotai/kimi-k2.6',
    ])
    expect(await loggedInProviders(home, env)).toEqual(['openrouter'])
    expect(await credentials(home, env)).toEqual({ openrouter: 'api-key' })
    const adapter = new PiAdapter({ runDir: tmp('tade-pi-'), env })
    expect(await adapter.account()).toMatchObject({ signedIn: true, who: 'openrouter' })
    expect((await adapter.models()).map((model) => model.id)).toEqual([
      'openrouter/moonshotai/kimi-k2.6',
    ])
    // Launched without it, pi reads the home's, which has neither.
    expect(await usableModels(home, {})).toEqual([])
    expect(await credentials(home, {})).toEqual({})
  })
})

describe('an endpoint written into models.json', () => {
  it('is a model to choose, and its key is a sign-in, as pi reads it', async () => {
    // Setup offers "a local model — Ollama, llama.cpp, LM Studio, anything
    // OpenAI-shaped", which is pi's models.json; read past it, a box set up
    // that way had no model and was told it was signed in to nothing.
    const home = tmp('pi-home-')
    const dir = join(home, '.pi', 'agent')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'models-store.json'),
      JSON.stringify({ openrouter: { models: [{ id: 'moonshotai/kimi-k2.6', name: 'Kimi' }] } }),
    )
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: 'http://localhost:11434/v1',
            api: 'openai-completions',
            apiKey: 'ollama',
            models: [{ id: 'qwen2.5-coder:7b', contextWindow: 32768 }],
          },
          // No key: pi then looks in the environment, so nothing here says it is usable.
          vllm: { baseUrl: 'http://gpu:8000/v1', models: [{ id: 'llama' }] },
        },
      }),
    )
    expect((await availableModels(home, {})).map((model) => model.id)).toEqual([
      'openrouter/moonshotai/kimi-k2.6',
      'ollama/qwen2.5-coder:7b',
      'vllm/llama',
    ])
    expect(await loggedInProviders(home, {})).toEqual(['ollama'])
    expect(await credentials(home, {})).toEqual({ ollama: 'api-key' })
    expect((await usableModels(home, {})).map((model) => model.id)).toEqual([
      'ollama/qwen2.5-coder:7b',
    ])
    const adapter = new PiAdapter({ runDir: tmp('tade-pi-'), env: { PI_CODING_AGENT_DIR: dir } })
    expect(await adapter.account()).toMatchObject({ signedIn: true, who: 'ollama' })
  })
})

describe('the model someone meant', () => {
  const catalog: AvailableModel[] = [
    {
      id: 'openrouter/anthropic/claude-opus-5',
      provider: 'openrouter',
      name: 'Anthropic: Claude Opus 5',
    },
    {
      id: 'openrouter/anthropic/claude-opus-5:batch',
      provider: 'openrouter',
      name: 'Claude Opus 5 (batch)',
    },
    { id: 'openrouter/anthropic/claude-opus-4.5', provider: 'openrouter', name: 'Claude Opus 4.5' },
    { id: 'openrouter/moonshotai/kimi-k2.6', provider: 'openrouter', name: 'Kimi K2.6' },
    { id: 'openrouter/moonshotai/kimi-k3', provider: 'openrouter', name: 'Kimi K3' },
  ]

  it('is found from how it is said, the plainest of equals first', () => {
    expect(findModel('opus 5', catalog)).toEqual({
      ok: true,
      provider: 'openrouter',
      id: 'anthropic/claude-opus-5',
    })
    expect(findModel('Kimi K2.6', catalog)).toMatchObject({ ok: true, id: 'moonshotai/kimi-k2.6' })
  })

  it('means the newest of a line when no version is said', () => {
    const opuses: AvailableModel[] = [
      { id: 'openrouter/anthropic/claude-opus-4', provider: 'openrouter', name: 'Claude Opus 4' },
      { id: 'openrouter/anthropic/claude-opus-5', provider: 'openrouter', name: 'Claude Opus 5' },
      { id: 'openrouter/anthropic/claude-opus-4.1', provider: 'openrouter', name: 'Opus 4.1' },
      { id: 'openrouter/anthropic/claude-opus-4.6', provider: 'openrouter', name: 'Opus 4.6' },
      // A release date is not a version: this is Opus 4, whatever the number says.
      { id: 'anthropic/claude-opus-4-20250514', provider: 'anthropic', name: 'Claude Opus 4' },
      // An alias for the newest is not a version either.
      {
        id: 'openrouter/~anthropic/claude-opus-latest',
        provider: 'openrouter',
        name: 'Opus Latest',
      },
    ]
    // "Use opus for it" is Opus 5, as anyone saying it means.
    expect(findModel('opus', opuses)).toEqual({
      ok: true,
      provider: 'openrouter',
      id: 'anthropic/claude-opus-5',
    })
    // Opus 4, released on 2025-05-14, is older than 4.6, however large its date.
    expect(findModel('Opus', opuses.slice(2))).toMatchObject({
      ok: true,
      id: 'anthropic/claude-opus-4.6',
    })
    // A version said is the one meant, or a question: never the newest instead.
    expect(findModel('opus 4.6', opuses)).toMatchObject({
      ok: true,
      id: 'anthropic/claude-opus-4.6',
    })
    const four = findModel('opus 4', opuses)
    expect(four.ok ? four.id : four.reason).not.toMatch(/4\.[16]|opus-5/)
    // Asked for by name, the alias is what was meant.
    expect(findModel('opus latest', opuses)).toMatchObject({
      ok: true,
      id: '~anthropic/claude-opus-latest',
    })
  })

  it('knows a line by its words, however it was spelled over the years', () => {
    const haikus: AvailableModel[] = [
      { id: 'openrouter/anthropic/claude-3-haiku', provider: 'openrouter', name: 'Claude 3 Haiku' },
      { id: 'openrouter/anthropic/claude-haiku-4.5', provider: 'openrouter', name: 'Haiku 4.5' },
      {
        id: 'openrouter/anthropic/claude-haiku-4.5:batch',
        provider: 'openrouter',
        name: 'Haiku 4.5 (batch)',
      },
    ]
    expect(findModel('haiku', haikus)).toMatchObject({ ok: true, id: 'anthropic/claude-haiku-4.5' })
  })

  it('asks which when two different models fit', () => {
    const found = findModel('kimi', catalog)
    expect(found.ok).toBe(false)
    expect(found.ok ? '' : found.reason).toMatch(
      /could be kimi-k3, kimi-k2.6|could be kimi-k2.6, kimi-k3/,
    )
    expect(findModel('gemini', catalog).ok).toBe(false)
  })
})

describe('a model pi is taught by one of its own extensions', () => {
  it('reads pi’s own listing, and nothing else for one', () => {
    const printed = [
      'provider   model                context  max-out  thinking  images',
      'tade-test  fake                 128K     4.1K     no        no    ',
      'ollama     qwen2.5-coder:7b     32K      8.2K     no        no    ',
      '',
    ].join('\n')
    expect(listedModels(printed)).toEqual([
      { id: 'tade-test/fake', provider: 'tade-test', name: 'fake' },
      { id: 'ollama/qwen2.5-coder:7b', provider: 'ollama', name: 'qwen2.5-coder:7b' },
    ])
    expect(listedModels('No models available. Use /login to log into a provider')).toBeNull()
    expect(listedModels('')).toBeNull()
  })

  it('is placed: a provider an extension registers is in no file Tade reads, so pi is asked', async () => {
    // As serve.test.ts configures its orchestrator: `provider: tade-test`,
    // `model: fake`, which the catalog cannot place and pi can.
    const dir = tmp('pi-agent-')
    const extensions = join(dir, 'extensions')
    mkdirSync(extensions, { recursive: true })
    writeProviderExtension(extensions)
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: dir,
      TADE_TEST_BASE_URL: 'http://127.0.0.1:9',
    }
    const adapter = new PiAdapter({ runDir: tmp('tade-pi-'), env })
    expect(await adapter.models()).toEqual([])
    expect(await adapter.resolveModel('tade-test/fake')).toEqual({
      ok: true,
      provider: 'tade-test',
      id: 'fake',
    })
    // And a name pi cannot place either is still not placed, for the
    // catalog's reason.
    const missing = await adapter.resolveModel('tade-test/surely-not-this-one')
    expect(missing).toMatchObject({ ok: false })
    expect(missing.ok ? '' : missing.reason).toMatch(/nothing you are signed in to offers/)
  })
})

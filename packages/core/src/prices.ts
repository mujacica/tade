import { z } from 'zod'

// What a model costs per token, where nobody who ran it will say.
//
// A harness that prices its own turns is the only thing that knows what was
// actually charged, and where one does, nothing here is used. This is for the
// other case — Codex counts tokens and never prices them, and a journal is
// full of turns whose harness said `none` — where the alternative to a price
// taken off a published page is a money column with a hole in it and nothing
// saying so. `ccusage` exists because that hole is real; the answer is to
// price it here rather than to send people to a second program.
//
// **Where the prices live, and why here.** Three places were possible and two
// are worse. A network lookup breaks the rule that nothing on a timer touches
// the network, and it makes a figure on a page depend on a machine being
// online — worse, it makes every reader of an old journal ask the internet
// what last March cost. A price typed into the config by every user is a
// blank table on every machine nobody filled in, which is the same hole with
// extra steps. So: a table checked in, with the day it was read off the
// providers' own pages (`PRICES_TAKEN`), overridden per model in `config.prices`
// for anybody on a rate this is not, and **never fetched**. The cost of that
// is that it goes stale, which is why the date rides with it everywhere it is
// read, and why an override needs no release.
//
// A model this table has never heard of is `null` and stays *unknown* — an
// invented price would be indistinguishable from a real one on the page, and
// a wrong dollar figure is worse than a missing one.
//
// A plan is not priced here and must never be: a subscription pays a flat fee,
// so the tokens under it have no per-token cost at all and turning them into
// dollars puts $954 nobody was billed beside $78 somebody was. `isMoney`
// (`spend.ts`) is where that is decided, before anything reaches this file.

/**
 * The day the table below was read off each provider's own pricing page.
 *
 * It rides with every figure this table produces, because a price is a fact
 * with a date on it and a dollar figure that cannot say when it was true is
 * one nobody can check.
 */
export const PRICES_TAKEN = '2026-09-27'

/**
 * What one model costs, in US dollars per million tokens, exactly as the
 * provider's own page states them.
 *
 * Four figures and not one, because the cheap ones are where the tokens are: a
 * cached prompt read back costs a tenth of a fresh one at Anthropic and at
 * OpenAI, and an agent's day is mostly cache reads. Pricing a long run off the
 * input rate alone overstates it several times over.
 *
 * `cacheWrite` is the provider's own charge for putting a prompt in the cache
 * — a quarter more than input at Anthropic, and the ordinary input rate where
 * a provider makes no separate charge for it, which is what OpenAI does.
 */
export interface ModelPrice {
  input: number
  output: number
  /** Reading a cached prompt back. */
  cacheRead: number
  /** Writing one. The input rate where the provider charges no premium. */
  cacheWrite: number
}

/** Models to prices, by the model's own name — what `modelIdentity` calls `name`. */
export type PriceTable = Readonly<Record<string, ModelPrice>>

/**
 * Anthropic's published rates, and the two multiples that are the same for
 * every model on them: a cache read is a tenth of input, a cache write a
 * quarter more than it. Written out per model rather than computed, so a model
 * that stops following the pattern is one line and not a special case.
 */
const claude = (input: number, output: number, cacheRead = input / 10): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
})

/**
 * OpenAI's published rates. Cached input is a tenth of input as at Anthropic,
 * and there is no separate charge for writing the cache — a write is billed at
 * the ordinary input rate, which is what `cacheWrite` says here.
 */
const openai = (input: number, output: number, cacheRead: number): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: input,
})

/**
 * What a million tokens costs, per model, as of `PRICES_TAKEN`.
 *
 * Keyed by the model's **own name** and nothing in front of it, because that
 * is the one spelling every route to it shares (`modelIdentity`): the same
 * weights reached through a router, an API key and a subscription are one
 * price and one row.
 *
 * Deliberately not exhaustive. A model nobody here has a price for is
 * *unknown*, which is an answer this repository already draws everywhere, and
 * a guess dressed as a figure is the one thing it may not be.
 */
export const PRICES: PriceTable = {
  // Anthropic, https://docs.claude.com/en/docs/about-claude/pricing
  'claude-fable-5-1': claude(10, 50, 0.25),
  'claude-mythos-5-1': claude(10, 50, 0.25),
  'claude-fable-5': claude(10, 50),
  'claude-opus-5': claude(5, 25),
  'claude-opus-4-8': claude(5, 25),
  'claude-opus-4-7': claude(5, 25),
  'claude-opus-4-6': claude(5, 25),
  'claude-sonnet-5': claude(2, 10),
  'claude-sonnet-4-6': claude(3, 15),
  'claude-haiku-4-5': claude(1, 5),
  // OpenAI, https://platform.openai.com/docs/pricing
  'gpt-5.3-codex': openai(1.75, 14, 0.175),
  'gpt-5': openai(1.25, 10, 0.125),
  'gpt-5-mini': openai(0.25, 2, 0.025),
  'gpt-5-nano': openai(0.05, 0.4, 0.005),
  // No cached rate is published for it, so a cache read costs what input does.
  'gpt-5-pro': openai(15, 120, 15),
}

/**
 * A price as the config spells one: two figures, and the cache rates only if
 * they differ. Here rather than in the schema beside the other settings,
 * because the shape of a price and the thing that reads one belong together.
 */
export const ModelPriceSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  /** Reading a cached prompt back. The input rate unless said. */
  cache_read: z.number().nonnegative().optional(),
  /** Writing one. The input rate unless said. */
  cache_write: z.number().nonnegative().optional(),
})

export type SaidPrice = z.infer<typeof ModelPriceSchema>

/**
 * What somebody wrote in `config.prices`, as a table this can look in.
 *
 * A cache rate left out is the input rate rather than nothing: somebody
 * writing down two figures has said what their model costs, and filling the
 * other two with zero would quietly price most of an agent's day at nothing.
 * Keys go through `priceKey` like every other, so a rate written with a
 * snapshot stamp on it still answers for the model.
 */
export function pricesFrom(said: Readonly<Record<string, SaidPrice>>): PriceTable {
  const table: Record<string, ModelPrice> = {}
  for (const [model, price] of Object.entries(said)) {
    table[priceKey(model)] = {
      input: price.input,
      output: price.output,
      cacheRead: price.cache_read ?? price.input,
      cacheWrite: price.cache_write ?? price.input,
    }
  }
  return table
}

/**
 * A model's name as the table keys it: lower case, without the snapshot stamp
 * some providers hang off the end.
 *
 * `claude-haiku-4-5-20251001` and `claude-opus-4-5@20251101` are the same
 * model as the bare name at the same price — the stamp says which build, not
 * which weights are billed — so stripping it is reading the name, not guessing
 * at a price. Nothing else is stripped: `gpt-5-mini` is its own model and its
 * own rate, and shortening towards a prefix would file it under `gpt-5` and
 * charge five times too much.
 */
export function priceKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/[@-]\d{8}$/, '')
    .replace(/[@-]\d{4}-\d{2}-\d{2}$/, '')
}

/**
 * What this model costs, or `null` where nothing here knows.
 *
 * The override is asked first and completely: somebody who writes a price for
 * a model has a rate this table does not have, and half of theirs beside half
 * of ours is a figure neither of them would stand behind.
 */
export function priceFor(model: string, over: PriceTable = {}): ModelPrice | null {
  const key = priceKey(model)
  if (key === '') return null
  return over[key] ?? PRICES[key] ?? null
}

/** How many tokens of each kind one turn used, as a `usage` event records them. */
export interface Tokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * What those tokens cost at those prices, in dollars.
 *
 * Per million, which is how every provider states them, and summed over the
 * four kinds rather than off a single total: the kinds differ by a factor of
 * fifty, and an agent's day is mostly the cheap one.
 */
export function estimateUsd(tokens: Tokens, price: ModelPrice): number {
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1_000_000
  )
}

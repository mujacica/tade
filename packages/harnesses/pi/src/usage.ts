// What pi counts as spent, one entry of its session at a time.
//
// pi keeps what a reply cost on the message it wrote (`entry.message.usage`),
// and what a summary it had a model write cost — a compaction, a branch
// summary — on the entry itself (`entry.usage`). Its own totals, the ones in an
// agent's footer, add up exactly these, so Tade's do too: a total that counts
// anything else, or less, disagrees with a number the person can see.
//
// It imports nothing, because the supervision extension runs inside pi and
// counts with it too: the count made live and the count made from the file
// afterwards have to be the same count.

export interface Spent {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  usd: number
}

export function nothingSpent(): Spent {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, usd: 0 }
}

/**
 * What one session entry cost. Null for an entry that ran no model — what
 * you said, a tool's output, a model change — and for a shape pi does not
 * write: the format is pi's, and an unfamiliar one is counted as nothing.
 */
export function spentBy(entry: unknown): Spent | null {
  if (!isRecord(entry)) return null
  if (entry.type === 'message') return spentByMessage(entry.message)
  if (entry.type === 'compaction' || entry.type === 'branch_summary') return priced(entry.usage)
  return null
}

/**
 * What one message cost: a reply, or the rare tool result that ran a model of
 * its own. The shape pi streams as it happens as well as the one it writes.
 */
export function spentByMessage(message: unknown): Spent | null {
  if (!isRecord(message)) return null
  if (message.role !== 'assistant' && message.role !== 'toolResult') return null
  return priced(message.usage)
}

/** Which model a message ran on, the way Tade names one: provider, then id. */
export function modelOfMessage(message: unknown): string | null {
  if (!isRecord(message) || typeof message.model !== 'string' || !message.model) return null
  return typeof message.provider === 'string' && message.provider
    ? `${message.provider}/${message.model}`
    : message.model
}

export function addSpent(total: Spent, more: Spent): Spent {
  return {
    input: total.input + more.input,
    output: total.output + more.output,
    cacheRead: total.cacheRead + more.cacheRead,
    cacheWrite: total.cacheWrite + more.cacheWrite,
    tokens: total.tokens + more.tokens,
    usd: total.usd + more.usd,
  }
}

function priced(usage: unknown): Spent | null {
  if (!isRecord(usage)) return null
  const input = count(usage.input)
  const output = count(usage.output)
  const cacheRead = count(usage.cacheRead)
  const cacheWrite = count(usage.cacheWrite)
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    // Cache reads are tokens too, and usually most of them.
    tokens:
      typeof usage.totalTokens === 'number'
        ? count(usage.totalTokens)
        : input + output + cacheRead + cacheWrite,
    usd: isRecord(usage.cost) ? count(usage.cost.total) : 0,
  }
}

/** Unknown is zero, never NaN: one NaN poisons every total that adds it. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

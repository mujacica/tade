// The harness's answer for what a harness can do: the one `offer()` reads.
//
// **Its own file for the reason `away-intake.ts` is** — the harness at the
// length a file is allowed to be — and because it is a stand-in for a harness
// rather than a part of the window, which is the half the harness says it
// fakes.

/**
 * A capabilities answer that can take a message live. The one `offer()` reads.
 *
 * Only `why` and `steer` matter here; the rest is filled in so the shape is a
 * real `WorkerCapabilities` rather than a cast.
 */
export function capabilities(steer: 'live' | 'idle' | 'none' = 'live') {
  return {
    permissionGate: true,
    steer,
    queue: 'live' as const,
    abort: 'live' as const,
    model: 'live' as const,
    thinking: 'live' as const,
    thinkingLevels: [],
    rename: 'live' as const,
    images: 'inline' as const,
    visibleUi: false,
    resume: true,
    resumeKeeps: true,
    continues: true,
    done: true,
    nativeExtensions: false,
    skills: false,
    tools: true,
    mcp: true,
    headless: true,
    spend: { usd: 'exact' as const, tokens: true, limits: 'none' as const },
    accounts: false,
    why: steer === 'none' ? { steer: 'pi has no way to take a message mid-turn' } : {},
  }
}

/** The capabilities of a harness that cannot be told anything. */
export const CANNOT_STEER = capabilities('none')

import type { ResolvedRoute } from '@tade/core'
import type { ModelFound, WorkerModel } from '@tade/harnesses-core'

// Which model the orchestrator starts on, and what is said about a name that
// could not be placed.
//
// Pure, and apart from `orchestrator.ts`, because it is a rule rather than a
// step: nothing here starts anything, asks a harness anything or reads a
// clock, so what it decides can be put in front of a test for each of the
// three cases it has.
//
// The rule it holds is one sentence: **a model named in the config that this
// harness cannot place is said and stepped over, never a refusal.**
//
// It used to throw. The reasoning was sound as far as it went — a harness
// handed a name it cannot resolve exits before it reads a word, which looks
// exactly like an orchestrator that never answered, so settling the model
// before anything starts is right. What was wrong was the remedy: refusing
// traded one dead orchestrator for another, and the second one is worse,
// because the *only* ways to repair the setting are the model picker in the
// strip and the Settings page — both of which are in the window you have just
// been refused. A name chosen for pi and a harness changed to Claude Code is
// an ordinary thing to find in a config, and it must never be a corner
// somebody cannot get out of from inside Tade.

/** The model a route names, as one string a harness can be asked about. */
export function modelNamed(route: ResolvedRoute | null | undefined): string | null {
  if (!route?.model) return null
  return route.provider ? `${route.provider}/${route.model}` : route.model
}

/**
 * What to start on, and what to say about it.
 *
 * Three cases, and the third is the one this exists for:
 *
 * - **Asked for outright** (`asked`) — a caller that has already settled it,
 *   which is every test and every restart onto a model somebody just chose.
 *   Nothing is resolved and nothing is said.
 * - **Named and placed** — the exact provider and id the harness found.
 * - **Named and not placed** — no model, so the harness runs on whatever it
 *   runs on by default, which is exactly where the setting sits before
 *   anybody has chosen anything. The name that was dropped, the harness's own
 *   reason for dropping it, and where to choose another are all said: a
 *   fallback nobody is told about is a window quietly not doing what its
 *   config says.
 */
export function startingModel(
  asked: WorkerModel | undefined,
  named: string | null,
  found: ModelFound | null,
  harness: string,
): { model: WorkerModel | undefined; warning: string | null } {
  if (asked) return { model: asked, warning: null }
  if (found?.ok) return { model: { provider: found.provider, id: found.id }, warning: null }
  if (found && !found.ok) {
    return {
      model: undefined,
      warning: `${harness} cannot run "${named}": ${found.reason}. Talking on whatever ${harness} runs by itself — choose another from the model beside the orchestrator, or in Settings › Orchestrator.`,
    }
  }
  return { model: undefined, warning: null }
}

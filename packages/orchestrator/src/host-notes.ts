import { type Arm, type Note, scopesOf } from '@tade/core'
import type { Noted, Workbench } from '@tade/workbench'
import { writtenBy } from './origin.ts'

// The `ToolHost` methods behind the note tools (`tools-notes.ts`): writing one
// down and retiring one. Their own file because `tool-host.ts` is near its
// budget, and because the two share one boundary — the person's own words,
// kept verbatim, and taken out of what anybody is told only on their say-so.
//
// **Retiring is checked here, in the window**, against the journal's `said`
// lines (`theirLine`), never in the tool: a rule that lives where the model
// lives is a rule the model can be talked out of.

type Handler = (params: Record<string, unknown>, arm: Arm) => unknown | Promise<unknown>

export function noteMethods(tade: Workbench): Record<string, Handler> {
  return {
    // `by` is **rewritten** for a remote arm and never taken from the call:
    // a note the orchestrator wrote because a phone asked for it is the
    // phone's, and one filed as the orchestrator's own is the same
    // provenance hole as a remote act recorded as `you`.
    'memory/remember': (p, arm) =>
      notedSays(
        tade.remember(
          String(p.text),
          scopesFrom(p.scope),
          writtenBy(arm, p.by),
          p.summary ? String(p.summary) : null,
        ),
      ),
    // Always the person's say-so: there is no `said`-less way in from here,
    // because the cleanup — the one retirement nobody asks for — runs in the
    // window on open and never through a tool.
    'memory/retire': async (p, arm) => {
      const retired = await tade.retireNote({
        at: String(p.at ?? ''),
        ...(p.text ? { text: String(p.text) } : {}),
        because: String(p.because ?? ''),
        by: writtenBy(arm, 'orchestrator'),
        said: String(p.said ?? ''),
      })
      return `Retired the note of ${retired.at} (${headlineOf(retired)}): ${retired.retired?.because}. No agent, briefing or turn of yours is told it now; tade_notes with all still reads it, and the journal says who retired it and why.`
    },
  }
}

/** What a note's scope arrives as: one, a list, or nothing for everything. */
function scopesFrom(value: unknown): string | string[] | null {
  if (Array.isArray(value)) return value.map(String)
  return value === null || value === undefined ? null : String(value)
}

/** Which tasks and projects, in words. */
function aboutOf(note: Note): string {
  const scopes = scopesOf(note)
  return scopes[0] === null ? 'everything' : scopes.join(', ')
}

function headlineOf(note: Note): string {
  return note.summary ?? (note.text.length > 60 ? `${note.text.slice(0, 59)}…` : note.text)
}

/**
 * What writing a note did, said so the model cannot read it wrong. A new note
 * is handed back as it was kept, as it always was; the same words again say
 * that nothing was written; and a note about everything says who hears it.
 */
export function notedSays(noted: Noted): unknown {
  const { already, ...note } = noted
  if (already === 'noted') {
    return `Already noted at ${note.at}, about ${aboutOf(note)}: nothing was written. The same words are one note, so there is nothing to add${
      note.scope === null
        ? ' — it is about everything, so every agent in every project is told it; if it is only about particular tasks, retire it (tade_notes_retire) and write it again with about'
        : ''
    }.`
  }
  if (already === 'widened') {
    return `Already noted at ${note.at}; that note is now about ${aboutOf(note)} — one note, not a second copy of the same words.`
  }
  if (note.scope === null) {
    return {
      ...note,
      told: 'about everything: every agent in every project is told it. If you meant particular tasks or projects, retire it and write it again with about.',
    }
  }
  return note
}

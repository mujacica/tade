import {
  contentHash,
  draftYaml,
  editWorkflow,
  readDraft,
  type Template,
  type WorkflowScope,
  writeDraft,
} from '@tade/core'
import {
  type DraftCall,
  draftRev,
  type From,
  Moved,
  NotOffered,
  NotThere,
  type Outcome,
  type WebDrafting,
} from '@tade/web'

// The window's end of saving a draft: what one field actually does.
//
// **Its own file, and the seam is the one `web-acting.ts` and `web-asking.ts`
// have.** What the away view is handed is exactly this — one method and
// `unlocked`, and nothing else on it. A `WebDrafting` that was the whole
// `Away` subject would put the device file, the projectors and the streams one
// property access away from a route.
//
// ## The three things only the window can do, and this file owes all three
//
// 1. **Re-check the state at the moment of the write.** The hash the device
//    echoed (`was`) against the draft as it is on disk *now*, read again right
//    here — never against a fold from the last beat. Two phones editing one
//    draft, or a person at the machine editing it while a phone is, both end
//    with one save landing and the other refused with what is true now.
// 2. **Put the edit through the validator the file goes through.**
//    `editWorkflow` is pure and is the same function the window's own form
//    calls, so a save can never write what publishing would refuse — and a
//    field the template says cannot be changed here comes back as its own
//    refusal rather than as a silent nothing.
// 3. **Write only a draft.** `writeDraft` builds its own path in the drafts
//    directory and nothing passed in can move it, and it refuses a name Tade
//    ships. There is no call here that publishes, renames, makes or removes
//    one — `DRAFTS_ARE_NOT_PUBLISHED` is the sentence and this file is where
//    it stops being one.
//
// What this file deliberately does **not** do is decide who may save. That is
// the gate (`drafted.ts`): the setting read now, the `draft` scope, every
// project, and a trusted origin.

/** What saving needs of the window: a home, the setting, and a way to say so. */
export interface DraftingDeps {
  home: string
  /** Whether the setting is on, read **at the save** and never cached. */
  drafting: () => boolean
  /** A save that landed, so the away view's own fold reads the file again. */
  saved: (template: string) => void
  now: () => number
}

/**
 * The one method, and nothing else reachable.
 *
 * `unlocked` is read at every save: the route table was built when the window
 * started, so turning the setting **off** has to mean something before the
 * next restart. Turning it on waits, and the setting's own words say so.
 */
export function webDrafting(deps: DraftingDeps): WebDrafting {
  return {
    unlocked: () => deps.drafting(),

    async save(call: DraftCall, _from: From): Promise<Outcome> {
      // **Read again here, not from a fold.** The fold is seconds old by
      // design, and what decides whether this save is current is the bytes on
      // disk at this moment.
      const read = await readDraft(deps.home, call.template)
      if ('problem' in read) throw new NotThere(read.problem)
      const held: Template = read.template
      const hash = contentHash(draftYaml(held))
      if (draftRev({ hash }) !== call.was) {
        // The draft has moved. What is true now goes back with the refusal, so
        // the page redraws the truth rather than a toast about it — and
        // whatever somebody typed stays typed (`afterAnswer`).
        throw new Moved(
          `${call.template} has been edited since this screen was drawn: it is at ${hash} now`,
          hash,
        )
      }
      const scope = scopeOf(held, call)
      if (scope === null) {
        throw new NotThere(`${call.template} has no step called ${call.scope}`)
      }
      const edited = editWorkflow(held, scope, call.field, call.value)
      // `problem` is the validator's own sentence — a field this form may not
      // change, a value that is not one of the choices, a name that is taken.
      // `NotOffered` rather than a `500`: the thing was asked for and cannot
      // be done, which is a refusal with a reason beside the control.
      if (!('ok' in edited)) throw new NotOffered(edited.problem)
      const wrote = await writeDraft(deps.home, edited.template)
      if ('problem' in wrote) throw new NotOffered(wrote.problem)
      const now = contentHash(draftYaml(edited.template))
      // The fold reads the templates on a clock of its own, because a file
      // edit writes no journal line — so a save says so, and the next fold is
      // the one that sees it rather than the one half a minute later.
      deps.saved(call.template)
      return {
        did: now !== hash,
        rev: draftRev({ hash: now }),
        // Tade's own sentence, with the field named and **never the value**:
        // what somebody typed on a phone is not a record Tade writes about
        // them. `did: false` where the value was already what it is, which is
        // an answer rather than a failure.
        said:
          now === hash
            ? `${call.field} on ${call.template} was already that`
            : `${call.field} saved on the ${call.template} draft, which no run reads until somebody here publishes it`,
      }
    },
  }
}

/**
 * Which form the field belongs to, as `editWorkflow` takes it.
 *
 * **A step is named on the wire and turned into a position here**, which is
 * the one translation in this file and the reason it is worth a function. A
 * position moves when somebody adds or removes a step, so a save from a screen
 * drawn a minute ago would write into whichever step had slid into that place
 * — silently, into the right field of the wrong agent. The name is what the
 * page drew and what the template declares, and it is resolved against the
 * draft *this save just read*, so a renamed step is a refusal with a sentence
 * rather than a write somewhere else.
 */
function scopeOf(template: Template, call: DraftCall): WorkflowScope | null {
  if (call.scope === 'template') return { kind: 'template' }
  const at = template.agents.findIndex((one) => one.name === call.scope)
  return at < 0 ? null : { kind: 'step', at }
}

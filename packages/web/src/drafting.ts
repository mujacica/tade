import type { From, Outcome } from './acting.ts'

// What a paired device may *save*, as the one interface the window implements.
//
// **A fourth table, not a ninth verb and not a second saying**, and the reason
// is the shape of the thing. Every verb in `verbs.ts` is a task plus the state
// it expects, and the task's project is the per-project boundary the act gate
// checks. Every saying in `asking.ts` is free text with no target at all. This
// is neither: it has a target — a **draft**, by name, with its own revision —
// and that target belongs to no project, because a workflow names the
// repository it works in through an input and can name any of them.
//
// So it is its own interface, its own route table, its own setting
// (`surfaces.web.drafts`) and its own scope (`draft`) — and **acting does not
// imply it**. A device granted both acting tiers has been granted eight
// bounded things about work that already exists; it has not been granted a
// file every future run of a workflow would be stamped from.
//
// ## What makes it safe, said here because this is where somebody looks
//
// Not the word *bounded*. Five things, and four of them are absences:
//
// 1. **A draft is a file no run reads.** Publishing is what makes one run, and
//    there is no route that publishes — not here, not in `ACTS`, not in
//    `ASKS`. `DRAFTS_ARE_NOT_PUBLISHED` is the sentence and the route table is
//    the enforcement.
// 2. **One field at a time, out of a closed list.** The field is a
//    `WorkflowField.id` the template itself declared, and `editWorkflow` is
//    the pure validator the file goes through — so a form can never accept
//    what publishing would refuse, and there is no shape here in which a whole
//    template, a name or a version arrives.
// 3. **There is no make, no rename, no delete and no publish.** One method,
//    and `test/separation.test.ts` reads this interface against the table.
// 4. **The write cannot name a published version.** `writeDraft` builds its
//    own path in the drafts directory and nothing passed in can move it; a
//    published snapshot is `publishTemplate`'s and that is called from the
//    machine.
// 5. **The draft's own hash is the revision.** A save from a screen drawn
//    against a draft that has since moved meets a hash that is not the one it
//    echoed, and is refused — which is the same rule a verb's `was` is, with
//    the content doing the work a task file's facts do.

/**
 * One field of one draft, as a device asks for it.
 *
 * `scope` is which form the field belongs to — the template's own, or one
 * step's by name — because a field id is unique within a form and not across
 * them: `prompt` is a step's field and `title` is the template's, and a save
 * that guessed would write the right value into the wrong place.
 */
export interface DraftCall {
  /** The workflow's name, which is also the draft file's. Never a path. */
  template: string
  /** The draft's content hash, as the screen was drawn against it. */
  was: string
  /** `template`, or a step's own name. */
  scope: string
  /** The field, by the id `workflowFields` gave it. */
  field: string
  /** The new value, bounded and never trimmed into meaning. */
  value: string
}

/**
 * Saving a field of a draft: the one method, and the whole of what a paired
 * device may ever do to a stored workflow.
 *
 * **There is no method here that reads one.** The workflows are read through
 * the projection like everything else — a collection with a budget, behind the
 * `workflows` grant — so there is no shape in this interface that could answer
 * with a template, and no handler that does any work.
 */
export interface WebDrafting {
  /**
   * Whether saving is still unlocked, read **at the save**.
   *
   * A function and not a flag, exactly as `WebActing.unlocked` and
   * `WebAsking.unlocked` are: the route table was built when the window
   * started, and a person who turns the setting off wants that to mean
   * something before they next restart. The asymmetry is in the setting's own
   * words — on waits for a restart, off is now.
   */
  unlocked(): boolean
  save(call: DraftCall, from: From): Promise<Outcome>
}

/**
 * The facts a draft's revision is made of: one field, and it is the content.
 *
 * **The content hash and nothing beside it**, which is the opposite of
 * `TaskFacts` and is right for the same reason. A task's revision is a handful
 * of named facts because a task changes constantly in ways no act depends on —
 * a figure moved, an agent spoke — and a revision that moved with them would
 * refuse acts that are perfectly current. A draft changes only when somebody
 * writes one, so every change to it is a change a save depends on: the whole
 * file is the fact.
 *
 * It is `contentHash`'s answer, which the window computes over `draftYaml` —
 * the same bytes `writeDraft` writes, so what the screen was drawn against and
 * what is on disk are compared as the same thing rather than as two
 * serialisations that agree most of the time.
 */
export interface DraftFacts {
  /** `sha256:` and twelve hex characters, as `contentHash` makes one. */
  hash: string
}

/** A draft's revision: the hash, which is already short, opaque and theirs. */
export function draftRev(facts: DraftFacts): string {
  return facts.hash
}

/**
 * How much one field may carry.
 *
 * The same bound a note has (`BOUNDS.text`), and for the same reason: the
 * longest field on a workflow is a step's prompt, which is a paragraph
 * somebody wrote about how they want work done. Over the bound is `too_big`
 * and never a silent cut — half of what somebody wrote, saved as though it
 * were the whole, is a lie about what they meant.
 */
export const DRAFT_BOUND = 4_000

/**
 * A workflow's name, as a path segment Tade would have written.
 *
 * `isTemplateName`'s rule — lowercase, digits, dashes — which has no `/`, no
 * `.` and no `..` in it, so there is nothing to escape with rather than a list
 * of escapes to keep up with. **This is the one field that reaches a path**
 * (`writeDraft` joins it onto the drafts directory), which is why it is the
 * strictest of the three.
 */
export const DRAFT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * A form's own name: the literal `template`, or a step's name.
 *
 * A step's name is `editWorkflow`'s own rule — lowercase, digits, and `. _ -`
 * after the first character — because that is what a step may be called and a
 * narrower pattern here would silently refuse a legitimate one. It reaches no
 * path: the name is looked up in `template.agents`, so `..` finds no step and
 * is a refusal with a sentence rather than a file somewhere else.
 */
export const DRAFT_SCOPE = /^(template|[a-z0-9][a-z0-9._-]{0,63})$/

/**
 * A field's id, as `workflowFields` spells one.
 *
 * **Two shapes, and the second is the one worth the words.** Most are a plain
 * name (`title`, `project_input`, `leaves_checks`). The dependency fields are
 * `after:<step>` and `why:<step>` — a tick per other step and the reason
 * beside each tick — and a pattern that allowed only the first shape would
 * refuse exactly the field the whole designer argument is about: *a wait with
 * no reason given is the one thing `checkPlan` cannot tell you anything useful
 * about*. The step half is the same rule a scope's is, and like it, it reaches
 * no path.
 */
export const DRAFT_FIELD = /^[a-z][a-z0-9_]{0,31}(:[a-z0-9][a-z0-9._-]{0,63})?$/

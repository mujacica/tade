---
name: add-template-or-persona
description: Write, check, publish or change a reusable workflow template or a persona — the start defaults a template stamps out — and change what a template may say, what it compiles to, or how far the orchestrator reaches into one. Use when work arrives the same way again and again, when a template refuses something it should not, or when deciding whether a field belongs on one at all.
---

# Templates and personas

A **persona** is a named set of defaults for a task's *start*. A **template** is a stored `Plan`
with holes in it. Neither is a running thing, neither grants anything, and neither has an engine of
its own: a template compiles to a `Plan`, `checkPlan` keeps it or refuses it, and the ordinary queue
is still the executor.

| Path | What |
|---|---|
| `packages/core/src/personas.ts` | the told fields, the refused fields, and the rule |
| `packages/core/src/templates.ts` | the schema, the validation, and the fill that makes a `Plan` |
| `packages/core/src/templates-store.ts` | the directories, publishing, and what immutable means |
| `packages/core/src/templates-dry-run.ts` | what would happen, and nothing happens |
| `packages/core/src/templates-builtin.ts` | the ones Tade ships, as source |
| `packages/workbench/src/templates.ts` | reading the real world, and stamping one out |
| `packages/cli/src/commands/templates.ts` | `tade templates` and `tade personas` |
| `packages/core/src/templates-edit.ts` | the form: `workflowFields`, `editWorkflow`, `addWorkflowStep`, `removeWorkflowStep`, `workflowPlaces` |
| `packages/app/src/panels/workflow/` · `wire/workflows.ts` | writing one in the window: `/workflows`, the list, the form, the preview, Publish |
| `packages/orchestrator/src/tool-host.ts` | `template/list`, `template/dry-run`, `template/use` |

```
<TADE_HOME>/personas/{active,proposed,rejected}/<name>.md
<TADE_HOME>/templates/{drafts,rejected}/<name>.yaml
<TADE_HOME>/templates/published/<name>/<version>.yaml     ← written once, never rewritten
```

## The five rules, and what each one stops

1. **A persona may say what an agent is *told*; it may never say what an agent is *allowed*.**
   `PERSONA_RULE`, quoted everywhere it is enforced. `Told` is a strict object so a key nobody wired
   is an error, and the authority keys — `account`, `approvals`, `extensions`, `mcp`, `workspace`,
   `root`, `network`, `push`, a credential, which tools it may call — are refused **by name** with
   the reason, because "unrecognized key: account" teaches nobody why and somebody would add it.
   Every one of them is in `settingReach`'s `never` subtree already. **A field leaving `never` there
   does not make it a persona's**: a persona is stamped out by a template nobody re-reads, so a field
   here is authority arriving without anybody deciding it that time.
2. **A prompt is literal.** Nothing is substituted into one — not an input, not a path, not a ticket
   body, and nothing ever reaches a shell, because there is no substitution function to reach one
   with. Everything derived goes in the task's **context file**, under `OUTSIDE_IS_MATERIAL`
   (`compose.ts`). A test asserts no filled value appears in any prompt. Break this and a form field
   becomes an instruction.
3. **A published version is immutable, and its personas are folded into it.** Publishing takes a
   snapshot; the draft goes on being a draft. The same bytes again is nothing, different bytes under
   the same version is **refused** naming the version to bump to, and the snapshot carries **no
   clock** — the hash has to be a pure function of the content or none of the above means anything.
   This is where this slice overrules research.md §9.6, which made publishing `mv` into `active/`:
   that leaves the published thing editable, so a run's provenance would be a lie.
4. **Publishing is a person at this machine, enforced by absence.** There is no `template/publish`
   method and no tool. The orchestrator lists, dry-runs and uses what is **already published**; a
   draft — including one somebody imported or was sent — is not that, and `dryRunTemplate`'s
   `drafts` flag is passed only by the CLI.
5. **Nothing starts.** `useTemplate` makes the tasks through `tade.planTasks` and then parks every
   one. A person picks them up and the queue takes over. A template that made unparked tasks would
   be a stored shape that starts agents.

## Writing one

```yaml
template: bug-repro-fix-review   # == the file name
version: 1                       # bumped on every publish; written into every task it makes
title: Reproduce a reported bug, fix it, and have the change read by somebody else
project_input: project           # WHICH INPUT names the repository — never a literal
said_input: summary              # which input is the request, verbatim: becomes the plan's `said`
name_suffix: ticket              # which input is put on the end of every task name
inputs:
  project: { kind: project }
  ticket:  { kind: slug }
  summary: { kind: text }
  report:  { kind: document, required: false }
agents:
  - name: fix
    persona: implementer
    prompt: Reproduce it, then fix the cause.      # literal, always
    touches: [src/export.ts]
  - name: read
    persona: reviewer
    after: [{ agent: fix, why: a change is read by somebody who did not write it }]
```

Then: `tade templates check <name>` → `tade templates dry-run <name> -i …` → `tade templates
publish <name>`. **A template that will not dry-run cleanly against the real tree is not one to
publish** — a human rule, so it is said where a human is deciding (`check`'s own output and here),
not in the suite, because nothing mechanical can check it against a tree nobody has named yet.

- **`name_suffix` is all but required.** Without it a template can be used once: a task name is
  never used twice, and the second use is refused by `guardName` with nothing to say about why.
  `templateProblems` warns.
- **An input's kind decides where its value may go.** `project` routes, `slug` builds a name, `text`
  becomes `said` and is refused if it has a newline in it, `document` goes **only** into every task's
  context file. What came from outside is always a `document`.
- **A done rule may be given per workspace** — `done: { worktree: committed, checkout: said }` —
  which is what lets one published template be used in both kinds of project. `checkPlan` refuses
  `committed` and `merged` in a shared checkout; this is how a template covers both answers rather
  than picking one.
- **A document is handed over by path, not described.** `reads: [research]` puts the actual
  `producesPath` in the reader's context file. It is refused if it names an agent this one does not
  wait on, or one that produces nothing.
- **Across repositories, every mapping is explicit.** Reference a second `project` input and *every*
  agent must name its own — the template-level mirror of `checkPlan`'s rule, caught at check time
  rather than at use time.

## The deadlock, because it is the one shape that looks fine and is not

> A tester commits a failing test, and the project's checks have to pass to commit.

That agent never finishes, so everything waiting on it never starts. `leaves_checks: red` declares
the expectation, and `templateProblems` **refuses** it together with `done: committed`/`merged`,
naming both ways out: hand the failing reproducer in as a `document` input, or make reproducing and
fixing **one coherent agent**. `bug-repro-fix-review` takes the second, which is why it has no
separate `reproduce` step. An agent expected to leave the checks red that nothing waits on is
refused too — nothing would make them green again.

Declared and not sniffed, like every other capability here: a rule that read intent out of a prompt
would be a rule that is wrong twice a year and silent about it.

## Writing one in a form, which is a list and never a canvas

`/workflows` opens the editor: the templates and their steps down the left, a form for whichever
one you are on down the right, and under it the resolved tree. The comparison that decided this is
in research.md §9.4 — a node canvas expresses a DAG natively and costs a layout engine, drag, hit
testing, zoom and an undo of *geometry*, and positions are noise in every diff; an intake template
has three to five steps with one shape, and a canvas is for a graph you do not already know.

- **Every edit is a `Template` in and a `Template` out** (`templates-edit.ts`, pure), so the form
  and `tade templates check` run the same validator and a form can never accept what publishing
  refuses. The form may hold an invalid intermediate shape on purpose — refusing every one would be
  a form you could not get from one valid template to another in — and `templateProblems` is what
  refuses the publish.
- **A dependency is a tick beside the step it waits on, with the reason beside the tick**, because a
  wait with no reason given is the one thing `checkPlan` can tell you nothing useful about. The
  preview marks one.
- **Renaming a step rewires every wait on it.** A rename that left them behind makes a plan that
  waits on a step that does not exist — refused, after the file was already written.
- **A prompt of more than a line is not edited here.** A governing instruction is prose and a
  one-line field is where prose goes to die: the field says so and the edit is refused, because a
  field that quietly dropped every line after the first would be a form that edits an agent's
  instructions by deleting them.
- **Saving rewrites the draft file**, so a comment in it is not kept — said in the file's own header
  (`draftYaml`) rather than discovered. `writeDraft` writes drafts by absence: the path is the
  drafts directory and nothing passed in can move it.
- **Publishing is a person's, and it asks.** The page calls `publishTemplate`, the same door the
  command calls, so immutability, the validation and the personas folded in are one implementation.
  Nothing the orchestrator can reach writes, publishes or rejects a template.

## Changing something

- **A new told field on a persona**: add it to `Told`, to `Persona`, to `resolveAgent`, and give it
  a reader in `fillTemplate` in the same commit. A field with no reader is worse than no field.
  If it is authority-shaped, it goes in `REFUSED` instead, with the sentence somebody is told.
- **A new template field**: `Template`/`TemplateAgent`, a rule in `templateProblems`, the fill, and
  `snapshotYaml` — which is built field by field in a fixed order **on purpose**, because the hash
  of that text is what immutability is measured against and key order deciding whether a version
  "changed" would make the promise depend on which YAML library was installed.
- **A built-in**: `templates-builtin.ts`, as source, and the tests assert every one reads, holds
  together and makes a plan `checkPlan` keeps — in a worktree project *and* a shared checkout.
  Source constants rather than files because the staged tarball copies only tracked files and
  renames nothing but `.ts`, and because bytes in the source cannot be edited under a run.
- **A new orchestrator reach**: read `add-orchestrator-tool` first, and then ask the question this
  file is mostly about — whether the act is a person's. Writing, publishing and reaching a draft are,
  and they stay enforced by there being no method rather than by a check inside one.

## Then

`pnpm check`, and if the tool list or the orchestrator's rules changed,
`TADE_UPDATE_GOLDEN=1 pnpm vitest run packages/orchestrator/test/golden.test.ts` — and read the diff,
because that golden is the thing somebody reviews.

import type { OrchestratorTool } from './tools-extension.ts'

// Stored workflows, as far as the orchestrator's arm reaches into them.
//
// Beside `tools-extension.ts` rather than in it, the same two reasons
// `tools-config.ts` gives: that file is at its budget and a budget only goes
// down, and — the better reason — these three tools share one boundary, which
// is worth reading in one place rather than inferred from three descriptions
// scattered among forty.
//
// **The boundary.** It may list what somebody at this machine has *published*,
// ask what one *would* make, and use one — which makes tasks that are parked,
// so even that starts nothing. It may not write one, change one, publish one,
// or reach a draft nobody here has read. Three of those four are enforced by
// there being no method on the `ToolHost` at all; the fourth is a flag the
// host never passes. None of it is enforced here, because a rule that lives
// where the model lives is a rule the model can be talked out of.
//
// What is here is the half the model reads, and it is mostly *restraint*. A
// stored shape is cheaper to reach for than reading the code, so the failure
// these descriptions exist to stop is a template used for work that is not
// that shape — which is why each one says what to do instead, and why the
// listing says the bound every time rather than waiting to refuse.
//
// Type-only import, so nothing is loaded at runtime and there is no cycle: the
// caller hands `rpc` in. Like everything pi loads, this file imports nothing
// from the Tade workspace.

/** JSON Schema, as `tools-extension.ts` builds one. */
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const string = (description: string) => ({ type: 'string', description })

const version = {
  type: 'number',
  description: 'a published version; the newest when not said',
}

/**
 * How a template is filled in, said where a model is choosing what to put in
 * it — because the one mistake with real consequences is putting a ticket body
 * in the one-line request, and nothing refuses that except the input's kind.
 */
const inputs = (what: string) => ({
  type: 'object',
  description: what,
})

export function templateTools(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): OrchestratorTool[] {
  const tools: OrchestratorTool[] = []
  const tool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (params: Record<string, unknown>) => Promise<unknown>,
  ): void => {
    tools.push({
      name,
      label: name.replace(/^tade_/, 'tade: ').replace(/_/g, ' '),
      description,
      parameters,
      run,
    })
  }

  tool(
    'tade_templates',
    'Stored workflows somebody here wrote down and published: a plan with holes in it, for work whose shape arrives the same way again and again. This lists the published ones with the newest version of each. You cannot write one, change one or publish one — that is a person at this machine, with `tade templates publish` — and one that is only a draft is not listed here. Reach for tade_plan for everything else: it can read the repository first and a template cannot.',
    object({}),
    () => rpc('template/list', {}),
  )

  tool(
    'tade_template_dry_run',
    'What a published template would make, before anything is made: one row per task, what each is told to be, where it works, how it counts as finished, what it waits on and why, and which of them would run into work already going. It also says what the template grants, which is nothing, and what bounds the work — what each project may spend today, how many agents it allows at once, and where each sign-in stands against its plan. **It writes nothing and starts nothing.** Call it before tade_template_use, every time, and read it back to the person rather than summarising it: the point of it is that they see what would happen. One that will not dry-run cleanly is not one to use.',
    object(
      {
        template: string('the template, as tade_templates lists it'),
        version,
        inputs: inputs(
          'what it is filled in with, name to value, as the dry run lists what it takes. A value is never put into what an agent is told — it goes in the task’s own context file — so what came from outside goes in whichever input the template says is for material, never in the one-line request',
        ),
      },
      ['template'],
    ),
    (p) => rpc('template/dry-run', p),
  )

  tool(
    'tade_template_use',
    'Stamp a published template out: it makes the tasks through the same plan path tade_plan uses, with the same refusals, and **every one of them parked**. Nothing starts. A person picks them up — tade_queue_change with start, or in the window — and the queue takes it from there, so say that back rather than implying work is under way. Dry-run it first and show them what it would make: three agents is a real amount of somebody’s money and a real amount of their repository. Use it only for work whose shape genuinely repeats, and only when they asked for that template or for the thing it is plainly for; for anything else write the plan yourself with tade_plan. It makes nothing if the plan cannot be kept, and says why.',
    object(
      {
        template: string('the template, as tade_templates lists it'),
        version,
        inputs: inputs('what it is filled in with, name to value: the same as the dry run took'),
      },
      ['template'],
    ),
    (p) => rpc('template/use', p),
  )

  return tools
}

/**
 * Work that arrived from outside this machine, as far as the orchestrator's
 * arm reaches into it — which is **reading, and nothing else**.
 *
 * Beside the template tools because they share one boundary and it is worth
 * reading in one place. The boundary:
 *
 * **It may look.** Which requests arrived, which key allowed each one, which
 * published template version it was stamped from, where each stands, and what
 * approving one *would* start. All of that is this machine's own record of
 * what it decided, and a person asking "what came in while I was out?" should
 * not have to go and read a journal.
 *
 * **It may not act, and it may not widen.** There is no tool here that
 * approves, refuses or retries one, none that turns a source on, puts a
 * handle on an allowlist or names a template for a source — and that is
 * enforced by there being no method on the `ToolHost` at all, plus
 * `settingReach`, which has the whole `surfaces.intake` subtree at `never`:
 * every key under it is refused however it is asked for, by whoever asks.
 * The reason is one sentence: **the text the orchestrator reads all day does
 * not get to put itself on an allowlist**, and approving a request is starting
 * agents on somebody else's words.
 *
 * **And it never sees the request.** The answers below carry the source's own
 * ids, the handle, the grant and the state. The body is not in them — not
 * truncated, not summarised, not quoted: it is in the task's own context file,
 * under the one heading that says material is material, read by the agent
 * doing the work. An orchestrator that had read it would be an orchestrator
 * whose next turn might act on it, and `intent_spoken` is the person's.
 */
export function intakeTools(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): OrchestratorTool[] {
  const tools: OrchestratorTool[] = []
  const tool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (params: Record<string, unknown>) => Promise<unknown>,
  ): void => {
    tools.push({
      name,
      label: name.replace(/^tade_/, 'tade: ').replace(/_/g, ' '),
      description,
      parameters,
      run,
    })
  }

  tool(
    'tade_intake',
    'What has been handed to this machine from outside — a ticket somebody filed, a line typed at the local door — and where each one stands: noticed, proposed (a task is made and parked, waiting for a person), accepted, started, held, refused, or given up on. Also what each source’s grant says and when it last looked. Read it when somebody asks what came in, or what is waiting for them. **You cannot approve, refuse or retry one, and you cannot turn a source on or put anybody on its list** — each of those is a person at this machine, in the window or with `tade intake`; say that rather than offering. The request itself is not in this answer at any length: it is in the task’s own context file, as material, for the agent doing the work.',
    object({
      project: string('only this project’s; every project when not said'),
      waiting: {
        type: 'boolean',
        description: 'only the ones a person at the machine has to answer',
      },
    }),
    (p) => rpc('intake/list', p),
  )

  tool(
    'tade_intake_show',
    'One request in full: where it came from, the handle the source gave, the dotted path of the grant in the owner’s own config that allowed it, the published template version it was stamped from, what approving it would start — one row per task, what each waits on and why — and what bounds that work. **It starts nothing and changes nothing.** Call it before saying what would happen if somebody approved something, and read the rows back rather than summarising them. The request’s own words are deliberately not in the answer; if somebody wants to read it, the page in the window shows it under a heading saying whose words they are.',
    object({ item: string('the request, as tade_intake lists it: `<source>:<their id>`') }, [
      'item',
    ]),
    (p) => rpc('intake/show', p),
  )

  return tools
}

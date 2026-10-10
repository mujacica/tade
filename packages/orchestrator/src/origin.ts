import {
  type Arm,
  type Arming,
  armMay,
  armSees,
  needsYouHere,
  type RemoteGrant,
  type Who,
  whoOf,
} from '@tade/core'
import type { WorkerCapabilities } from '@tade/harnesses-core'

// What a turn's words may reach, as two closed tables.
//
// **This is the enforcement, and the sentence Tade prepends to a remote turn
// is not.** `cameFromAway` tells the model why a refusal is correct so it says
// so rather than hunting for another route; everything that actually refuses
// is here, in a pure function, in front of the two doors a tool call goes
// through. A model that read a stranger's words all day is exactly the thing
// that can be talked out of a paragraph, so nothing above depends on one.
//
// ## Two gates, because they answer different questions
//
// 1. **Whose tool is this?** (`allowTool`) The orchestrator's harness gives it
//    tools of its own — pi has `bash`, `write` and `edit` — and those never
//    touch Tade's code at all. Under a remote turn the answer for every one of
//    them is no: a remote turn may call **Tade's own tools and nothing else**,
//    and even among those only what the table below names. Asked by a
//    `tool_call` hook **inside Tade's own tools extension**, over the same
//    socket (`origin/allow`) — so it needs no approval mode and nothing about
//    a local turn changes, because the answer for a local turn is always yes.
// 2. **What may this call do?** (`allowMethod`) Tade's own tools come back out
//    to the `ToolHost`, and a name that passed gate 1 still carries parameters:
//    a task in a project this device may not see, a scope it was not granted, a
//    `by` it does not get to choose. Asked at dispatch, which is also what
//    stops a **direct** connection to the socket — a tool call Tade never
//    registered, or a second process of the same agent — from going round
//    gate 1 entirely.
//
// Neither stands in for the other. Gate 1 without gate 2 would let
// `tade_steer` reach a project the device cannot see; gate 2 without gate 1
// would leave `bash` wide open, which is the whole of the hole DESIGN.md's
// Phase 3 left: it worried about `said` and about what the transcript carries,
// and never about the model holding a shell.
//
// ## Why `said` could not have been the answer
//
// The shape everybody reaches for first is "a remote turn writes no `said`
// line, so `namedBy` finds nothing and an `asked`-tier setting is refused".
// It is true and it is not enough, in two ways that are both silent:
//
// - **`namedBy` reads the last forty lines the *person* said.** A remote turn
//   that asks for a setting the person happened to name on Tuesday is
//   authorised by their line. Writing no `said` of its own changes nothing
//   about the ones already there.
// - **`open`-tier settings need no words at all.** `settingReach`'s `open`
//   list is an ordinary request, so neither sentence above even applies.
//
// So the answer is not about what a remote turn writes. It is that
// `config/change` is not reachable from one, however the request is worded —
// and the same for every other door in the `local` half of the tables below.

/**
 * Whether a harness can run a remote turn at all, or why not.
 *
 * **Two declared capabilities, and a harness that lacks either serves no
 * remote turn.** Never a silent unrestricted run, which is the failure mode
 * this function exists to make impossible:
 *
 * - `permissionGate`, because gate 1 is the harness holding one of its own
 *   tool calls until Tade answers. Without that there is no moment at which
 *   `bash` can be refused, and a remote turn would reach a shell.
 * - `nativeExtensions`, for two reasons at once. The hook that asks gate 1
 *   lives in **Tade's own tools extension**, so it only exists where the
 *   harness loads Tade's code as its own modules — and the gate decides by
 *   **name**, which is only Tade's own name there. A harness handed the tools
 *   as an MCP server has neither: it renames them in its own way, and a gate
 *   that guessed at a prefix is a gate somebody gets past by registering a
 *   tool called `tade_status`.
 *
 * Both are declared rather than sniffed (R3): no branch anywhere reads the
 * harness's name, and a harness that grows the capability becomes eligible by
 * saying so. The sentence given back is the harness's own `why` where it has
 * one, because whatever reaches a person is a sentence somebody wrote.
 */
export function canBeArmed(
  capabilities: Pick<WorkerCapabilities, 'permissionGate' | 'nativeExtensions' | 'why'>,
): { ok: true } | { ok: false; why: string } {
  if (!capabilities.permissionGate) {
    return {
      ok: false,
      why:
        capabilities.why.permissionGate ??
        'cannot hold one of its own tool calls for a decision, so a message from away could reach any tool it has',
    }
  }
  if (!capabilities.nativeExtensions) {
    return {
      ok: false,
      why:
        capabilities.why.nativeExtensions ??
        'is not given Tade’s tools as its own, so Tade cannot tell one of them from a tool of the harness by name',
    }
  }
  return { ok: true }
}

// `Arming` is **`@tade/core`'s**, re-exported here so `tool-host.ts` reads it
// beside the tables it is asked about. It lives in the domain for the reason
// the away view's own sentences do: the window implements it and this package
// consumes it, and `@tade/app` cannot import this one — so a second spelling
// of the same three functions was the alternative.
export type { Arming }

/** What a tool or a method is reachable as. */
export type Reaching =
  /** Reachable from a remote turn with nothing beyond `ask`. */
  | { kind: 'read' }
  /** Reachable where the device was granted this. */
  | { kind: 'needs'; grant: RemoteGrant }
  /** Never from a remote turn, and the clause saying why. */
  | { kind: 'local'; because: string }

/** The decision: a sentence the caller is given when it is no. */
export type Allowed = { ok: true } | { ok: false; said: string }

// The four clauses the `local` half is written with. Grouped rather than one
// per entry, because the argument really is the same for each group and
// fifty-odd hand-written sentences would be fifty-odd chances to write a
// comfortable one.
const EXECUTES = 'it turns words into something running on this machine, as you, with your keys'
const GRANTS = 'it widens what an agent may do, or hands out a credential or a tool'
const PUBLISHES = 'it puts work, or Tade’s own reach, somewhere other people see it'
const CONFIRMS = 'the confirmation it needs is a person’s own second press, which a sentence is not'
const READS_WIDE =
  'what it answers carries more than this device may read — a command, a path, an agent’s own bytes'
// The fifth, and the only one that is not about what a call can reach: it is
// about what a call can make *stop being said*. Recording a decision about a
// document takes it off the list the person reads to find out that an analysis
// is still unread — so a phone that could write one could clear something
// nobody ever saw waiting, which is the one failure the list exists to prevent.
const DECIDES_FOR_SOMEBODY =
  'it writes down a decision, and a decision recorded from away is one the person never saw waiting'

/**
 * Every one of Tade's own tools, and what a remote turn may do with it.
 *
 * **Exhaustive, and a test holds it against `orchestratorTools()`.** A tool
 * added without a line here fails that test rather than arriving reachable or
 * arriving silently refused — the first is the hole and the second is a
 * capability that stops working with nobody told. At runtime an unknown name
 * is refused (`reachOfTool`), so the failure direction is safe either way.
 *
 * The shape of what is left reachable: **reading this device's own view, plus
 * the two things its own controls can already do.** Everything a device can
 * ask Tade for in words, it could already have pressed — which is the property
 * worth having, because it means talking to Tade adds no authority to a phone,
 * only a way to use what it has.
 */
export const REMOTE_TOOLS: Readonly<Record<string, Reaching>> = {
  // The one read, and it is narrowed rather than trusted: under a remote arm
  // `status/read` is answered with *this device's own projection* — the same
  // pathless, per-device, grant-honouring tree the phone already holds. So the
  // conversation can talk about exactly what its screens show and no more,
  // which is what keeps `ask` from being a way round every read grant.
  tade_status: { kind: 'read' },

  // What a device granted `answer` can already press.
  tade_approvals: { kind: 'needs', grant: 'answer' },
  tade_approve: { kind: 'needs', grant: 'answer' },
  tade_deny: { kind: 'needs', grant: 'answer' },

  // What a device granted `steer` can already press.
  tade_steer: { kind: 'needs', grant: 'steer' },
  tade_park: { kind: 'needs', grant: 'steer' },
  tade_resume: { kind: 'needs', grant: 'steer' },
  tade_remember: { kind: 'needs', grant: 'steer' },

  // Execution, by every route it has.
  tade_run_start: { kind: 'local', because: EXECUTES },
  tade_terminal_open: { kind: 'local', because: EXECUTES },
  tade_terminal_run: { kind: 'local', because: EXECUTES },
  tade_terminal_close: { kind: 'local', because: EXECUTES },
  tade_terminal_rename: { kind: 'local', because: EXECUTES },
  tade_chat_open: { kind: 'local', because: EXECUTES },
  tade_write_extension: { kind: 'local', because: EXECUTES },
  tade_plan: { kind: 'local', because: EXECUTES },
  tade_task_create: { kind: 'local', because: EXECUTES },
  tade_template_use: { kind: 'local', because: EXECUTES },
  tade_schedule: { kind: 'local', because: EXECUTES },

  // Grants, credentials, and who is asked.
  tade_setting_change: { kind: 'local', because: GRANTS },
  tade_settings: { kind: 'local', because: GRANTS },
  tade_watch_change: { kind: 'local', because: GRANTS },
  tade_watches: { kind: 'local', because: GRANTS },
  tade_project_open: { kind: 'local', because: GRANTS },
  tade_project_close: { kind: 'local', because: GRANTS },
  tade_project_rename: { kind: 'local', because: GRANTS },
  tade_project_configure: { kind: 'local', because: GRANTS },
  tade_project_reorder: { kind: 'local', because: GRANTS },
  tade_agent_model: { kind: 'local', because: GRANTS },
  tade_agent_thinking: { kind: 'local', because: GRANTS },
  tade_agent_harness: { kind: 'local', because: GRANTS },
  tade_orchestrator_model: { kind: 'local', because: GRANTS },
  tade_limits: { kind: 'local', because: GRANTS },
  tade_intake: { kind: 'local', because: GRANTS },
  tade_intake_show: { kind: 'local', because: GRANTS },
  tade_propose_skill: { kind: 'local', because: GRANTS },

  // Work, or Tade's own reach, becoming visible to other people.
  tade_updates: { kind: 'local', because: PUBLISHES },
  tade_queue_change: { kind: 'local', because: PUBLISHES },
  tade_agent_rename: { kind: 'local', because: PUBLISHES },

  // Asking again does not undo it, so the confirmation is a person's own
  // second press. The `done` verb has one and this has nowhere to put one.
  tade_done: { kind: 'local', because: CONFIRMS },
  tade_run_stop: { kind: 'local', because: CONFIRMS },
  tade_run_cleanup: { kind: 'local', because: CONFIRMS },

  // Reads whose answer is wider than a read grant: a lane's bytes, a journal
  // detail, a note's words, a template's prompt, a chat's working directory.
  // Each is a *reading* decision with its own threat model, and the away view
  // already serves what it has decided to serve. A tool that reads round a
  // grant is a grant that does not hold.
  tade_logs: { kind: 'local', because: READS_WIDE },
  // A path in Tade's home, and a task id for tasks the away view no longer
  // draws: a read wider than a read grant, like the rest of this group.
  tade_documents: { kind: 'local', because: READS_WIDE },
  tade_notes: { kind: 'local', because: READS_WIDE },
  tade_terminal_read: { kind: 'local', because: READS_WIDE },
  tade_terminal_search: { kind: 'local', because: READS_WIDE },
  tade_terminal_list: { kind: 'local', because: READS_WIDE },
  tade_chat_list: { kind: 'local', because: READS_WIDE },
  tade_run_list: { kind: 'local', because: READS_WIDE },
  tade_queue: { kind: 'local', because: READS_WIDE },
  tade_templates: { kind: 'local', because: READS_WIDE },
  tade_template_dry_run: { kind: 'local', because: READS_WIDE },

  // Its own clause, because it is the only one here that is not about what a
  // call can reach.
  tade_document_triage: { kind: 'local', because: DECIDES_FOR_SOMEBODY },
}

/**
 * What a remote turn may do with a tool of this name.
 *
 * **An unknown name is refused**, which is the direction that matters: the
 * names that reach here are whatever the harness registered, so a tool of the
 * harness's own (`bash`), one an extension added, and one a future version of
 * Tade declared all arrive as names this table has never heard of. Allowing by
 * default would make every one of them reachable; refusing by default makes a
 * forgotten line a capability that stops working, which somebody notices and
 * nobody regrets.
 */
export function reachOfTool(tool: string): Reaching {
  return (
    REMOTE_TOOLS[tool] ?? {
      kind: 'local',
      because: 'it is not one of the tools Tade offers a paired device',
    }
  )
}

/**
 * Gate 1: whether this turn may call a tool of this name at all.
 *
 * Local is allowed without being asked anything — there is no list a local
 * turn is checked against, which is the type saying that local control is
 * unchanged rather than a comment promising it.
 */
export function allowTool(tool: string, arm: Arm): Allowed {
  if (arm.how === 'local') return { ok: true }
  const reaching = reachOfTool(tool)
  if (reaching.kind === 'local')
    return { ok: false, said: needsYouHere(`\`${tool}\`: ${reaching.because},`) }
  if (reaching.kind === 'needs' && !armMay(arm, reaching.grant)) {
    return {
      ok: false,
      said: `\`${tool}\` needs this device to have been granted ${reaching.grant} at the machine, and it was not. Say so; there is no other route to it.`,
    }
  }
  return { ok: true }
}

/**
 * Which parameter of a `ToolHost` method names the project it is about, where
 * one does.
 *
 * A function per method rather than a field name, because the project is read
 * out of a task id in one and out of a note's scope in another — and because a
 * method whose project cannot be worked out has to say so rather than be
 * waved through. `null` means *this method is about no project in particular*,
 * which for a remote arm is only ever true of a read that is itself narrowed.
 */
export type ProjectOf = (params: Record<string, unknown>) => string | null

/** One method, what it needs, and how its project is found. */
export interface MethodReaching {
  reaching: Reaching
  /** Null where the method is about no one project. */
  project?: ProjectOf
}

/**
 * The project half of a task id, which is the per-project boundary.
 *
 * **The empty string where there is no project half**, and never `null`: a
 * `null` means *this call is deliberately about no project* — a note about
 * everything — and `armSees` answers no to the empty string, so a task id
 * nobody could parse is refused rather than waved through. Those two answers
 * being one value is a hole a bare name walks through: `task: 'orphan'` names
 * no project, and *no project* must never be read as *every project*.
 */
function projectOfTask(value: unknown): string {
  const task = typeof value === 'string' ? value : ''
  const cut = task.indexOf('/')
  return cut <= 0 ? '' : task.slice(0, cut)
}

/** The local half of the table, written once: every method that is never remote. */
function never(because: string): MethodReaching {
  return { reaching: { kind: 'local', because } }
}

/**
 * Every `ToolHost` method, and what a remote turn may do with it.
 *
 * **Exhaustive, and a test holds it against the host's own method names.** The
 * ratchet `reach.test.ts`'s `decided` set is, for the same reason: a method
 * added without a line here is a method whose authority nobody decided, and
 * the compiler cannot ask the question because the host's methods are a record
 * of closures rather than a type.
 *
 * It is **not** a copy of `REMOTE_TOOLS` in another vocabulary. The two tables
 * are keyed by different things and one is not derivable from the other: a
 * tool may shell out to the CLI and reach no method at all (`tade_notes`), and
 * a method may be reachable by more than one tool (`task/park`, from
 * `tade_park` and `tade_resume`). What they share is that both default to no.
 */
export const REMOTE_METHODS: Readonly<Record<string, MethodReaching>> = {
  // **The gate itself**, which has to be reachable from the turn it is for:
  // Tade's own tools extension asks it before every tool call, and a gate that
  // refused to answer during a remote turn would refuse every tool including
  // the ones that arm was granted. It answers its own decision and nothing
  // else, so what a remote turn learns from it is what the refusal would have
  // told it.
  'origin/allow': { reaching: { kind: 'read' } },
  // The one read of Tade's own state, and the narrowing is in the handler:
  // under a remote arm it answers this device's own projection rather than
  // `tade status`.
  'status/read': { reaching: { kind: 'read' } },

  // Answering what is already waiting. `worker/pending` is narrowed on the way
  // out (`waiting`) and `worker/decide` finds its project through the approval
  // it names, because the call names a run and a run is not a task.
  'worker/pending': { reaching: { kind: 'needs', grant: 'answer' } },
  'worker/decide': { reaching: { kind: 'needs', grant: 'answer' } },

  // The steer tier, each the same act the device's own control makes.
  'worker/steer': {
    reaching: { kind: 'needs', grant: 'steer' },
    project: (p) => projectOfTask(p.task),
  },
  'task/park': {
    reaching: { kind: 'needs', grant: 'steer' },
    project: (p) => projectOfTask(p.task),
  },
  // A note's scope is a task id, a project name, or nothing at all — and
  // nothing at all is a note about everything, which a device may write: it is
  // the same note its own `note` verb writes, with the same `by`.
  'memory/remember': {
    reaching: { kind: 'needs', grant: 'steer' },
    project: (p) => {
      const scope = typeof p.scope === 'string' ? p.scope.trim() : ''
      // `null` is *about everything*, which is the one place that answer is a
      // real one rather than a failure to parse.
      if (scope === '') return null
      return scope.includes('/') ? projectOfTask(scope) : scope
    },
  },

  'task/create': never(EXECUTES),
  'task/done': never(CONFIRMS),
  'task/rename': never(PUBLISHES),
  'queue/plan': never(EXECUTES),
  'queue/list': never(READS_WIDE),
  'documents/list': never(READS_WIDE),
  'documents/triage': never(DECIDES_FOR_SOMEBODY),
  'queue/change': never(PUBLISHES),
  'queue/schedule': never(EXECUTES),
  'template/list': never(READS_WIDE),
  'template/dry-run': never(READS_WIDE),
  'template/use': never(EXECUTES),
  'intake/list': never(GRANTS),
  'intake/show': never(GRANTS),
  'config/settings': never(GRANTS),
  'config/change': never(GRANTS),
  'watch/list': never(GRANTS),
  'watch/change': never(GRANTS),
  'project/open': never(GRANTS),
  'project/close': never(GRANTS),
  'project/rename': never(GRANTS),
  'project/reorder': never(GRANTS),
  'project/configure': never(GRANTS),
  'plan/limits': never(GRANTS),
  'extension/call': never(GRANTS),
  'worker/model': never(GRANTS),
  'worker/thinking': never(GRANTS),
  'worker/harness': never(GRANTS),
  'orchestrator/model': never(GRANTS),
  'worker/start': never(EXECUTES),
  'worker/list': never(READS_WIDE),
  'worker/stop': never(CONFIRMS),
  'events/read': never(READS_WIDE),
  'chat/list': never(READS_WIDE),
  'chat/open': never(EXECUTES),
  'terminal/list': never(READS_WIDE),
  'terminal/open': never(EXECUTES),
  'terminal/close': never(EXECUTES),
  'terminal/rename': never(EXECUTES),
  'terminal/run': never(EXECUTES),
  'terminal/read': never(READS_WIDE),
  'terminal/search': never(READS_WIDE),
  'lane/write': never(EXECUTES),
}

/**
 * Gate 2: whether this call may go through to the window.
 *
 * `project` is resolved by the caller rather than read here for the one method
 * whose project only the window can find — `worker/decide` names a run, and
 * which task a run belongs to is the supervisor's answer. Passing it in keeps
 * this function pure and keeps the reach check in one place.
 */
export function allowMethod(
  method: string,
  params: Record<string, unknown>,
  arm: Arm,
  project: string | null = null,
): Allowed {
  if (arm.how === 'local') return { ok: true }
  const found = REMOTE_METHODS[method]
  if (found === undefined) {
    return {
      ok: false,
      said: needsYouHere(`\`${method}\`: it is not something a paired device may reach,`),
    }
  }
  const { reaching } = found
  if (reaching.kind === 'local') {
    return { ok: false, said: needsYouHere(`\`${method}\`: ${reaching.because},`) }
  }
  if (reaching.kind === 'needs' && !armMay(arm, reaching.grant)) {
    return {
      ok: false,
      said: `\`${method}\` needs this device to have been granted ${reaching.grant} at the machine, and it was not.`,
    }
  }
  const named = project ?? found.project?.(params) ?? null
  if (named !== null && !armSees(arm, named)) {
    return {
      ok: false,
      said: `this device was not granted ${named}, so nothing it asks for can reach that project.`,
    }
  }
  return { ok: true }
}

/**
 * What a `memory/remember` call writes as its `by`, under either arm.
 *
 * **Rewritten rather than trusted**, because the tool sends `by: 'orchestrator'`
 * and that is true of a local turn and false of a remote one: a note the
 * orchestrator wrote because a phone asked it to is the phone's, and a note
 * filed as the orchestrator's own is the provenance hole one layer down from
 * the `said` one. The word is `byOf`'s, which is the same word the device's
 * own `note` verb writes, so the two doors agree.
 */
export function writtenBy(arm: Arm, said: unknown): string {
  const who: Who = whoOf(arm)
  if (who.how === 'remote') return `device ${who.device}`
  return typeof said === 'string' && said !== '' ? said : 'tade'
}

/** One approval, as a remote turn may see it. */
export interface WaitingOut {
  run: string
  task: string
  request: string
  /** The tool's **name**, and never the command. */
  tool: string
  at: number
}

/**
 * The approvals a remote turn may see: whose project it reaches, and the name
 * of what is waiting.
 *
 * **The summary is the field this exists to leave out.** `describeToolCall`
 * renders `bash: <the whole command>` and `read <an absolute path>` — it is the
 * tool call itself, which is exactly what the projection already refuses to put
 * on a phone (`TaskIn.approval` carries the tool's name and the count and
 * nothing else). So a remote turn is told the same as the page: what is waiting
 * and on which task, enough to answer it, and the command stays at the machine
 * where the lane is. `tier`, `rule` and `reason` go for the lesser version of
 * the same reason — none of them is needed to say yes or no, and `reason`
 * quotes the policy's own clause about a command.
 *
 * Hand-written field by field rather than a delete of three keys, because a
 * field added to `PendingApproval` next month must not arrive here by default.
 */
export function waiting(
  approvals: readonly { run: string; task: string; requestId: string; tool: string; at: number }[],
  arm: Arm,
): WaitingOut[] {
  if (arm.how === 'local') {
    return approvals.map((one) => ({
      run: one.run,
      task: one.task,
      request: one.requestId,
      tool: one.tool,
      at: one.at,
    }))
  }
  const out: WaitingOut[] = []
  for (const one of approvals) {
    if (!armSees(arm, projectOfTask(one.task))) continue
    out.push({ run: one.run, task: one.task, request: one.requestId, tool: one.tool, at: one.at })
  }
  return out
}

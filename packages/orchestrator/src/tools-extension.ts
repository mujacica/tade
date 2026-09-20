import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'

/** Where extensions live. Set by the orchestrator that launched us. */
function extensionsRoot(): string {
  const configured = process.env.TADE_EXTENSIONS
  if (configured) return configured
  return join(process.env.TADE_HOME ?? process.cwd(), 'extensions')
}

/** The extension tools Tade listed for this orchestrator, or none. */
function extensionTools(): Array<{
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
}> {
  const path = process.env.TADE_EXTENSION_TOOLS
  if (!path) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((one) => typeof one?.name === 'string' && typeof one?.parameters === 'object')
      : []
  } catch {
    return []
  }
}

/** Where lessons are written. Set by the orchestrator that launched us. */
function skillsRoot(): string {
  return process.env.TADE_SKILLS ?? join(process.env.TADE_HOME ?? process.cwd(), 'skills')
}

// Tade's tools, as seen by the orchestrator.
//
// pi loads this file directly, so like the supervision extension it is
// SELF-CONTAINED: no imports from the Tade workspace, and the host's
// JSON-RPC framing is implemented here rather than pulled in.
//
// Tools that change something call back to Tade. "Where are we" shells out to
// `tade status`, so there is exactly one implementation of how status is
// derived, and the orchestrator sees precisely what a human would.

interface ToolContext {
  cwd: string
  /** pi's model catalog, for switching this session to a model Tade found. */
  modelRegistry?: { find?(provider: string, id: string): unknown }
}
/**
 * What a tool hands back: pi reads `content` and nothing else, and counts a
 * call as failed only when it throws. Returning an `output` field instead —
 * as these tools once did — gave the model an empty answer from every one.
 */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
}
interface ToolDefinition {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult>
}
interface PiApi {
  registerTool(tool: ToolDefinition): void
  /** Switches this session only; the default for new sessions is left alone. */
  setModel?(model: unknown): Promise<boolean>
}

const SOCKET = process.env.TADE_SOCKET ?? ''
const CLI = process.env.TADE_CLI ?? 'tade'
/** Arguments before the command, so a source checkout can run `node path/to/bin.ts`. */
const CLI_ARGS = (process.env.TADE_CLI_ARGS ?? '').split(' ').filter((a) => a.length > 0)

/** JSON Schema, which is also what pi's schema type is at runtime. */
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

/**
 * How a task counts as finished, as core's `DONE_RULES` says. Spelled out here
 * because pi loads this file on its own; the golden tool list is what notices
 * the two drifting apart.
 */
const done = {
  type: 'string',
  enum: ['said', 'idle', 'committed', 'merged', 'manual'],
  description:
    'how this task counts as finished, which is what work waiting on it waits for. said: its agent says it has finished (the usual choice); idle: its agent ends a turn with nothing waiting on anyone, for small jobs done in one go; committed: its agent stopped with its work committed (worktree mode only); merged: its branch is merged into the base (worktree mode only); manual: only when someone marks it finished. Anyone can also mark any task finished by hand.',
}

/** One of Tade's own tools, as any harness is given it. */
export interface OrchestratorTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  run(params: Record<string, unknown>, callId: string, ctx: ToolContext): Promise<unknown>
}

/**
 * Everything the orchestrator can do, in one list.
 *
 * Declared once and given to whatever harness it is running in: pi registers
 * them as its own tools (below), and a harness that speaks MCP is served the
 * same list by `tools-mcp.ts`. Two lists would be two tool surfaces, and the
 * golden file would only ever protect one of them.
 *
 * `switchModel` is the one thing a harness does differently: a harness that
 * can change model mid-session does it here, and one that cannot says the
 * model is kept and starts again on it.
 */
export function orchestratorTools(
  opts: {
    switchModel?: (
      chosen: { provider: string; id: string },
      ctx: ToolContext,
    ) => Promise<string | null>
  } = {},
): OrchestratorTool[] {
  const tools: OrchestratorTool[] = []
  const tool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (params: Record<string, unknown>, callId: string, ctx: ToolContext) => Promise<unknown>,
    label = name.replace(/^tade_/, 'tade: ').replace(/_/g, ' '),
  ): void => {
    tools.push({ name, label, description, parameters, run })
  }

  tool(
    'tade_status',
    'Where everything stands: every task, its state, and why. Derived fresh from git, running agents and provider transcripts. Use this for any question about what is happening.',
    object({}),
    // From the window when there is one: only it knows which agents are between
    // turns, and the CLI would call every one of them working.
    async () => {
      const seen = await rpc('status/read', {}).catch(() => null)
      return seen === null ? runCli(['status', '--json']) : JSON.stringify(seen, null, 2)
    },
  )

  tool(
    'tade_write_extension',
    'Write a new tool for yourself. It is saved in the extensions folder turned off, and does nothing until a human reads it and turns it on — in Extensions, or `tade extensions enable` — after which it loads the next time Tade starts. Never assume a tool you wrote is available.',
    object(
      {
        name: string('short name, lowercase with dashes'),
        source: string('the extension source: a pi extension module'),
        why: string('what it is for, in one sentence'),
      },
      ['name', 'source', 'why'],
    ),
    async (p) => {
      const name = String(p.name)
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
        throw new Error(`${name} is not a usable name: lowercase letters, digits and dashes`)
      }
      const dir = extensionsRoot()
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${name}.ts`)
      // The reason it was written goes in the file: it is the first line the
      // panel shows of something nobody has read yet, and a tool with no
      // stated purpose never gets turned on.
      const header = `// ${String(p.why)}\n// Written by Tade on ${new Date().toISOString()}.\n\n`
      await writeFile(path, header + String(p.source))
      return `Wrote ${name}, turned off. It is not running: a human reads ${path} and turns it on \`tade extensions enable ${name}\`, and it loads the next time Tade starts.`
    },
  )

  // What an agent should know before it starts, and where the work came from:
  // written into its worktree, so it finds them however it is started.
  const context = string(
    'what the agent should know before it starts, in markdown: what you found, where to look, what done looks like. Written to .tade/context.md in its worktree.',
  )
  const links = {
    type: 'array',
    description: 'where the work came from: an issue, a trace, a discussion',
    items: object({ title: string('what it is'), url: string('where it is') }, ['title', 'url']),
  }

  tool(
    'tade_task_create',
    "Create a task: a branch, a worktree, and the human's intent recorded verbatim. Pass the intent exactly as they said it, never paraphrased. Give it the context and links you gathered, so the agent that works on it starts knowing what you know.",
    object(
      {
        project: string('project name, as configured'),
        name: string('short task name, lowercase with dashes'),
        intent: string('what the human said, word for word'),
        context,
        links,
        done,
      },
      ['project', 'name', 'intent'],
    ),
    (p) =>
      rpc('task/create', {
        project: String(p.project),
        slug: String(p.name),
        intent: String(p.intent),
        ...(p.context ? { context: String(p.context) } : {}),
        ...(Array.isArray(p.links) ? { links: p.links } : {}),
        ...(p.done ? { done: String(p.done) } : {}),
      }),
  )

  tool(
    'tade_done',
    'Mark a task finished because the human said it is, whatever its rule: work waiting on it starts. Not for your own guess that it looks done — ask them.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        summary: string('what was done, in a line, when they said'),
      },
      ['task'],
    ),
    (p) =>
      rpc('task/done', {
        task: String(p.task),
        ...(p.summary ? { summary: String(p.summary) } : {}),
      }),
  )

  const stringList = (description: string) => ({
    type: 'array',
    description,
    items: { type: 'string' },
  })

  tool(
    'tade_plan',
    "Start several changes as one plan: agents that can work at the same time start now, and the rest wait in Tade's queue until what they wait on has finished, then start by themselves. Before calling it, read the code to see what each change will touch. In a project whose agents share one checkout, never let two agents that change the same files run at once: make one wait on the other. Small changes to the same place are one agent. Give every wait a reason, and choose how each agent counts as finished. Nothing is made if the plan cannot be kept, and it says why.",
    object(
      {
        project: string('project name, as configured'),
        said: string('the whole request, word for word'),
        agents: {
          type: 'array',
          description: 'one entry per agent, in any order',
          items: object(
            {
              name: string('its task name, lowercase with dashes'),
              said: string('the words of the request this agent covers, word for word'),
              prompt: string('what to tell the agent first'),
              done,
              after: {
                type: 'array',
                description:
                  'what it waits on: other agents in this plan by name, or tasks already in the project',
                items: object(
                  {
                    agent: string('an agent in this plan, or an existing task'),
                    why: string('why it has to wait, in a few words'),
                  },
                  ['agent', 'why'],
                ),
              },
              touches: stringList('the files or folders it will change, as you read the code'),
              at: string(
                'not before this time, ISO 8601 with a time zone, when it should wait for one',
              ),
              model: string('the model to start it on, only when the human named one'),
              thinking: string('how hard it thinks: minimal, low, medium, high, xhigh'),
            },
            ['name', 'said', 'prompt'],
          ),
        },
      },
      ['project', 'said', 'agents'],
    ),
    (p) => rpc('queue/plan', p),
  )

  tool(
    'tade_queue',
    'What is waiting to start, and why: after what, until when, held by what, or paused. Work held because agents at work have already changed the files it was planned around says so, and says which files and whose. Answer questions about queued work with this, not from memory.',
    object({}),
    () => rpc('queue/list', {}),
  )

  tool(
    'tade_queue_change',
    "Change queued work or a schedule, as the human asked. For queued work: start it now whatever it waits on, pause or resume it, wait again past what held it, remove it, or put it in an order (change: order, with order: the tasks first to last) — an order is only a preference among work that is already ready, and never jumps a wait, unholds a hold or starts anything. Name no task to pause or resume a whole project's queue. For a schedule: start runs it now, and it can be paused, resumed, renamed or removed.",
    object(
      {
        change: {
          type: 'string',
          enum: ['start', 'pause', 'resume', 'wait', 'order', 'rename', 'remove'],
          description: 'what to do',
        },
        task: string('the queued task, like checkout/add-refunds'),
        schedule: string('the schedule, by the id tade_queue lists it with'),
        name: string('the new name, when renaming a schedule'),
        project: string('the project, when pausing or resuming all of its queue'),
        order: stringList(
          'for order: the queued tasks, first to last; what is left out keeps its place behind',
        ),
      },
      ['change'],
    ),
    (p) => rpc('queue/change', p),
  )

  tool(
    'tade_schedule',
    'Put work on a clock: once at a moment, or again and again — every so often, at times of day, on days of the week or month, or by cron. Each time, it starts an agent (agent: what to tell it), asks you something (ask), or looks with a watch an extension offers (watch: listed with the extension, like sentry.new-errors), which starts an agent on each new thing it finds — or tells you, with found: ask. A watch looks as often as it says unless when is given. It runs while Tade is open, and catches up once for what came due while it was closed unless told to skip. Made again under the same name, it is changed. Say back when it next runs, which this answers with.',
    object(
      {
        name: string('what it is called, in a few words'),
        project: string('project name, as configured'),
        said: string('what the human said, word for word'),
        when: object({
          at: string('once, at this moment: ISO 8601 with a time zone'),
          every: string(
            'every so often, like 30m, 2h, 1d; or day, weekday, week or month with times and on',
          ),
          times: stringList('times of day, HH:MM, for day, weekday, week or month'),
          on: {
            type: 'array',
            description: 'days: mon to sun for week, 1 to 31 for month',
            items: { type: ['string', 'number'] },
          },
          cron: string('for anything else: minute hour day-of-month month day-of-week'),
          count: { type: 'number', description: 'stop after this many runs' },
          until: string('stop after this moment: ISO 8601'),
          tz: string('an IANA time zone, like Europe/Sarajevo; the machine’s own when not said'),
        }),
        agent: string('start an agent each time, told this'),
        ask: string('ask you this each time, instead of starting an agent'),
        watch: string("look with this extension's watch each time, like sentry.new-errors"),
        input: {
          type: 'object',
          description: 'what the watch is turned on with, when it takes anything',
        },
        found: {
          type: 'string',
          enum: ['agent', 'ask'],
          description:
            'what each new thing a watch finds becomes: an agent on it (the default), or a question for you',
        },
        most: {
          type: 'number',
          description:
            'at most this many new things one look acts on; the rest wait for the next (2 unless said)',
        },
        done,
        missed: {
          type: 'string',
          enum: ['once', 'skip'],
          description:
            'what happens to runs that came due while Tade was closed: once (the default) or skip',
        },
      },
      ['name', 'project', 'said'],
    ),
    (p) => rpc('queue/schedule', p),
  )

  // Tade's extensions: listed when Tade started this orchestrator, run by
  // Tade, which is where their settings, secrets and window are.
  for (const spec of extensionTools()) {
    tool(
      spec.name,
      spec.description,
      spec.parameters,
      (p, callId) => rpc('extension/call', { tool: spec.name, input: p, callId }),
      spec.label,
    )
  }

  tool(
    'tade_run_start',
    'Start an agent working on an existing task. The prompt is what the agent is told first; files the human attached to what you are answering go with it. When they named a model for the work ("use opus"), pass it here so the agent starts on it: Tade finds it before anything starts, and when it cannot tell which model they meant nothing starts and it says what to ask them.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        prompt: string('what to tell the agent first'),
        model: string(
          'the model to start it on, as the human said it: "opus", "kimi k2.6". Only when they named one.',
        ),
      },
      ['task'],
    ),
    async (p) => {
      const task = String(p.task)
      const worktree = await worktreeOf(task)
      if (!worktree) throw new Error(`no such task: ${task}`)
      return rpc('worker/start', {
        task,
        cwd: worktree,
        prompt: String(p.prompt ?? ''),
        ...(p.model ? { model: String(p.model) } : {}),
      })
    },
  )

  tool(
    'tade_agent_model',
    'Switch the model an agent is running on: "switch refunds to opus 5", "use kimi in agent-1". New agents start on it from then on, until another is chosen; agents already working keep their own. Say the model the way the human did; Tade finds it among the models they are signed in to, and says which it means when more than one fits. The agent must be running: to start one on a model, give the model to tade_run_start instead.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        model: string('the model as the human said it: "opus 5", "claude-sonnet-5", "kimi k2.6"'),
      },
      ['task', 'model'],
    ),
    async (p) => {
      const chosen = (await rpc('worker/model', {
        task: String(p.task),
        model: String(p.model),
      })) as {
        provider?: string
        id?: string
      }
      return `${String(p.task)} is switching to ${chosen.provider ? `${chosen.provider}/` : ''}${chosen.id ?? String(p.model)}.`
    },
  )

  tool(
    'tade_agent_thinking',
    'Set how hard an agent thinks before it answers — off, minimal, low, medium, high, xhigh or max — from its next turn: "think harder on refunds", "less thinking for agent-1". New agents think that hard too, until another level is chosen. A model that cannot think that hard takes the most it can. The agent must be running.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        level: string('off, minimal, low, medium, high, xhigh or max'),
      },
      ['task', 'level'],
    ),
    async (p) => {
      const done = (await rpc('worker/thinking', {
        task: String(p.task),
        level: String(p.level),
      })) as { level: string }
      return `${String(p.task)} thinks at ${done.level} from its next turn, and new agents will too.`
    },
  )

  tool(
    'tade_agent_harness',
    'Run an agent in another harness — the program that is the agent: pi, or Claude Code on the account it is signed in to — from its next start on; a running agent is started again in it, and a conversation does not move between harnesses. Only when the human asks. Tade says which harnesses exist and which it can run yet.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        harness: string('the harness id: pi or claude-code'),
      },
      ['task', 'harness'],
    ),
    async (p) => {
      const task = String(p.task)
      const worktree = await worktreeOf(task)
      if (!worktree) throw new Error(`no such task: ${task}`)
      const done = (await rpc('worker/harness', {
        task,
        worktree,
        harness: String(p.harness),
      })) as { harness: string; restarted: boolean }
      return `${task} runs in ${done.harness}${done.restarted ? ', started again there' : ' from its next start'}.`
    },
  )

  tool(
    'tade_orchestrator_model',
    'Switch the model you — the orchestrator — think with: "use opus 5 yourself", "change your model to sonnet". Say the model the way the human did. It takes effect from your next reply and is kept for the next time Tade starts. For an agent\'s model use tade_agent_model; for "both", call each.',
    object({ model: string('the model as the human said it') }, ['model']),
    async (p, _id, ctx) => {
      const chosen = (await rpc('orchestrator/model', { model: String(p.model) })) as {
        provider: string
        id: string
      }
      const said = await opts.switchModel?.(chosen, ctx)
      return (
        said ??
        `The orchestrator is kept on ${chosen.provider}/${chosen.id}, and starts again on it: the same conversation, from its next reply.`
      )
    },
  )

  tool(
    'tade_agent_rename',
    'Give an agent a name: what its work is called, shown in the window and in its own session. Only when the human asks to rename it. A name they give is never replaced by one Tade would have chosen.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        name: string('the new name, as they said it'),
      },
      ['task', 'name'],
    ),
    async (p) => {
      const task = String(p.task)
      const worktree = await worktreeOf(task)
      if (!worktree) throw new Error(`no such task: ${task}`)
      const title = await rpc('task/rename', { task, worktree, title: String(p.name) })
      return `${task} is now called ${String(title)}.`
    },
  )

  tool(
    'tade_run_list',
    'The agents working right now, and the task each is on. One agent per task at most.',
    object({}),
    () => rpc('worker/list', {}),
  )

  tool(
    'tade_steer',
    'Tell the agent working on a task something, without stopping it.',
    object({ task: string('task id, like checkout/refunds'), message: string('what to tell it') }, [
      'task',
      'message',
    ]),
    (p) => rpc('worker/steer', { task: String(p.task), message: String(p.message) }),
  )

  tool(
    'tade_run_stop',
    'Stop the agent working on a task. The task and its worktree stay; only the agent ends.',
    object({ task: string('task id, like checkout/refunds') }, ['task']),
    (p) => rpc('worker/stop', { task: String(p.task) }),
  )

  tool(
    'tade_run_cleanup',
    'Stop agents that match a state filter: idle (not actively working), done (ready to merge, in review state), failed, or all (any non-working agent). Use when the human asks to clean up finished or failed agents.',
    object({ filter: string('which agents to stop: idle, done, failed, or all') }, ['filter']),
    async (p) => {
      const filter = String(p.filter).toLowerCase()
      const status = JSON.parse(await runCli(['status', '--json'])) as {
        projects: Array<{ tasks: Array<{ id: string; state: string }> }>
      }
      const toStop: string[] = []
      for (const project of status.projects) {
        for (const task of project.tasks) {
          const matches =
            filter === 'all'
              ? task.state !== 'working'
              : filter === 'idle'
                ? task.state !== 'working'
                : filter === 'done'
                  ? task.state === 'review'
                  : filter === 'failed'
                    ? task.state === 'failed'
                    : false
          if (matches) toStop.push(task.id)
        }
      }
      const stopped: string[] = []
      for (const task of toStop) {
        try {
          await rpc('worker/stop', { task })
          stopped.push(task)
        } catch {
          // skip ones that could not be stopped
        }
      }
      return stopped.length === 0
        ? `No agents matched filter "${filter}"`
        : `Stopped ${stopped.length} agent${stopped.length === 1 ? '' : 's'}: ${stopped.join(', ')}`
    },
  )

  for (const [name, parked, what] of [
    [
      'tade_park',
      true,
      'Set a task aside. Nothing is lost: the worktree stays and it can be picked back up.',
    ],
    ['tade_resume', false, 'Pick a parked task back up, so it counts as work again.'],
  ] as const) {
    tool(
      name,
      what,
      object({ task: string('task id, like checkout/refunds') }, ['task']),
      async (p) => {
        const task = String(p.task)
        const worktree = await worktreeOf(task)
        if (!worktree) throw new Error(`no such task: ${task}`)
        return rpc('task/park', { worktree, parked, task })
      },
    )
  }

  tool(
    'tade_remember',
    'Write down something the human told you, in their words. Scope it to a task or project when it is about one; leave it off when it is about everything.',
    object(
      {
        text: string('exactly what they said, never a tidier version of it'),
        about: string('task or project it is about, if any'),
      },
      ['text'],
    ),
    (p) =>
      rpc('memory/remember', {
        text: String(p.text),
        scope: p.about ? String(p.about) : null,
        by: 'orchestrator',
      }),
  )

  tool(
    'tade_propose_skill',
    'Write down a lesson about working here — something you noticed that would have helped you earlier. It is saved as a proposal and does nothing until a human reads it and activates it. Propose one only when you have actually learned something, not to be helpful.',
    object(
      {
        name: string('short name, lowercase with dashes'),
        text: string('the lesson, in markdown, in your own words'),
        about: string(
          'the project or task it is about, like checkout or checkout/refunds. Leave it off only when the lesson is about working here in general: a lesson scoped to something stops being mentioned once that thing goes quiet, and an unscoped one is repeated forever.',
        ),
      },
      ['name', 'text'],
    ),
    async (p) => {
      const name = String(p.name)
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
        throw new Error(`${name} is not a usable name: lowercase letters, digits and dashes`)
      }
      const about = p.about ? String(p.about).trim().toLowerCase() : ''
      const dir = join(skillsRoot(), 'proposed')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${name}.md`)
      // The subject goes on its own line at the top, which is where it is read
      // back from: a lesson is written by a model and reviewed by a human, so
      // the file has to stay something a person can read.
      const header = about ? `about: ${about}\n\n` : ''
      await writeFile(path, `${header}${String(p.text).trim()}\n`)
      return `Proposed ${name}. It is not in use: a human activates it with \`tade skills activate ${name}\` after reading ${path}.`
    },
  )

  // Terminals: shells along the bottom of the window that belong to a project.
  // The human sees everything typed into one, as it is typed.
  const terminal = string(
    'which terminal: its name ("tests"), its number, or its id; leave it out when there is only one',
  )
  const inProject = string('project name, as configured, when it is not obvious')

  tool(
    'tade_terminal_list',
    'The terminals open along the bottom of the window, with their names, projects and folders.',
    object({ project: inProject }),
    (p) => rpc('terminal/list', p.project ? { project: String(p.project) } : {}),
  )

  tool(
    'tade_terminal_open',
    "Open a terminal: a shell in the project's folder, or in the folder given (an agent's worktree, say). It appears along the bottom of the window.",
    object(
      {
        project: string('project name, as configured'),
        name: string('what to call it, like "tests" or "server"'),
        cwd: string('folder to start in, when not the project itself'),
      },
      ['project'],
    ),
    (p) => rpc('terminal/open', p),
  )

  tool(
    'tade_terminal_run',
    'Run a command in a terminal, exactly as if the human typed it and pressed enter. They see it happen. Read the terminal afterwards to see what it printed.',
    object(
      {
        terminal,
        command: string('the command line, exactly'),
        submit: { type: 'boolean', description: 'false to type it without running it' },
        project: inProject,
      },
      ['command'],
    ),
    (p) => rpc('terminal/run', p),
  )

  tool(
    'tade_terminal_read',
    'What a terminal shows, with some of its scrollback: how to see what a command printed.',
    object({
      terminal,
      lines: { type: 'number', description: 'how many lines back, 200 unless said' },
      project: inProject,
    }),
    (p) => rpc('terminal/read', p),
  )

  tool(
    'tade_terminal_search',
    "Find lines in a terminal's scrollback containing some text, any case.",
    object({ terminal, text: string('what to look for'), project: inProject }, ['text']),
    (p) => rpc('terminal/search', p),
  )

  tool(
    'tade_terminal_rename',
    'Rename a terminal, so it can be found by what it is for: "tests", "server".',
    object({ terminal, name: string('its new name'), project: inProject }, ['name']),
    (p) => rpc('terminal/rename', p),
  )

  tool(
    'tade_terminal_close',
    'Close a terminal, ending whatever is running in it. Only when the human asked for that.',
    object({ terminal, project: inProject }),
    (p) => rpc('terminal/close', p),
  )

  tool(
    'tade_logs',
    'What has happened recently, from the journal: tool calls, approvals, failures and turns. Use it to answer questions about the past rather than guessing.',
    object({
      task: string('only this task'),
      limit: { type: 'number', description: 'how many events, newest last' },
    }),
    (p) =>
      rpc('events/read', {
        ...(p.task ? { task: String(p.task) } : {}),
        limit: Number(p.limit) > 0 ? Number(p.limit) : 50,
      }),
  )

  tool(
    'tade_approvals',
    'Commands agents are waiting for permission to run.',
    object({ task: string('only this task') }),
    (p) => rpc('worker/pending', p.task ? { task: String(p.task) } : {}),
  )

  tool(
    'tade_approve',
    'Let a waiting command run. Only after the human has agreed to that exact command.',
    object({ run: string('run id'), request: string('request id') }, ['run', 'request']),
    (p) =>
      rpc('worker/decide', {
        run: String(p.run),
        requestId: String(p.request),
        decision: { allow: true },
      }),
  )

  tool(
    'tade_deny',
    'Refuse a waiting command, telling the agent why.',
    object({ run: string('run id'), request: string('request id'), reason: string('why not') }, [
      'run',
      'request',
    ]),
    (p) =>
      rpc('worker/decide', {
        run: String(p.run),
        requestId: String(p.request),
        decision: { allow: false, reason: String(p.reason ?? 'denied') },
      }),
  )
  return tools
}

/**
 * pi loads this file: the same tools, registered as pi's own, and its model
 * switched in the session it is already in.
 */
export default function tadeTools(pi: PiApi): void {
  const switchModel = async (
    chosen: { provider: string; id: string },
    ctx: ToolContext,
  ): Promise<string | null> => {
    const found = ctx.modelRegistry?.find?.(chosen.provider, chosen.id)
    if (!found || !pi.setModel) {
      throw new Error(
        `${chosen.provider}/${chosen.id} is saved for the next start, but this session could not switch to it now`,
      )
    }
    await pi.setModel(found)
    return `The orchestrator is on ${chosen.provider}/${chosen.id} from its next reply, and will start on it next time.`
  }
  for (const spec of orchestratorTools({ switchModel })) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(id, params, _signal, _update, ctx) {
        // A failure is thrown, so pi marks the call failed and the model is
        // told what went wrong in words it can choose another route from.
        const result = await spec.run(params ?? {}, id, ctx)
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        return { content: [{ type: 'text', text }], details: {} }
      },
    })
  }
}

async function worktreeOf(task: string): Promise<string | null> {
  const status = JSON.parse(await runCli(['status', '--json'])) as {
    projects: Array<{ tasks: Array<{ id: string; worktree: string }> }>
  }
  for (const project of status.projects) {
    const found = project.tasks.find((t) => t.id === task)
    if (found) return found.worktree
  }
  return null
}

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const argv = [...CLI_ARGS, ...args, '--no-pr']
    execFile(CLI, argv, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout)
    })
  })
}

/** Minimal JSON-RPC 2.0 client: one connection per call, Content-Length framed. */
function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!SOCKET) return Promise.reject(new Error('TADE_SOCKET is not set: no way back to Tade'))
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET)
    let buffer = Buffer.alloc(0)
    const fail = (err: Error) => {
      socket.destroy()
      reject(err)
    }
    socket.on('error', fail)
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), 'utf8')
      socket.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
      socket.write(body)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const split = buffer.indexOf('\r\n\r\n')
      if (split < 0) return
      const header = buffer.subarray(0, split).toString('utf8')
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0)
      const start = split + 4
      if (buffer.byteLength < start + length) return
      const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8')) as {
        result?: unknown
        error?: { message?: string }
      }
      socket.end()
      if (message.error) reject(new Error(message.error.message ?? 'Tade rejected the request'))
      else resolve(message.result ?? { ok: true })
    })
  })
}

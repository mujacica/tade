import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { configTools } from './tools-config.ts'
import { documentTools } from './tools-documents.ts'
import { type Gateable, gateTools } from './tools-gate.ts'
import { lessonTools } from './tools-lessons.ts'
import { listedTools } from './tools-listed.ts'
import { machineTools } from './tools-machine.ts'
import { noteTools } from './tools-notes.ts'
import { done, PLAN_AFTER, PLAN_CONTEXT, queueTools, stringList, TOUCHES } from './tools-queue.ts'
import { raceTools, replayTools } from './tools-race.ts'
import { ON_MACHINE, remoteTools } from './tools-remotes.ts'
import { intakeTools, templateTools } from './tools-templates.ts'

/** Where extensions live. Set by the orchestrator that launched us. */
function extensionsRoot(): string {
  const configured = process.env.TADE_EXTENSIONS
  if (configured) return configured
  return join(process.env.TADE_HOME ?? process.cwd(), 'extensions')
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
interface PiApi extends Gateable {
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
    'Where everything stands: every task, in every project, with its state, why, and the effort it belongs to when it is one repository\'s share of a change that spans several — so "how far is oauth-scopes" is these tasks counted, never something remembered. Derived fresh from git, running agents and provider transcripts. Use this for any question about what is happening. With `machine`, the same for another machine this one is linked to, as it last said — its agents, checks, findings, requests, schedules, plans, problems, the Tade it runs and its public name — and as of when, where its link is down.',
    object({ machine: ON_MACHINE }),
    // From the window when there is one: only it knows which agents are between
    // turns, and the CLI would call every one of them working.
    async (p) => {
      if (typeof p.machine === 'string' && p.machine !== '') return rpc('remote/status', p)
      const seen = await rpc('status/read', {}).catch(() => null)
      return seen === null ? runCli(['status', '--json']) : JSON.stringify(seen, null, 2)
    },
  )

  tool(
    'tade_limits',
    'Where every sign-in stands against its plan: each account of each harness, how much of each rolling window it has used, what is left of it and when it starts over \u2014 with the ones at their limit named, and what else there is to run as. Use it when somebody asks whether they are about to run out, when an agent has stopped or slowed and a plan could be the reason, and before telling somebody they can keep working. Each says whether new agents run as it, and which projects name it as theirs. Say what you would move to \u2014 another account of the same harness, another harness, or an API key rather than a subscription \u2014 and move new agents to another account only when the person asked for it in their own words, with tade_setting_change on that harness\u2019s account row (`workers.accounts.<harness>`, or `projects.<name>.accounts.<harness>` for one project): an agent already working stays where it is unless they ask for it to be moved, which is tade_agent_account, and which one you yourself run as is `orchestrator.account`, the same way. Adding, removing or signing in an account is never yours. A sign-in that reports nothing has not reported nothing used: the harnesses that only hear about a plan while one of their agents is working say so in their own words, and that reads as cannot tell, never as zero. None of it is money \u2014 a subscription has no price per turn \u2014 so never add a plan to what anything cost.',
    object({}),
    // From the window: only the process holding the harnesses knows what each
    // last said, and nothing asks anybody on the way.
    async () => rpc('plan/limits', {}),
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
  // Not how it is done: a context saying "No push/deploy." silently beat branch-and-review.
  const context = string(
    'what the agent should know before it starts, in markdown: what you found, where to look, what done looks like. Written to a file of its own in Tade’s home, and the agent is told where. Say what the work is, never how an agent is to work: where it works, when it commits and whether finished work is pushed are the project’s own settings, already in what the agent is told, and a line here like “no push” contradicts them rather than changing them — set the setting (tade_project_configure) or say nothing.',
  )
  const links = {
    type: 'array',
    description: 'where the work came from: an issue, a trace, a discussion',
    items: object({ title: string('what it is'), url: string('where it is') }, ['title', 'url']),
  }
  // What a task made to plan, audit or research says about itself. A name, not
  // a path: the document is kept in Tade's home past its task, so no project
  // carries it and nothing commits it, and Tade hands over the whole path the
  // moment the task finishes — which is the only thing the repository was ever
  // buying. The last sentence is the other half: a README really is the
  // project's, and this field is not how one gets written.
  const produces = string(
    'for an agent that writes something up rather than changing code — a plan, an audit, an analysis: the name of the file it writes. Tade keeps it in the project’s documents folder in its home, never in the repository and never committed, and it outlives the task. Tade tells you when the task finishes, with the full path, so you read it and decide what follows. A file that belongs to the project itself — a README, a changelog — is an ordinary change and not this.',
  )

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
        produces,
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
        ...(p.produces ? { produces: String(p.produces) } : {}),
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

  tool(
    'tade_plan',
    "Start several changes as one plan: agents that can work at the same time start now, and the rest wait in Tade's queue until what they wait on has finished, then start by themselves. A plan may span repositories — give an agent its own project and it works there, and a wait may name a task in another project, which waits for it to finish and then starts from its own repository's base. The plan's own project is the default for a plan that is all one repository, and an agent that names none is put there: so when the work spans two, give every agent its own project, including the ones in the plan's. A plan where one agent names another repository and another names none is refused. When the whole plan is one change, give it an effort: a short name, which every task it makes carries, so \"two of three repos done\" is one question later. Before calling it, read the code to see what each change will touch. In a project whose agents share one checkout, never let two agents that change the same files run at once: make one wait on the other. Small changes to the same place are one agent. Give every wait a reason, and choose how each agent counts as finished. What every agent should know goes once, in context, and each prompt says only what is its own: a placeholder left in two prompts that nobody said (PAGE_BRIEF, {{brief}}, TODO) is refused. Nothing is made if the plan cannot be kept: every name, wait, project, done rule and prompt is checked before anything is, a name against every task Tade has ever had, and the answer gives every reason at once, with a free name for each one used before. Should making stop after that, on a disk or git error, the answer names what was made, which stays queued, and what was not. To change when work already queued starts, use tade_queue_change after: never remove it and plan it again, which uses its name up for good and holds everything waiting on it.",
    object(
      {
        project: string(
          'project name, as configured: where an agent that names no project of its own is put, which is the default for a plan that is all one repository',
        ),
        said: string('the whole request, word for word'),
        effort: string(
          'what to call this one change, lowercase with dashes, when the whole plan is one change across repositories or one of several streams in a repository',
        ),
        context: string(PLAN_CONTEXT),
        agents: {
          type: 'array',
          description: 'one entry per agent, in any order',
          items: object(
            {
              name: string('its task name, lowercase with dashes'),
              project: string(
                'the repository it works in; required of every agent in a plan that spans more than one, the plan’s own included',
              ),
              said: string('the words of the request this agent covers, word for word'),
              prompt: string('what to tell the agent first'),
              done,
              produces,
              after: PLAN_AFTER,
              touches: stringList(TOUCHES),
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

  // Changing work already queued, and work on a clock: its own file, `tools-queue.ts`.
  for (const spec of queueTools(rpc)) tools.push(spec)

  // Tade's extensions, and another machine's where a tool only reads: `tools-listed.ts`.
  for (const spec of listedTools(rpc)) tools.push(spec)

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
    'Switch the model one running agent is on: "switch refunds to opus 5", "use kimi in agent-1". That agent alone: new agents keep the project\'s default, and the default is a setting — what new agents start on is changed with tade_setting_change, on their words naming it, never by switching an agent. Say the model the way the human did; Tade finds it among the models they are signed in to, and says which it means when more than one fits. The agent must be running: to start one on a model, give the model to tade_run_start instead.',
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
      })) as { provider?: string; id?: string }
      return `${String(p.task)} is switching to ${chosen.provider ? `${chosen.provider}/` : ''}${chosen.id ?? String(p.model)}. ${alone('model')}`
    },
  )

  tool(
    'tade_agent_thinking',
    'Set how hard one running agent thinks before it answers — off, minimal, low, medium, high, xhigh or max — from its next turn: "think harder on refunds", "less thinking for agent-1". That agent alone: new agents keep the project\'s default, and the default is a setting — how hard new agents think is changed with tade_setting_change, on their words naming it. A model that cannot think that hard takes the most it can. The agent must be running.',
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
      return `${String(p.task)} thinks at ${done.level} from its next turn. ${alone('thinking')}`
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
    'tade_agent_account',
    'Run one agent as another account of its harness — "move refunds to the work account", "put agent-1 back on my own sign-in" — so it goes on where a plan has run out. Only when the human asks. Its conversation goes with it where its harness can carry it, and a running agent is started again there. That agent alone: which account new agents run as is a setting (`workers.accounts.<harness>`, or `projects.<name>.accounts.<harness>` for one project), and which one you yourself run as is `orchestrator.account` — each changed with tade_setting_change, on their words naming it. tade_limits says which accounts there are and how much of each plan is left.',
    object(
      {
        task: string('task id, like checkout/refunds'),
        account: string(
          'the account\'s name, or "default" — or the name it was given, as tade_limits labels it — for its harness\'s own sign-in',
        ),
      },
      ['task', 'account'],
    ),
    async (p) => {
      const task = String(p.task)
      const worktree = await worktreeOf(task)
      if (!worktree) throw new Error(`no such task: ${task}`)
      const done = (await rpc('worker/account', {
        task,
        worktree,
        account: String(p.account),
      })) as {
        account: string | null
        restarted: boolean
        carried: boolean
        ownName?: string | null
      }
      return `${task} runs as ${done.account ?? done.ownName ?? 'its own sign-in'}${done.carried ? ', its conversation with it' : ''}${done.restarted ? ', started again there' : ' from its next start'}. Only it: new agents keep the account their project names, which is a setting.`
    },
  )

  tool(
    'tade_orchestrator_model',
    'Switch the model you — the orchestrator — think with: "change your model to sonnet", "use opus 5 as your model". Refused unless a line of theirs names your model — "your model", "the orchestrator\'s model" — so where they did not, ask them plainly first. Say the model the way the human did, and pass their sentence as `said`: it is written down beside the change. Only among the provider you are on: a model of another provider is refused, because where your own conversation is sent is a person\'s to move, in Settings (ctrl+,) or on your tab\'s model picker. It takes effect from your next reply and is kept for the next time Tade starts. For an agent\'s model use tade_agent_model; for "both", call each.',
    object(
      {
        model: string('the model as the human said it'),
        said: string('what the person said that asked for this, word for word'),
      },
      ['model', 'said'],
    ),
    async (p, _id, ctx) => {
      const chosen = (await rpc('orchestrator/model', {
        model: String(p.model),
        said: String(p.said ?? ''),
      })) as {
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
    'The agents working right now, and the task each is on. One agent per task at most. Each comes with the harness it runs in and the session it is talking in — which is what says where its own words are kept, since the journal has what was decided and never what was said.',
    object({}),
    () => rpc('worker/list', {}),
  )

  tool(
    'tade_steer',
    'Tell the agent working on a task something, without stopping it. It is for an agent that is running: queued work has no agent yet, so what it will be told when it starts is changed with tade_queue_change retell.',
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
        if (!(await worktreeOf(task))) throw new Error(`no such task: ${task}`)
        return rpc('task/park', { parked, task })
      },
    )
  }

  // Chats: an agent in the lower pane with no task and no project, for a
  // question about this machine or something that is nobody's repository.
  // There is no `tade_chat_steer` or `tade_chat_stop`: a chat is an agent, so
  // it is steered and stopped by the tools that steer and stop agents, by the
  // task id these two hand back.

  tool(
    'tade_chat_list',
    'The chats in the lower pane: agents with no task and no project. `open` are running, each with the id that steers and stops it (tade_steer, tade_run_stop), what it is called on its tab, the harness it runs in and the folder it is standing in. `closed` are chats that were closed whose harness still keeps the conversation, with when each closed and the first thing said in it: tade_chat_reopen brings one back.',
    object({}),
    () => rpc('chat/list', {}),
  )

  tool(
    'tade_chat_reopen',
    "Bring back a chat that was closed — by accident, or wanted again — in its own tab, carrying on the same conversation: the same number, harness and folder. Use it when somebody asks for a chat they closed back, rather than opening a new one, which would start the conversation over. Name it by its id from tade_chat_list's `closed`, like chats/5. Nothing is said to it. Whatever it had running in the background when it closed — a subagent, a background shell — ended with it: say so, and never say it is still running. Refused, with why, for a harness that cannot come back to a conversation or no longer keeps this one.",
    object({ chat: string('the closed chat, like chats/5') }, ['chat']),
    (p) => rpc('chat/reopen', p),
  )

  tool(
    'tade_chat_open',
    'Open a chat: an agent in the lower pane with no task, no project, no branch and nothing to commit — for asking about this machine, or researching something that is nobody\'s repository. Use it when somebody wants an agent to talk to rather than work done: "give me an agent", "open me a claude", "I just want to ask something". Not for work on a project — that is a task with an agent in it (tade_task_create, tade_run_start) — and not instead of a terminal, which runs commands rather than answering. It starts in their home folder unless you say otherwise, and it costs money like any other agent: say which harness you opened and that stopping it is tade_run_stop with the id it comes back with.',
    object({
      harness: string('which agent to talk to: pi, claude-code or codex. The default unless said'),
      prompt: string('what to ask it first, in their words. Leave it out to just open one'),
      cwd: string(
        'a folder for it to look at, when they named one. Work on a project is a task with an agent in it, never a chat standing in its checkout',
      ),
    }),
    (p) => rpc('chat/open', p),
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
    "What has happened recently, from the journal: tool calls, approvals, failures and turns. Use it to answer questions about the past rather than guessing. It is what was decided, never what was said: an agent's own words are not in it, and what it printed is counted there in bytes.",
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

  // Tade configuring itself, and the work it runs. Each in a file of its own
  // because what it may touch is a boundary, worth reading in one place.
  const groups = [configTools, documentTools, lessonTools, templateTools, raceTools, replayTools]
  for (const group of [...groups, intakeTools, remoteTools]) tools.push(...group(rpc))
  tools.push(...machineTools(rpc, runTade), ...noteTools(rpc, runTade))

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
  gateTools(pi, rpc)
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

/**
 * Said after switching one agent, because "and new agents too?" is the next
 * question: they keep the project's default, which is a setting of its own.
 */
function alone(what: 'model' | 'thinking'): string {
  return `Only it: new agents keep the project's default ${what}, which is a setting — tade_settings says what it is.`
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

/** The CLI, with exactly the arguments given: for a command `status`'s flags are not its own. */
function runTade(args: string[]): Promise<string> {
  // `spawn`, in a group of its own like all Tade starts: `execFile` drops `detached`.
  const child = spawn(CLI, [...CLI_ARGS, ...args], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8'))
      reject(new Error(Buffer.concat(err).toString('utf8').trim() || `${CLI} exited ${code}`))
    })
  })
}

function runCli(args: string[]): Promise<string> {
  return runTade([...args, '--no-pr'])
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

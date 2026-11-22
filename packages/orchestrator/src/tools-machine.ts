import type { OrchestratorTool } from './tools-extension.ts'

// Keeping what Tade runs current, and starting the window again on a new Tade:
// what is out of date, running the updates, and the reload that follows one.
// And what each of the person's machines has, and moving this one's keys into
// one file (`ENV_MOVE_REACH`): the other act here that changes the machine
// itself, on the person's word.
//
// Beside `tools-extension.ts` rather than in it, for `tools-config.ts`'s two
// reasons: that file is at its budget, and these are the tools that install
// software on this machine and end the window the orchestrator runs in — a
// boundary worth reading in one place. The boundary itself is `UPDATE_REACH`
// and `RELOAD_REACH` in core, enforced in the window; what is here is the half a
// model reads, with every limit in the words of its refusal.
//
// Like everything pi loads, this file imports nothing from the Tade workspace:
// `rpc` and `runTade` are handed in.

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

/** The person's own words, which both acts here are checked against. */
const said = string(
  'what the person said that asked for this, word for word. Tade checks it against what they actually said, so pass their sentence and never your own summary of it',
)

export function machineTools(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  runTade: (args: string[]) => Promise<string>,
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
    'tade_updates',
    'What Tade runs and whether it is current: every program it shells out to — the harnesses, the driver, git, gh — with which version is installed, how it was installed, and what to run to move it forward, plus whether there is a newer Tade. From the window it also says the run going now, what the last run updated (`lastRun`), and whether Tade itself moved and the window is owed a reload (`reloadOwed`). Use it when asked whether anything is out of date, or what an update did. `check` asks the registries, which reaches the network and takes a few seconds; without it this is the last answer the window kept, or only what is installed here. It installs nothing: tade_updates_run does, when they ask.',
    object({
      check: { type: 'boolean', description: 'also ask what is current (reaches the network)' },
    }),
    async (p) => {
      // From the window when there is one: only it knows what it ran.
      const read = await rpc('updates/read', { check: p.check === true }).catch(() => null)
      return typeof read === 'string'
        ? read
        : runTade(['update', '--json', ...(p.check === true ? ['--check'] : [])])
    },
  )

  tool(
    'tade_updates_run',
    'Update what Tade runs, when the person asks you to — "update Tade", "upgrade gh", "install the updates". It is the same run as the strip’s updates chip and Settings › Updates: each exact command Tade read off how that program got here is typed into the `updates` terminal, put in front of them, and how it ended is read back. You choose which, never what: `which` names programs by their command or title, or `tade`, and nothing named is everything the last check said is behind. Refused unless they asked for an update in their own words — pass their sentence in `said` — and refused while a run is going. It waits up to a minute; a longer run says it is still going: what it comes to is said in the conversation when it ends, and reaches you with the next thing they say, or ask tade_updates (`lastRun`). Never type an install command into a terminal yourself. Where Tade itself moved, the window runs the old one until it reloads, and offers to: tade_reload does it once they say so.',
    object(
      {
        which: {
          type: 'array',
          items: { type: 'string' },
          description:
            'what to update: `tade`, or a program by its command (`gh`, `claude`) or title. Empty or left out: everything behind',
        },
        said,
      },
      ['said'],
    ),
    async (p) =>
      rpc('updates/run', {
        which: Array.isArray(p.which) ? p.which.map((one) => String(one)) : [],
        said: String(p.said ?? ''),
      }),
  )

  tool(
    'tade_reload',
    'Start the window again, on the Tade that is on disk now — after Tade itself was updated, when they ask for it ("reload", "restart Tade"). Agents keep working where the driver’s lanes outlive the window; where they would stop, the reload panel asks them instead and the press is theirs. Your conversation carries on in the new window: it is the same conversation, and you are not introduced again, but the turn this is called in ends with the window. Refused unless they asked for a reload in their own words — pass their sentence in `said`. Say what you are doing before you call it.',
    object({ said }, ['said']),
    async (p) => rpc('window/reload', { said: String(p.said ?? '') }),
  )

  tool(
    'tade_machines',
    'What each of the person’s machines has, by name and never by value: every harness sign-in and the days it has left, every key Tade’s extensions and accounts use and where it comes from, every environment key their shell files, the service unit or launchd set — by file and line — MCP servers, the git identity, `gh`, whether origin answers with that machine’s own credentials, per-machine apps and the public name; for this machine and each one it links to or that told it, with what each lacks against this one (`✗`), holds differently (`≠`), or could not say (`?`). The same as Settings › Machines. Use it when they ask what a machine is missing, why something works here and not on the VPS, where a key is set, or whether `tade serve` sees a key. Keys are compared by digest: you never see one, and never ask for one.',
    object({}),
    async () => {
      // From the window when there is one; where there is none, from a shell,
      // saying why the window could not answer if that cannot either.
      const read = await rpc('machines/read', {}).catch((err: unknown) => ({ unread: String(err) }))
      if (typeof read === 'string') return read
      return runTade(['machine', '--json']).catch((err: unknown) => {
        throw new Error(
          `${(read as { unread?: string }).unread ?? 'the window did not answer'}; and \`tade machine\` could not either: ${String(err)}`,
        )
      })
    },
  )

  tool(
    'tade_env_move',
    'Move the keys the person’s shell files set (`~/.zshenv`, `~/.zshrc`, `~/.bashrc`, `~/.profile`…) into one file, `~/.config/tade/env` (0600), which their login shell and `tade serve` both read — so a key that works in their terminal is also one the service has. Without `move` it changes nothing and answers the diff, every value hidden, and which keys stay where they are and why: say that to them first. With `move` it does it: each file is copied beside itself, a fresh login shell is asked which variables it sets before and after, and every file is put back byte for byte if anything differs — the answer says which happened. Refused unless they asked for it in their own words — pass their sentence in `said`. Never edit a shell file yourself, and never read one aloud: it holds their keys.',
    object(
      {
        move: { type: 'boolean', description: 'do it; left out, only say what it would do' },
        said,
      },
      ['said'],
    ),
    async (p) => rpc('machines/env-move', { said: String(p.said ?? ''), move: p.move === true }),
  )

  return tools
}

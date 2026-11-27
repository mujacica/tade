// The `ToolHost` methods that reach another machine: passing a sentence to its
// orchestrator and moving work to it (`tools-remotes.ts`), and what the reading tools answer when
// they name it — its status, its documents, the requests handed to it, and one
// of its extension tools that only reads (`machine` on `tade_status`,
// `tade_documents`, `tade_intake`, `tade_intake_show` and every extension tool
// that `reads`). All of it over this machine's owner session there, held by the
// window's link to it. Their own file because `tool-host.ts` is at its budget,
// and because they are the methods that reach another machine.
//
// **The window's, like the config.** The link is the window's (`Remotes`), and
// the check that a line of the person's names that machine
// (`REMOTE_TELL_REACH`) is made there against the journal — never here, where
// the model's call lands. What is made here, before the window is asked at
// all, is the gate every method has: under a narrowed turn each of these is
// `local` (`origin.ts`), because the session it uses is an owner's and the arm
// of that turn is not — passing its words on through it would launder them
// into the keyboard's reach on that machine.

type Handler = (params: Record<string, unknown>) => Promise<string>

/** What the window answers for it. Without a window, there is no link to pass anything over. */
export interface RemoteHost {
  tell(req: { machine: string; said: string; asked: string }): Promise<string>
  /** Work moved to it: queued work started there instead of here (`tade_task_move`). */
  move(req: { task: string; machine: string; asked: string }): Promise<string>
  /** What one machine last said of itself and its work, as of when: `tade_status` there. */
  status(machine: string): Promise<string>
  /** Its documents, or — with a task and a name — one read into a copy here, by its path. */
  documents(req: { machine: string; task?: string; name?: string }): Promise<string>
  /** The requests handed to it, or one of them by its item. */
  intake(req: {
    machine: string
    project?: string
    waiting?: boolean
    item?: string
  }): Promise<string>
  /** One of its extension tools that only reads, run there with its own settings. */
  tool(req: { machine: string; tool: string; input: Record<string, unknown> }): Promise<string>
}

/**
 * One of the orchestrator's own tool calls run on another machine of the
 * person's, through that machine's own gate (`tade_remote_act`): the
 * window's or the heart's (`acts.ts`), since a machine with no screen acts on
 * the ones that link to it too.
 */
export interface ActHost {
  act(req: {
    machine: string
    asked: string
    key: string
    method: string
    params: Record<string, unknown>
  }): Promise<unknown>
}

/** A string parameter where one was given, or nothing: never `"undefined"`. */
const given = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** `remote/act`: one method of this host's, asked of another machine instead (`tade_remote_act`). */
export function actMethods(host: () => ActHost | undefined): Record<string, Handler> {
  return {
    'remote/act': async (p) => {
      const found = host()
      if (!found) throw new Error('nothing here acts on another machine')
      const params =
        typeof p.params === 'object' && p.params !== null && !Array.isArray(p.params)
          ? (p.params as Record<string, unknown>)
          : {}
      const result = await found.act({
        machine: String(p.machine ?? ''),
        asked: String(p.asked ?? ''),
        key: String(p.key ?? ''),
        method: String(p.method ?? ''),
        params,
      })
      return typeof result === 'string' ? result : JSON.stringify(result)
    },
  }
}

export function remoteMethods(host: () => RemoteHost | undefined): Record<string, Handler> {
  const window = (): RemoteHost => {
    const found = host()
    if (!found) throw new Error('other machines are linked by the window, and no window is open')
    return found
  }
  return {
    'remote/tell': async (p) =>
      window().tell({
        machine: String(p.machine ?? ''),
        said: String(p.said ?? ''),
        asked: String(p.asked ?? ''),
      }),
    'remote/move': async (p) =>
      window().move({
        task: String(p.task ?? ''),
        machine: String(p.machine ?? ''),
        asked: String(p.asked ?? ''),
      }),
    'remote/status': async (p) => window().status(String(p.machine ?? '')),
    'remote/documents': async (p) => {
      const task = given(p.task)
      const name = given(p.name)
      return window().documents({
        machine: String(p.machine ?? ''),
        ...(task === undefined ? {} : { task }),
        ...(name === undefined ? {} : { name }),
      })
    },
    'remote/intake': async (p) => {
      const project = given(p.project)
      const item = given(p.item)
      return window().intake({
        machine: String(p.machine ?? ''),
        ...(project === undefined ? {} : { project }),
        ...(p.waiting === true ? { waiting: true } : {}),
        ...(item === undefined ? {} : { item }),
      })
    },
    'remote/tool': async (p) =>
      window().tool({
        machine: String(p.machine ?? ''),
        tool: String(p.tool ?? ''),
        input:
          typeof p.input === 'object' && p.input !== null && !Array.isArray(p.input)
            ? (p.input as Record<string, unknown>)
            : {},
      }),
  }
}

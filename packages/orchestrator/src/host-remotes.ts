// The `ToolHost` method behind passing a sentence to another machine's
// orchestrator (`tools-remotes.ts`): this machine's owner session there, held
// by the window's link to it. Its own file because `tool-host.ts` is at its
// budget, and because it is the one method that reaches another machine.
//
// **The window's, like the config.** The link is the window's (`Remotes`), and
// the check that a line of the person's names that machine
// (`REMOTE_TELL_REACH`) is made there against the journal — never here, where
// the model's call lands. What is made here, before the window is asked at
// all, is the gate every method has: under a paired device's turn this one is
// `local` (`origin.ts`), because the session it uses is an owner's and the
// arm of the turn that calls it is not, and passing a phone's words on through
// it would launder them into the keyboard's reach on that machine.

type Handler = (params: Record<string, unknown>) => Promise<string>

/** What the window answers for it. Without a window, there is no link to pass anything over. */
export interface RemoteHost {
  tell(req: { machine: string; said: string; asked: string }): Promise<string>
}

export function remoteMethods(host: () => RemoteHost | undefined): Record<string, Handler> {
  return {
    'remote/tell': async (p) => {
      const found = host()
      if (!found) throw new Error('other machines are linked by the window, and no window is open')
      return found.tell({
        machine: String(p.machine ?? ''),
        said: String(p.said ?? ''),
        asked: String(p.asked ?? ''),
      })
    },
  }
}

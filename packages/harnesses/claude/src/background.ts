// What a Claude Code agent is told about a call to one of Tade's tools that
// runs long — appended to its instructions at every launch, so a conversation
// Tade reopens hears it too.
//
// Claude Code moves an MCP call that is still running after two minutes into
// the background (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, 120 000 unless set, and
// only in an interactive session: a headless one waits), and the answer comes
// back on its own as a task notification. `checks_run` takes minutes, so in a
// lane it is moved there nearly every time.
//
// What used to fetch the answer sooner was TaskOutput, and Claude Code 2.1.287
// no longer has it — it lists it among the tools it has retired. Agents went on
// calling it anyway, five in one afternoon and every one of them straight after
// `checks_run` was moved, and were told "No such tool available". Nothing Tade
// says had ever named it: they had it from their own history, recorded on
// 2.1.267 where it was there and they had called it after every long run, and
// a reopened conversation brings that history with it. Nor did anything Tade
// says tell them how the answer comes now. This is that sentence.
//
// Not `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, which would make the call wait
// the way it does under pi: it is Claude Code's own undocumented switch, it
// would reach every MCP server the person gave their own Claude Code, and it
// takes away the move that lets a message typed to a busy agent reach it.

/**
 * Claude Code tools that are gone. Nothing Tade tells an agent may tell it to
 * call one; the sentence below names the first only to say it is gone.
 */
export const RETIRED_TOOLS = ['TaskOutput', 'BashOutput', 'AgentOutput'] as const

/** How a long call to one of Tade's tools comes back, in Claude Code. */
export const BACKGROUNDED =
  'A call to one of Tade’s tools that is still running after two minutes — checks_run usually is — is moved to the background by Claude Code, and its answer comes to you by itself as a task notification. Nothing fetches it sooner: do not call TaskOutput for it, which current Claude Code no longer has, however often earlier turns of this conversation did. Until it comes, change nothing it is checking.'

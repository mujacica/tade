import type { RequiredProgram } from '@tade/core'

// The agents the `acp` harness is configured to drive: each one a program on
// this machine that speaks the Agent Client Protocol when started with the
// arguments below. Read from the ACP registry (github.com/agentclientprotocol/
// registry, each agent's `agent.json`, 2026-10-16) and, for Kiro CLI, which is
// not in it, from its own documentation (kiro.dev/docs/cli/acp). Grok Build's
// is its own binary's (`grok agent stdio`, Grok 1.0.92, 2026-11-25).
//
// Nothing here installs anything. Each is a `programs` declaration — what it
// is, how to see its version and where to get it — and an install command only
// where the registry names an npm package for it, or the agent's own docs do
// where the registry's is out of date (OpenCode 2); the others say where to get
// them instead, because a command that installs something else under the same
// name is worse than none. The registry's own adapters for agents Tade already
// drives natively (`claude-acp`, `codex-acp`, `pi-acp`) are not here: those
// have adapters of their own, which see more than ACP carries. Grok is here
// although it has one too (`harnesses/grok`), because its ACP is not a bridge
// somebody else wrote but the agent itself, signed in the same way: the second
// road to the same program, for whoever would rather take it.

export interface AcpAgent {
  /** Tade's name for it, the registry's id: what a model's provider says. */
  id: string
  /** What a person calls it. */
  title: string
  /** The program, as it is run. */
  command: string
  /** What makes it speak ACP on its standard input and output. */
  args: readonly string[]
  /** How it is put on a machine, as the registry distributes it. */
  install: NonNullable<RequiredProgram['install']>
}

export const ACP_AGENTS: readonly AcpAgent[] = [
  {
    id: 'gemini',
    title: 'Gemini CLI',
    command: 'gemini',
    args: ['--acp'],
    install: { npm: '@google/gemini-cli' },
  },
  {
    id: 'opencode',
    title: 'OpenCode',
    command: 'opencode',
    // OpenCode 2, whose `acp` runs a private server of its own every time and
    // never the shared background service. Its package is OpenCode's own
    // word for V2 (opencode.ai/docs, 2.4.1, 2026-11-25): the registry's
    // `opencode-ai` is V1, whose server and storage V2 replaced.
    args: ['acp'],
    install: {
      npm: '@opencode/cli',
      instead: 'opencode.ai: curl -fsSL https://opencode.ai/v2/install | bash',
    },
  },
  {
    id: 'goose',
    title: 'goose',
    command: 'goose',
    args: ['acp'],
    install: { instead: 'block.github.io/goose, or its releases on github.com/block/goose' },
  },
  {
    id: 'github-copilot-cli',
    title: 'Copilot CLI',
    command: 'copilot',
    args: ['--acp'],
    install: { npm: '@github/copilot' },
  },
  {
    id: 'kiro-cli',
    title: 'Kiro CLI',
    command: 'kiro-cli',
    args: ['acp'],
    install: { instead: 'kiro.dev/docs/cli' },
  },
  {
    id: 'cursor',
    title: 'Cursor CLI',
    command: 'cursor-agent',
    args: ['acp'],
    install: { instead: 'cursor.com/docs/cli' },
  },
  {
    id: 'qwen-code',
    title: 'Qwen Code',
    command: 'qwen',
    args: ['--acp'],
    install: { npm: '@qwen-code/qwen-code' },
  },
  {
    id: 'grok',
    title: 'Grok Build',
    command: 'grok',
    // `--no-leader`, so the agent is the lane's own child and dies with it,
    // rather than a client of a shared process that outlives the lane.
    args: ['agent', '--no-leader', 'stdio'],
    install: { instead: 'x.ai/cli: curl -fsSL https://x.ai/cli/install.sh | bash' },
  },
]

/** Each agent as a program this harness needs — any one of them, so each is optional. */
export function programsOf(agents: readonly AcpAgent[]): RequiredProgram[] {
  return agents.map((agent) => ({
    command: agent.command,
    title: agent.title,
    why: `being the agent, for a task run in the acp harness on ${agent.title}`,
    versionArgs: ['--version'],
    optional: true,
    install: agent.install,
  }))
}

/** An agent named the way a person or a config says it: its id, its title, or its program. */
export function agentNamed(agents: readonly AcpAgent[], said: string): AcpAgent | null {
  const words = said.trim().toLowerCase()
  if (!words) return null
  return (
    agents.find(
      (agent) =>
        agent.id === words || agent.title.toLowerCase() === words || agent.command === words,
    ) ?? null
  )
}

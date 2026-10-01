# Tade — **T**erminal **A**gentic **D**evelopment **E**nvironment

### Run a team of coding agents. Know exactly what each one did, and what it cost.

Plenty of things run agents in parallel. Tade is the one that keeps the books. A queue where every
piece says what it waits on and holds when that fails. The project's own checks, recorded against
the commit they ran on. Per-agent cost that never adds a subscription's turns to a dollar total. A
judge whose findings the agent has to answer and you rule on. And nothing is remembered — what each
agent *is* comes back from git and the processes every time you look, so nothing drifts and closing
Tade leaves nothing behind.

One machine, one terminal. No server, no browser, no cloud, and agents are not sandboxed — see
[Agents run as you](#agents-run-as-you).

```sh
npm install -g tade-sh   # the package is `tade-sh`; the command it installs is `tade`
tade                     # the window; the first time, a short setup that sets you up
```

Needs Node ≥ 22.19 and git; [Installing](#installing) has the rest.

![Tade: a project with nothing running, a request typed to the orchestrator, the orchestrator calling its tools, an agent at work asking for approval, and the brief](https://raw.githubusercontent.com/mujacica/tade/main/images/tade.svg)

## Agents run as you

One thing to know before the first agent starts: **agents run as you.** Nothing in Tade contains
them and nothing asks before a command, so an agent can read and change whatever you can — your
files, and `~/.tade/config.yaml`, where every key you paste into Tade is kept. Approvals are there
and yours to turn on; containing an agent is its harness's business, not Tade's; and a key you
would rather Tade never wrote down can stay in an environment variable, which always wins over the
file.

## The window

Agents down the left with what each has cost, their changes, the files, the agent you are watching
in the middle, the orchestrator along the bottom. One terminal, no browser, no daemon.

![The Tade window: agents, changes, files, an agent asking to run a command, and the orchestrator below](https://raw.githubusercontent.com/mujacica/tade/main/images/window.svg)

## An orchestrator you talk to

Say or type what you want. It starts, steers and stops agents, opens terminals, and shows every tool
as it runs — including the ones that fail, with the reason. Drop a screenshot on the window and it
goes with whatever you say next.

![The orchestrator answering a request, each tool shown as it runs, one failing with the reason](https://raw.githubusercontent.com/mujacica/tade/main/images/orchestrator.svg)

## Voice, first

Hold `ctrl+space` and talk. Speech stays on your machine by default, answers come back as a few
spoken sentences with the rest on screen, and mute cuts the sentence being said, not the next one.

![Push to talk: the strip says it is listening, a level meter moves with your voice](https://raw.githubusercontent.com/mujacica/tade/main/images/voice.svg)

## Agents, together or apart

Every agent gets a lane of its own. By default they all work in the project's checkout; one setting
gives each a worktree and branch instead. What each one *is* — working, idle, waiting on you,
failed, finished — is read back from git and the processes, never remembered.

<table>
<tr>
<td width="34%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/agents.svg" alt="Agents down the side, one of each kind: working, idle, waiting for approval, failed, finished, queued, paused"></td>
<td width="66%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/terminals.svg" alt="A shell open beside the agent, in the same worktree, with a divider you can drag"></td>
</tr>
</table>

## Smart queues

Ask for five things at once. What can run now runs; the rest waits for exactly what it needs and
starts by itself. Click a piece of queued work and you see the whole chain, why each link waits, and
what its agent will be told — looking is never starting.

![Queued work opened: the chain it is in drawn as boxes, why each waits, and what its agent will be told](https://raw.githubusercontent.com/mujacica/tade/main/images/queue.svg)

`plan` on the queue's heading steps back from one piece to all of it: the whole plan on one screen,
a column per step, so you can see what is running now, what runs next, and why — before any of it
starts.

![The plan: a column per step, a box per task with what it is doing, an arrow for every wait, and the reason for each one under it](https://raw.githubusercontent.com/mujacica/tade/main/images/plan.svg)

When something upstream fails, the work it feeds is **held**, not lost — and Tade says so and asks.

![Queued work held because what it waited on failed, with the choices: wait for a retry, start anyway, remove](https://raw.githubusercontent.com/mujacica/tade/main/images/queue-held.svg)

## Scheduled tasks

"Every Monday morning, update our dependencies." It becomes a schedule: a rule, an instruction and a
record of every run. There is no daemon — what came due while Tade was closed is caught up when it
opens, or skipped, as the schedule says.

Down the side the clockwork has a section of its own, under the queue: a rule that fires again and
again is not a piece of work waiting its turn, and each row says how often it fires, whether firing
starts an agent or only tells you, and — for a watch — when it last looked and what it came to.

![A schedule: every Monday at 09:00 it starts an agent, what it is told, when it runs next, and every run so far](https://raw.githubusercontent.com/mujacica/tade/main/images/schedules.svg)

## Watches

A watch is a schedule that looks before it acts: a cheap check, and an agent on each new finding —
or, where the work is already going and going badly, a sentence for the orchestrator to bring you.
**Agents going in circles** is the second kind: it counts what each agent keeps doing, and where the
same failing call keeps coming round it asks whether that is a loop or a method, and tells you which
agent and what it keeps trying. It never stops one, steers one or starts one.
Extensions offer them, and almost nothing is watched until you turn one on — the exception is
**CI on the branch you are on**, which is on wherever you have a forge, because a red `main` is
everybody's and nobody should have to notice it by hand. Setting up offers the rest once, saying
what each one costs before you answer: one that starts an agent on what it finds says so, and one
whose extension has no key says what it needs instead of pretending it would work. Afterwards it is
the Extensions page, or asking — "turn the vulnerable dependencies watch on".

![A watch: every hour it looks, starts an agent on each new issue, and keeps what it found and every look](https://raw.githubusercontent.com/mujacica/tade/main/images/watches.svg)

## An IDE in the terminal

The repository is right there while the agents work it: the file tree, the diffs, the branch, a
terminal in the same worktree — and a file you can open where you are, typed into and saved, or
handed to the editor you actually use.

![A file open in the window: highlighted, numbered, typed into, with save, copy path and open in your editor](https://raw.githubusercontent.com/mujacica/tade/main/images/editor.svg)

## Context-rich search

`ctrl+k` finds agents, files in every worktree, the lines inside them and the things Tade can do —
each result saying which project and which agent it belongs to. `file:42` goes straight to a line.

![Search: files and matching lines across projects and worktrees, each labelled with its project and agent](https://raw.githubusercontent.com/mujacica/tade/main/images/search.svg)

It also matches what is *happening*: what each agent is doing right now, what it was asked for in
your own words, what queued work waits on and why, how the checks stand, your notes. So `coverage`
finds the agent raising it even though nothing is called that, and the row says which line of what
is going on put it there.

Type a sentence rather than a name and, with Jev on, it goes to a judge alongside whatever the
letters found — which of the things already in that list you meant, under **MIGHT MEAN**. It appears
beside the ordinary results, never instead of them, and choosing one does what choosing it always
did.

![A sentence typed into search, and the two things already in the list that it might have meant](https://raw.githubusercontent.com/mujacica/tade/main/images/asking.svg)

**What that sends.** The letters match everything above on your own machine and send nothing
anywhere. The sentence does not: what goes with the question is the name of each thing in front of
you, where it is, and what is happening about it — so task intents, notes and what agents are doing
reach whoever answers, which today is Jev's provider. It is on because a sentence answered out of
names alone is not answered at all. Turn it off in Settings › Search and search keeps everything
else, letters and all; `Answer search` off on Jev's own page stops the question being asked at all.

## Changes, tracked as they happen

Every file an agent touches, marked the way git marks it, with the diff a click away.

<table>
<tr>
<td width="30%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/changes.svg" alt="Files coloured the way git sees them, and the branch, worktree and path the agent works in"></td>
<td width="70%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/diff.svg" alt="A changed file as a diff, with buttons to open it in your editor or ask the agent about it"></td>
</tr>
</table>

## The checks, before anybody else sees them

Nothing to configure: a project already says what it checks, in the workflows that run on every
change and in the hook that runs before a commit, and Tade reads those. It runs them here, one set
at a time per checkout, and records each against the commit it ran on. A push with nothing green
behind it is held, with what is missing.

![The ACTIONS tab: the commits this agent made, what is not committed, and each check with how long it took and what it counted](https://raw.githubusercontent.com/mujacica/tade/main/images/work.svg)

Two categories, because a step only CI can run — a secret, a service container — is not a step that
passed. What runs here is the page; what does not is a fold with the reason on each row, and it is
out of what a local run adds up to. Which category a check is in is yours: turn one off, turn a
skipped one on, and the answer goes in Tade's own config under the project — never a file in your
repository.

![The checks as two categories: what runs here, and under a fold the ones that do not, each saying why](https://raw.githubusercontent.com/mujacica/tade/main/images/checks-here.svg)

## Reviews, and the loop around them

What you have offered other people, and what they and their robots say about it: your open pull
requests, what waits on you, what CI makes of each, and the conversations nobody has answered.
Watches can fix what is red and answer the bots — and nothing merges anything unless you asked for
exactly that. **CI on the branch itself is watched too**, which is the half of it that has no
review: push straight to `main`, and a red commit puts one agent on reproducing it here and fixing
the cause. One agent per red commit, however many checks went red; a re-run of the same commit
starts nothing new; and it never force-pushes, never reverts and never merges.

![The REVIEWS section: every open review as two rows — where it stands, and what its checks and verdicts came to](https://raw.githubusercontent.com/mujacica/tade/main/images/reviews.svg)

## Spend, time and tokens

What every agent and the orchestrator cost — tokens, runtime and dollars, each project against the
budget you gave it — over today, this window, seven days, thirty, or the whole of the journal, which
goes back as far as you have been running Tade.

Where a subscription pays for the work there is no price per turn, so what is used up is a share of
a rolling window: how much of each plan is gone and when it comes back. Never added to the money: a
plan and a dollar are different currencies with no rate between them, and a plan's turns are tokens
and hours on this page rather than a large number of dollars nobody is charged. Every sign-in is
read — each harness's own and every account beside it — and the fullest window of any of them sits in
the status bar beside the cost, since that is the one about to stop somebody working; press its name
to look at another. Ask Tade and it will tell you where each one stands and what else there is when
one is nearly gone, and leave switching to you.

![Spend: every agent with its model, tokens, share, runtime and cost over the range you pick, how much of each subscription’s window is used and when it resets, and each project against its budget](https://raw.githubusercontent.com/mujacica/tade/main/images/spend.svg)

Ask it by agent, by project, by model — or by the harness it ran in, the sign-in it ran as and the
provider it was reached through. A model is one row under its own name however it was reached, so an
agent's hours and its money are in the same place; the same weights on a subscription, through an
API key and through a router are three different bills, and those last three groupings are what tell
them apart. Money a harness priced against its own catalog is never added to money it could only
guess at without saying so: a guessed figure wears a `~` wherever you read it, one Tade worked out
from the published rate wears a `≈`, and money nobody reported and nothing could price at all is a
dash rather than a zero that reads as free. Where a plan paid, the cost column says what those turns
would have cost at list price — quietly, because nobody is billed it, and in no total. How long the
agents ran is every agent's time added together rather than time on the clock, which the figure says
as it stands.

![The same morning grouped by model: one model reached three ways is one row, its hours and its money in the same place, with the groupings for harness, sign-in and provider beside it](https://raw.githubusercontent.com/mujacica/tade/main/images/spend-by-model.svg)

## Resources

Tade has to be light, and proves it: what it and everything it runs is using, in the status bar and
broken down by project, by kind and by agent.

![Resources: CPU and memory by project, by kind, and by agent](https://raw.githubusercontent.com/mujacica/tade/main/images/resources.svg)

## Local memory and notes

Notes are the one thing Tade is told rather than derives, so they are kept word for word, in a file
you own. Say *"remember the staging key rotates on the 1st"*, or press `+`. Agents are given the
notes that concern their work.

![A note being written: about this project or about everything, kept word for word](https://raw.githubusercontent.com/mujacica/tade/main/images/notes.svg)

Down the side each one is two lines: what it is about and what it does, over the words you actually
said. Tade writes that headline as it takes the note down, never out of the words afterwards — and
clicking a note opens the note itself, where you can write one yourself, change the words, copy them
or forget it.

![A note read whole: the headline it was given, what it is about, who said it when, and its own words — changed, copied, forgotten or given a headline from the same page](https://raw.githubusercontent.com/mujacica/tade/main/images/note.svg)

## Many projects, many tasks

Projects along the top, agents running in all of them at once. Each tab says what is happening in
its own — what is working, what wants you, what is queued, and `✓` where everything you asked for in
there is done — so the project you are not looking at is not the one you have to guess about. The
figures at the right are everybody's, and say whose.

![The tabs along the top, each saying what is happening in its own project](https://raw.githubusercontent.com/mujacica/tade/main/images/project-tabs.svg)

Each tab has an `×` and a `≡` of its own, like a terminal's. The menu is where a project is renamed
— what it is called here, never its name, which every task id, every `Tade-Task:` trailer and every
line of the journal keeps — moved along the row, configured, or closed. **Closing one deletes
nothing**: the folder, the git history, the branches, the worktrees and the journal all stay, and
opening that path again brings them back.

![A project's menu: rename, move, configure and close](https://raw.githubusercontent.com/mujacica/tade/main/images/project-menu.svg)

An agent in a project you are not looking at can still reach you — and be answered from where you
are.

![Projects along the top, and an agent in another project asking for approval](https://raw.githubusercontent.com/mujacica/tade/main/images/projects.svg)

## Extensions

Checks, Dependencies, Jev, Reviews, Sentry and Resources ship with Tade; yours go beside them in
`~/.tade/extensions/`. An extension brings tools the orchestrator and your agents can both call,
settings and watches. Being there is not being on: one of yours is listed and off until you turn it
on. Keys are pasted in as text and written into `~/.tade/config.yaml`, so you can read one back and
check it against the console that issued it — and any agent you run can read it too. To keep one out
of the file, export its variable instead, or leave that extension unconfigured.

Every one of them is down the side, searchable by anything it would say — and the one you pick says
what it is for in the work you actually do, every tool it brings with what each is for, what it
offers to watch, and what it can be given.

![The Extensions panel: the list down the side, and one of them in full — how it is used, its buttons, its tools, its watches and its settings](https://raw.githubusercontent.com/mujacica/tade/main/images/extensions.svg)

## MCP servers, in one place

An MCP server somebody turns on is an extension whose tools are that server's tools. The window is
the only client there is, so turning one on hands its tools to every agent and to the orchestrator —
pi, Claude Code, Codex alike — named by Tade, gated by Tade, and with your key never leaving this
machine. No config written for anybody else's client, and no process per agent per server.

The popular ones are listed and off: a server is somebody else's code with tools your agents will
call, so turning one on is yours alone, in the window or with `tade mcp enable <name>`. What each
harness loads by itself is listed too — read, never adopted.

![The MCP servers Tade knows about, listed and off: what each is for, how Tade would talk to it, and what turning it on would need](https://raw.githubusercontent.com/mujacica/tade/main/images/mcp.svg)

## Jev, for what nobody has time to read

A judge answers bounded questions — yes or no, one of these, one of these levels — with a
probability and no paragraph, cheaply enough to ask of every diff and every thousand lines of log.
Tade asks it where nobody is going to look: a branch that has stopped moving, read for injection,
secrets, permissions, swallowed errors, missing tests, whether it did what was asked and this
project's own rules; a command an agent is held at that the approval rules do not name; an agent
going round on the same failing command; a sentence typed into search; a request before it becomes a
plan, and a queue that needs an order.

It may only ever add caution — it never approves, merges, closes, unholds or shortens anything — and
what reaches you is a sentence Tade wrote, never a number. Every question it asks and every threshold
is one file you can argue with, every finding keeps the version that answered, and what was made of
a finding is kept beside it, so a question that never fires can be deleted and one that is always
wrong can be rewritten.

That last part is a loop, and who says what in it is the whole of it. The agent whose change was
flagged gets the question in the judge's own words — material to judge, never an instruction — and
answers it: it fixed the cause, or the finding is not real and why. That is its **account**, not a
verdict; an agent marking its own work a false positive is the defendant grading the exam. The
**verdict** is yours or the orchestrator's, and it has to name what in the change decided it. What
nobody answered is swept up and put in front of you — again as it keeps waiting, never once and
then silence — and nothing becomes a false positive by getting old. Every finding with no verdict
says *why* it has none, because "waiting on a verdict" is the symptom and each of its causes wants
something different done.

![What Jev read today, where every finding stands and why, and whether the questions earn their place](https://raw.githubusercontent.com/mujacica/tade/main/images/jev.svg)

Paste a key and it is on. With none, none of it runs and nothing else changes.

## Sentry, both ways

Point the Sentry extension at your organisation and *"fix new Sentry errors as they come"* becomes a
watch: each new issue is an agent with the stack trace, the trace and the logs already in its
context. Point Tade's own telemetry at a Sentry project of yours and it reports **itself** the same
way — its crashes and its own warnings, never your code or what you said — so Tade can be handed its
own bug.

![An agent started from a Sentry issue: the issue and trace one click away, the context file the first thing it reads](https://raw.githubusercontent.com/mujacica/tade/main/images/sentry.svg)

## Models and harnesses

Pick what the orchestrator runs on and what every new agent starts on — every model you are signed
in to, priced per million tokens — and how hard it should think.

![Choosing a model: every model the harness is signed in to, with what it costs in and out, filtered as you type](https://raw.githubusercontent.com/mujacica/tade/main/images/models.svg)

Agents run in **pi** or in **Claude Code**, side by side, one harness per agent, moved from one to
the other from its menu. Claude Code signs in as itself — Tade never sees it — and can run as more
than one account at once; an agent that runs out moves to another, its conversation with it.

![Accounts: each harness's own sign-in, a second Claude Code account beside it, how much of the plan is used, and what can be done to each](https://raw.githubusercontent.com/mujacica/tade/main/images/accounts.svg)

## Shortcuts and settings

`ctrl+space` talk · `ctrl+k` search · `tab` next agent · `ctrl+n` new agent · `ctrl+t` terminal ·
`ctrl+/` orchestrator · `ctrl+m` mute · `F1` every shortcut · `ctrl+,` settings

Everything else goes straight to the agent or terminal you are typing at. Every key is changeable,
and every setting has what it means beside it.

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/keys.svg" alt="The keys Tade keeps, talking first"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/settings.svg" alt="Settings over the window: categories down the side, and a real control for each with what it means beside it"></td>
</tr>
</table>

## Up to date, and honest about it

Which of the programs Tade runs are here, how each one got here — Homebrew, a global npm package, a
binary somebody dropped on their PATH — and what is current. Nothing is written down at a call site:
every driver, harness and forge declares what it needs and how to ask it its version. Checking is the
one thing here that reaches the network and it happens when you press it, nothing installs anything
behind your back, the exact command is on the page before it runs, and what nobody can be asked about
comes back as *cannot tell* rather than a guess. Tade itself is a row like any other, with what
reloading into the new one would cost said before you choose it.

![Updates: every program Tade runs with how it got here and what is current, the exact command before anything runs it, and what reloading would cost](https://raw.githubusercontent.com/mujacica/tade/main/images/updates.svg)

## The brief, and where everything stands

One paragraph of what is stopped, what is moving and what the extensions found — in the window, by
voice, or as `tade brief` from any shell. Nothing in it is remembered: every task is derived again
from git, processes and transcripts.

![The brief: one paragraph of what is blocked, what is moving and what extensions found](https://raw.githubusercontent.com/mujacica/tade/main/images/brief.svg)

## Approvals, on your terms

Off by default, and every command an agent runs is written down either way. Turn approvals on and
the risky ones stop and ask — in the window, by voice, or from another project's toast. This is the
whole of what Tade holds an agent to: containing one is its harness's own business, and Tade does
not pretend to a half of it.

![An agent at work, stopped at a command it wants to run, with Allow once and Deny beside it](https://raw.githubusercontent.com/mujacica/tade/main/images/approval.svg)

The rules are patterns somebody wrote — `sudo`, a force push, an `rm -rf` aimed outside the
worktree. With Jev on, what no pattern names is read a second time before you are asked about it, so
a `terraform destroy` is the command read back rather than one word said to it. It can only ever
make Tade ask for more, never less, and what you hear is Tade's own sentence, never a probability.

## Installing

```sh
npm install -g tade-sh
tade
```

Needs Node ≥ 22.19 and git. The first `tade` is a short setup: it looks at the machine, offers to
install what is missing — the exact command on screen first, run in a terminal you are watching —
and ends by opening a lane, running a command in it and closing it, so that "all set" means a
terminal that actually opened. `tade setup --check` does the same whenever you want to be sure.

What it is looking for, in case you would rather do it yourself. Two of the things Tade is built on
are native — node-pty, which is every terminal it opens, and better-sqlite3 — and they arrive
prebuilt on macOS and are compiled on Linux, which needs python3 and a C++ toolchain
(`build-essential`, or `gcc-c++ make python3`). Installing with pnpm, add `pnpm approve-builds -g`:
pnpm 10 holds a dependency's install scripts until you say so, and an unbuilt node-pty is a Tade
that cannot open a terminal — which setup recognises and tells you how to fix, rather than leaving
it to be found at the first lane. Optional: tmux (agents that outlive the window), whisper.cpp and
ffmpeg (speech), `gh` (pull request state); setup offers to install each where you want it.

## Contributing

From a checkout, which is how you change Tade:

```sh
git clone https://github.com/mujacica/tade && cd tade
pnpm install
pnpm run link:global    # puts `tade` on your PATH
```

There is no build step — Node runs the TypeScript — so `tade` always runs the code you have and
`git pull` is the upgrade. Changing Tade itself starts at [AGENTS.md](AGENTS.md): the invariants,
where things go, and which recipe under `.claude/skills/` covers the change you are making.

## License

MIT — see [LICENSE](LICENSE). Tade builds on the work of many others; they are credited, with their
licences, in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

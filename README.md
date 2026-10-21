# Tade — **T**erminal **A**gentic **D**evelopment **E**nvironment

A control room in your terminal for running coding agents and landing what they make.

```sh
curl -fsSL https://tade.sh/install.sh | sh
```

![Tade: a project with nothing running, a request typed to the orchestrator, the orchestrator calling its tools, an agent at work asking for approval, and then what its work came to — its own commits, the review it is out for and the project's checks run here](https://raw.githubusercontent.com/mujacica/tade/main/images/tade.svg)

## Why Tade

Plenty of things run agents in parallel. The work still has to be read, checked and merged before it
counts, and that is where the day goes: you are the queue. Tade is the place agent work becomes
merged work — honestly, which means what it says about the work is read back out of git, the checks,
the forge and what the agents spent, and none of it is graded by the agent that did the work.

- **[Collisions, forecast before they happen.](#collisions-forecast-before-they-happen)** Live work
  that would collide is marked on both agents while either can still give way, and the orchestrator
  is told which one should.
- **[The project's own checks, run before anybody else sees them.](#the-checks-before-anybody-else-sees-them)**
  Read out of the workflows and the commit hook it already has, run here and recorded against the
  commit they ran on; a push with nothing green behind it is held, with what is missing.
- **[An independent judge, and its findings answered.](#jev-a-judge-whose-findings-are-answered)**
  It reads each change once it stops moving, for what nobody has time to; the agent accounts for
  each finding, and the verdict is yours or the orchestrator's, never the agent's.
- **[Scorecards nobody graded for themselves.](#evaluations-which-way-of-working-lands-work)** Which
  harness, model, persona and template lands work, counted from what was recorded — and your own
  landed tasks [replayed on a candidate](#your-own-eval-replay-what-landed-on-a-candidate) before
  your agents move to it.
- **[Mistakes turned into checks.](#a-mistake-made-twice-becomes-a-check)** The same real finding
  twice in one project becomes a proposed hook line, lint rule or test, rather than one more
  paragraph an agent can read past.
- **[On your Mac, on a server of yours, or both.](#installing)** A VPS keeps working with the
  laptop shut, and the Mac's window shows and drives every machine's projects.

The number to read first is **what a landed task cost**, not how many agents are running:
Evaluations divides each way of working's spend by the work of it that landed — merged, or committed
onto a shared checkout under its own trailer — with billed money and a plan's list price kept apart.
How long finished work then waits to land is the next figure, and is not built yet
([Planned](#planned)).

Under all of it: spend that never adds a subscription's turns to a dollar total, and nothing
remembered — what each agent *is* comes back from git and the processes every time you look, so
nothing drifts and closing Tade leaves nothing behind. Agents are not sandboxed — see
[Agents run as you](#agents-run-as-you).

## Agents run as you

One thing to know before the first agent starts: **agents run as you.** Nothing in Tade contains
them and nothing asks before a command, so an agent can read and change whatever you can — your
files, and `~/.tade/config.yaml`, where every key you paste into Tade is kept. Approvals are there
and yours to turn on; containing an agent is its harness's business, not Tade's; and a key you
would rather Tade never wrote down can stay in an environment variable, which always wins over the
file.

## Agents, together or apart

Every agent gets a lane of its own. By default they all work in the project's checkout; one setting
gives each a worktree and branch instead, and a new worktree gets what its project says it needs —
the ignored files it lists in `.worktreeinclude`, copied or linked from the checkout, and the setup
command read from `.cursor/worktrees.json`, a devcontainer or the lockfile, run in the agent's lane
before it starts. What each one *is* — working, idle, waiting on you, failed, finished — is read
back from git and the processes, never remembered, and an agent's dev server is a link under GIT.

With a worktree each, finished work ends up where somebody can read it: the agent pushes its own
branch and opens a pull request on it, published rather than a draft. In the shared checkout there is
no branch of its own to open one for, so it commits and stops and pushing stays yours. Either answer
is one setting, per project or for the machine, and merging is never Tade's.

<table>
<tr>
<td width="34%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/agents.svg" alt="Agents down the side, one of each kind: working, idle, waiting for approval, failed, finished, queued, paused"></td>
<td width="66%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/terminals.svg" alt="A shell open beside the agent, in the same worktree, with a divider you can drag"></td>
</tr>
</table>

## Collisions, forecast before they happen

Two agents can each be right and still not land together. While the work is live, Tade looks for
what would collide: with a worktree each, it asks git whether each pair of branches — and each
branch against a base that has moved — would merge cleanly (`git merge-tree`, which writes nothing);
in a shared checkout, whether two agents have uncommitted changes in the same file, from what each
one's harness said it wrote. Work that would collide wears `⇄` on both agents and in the plan, with
what it runs into and over which files, and the orchestrator is told once — naming the side that
should give way, by merging the other in or, in a shared checkout, by going second — and settles it
without asking unless you keep that decision for yourself (`queue.holds: ask`). A collision is said
again only for a new file. Where the same repository is a project on another machine of yours,
that machine's live branches are in it too ([below](#many-projects-many-tasks)). The forecast
only tells, never stops or holds anything, and when it cannot tell it says that rather than nothing.

![Two agents the forecast says would collide in one file, each marked ⇄ down the side and in the plan, with the work queued after both waiting for them](https://raw.githubusercontent.com/mujacica/tade/main/images/collide.svg)

Once the work is out for review, a conflict with its base is for the review watches to settle —
**Conflicts on your reviews**, off until you turn it on — in
[Reviews, and the loop around them](#reviews-and-the-loop-around-them).

## Changes, tracked as they happen

Every file an agent touches, marked the way git marks it. Click one and it opens in the window's own
editor with git's answer drawn into it — added lines green, the lines that were there red — where you
can fix it and press ctrl+s, rather than read it here and go and fix it somewhere else. It opens on
the first change, the bar down its side marks where the others are, and `n` and `p` go from one to
the next.

Or say something about it: press a line's number, or `c`, and write on that line. A comment goes to
Tade as your own words, anchored at `file:line` with its hunk beside it, or — tab, on the same
comment — straight to the agent whose change it is. Write on as many lines as you like, in this file
or the patch reader, and send them together.

<table>
<tr>
<td width="30%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/changes.svg" alt="Files coloured the way git sees them, and the branch, worktree and path the agent works in"></td>
<td width="70%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/diff.svg" alt="A changed file clicked in CHANGES: the editor it opens in, with git’s answer drawn into it and a comment being written on a line"></td>
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

## Jev, a judge whose findings are answered

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

### A mistake made twice becomes a check

When the verdicts say the same question was real about two changes in one project — or the
orchestrator, looking back at finished work, sees the same correction twice — Tade proposes
something a machine runs, a line in the commit hook, a lint rule or a test, rather than another
paragraph an agent can read past. Only verdicts somebody wrote count, never an agent's account or a
probability, and only questions a machine could catch. It arrives as parked work, and picking it up
is approving it. The watch that looks for them, **Mistakes made twice**, is on wherever Jev is.

## Evaluations: which way of working lands work

Every vendor publishes the flattering version of this number, graded by themselves. Tade already
writes down the facts the honest version needs, so `/evals` (or `tade stats --by
harness|model|persona|template`) folds them: per harness, model, persona and template, how many
agents finished and landed — merged, or committed straight onto a shared checkout under their own
trailer — how often the first push was green, the reds caught on this machine before CI saw them,
what the judge raised about each change and how its verdicts came out, what a landed agent cost in
money and tokens, and how long work took to finish. Counts come first and a rate only from five,
because `2 of 2` is a fact and `100%` is not; billed money and a plan's list price are divided by
their own agents and never added; and anything nobody could say is a dash with its word, never a
nought. The judge's own record sits on a tab beside them — precision per question and per band of
probability, out of verdicts people wrote — and the same page is on the away view. How long finished
work then waits to land is not one of its figures yet ([Planned](#planned)).

![Evaluations by harness: agents, done and landed, first push green, reds caught here, the judge's findings, cost per landed agent and time to done — counts first, a rate only from five](https://raw.githubusercontent.com/mujacica/tade/main/images/evaluations.svg)

## Your own eval: replay what landed, on a candidate

Public benchmarks do not transfer to your repository; your own landed work does. Ask the
orchestrator to eval a model (or run `tade eval run <project> --model <m> --ceiling <usd>`) and
Tade takes the last few tasks that landed there and asks each again — in a worktree at the commit
it began from, with your original words verbatim — on the candidate. It varies one thing: a model
on the harness each task first ran on, or a harness alone, because changing both at once confounds
the comparison. Each replay is scored by the facts the original was read with: the project's
checks at its head, the tests the original change added laid over it, whether the judge says it
did what was asked, how big it is beside the original, and what it cost and took. Words that were
an answer to a conversation nobody kept, and agents that stopped without changing anything, are
*could not replay* — never a fail. It costs money, so it runs only when you ask, under a ceiling
you set, a few at a time through the queue (`--at` puts it off until tonight), and is never pushed.
`tade eval judge` does the same for the judge: Jev's questions asked again of a candidate judge,
counted against the verdicts people wrote. Both land on `/evals` under Replays.

![Your own eval: a candidate judge counted against the verdicts, then five landed tasks asked again on Sonnet, each beside its original — passed, failed with why, could not replay, running — with cost, time and the ceiling](https://raw.githubusercontent.com/mujacica/tade/main/images/replays.svg)

## Races: one request, several agents, and you keep one

Ask the orchestrator to race something and it gives the same request to two to four agents at
once — each on its own harness or model, each in a worktree of its own — and the queue starts them
like any other work. `/race` puts them side by side in the order the facts put them: the checks at
each one's head, whether the judge said a change did something other than what was asked, the
findings nobody has settled, then the smaller change, with what each cost and what the race has
cost so far. That order is not a pick, and nothing picks but you: press **Pick this one**, say yes,
and the others are stopped and marked finished with every branch kept. The orchestrator can do it
too, but only when a line of yours since the race began asks it to. There is a `race` template for
three attempts on one route, and the races are a tab on the away view's Evaluations page.

![A race: one request given to three agents on Claude Code, Codex and pi, in the order the facts put them — checks, whether the judge said one strayed from what was asked, findings, size and cost — and nobody has picked](https://raw.githubusercontent.com/mujacica/tade/main/images/race.svg)

## Reviews, and the loop around them

What you have offered other people, and what they and their robots say about it: your open pull
requests, what waits on you, what CI makes of each, and the conversations nobody has answered.
Watches can fix what is red, answer the bots, and settle a review of Tade's that conflicts with its
base — the base merged in from a tree of its own, never a rebase and never a force-push — and
nothing merges a review unless you asked for exactly that. **CI on the branch itself is watched
too**, which is the half of it that has no
review: push straight to `main`, and a red commit becomes one agent's work reproducing it here and
fixing the cause. One per red commit, however many checks went red; a re-run of the same commit
starts nothing new; the next red commit while the first fix is still going is put to the
orchestrator beside it rather than becoming a second agent in the same checkout; and it never
force-pushes, never reverts and never merges.

![The REVIEWS section: every review open on the project you are in, as two rows — where it stands, and what its checks and verdicts came to](https://raw.githubusercontent.com/mujacica/tade/main/images/reviews.svg)

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

## The window

Everything above is what becomes of the work once an agent has done it; from here on is the room it
is done in. Agents down the left with what each has cost, their changes, the files, the agent you
are watching in the middle, the orchestrator along the bottom. One terminal, no browser, no daemon.

![The Tade window: agents, changes, files, an agent asking to run a command, and the orchestrator below](https://raw.githubusercontent.com/mujacica/tade/main/images/window.svg)

The `+` on that bottom row opens a shell, or an agent to talk to — pi, Claude Code or Codex, with no
task, no project and nothing to commit, for asking about this machine or about something that is
nobody's repository. It costs money and takes time like any other agent, so it is on the Spend page
with the rest; closing it ends the agent and leaves the conversation where it was.

## An orchestrator you talk to

Say or type what you want. It starts, steers and stops agents, opens terminals, and shows every tool
as it runs — including the ones that fail, with the reason. Drop a screenshot on the window and it
goes with whatever you say next.

![The orchestrator answering a request, each tool shown as it runs, one failing with the reason](https://raw.githubusercontent.com/mujacica/tade/main/images/orchestrator.svg)

## Voice, first

Hold `ctrl+space` and talk. Speech stays on your machine by default. Tade starts muted, with every
answer on screen; unmute it (`ctrl+m`) and answers come back as a few spoken sentences, and muting
again cuts the sentence being said, not the next one.

![Push to talk: the strip says it is listening, a level meter moves with your voice](https://raw.githubusercontent.com/mujacica/tade/main/images/voice.svg)

## Smart queues

Ask for five things at once. What can run now runs; the rest waits for exactly what it needs and
starts by itself. Click a piece of queued work and you see the whole chain, why each link waits, and
what its agent will be told — looking is never starting.

![Queued work opened: the chain it is in drawn as boxes, why each waits, and what its agent will be told](https://raw.githubusercontent.com/mujacica/tade/main/images/queue.svg)

`plan` on the queue's heading steps back from one piece to all of it: the whole plan on one screen,
a column per step, so you can see what is running now, what runs next, and why — before any of it
starts.

![The plan: a column per step, a box per task with what it is doing, an arrow for every wait, and the reason for each one under it](https://raw.githubusercontent.com/mujacica/tade/main/images/plan.svg)

Work that spans projects is one **plan**, and `ctrl+shift+p` (or `/plans`, a plan's heading down
the side, or its row in `ctrl+k`) shows every plan at once: what wants you first, then what is moving
and how far along, then what is done — each with its whole graph, finished and running steps
included. Open one for its facts, every wait's reason and each step stage by stage. It is the same
answer the away view's Plans page gives, out of the same task files.

![Every plan: each step a mark with the parts counted under it, then the plan that wants you with its whole graph, the one under way, and a quiet row for the one that finished](https://raw.githubusercontent.com/mujacica/tade/main/images/plans.svg)

When something upstream fails, the work it feeds is **held**, not lost — and Tade says so and asks.

![Queued work held because what it waited on failed, with the choices: wait for a retry, start anyway, remove](https://raw.githubusercontent.com/mujacica/tade/main/images/queue-held.svg)

## Scheduled tasks

"Every Monday morning, update our dependencies." It becomes a schedule: a rule, an instruction and a
record of every run. There is no daemon — what came due while Tade was closed is caught up when it
opens, or skipped, as the schedule says.

Down the side the clockwork has a section of its own, under the queue: a rule that fires again and
again is not a piece of work waiting its turn, and each row says how often it fires, whether firing
starts an agent or only tells you, and — for a watch — when it last looked and what it came to.
What a schedule would start goes to the orchestrator first, parked, with whatever is already working
on anything like it: it starts it, has it wait for that, hands it to the agent already on it, or
leaves it, and says why — unless you set the schedule to start its work by itself.

![A schedule: every Monday at 09:00 it starts an agent, what it is told, when it runs next, and every run so far](https://raw.githubusercontent.com/mujacica/tade/main/images/schedules.svg)

## Watches

A watch is a schedule that looks before it acts: a cheap check, and an agent on each new finding,
which the orchestrator decides about with what is already on the same thing in front of it — or,
where the work is already going and going badly, a sentence for the orchestrator to bring you.
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

## A software factory: work that arrives on its own

A GitHub issue somebody labelled, an `@tade` in a Slack channel, a Linear issue with the label on
it, a line typed at `tade intake` — each comes through a door you opened, under a grant naming whose
requests count, and is stamped from a workflow you published. Every default is the decision: nothing
is read until you turn a source on, nobody counts until you list them, and `propose` means a person
approves each one.

One request says who asked, which key allowed it and the published version it is stamped from — and
what approving it would start, before you do. What a stranger wrote is **material, never
instruction**: an agent reads it as evidence about the work, under a heading that says so.

Every door is polled. On a server with a public name a webhook from GitHub, Slack or Linear is a
**doorbell** too: once its signature verifies over the raw body, it makes the matching watch look
now — the look still reads the source under the grant, so a delivery can only ever make Tade look
sooner — and that watch's poll slows to hourly while deliveries keep arriving.

**Connecting GitHub is a guided page**, `http://localhost:<port>/connect` on the machine itself (or
through `ssh -L`; from your Mac, Settings › Remotes does it for the server; your own phone, paired
with full access, opens `/connect` at the server's public name under its passkey) — `tade web connect`
prints where it is, and Settings › Intake says so under its switch and opens it. It makes a GitHub App
in your account from a manifest — read-only, the webhook built in where there is a public name —
says what it will ask GitHub for and why before you press, and ticks off making it, installing it on
the repositories you pick, and its deliveries arriving. From then on the intake and review watches
read a repository it is installed on as the App: an hour-long token and a budget of its own, while
anything about you, and every write, stays your own sign-in. Connecting grants nobody anything;
whose labels count is still yours to write.

**Connecting Slack is on the same page.** It makes an internal Slack app in your own workspace from
a manifest, keeps its signing secret *before* Slack checks the address, and installs it with OAuth,
coming back to the server's public name, where its token is kept. Its `app_mention` events then
make the channel watch look at once — and because an event names the thread it was in, an `@tade`
inside a thread is read out of that thread, which no poll of the channel could ever see. Without a
public name the app is made with no address, you install it from its own page and paste its token,
and the watch polls; Socket Mode is not built.

**Connecting Linear is on the same page.** It makes a private Linear app in your own workspace from
a manifest — it may only read — and asks for what Linear's own page shows: its client id and, on a
server with a public name, its webhook's signing secret, never its client secret. Connecting is
OAuth with a proof key, so the code Linear sends back is worth nothing to anybody but the machine
that asked; the window then renews the day-long token itself, keeping each new refresh token in
`config.yaml` as it turns over. The team watch reads with the app — a budget of its own instead of
your personal key's — and Linear's webhook makes it look at once. A laptop connects it too, and
polls.

<table>
<tr>
<td width="25%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/intake.svg" alt="INTAKE down the side: work handed to this machine from outside it, each row saying who asked, the door it came through and how far it got"></td>
<td width="75%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/intake-request.svg" alt="One request in front of you: where it came from, what approving it would start, the wait between its two tasks and why, and the keys to approve or refuse"></td>
</tr>
</table>

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

## The brief, and where everything stands

One paragraph of what is stopped, what is moving and what the extensions found — in the window, by
voice, or as `tade brief` from any shell. Nothing in it is remembered: every task is derived again
from git, processes and transcripts.

![The brief: one paragraph of what is blocked, what is moving and what extensions found](https://raw.githubusercontent.com/mujacica/tade/main/images/brief.svg)

## Many projects, many tasks

Projects along the top, agents running in all of them at once. Each tab says what is happening in
its own — what is working, what wants you, what is queued, and `✓` where everything you asked for in
there is done — so the project you are not looking at is not the one you have to guess about. The
figures at the right are everybody's, and say whose.

![The tabs along the top, each saying what is happening in its own project](https://raw.githubusercontent.com/mujacica/tade/main/images/project-tabs.svg)

Open more than fit and none of them is lost. The row shortens as far as it shortens — the counts,
then the marks — and only then does a tab go in the `⋯` beside the `+`, which says how many have
none and carries the most urgent mark of all of them, so a project asking for a decision says so
whether or not you can see it. Its menu is those projects, each with what its tab would have said,
and going to one brings its tab back: the project you are in always has one. Which ones keep a tab
is the order you arranged them in, so Move left is how one stays.

![Twelve projects and room for eight, the rest in the `⋯` beside the `+`](https://raw.githubusercontent.com/mujacica/tade/main/images/project-tabs-more.svg)

Each tab has an `×` and a `≡` of its own, like a terminal's. The menu is where a project is renamed
— what it is called here, never its name, which every task id, every `Tade-Task:` trailer and every
line of the journal keeps — moved along the row, configured, or closed. **Closing one deletes
nothing**: the folder, the git history, the branches, the worktrees and the journal all stay, and
opening that path again brings them back.

![A project's menu: rename, move, configure and close](https://raw.githubusercontent.com/mujacica/tade/main/images/project-menu.svg)

An agent in a project you are not looking at can still reach you — and be answered from where you
are.

![Projects along the top, and an agent in another project asking for approval](https://raw.githubusercontent.com/mujacica/tade/main/images/projects.svg)

**Projects on other machines are tabs too, under the machine they are on**: this Mac's first, then
each server linked with `tade remote add` ([below](#from-your-mac-to-your-vps)) by its name, every tab carrying the
marks that machine gave its agents — so the `tade` here and the `tade` on the VPS are never two tabs
nobody can tell apart. A machine's name opens its projects. Standing in one, the side lists its
agents with how long ago each moved and its queued work under them, and the pane says where it is
and how it stands; search says which machine each project and agent is on, and the Spend page has a
row for each machine's agents, each by its own clock and never added together. Everything another
machine wrote is reduced to text before it is drawn, so a title full of escape sequences cannot
write into this terminal.

![Projects on this Mac and on two servers, and an agent list read from the VPS](https://raw.githubusercontent.com/mujacica/tade/main/images/machines.svg)

When a link drops, nothing goes blank: the machine's name wears `○`, its rows stay as it last said
them with their ages as of then, and the side says `as of 13:52`.

![A remote whose link is down, its agents as it last said them](https://raw.githubusercontent.com/mujacica/tade/main/images/machines-down.svg)

**An agent there opens here.** Press its row and the pane shows its screen on that machine,
read-only and kept current while you look, with what that machine says may be asked of it: steer
it with a sentence, park it, stop it, open it again, start queued work, allow or deny what it is
held on — each one that machine's own act, over the link this Mac holds as its owner.

![An agent on the VPS opened from the Mac: its screen there, and what may be asked of it](https://raw.githubusercontent.com/mujacica/tade/main/images/remote-agent.svg)

**Enter types into it**: a terminal on the Mac that is the agent on the VPS, in front of the lower
pane — that machine's own tmux, in a view of its own so two agents side by side stay two agents,
over the SSH connection the link already holds, or over mosh where both machines have it and its
UDP gets through (otherwise `ssh -t`, said, and remembered for that machine). Closing the tab ends
the terminal and never the agent; a lid closed or a network dropped ends only the connection, and
the terminal comes back in the same tab when the link does.

![Typing into an agent on the VPS, in a terminal on the Mac](https://raw.githubusercontent.com/mujacica/tade/main/images/remote-terminal.svg)

**And its orchestrator is a tab beside this one's.** What you type on the VPS's tab goes to the
orchestrator on the VPS — as this Mac's owner session there, so it can start and plan work on that
machine — and never to the Mac's; escape there stops its turn there. (Talking to Tade from another
screen has to be on there, `surfaces.web.orchestrator`, and the tab says so where it is not.) When
the laptop opens and the link comes back after a while, the tab says what the VPS says happened
since this Mac last told it you were at the keyboard: what waits on you, what finished, what is
waiting to be read, what is held, what it cost. The Mac's orchestrator is told a line about each
machine with everything you say to it (`vps: 3 working, 1 wants you`), and passes a sentence on to
one when you ask for something there by its name — never when the words came from a phone.

![The VPS's orchestrator on a tab beside the Mac's, with what happened there since you were last here](https://raw.githubusercontent.com/mujacica/tade/main/images/remote-orchestrator.svg)

**Where one repository is a project on both machines**, the VPS's branches come to the Mac over
the same SSH connection, into a mirror in Tade's home that borrows your checkout's objects — so it
costs only what the VPS added, and nothing is ever written into your checkout. Two machines are the
same repository when their `origin` names the same one, whatever the projects are called. From it
the collision forecast adds the VPS's live branches: a branch here that would conflict with one
there wears `⇄`, and the Mac's orchestrator is told once, with where to fetch the other branch from
to merge it in — the side on the VPS is that machine's own.

**And its watches run on one of them.** A watch on GitHub, Slack, Linear, Sentry or your
dependencies finds the same thing from either machine, so one red build would be two findings and
two agents; each project says which machine looks (Settings › Projects, `here` or a remote's name),
the VPS by default, since it never closes. Where the VPS already looks with a watch on the same
repository, the Mac's own stays off and says why, its row under SCHEDULES reading `on vps` — and
taken back, it starts from the last moment the VPS had it.

## An IDE in the terminal

The repository is right there while the agents work it: the file tree, the diffs, the branch, a
terminal in the same worktree — and a file you can open where you are, typed into and saved, or
handed to the editor you actually use.

![A file open in the window: highlighted, numbered, typed into, with save, copy path and open in your editor](https://raw.githubusercontent.com/mujacica/tade/main/images/editor.svg)

## Context-rich search

`ctrl+k` finds agents, files in every worktree, the lines inside them, the documents tasks produced
and the things Tade can do — each result saying which project and which agent it belongs to.
`file:42` goes straight to a line. A document is found by its file or by the task that wrote it,
says whether it is waiting on you, and is found after its task is gone, because it outlives it.

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

## Local memory and notes

Notes are the one thing Tade is told rather than derives, so they are kept word for word, in a file
you own. Say *"remember the staging key rotates on the 1st"*, or press `+`. Agents are given the
notes that concern their work. On a Mac linked to a server ([below](#from-your-mac-to-your-vps)) the notes are
shared both ways, so both orchestrators and every agent hear what you said to either, and a note's
own page says which machine it was taken on.

![A note being written: about this project or about everything, kept word for word](https://raw.githubusercontent.com/mujacica/tade/main/images/notes.svg)

Down the side each one is two lines: what it is about and what it does, over the words you actually
said. Tade writes that headline as it takes the note down, never out of the words afterwards — and
clicking a note opens the note itself, where you can write one yourself, change the words, copy them
or forget it.

![A note read whole: the headline it was given, what it is about, who said it when, and its own words — changed, copied, forgotten or given a headline from the same page](https://raw.githubusercontent.com/mujacica/tade/main/images/note.svg)

## A remote control, while the window is open

The same floor on a phone you paired by scanning a code in the window. It opens on an overview of
every project at once — what wants you, what is working, what is queued, what it cost and the
quota that runs out first, five figures on one line — then the work that wants somebody,
with the presses that device was granted right on the card (allow, deny, done, set aside), then
every project as a card with the shape of its work. Tade is one press away from anywhere: the
middle of the tab bar on a phone raises the conversation as a sheet, and the search in the header —
`⌘K` at a keyboard — is one bar that sends what you type to Tade, or jumps to any screen, project or
piece of work by name. The agents and the queue are the tab beside it, a drawer split by project. Letting a device in is a keypress here, so a
typed address reaches the pairing page with nothing to present. The listener dies with the window —
on a server, `tade serve` is the window and never closes — and a page opened with Tade closed says it cannot reach the machine — and, where the phone kept its
last view, what it last knew — never an empty control room.

![Tade's away view on a laptop and then a phone: the overview with what needs you and its presses, the agent waiting on npm i stripe@15 with Allow and Deny and its screen, two plans with their steps, the morning's spend against each plan's limits, and three phones](https://raw.githubusercontent.com/mujacica/tade/main/images/away-page.svg)

On a laptop it takes the window's shape — the places in a menu down the left, the work down the
right a project at a time (its agents with their marks, grouped by plan, and its queue hung as a tree
of what waits on what), and Tade docked at the foot of the middle; each of the three folds, with
`[`, `]` and `\`, and stays folded on that device. Every page in the middle is one template: a bar
level with the side's own heading — its name, where it is one row of, and what may be done there —
then groups headed as the menu heads its own. An agent's page opens on what it is doing now —
washed in its tone when it wants you or failed — with its checks, branch, spend and plan beside it,
then its screen with a box to tell it something, its timeline, what was asked for and the controls.
The picture above is the page drawing itself: its own code over a made-up morning, the same one the
window's pictures show. Pairing is four steps the page leads you through:
open Tade, scan its code — or, on a computer, click the link under it or its Open or Copy — name
the device, approve it at the machine. What its
screen shows is a grant of its own, per device and off for every one: the last rows, read only
while that page is open, with machine paths and every key Tade knows of taken out. Nothing on the
page types into an agent; what you say goes through Tade.

A device asking in is a card at the top of the panel — what it calls itself, where it came from in
words, that a yes grants full access, a bar for the minute it has, and Approve or Refuse, the same
`a` and `d` as approving a tool call. What each device may read and do is granted here, per device,
a box each, ticked where it was granted, and pointing at a box says in one line what it grants.

**Your own phone is you.** Paired with full access — every box ticked, which is what pairing gives
unless you untick one — it does whatever you can at the machine Tade runs on: what you type there
is your own words, it changes any setting, a key included (typed, never shown), and the orchestrator
answers it with the reach your keyboard has. Pulling the plug is revoking it — **Sign out** beside it in the
device list, or `tade web revoke` — and that takes it back at its next press. A device with anything
unticked keeps exactly what is ticked, its messages are never your words, and Tade's tools are
narrowed in code to its view. Every device acts only from this machine or an `https` name you
trusted, and every act one takes is in the journal under its own id. The two pictures below are the
window's end of it.

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/away.svg" alt="The away view in the window with a phone asking to pair: a card with the device, where it came from, that a yes grants full access, a countdown bar, and Approve in green and Refuse in red with their keys; then the code to scan, and that an agent on this machine could pair itself"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/away-devices.svg" alt="The away view with acting on: every device with whether it is connected, where it paired from, what it reads, a ticked box per thing it may do, and in one line what the box under the pointer grants"></td>
</tr>
</table>

Turning it on is one switch, in Settings › Away view, and the code, its link and the devices appear
under it at once. The strip at the foot of the window says which it is — `remote off`, or `remote 2`
in green for the devices with a page open — and pressing it goes to that switch, or to the code once
something is listening. The switch is off until you turn it; every step under it is on, each
applies as you change it — the listener is built again, and a phone with a page open comes back on
it — and each is still nothing to a device until you grant that device here:

| Switch | Default | What it adds |
|---|---|---|
| **Serve the away view** | off | a listener while this window is open, and the code to pair with drawn under the switch |
| **Who can reach it: lan** | this machine | plain HTTP on your wifi, and read-only whatever else is on — `tailscale serve localhost:7654` gives a phone HTTPS and leaves Tade listening here |
| **Public name** | none | the internet, through Caddy on a server of yours: a second listener on a socket only Caddy can open, where nothing is ever this machine, and each phone's own pairing limit — `tade host domain` and `tade host caddy` say the rest |
| **Passkey before acting** | 12 hours | from the public name, a device acts only within this many hours of using its passkey — a face, a fingerprint, a passcode — made on it in the minutes after it pairs, so a session copied off a phone reads and cannot act. Reading never asks; nought asks nothing |
| **Act** | on | your own phone, with full access, does what you can at the machine; any other device, only what is ticked for it — and either only from this machine or an `https` name you trusted |
| **Talk to Tade** | on | free text into the same conversation: from your own phone, your own words; from any other device, answered with its tools narrowed to its own view |
| **Save draft workflows** | on | one field at a time, into a file no run reads until you publish it here |
| **Change settings** | on | only what an ordinary request is enough for — the sidebar's width, the strip's height, the editor, what a project pushes — two presses each, under the device's id. Your own device, with full access, changes any setting as you would here, a key included; on any other, anything that needs your own words is changed here. A key is said as set or not set, never shown |
| **Install · keep · be told** | on | the page and two icons; counts and a moment; a notification with a count, and the work's name while **Get work names in them** is on and that device may read names |

![The away view in Settings, turned on: the code, its link and the devices under the switch, then what a paired device may do as short names under one heading](https://raw.githubusercontent.com/mujacica/tade/main/images/away-settings.svg)

On a box with no screen — a server of yours — the shell is the machine: `tade web pair` over SSH
prints the code in your terminal instead, and running it was the yes, so nobody is asked again. The
code works once, within five minutes, on the name its link carries, and a new one takes the last
back. `tade web pair --owner` mints an **owner device** for the Tade on the machine you came from: a
session bound to the server's own address, so it works only through SSH and never over its public
name, whose messages to Tade reach what you would reach at that server's keyboard — and what you type
on that server's tab is your own words there, while what the Mac's orchestrator passes on never is.

```sh
tade web               # what is on, and where
tade web pair          # a code to scan, from a shell: over SSH, on a box with no screen
tade web devices       # who is paired, owners marked, and what each may do
tade web revoke --all  # disconnect every one of them, and every code nobody used
tade web connect       # where the guided pages that connect GitHub, Slack and Linear are
```

## Models and harnesses

Pick what the orchestrator runs on and what every new agent starts on — every model you are signed
in to, priced per million tokens — and how hard it should think.

![Choosing a model: every model the harness is signed in to, with what it costs in and out, filtered as you type](https://raw.githubusercontent.com/mujacica/tade/main/images/models.svg)

Agents run in **pi**, **Claude Code** or **Codex**, side by side, one harness per agent, moved from
one to another from its menu — or in any agent that speaks the **Agent Client Protocol** (Gemini
CLI, opencode, goose, Copilot CLI, Kiro CLI), whose conversation Tade draws in its lane.

Claude Code and Codex sign in as themselves — Tade never sees it — and each can run as more than one
account at once: your personal subscription and your company's, side by side. Choose which one new
agents run as for the machine, and remember a different one for a project, so the company repository
always runs on the company's plan; switch in Settings, from a terminal, or by asking the
orchestrator in your own words. A switch is for new agents — one already working stays where it is,
and one that runs out moves to another account from its menu, its conversation with it.

![Accounts: each harness's own sign-in, a second Claude Code account beside it that one project runs as, how much of the plan is used, and what can be done to each](https://raw.githubusercontent.com/mujacica/tade/main/images/accounts.svg)

```sh
tade accounts                                    # every sign-in, its plan, and who runs as it
tade accounts add claude-code work               # a second sign-in, in a folder of its own
tade accounts use claude-code work -p payments   # payments' new agents run as work, remembered
```

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

## Sentry, both ways

Point the Sentry extension at your organisation and *"fix new Sentry errors as they come"* becomes a
watch: each new issue is an agent with the stack trace, the trace and the logs already in its
context. Point Tade's own telemetry at a Sentry project of yours and it reports **itself** the same
way — its crashes and its own warnings, never your code or what you said — so Tade can be handed its
own bug.

![An agent started from a Sentry issue: the issue and trace one click away, the context file the first thing it reads](https://raw.githubusercontent.com/mujacica/tade/main/images/sentry.svg)

## Resources

Tade has to be light, and proves it: what it and everything it runs is using, in the status bar and
broken down by project, by kind and by agent.

![Resources: CPU and memory by project, by kind, and by agent](https://raw.githubusercontent.com/mujacica/tade/main/images/resources.svg)

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
every driver, harness and forge declares what it needs and how to ask it its version. What nobody can
be asked about comes back as *cannot tell* rather than a guess, and Tade itself is a row like any
other.

The window asks what is current once a day (Settings › Window › *Check for updates*: daily, weekly or
never) and keeps the answer, so the next window knows it without asking again. When something can
move forward, a chip in the strip says `updates 2`. Pressing it runs the exact commands Settings ›
Updates shows, one after another, in an `updates` terminal put in front of you — `updating 1/2` while
it goes — and says what came of it in the conversation: what moved and to what, and for anything that
failed, its command and the last of what it printed. Nothing installs anything behind your back.
When Tade itself moved, the window offers to reload into it, says what that would stop, and the chip
turns into `reload Tade` until you do. The orchestrator can do both when you ask it to — "update
Tade", then "reload" — and it is the same run, checked against what you actually said.

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/updates.svg" alt="Updates: every program Tade runs with how it got here and what is current, the exact command before anything runs it, and what reloading would cost"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/mujacica/tade/main/images/reload.svg" alt="Tade was updated from the strip: the window offers to reload into the new one, and says what that would stop"></td>
</tr>
</table>

## Planned

Not built yet, and named here rather than anywhere above, at the part of Tade it would be built on.

- **Time from done to landed**, beside the cost per landed task on Evaluations
  (`evaluationsFrom`, `core/src/evaluations.ts`). Evaluations already says how long work took to
  finish; nothing yet folds the stretch from `task_done` to the merge that landed it into a figure
  per harness, model, persona and template. Work committed straight onto a shared checkout has landed by the time it is
  done, so the figure is about reviews.

## Installing

One npm package, `tade-sh`; the command is `tade`. macOS and Linux (**Windows is not supported
yet**), Node ≥ 22.19 and git. Every machine runs its own Tade — its own home, journal and agents —
and the Mac's window shows and drives the others over SSH. Agents run as the user Tade runs as, on
every machine.

| Where | What you run | What you get |
|---|---|---|
| [Your Mac](#on-your-mac) | the installer, then `tade` | the window; agents work while it is open, and with tmux after it closes |
| [A VPS](#on-a-vps) | the installer, `tade setup` and `tade host service` over SSH | agents that keep working with the laptop shut; a phone and webhooks through a domain of yours |
| [Both](#from-your-mac-to-your-vps) | `tade remote add vps --ssh vps` on the Mac | every machine's projects as tabs in one window |

### On your Mac

```sh
curl -fsSL https://tade.sh/install.sh | sh
tade                                          # the window; the first time, a short setup
```

The one-liner installs `tade-sh` from npm with whichever of npm, pnpm or bun you have — it downloads
no binary and builds nothing, prints the exact command before it runs it and never asks a question.
Read it first at [tade.sh/install.sh](https://tade.sh/install.sh) or
[`scripts/install.sh`](scripts/install.sh). Or by hand:

```sh
npm install -g tade-sh
pnpm add -g tade-sh  && pnpm approve-builds -g
bun add -g tade-sh   && bun pm -g trust --all
```

**The second command on the pnpm and bun lines is the one people miss**: both hold a dependency's
install scripts until you say so, and so does npm from 11.19, which is why the one-liner passes
`--allow-scripts`. node-pty (every terminal Tade opens) and better-sqlite3 are native, and an
unbuilt node-pty is a Tade that cannot open a terminal; setup says so and how to fix it.

The first `tade` is setup: it looks at the machine, offers to install what is missing — the exact
command on screen first, run in a terminal you are watching — and ends by opening a lane, so "all
set" means a terminal that opened. `tade setup --check` does it again whenever you like. Optional:
tmux 3.2 or newer (agents that outlive the window), whisper.cpp and ffmpeg (speech), `gh` (pull
request state).

### On a VPS

Any Debian or Ubuntu box you can reach over SSH, as an ordinary user with sudo.

```sh
sudo apt-get install -y git tmux build-essential python3   # plus Node 22, from nodejs.org or your distribution
curl -fsSL https://tade.sh/install.sh | sh                 # into ~/.local where npm's global folder is root's
tade setup                                                 # over SSH: it knows the box has no screen
tade host service                                          # the systemd user unit for `tade serve`; starts it
```

**Setup** gives each missing program its exact `apt` or `dnf` line and signs each harness in the
way a server can — Claude Code's link and pasted code (with the days its login has left), Codex's
device code, pi's pasted code, or an OpenAI-shaped endpoint in pi's `models.json`. Pick tmux
(`workspace.driver: tmux`), so restarting or upgrading Tade never ends an agent, and say yes to
`loginctl enable-linger` and the unit. **The service** runs `tade serve`, the window with no screen
— queue, schedules, watches, intake, the orchestrator and the away view — and logs to `journalctl
--user -u tade.service -f`.

That is a working remote. A phone and webhooks also need a name of yours on the internet:

```sh
tade host domain tade.example.com   # the A, AAAA, DNSSEC and CAA records it needs, each checked; sets the name on a press
tade host caddy                     # the Caddy site block, and the one root line that makes its socket's directory
tade web on                         # serve the away view; behind Caddy, on a socket only Caddy can open
tade host caddy --check             # the directory, the socket, the certificate and Caddy's version, from the box
```

`tade host domain` says of each record whether it is missing, wrong or not yet visible, with the
exact record to add. `tade.sh` and the names under it are refused: it serves the installer. The
site block needs **Caddy 2.7 or newer**, which Debian's and Ubuntu's own package is not — install it
from [Caddy's apt repository](https://caddyserver.com/docs/install).

### From your Mac to your VPS

```sh
tade remote add vps --ssh vps   # vps is a Host in ~/.ssh/config, user@host or ssh://user@host:port
tade remote carry vps --keys    # send the keys too, after saying what that means
tade remote status              # up, down or signed out, and since when
```

`tade remote add` shows a box it has never met by its host key's fingerprint and trusts it only when
you say so (`--accept-key` for a script); a changed key is said plainly and never trusted. It pairs
this Mac as an **owner** of that Tade over SSH (`tade web pair --owner` there), carries your
preferences, personas and published templates, signs in each harness this Mac uses through its own
sign-in in your terminal — a subscription token never passes through Tade — and ends with a
checklist of what was carried and what still needs you; Settings › Remotes shows the same. Keys,
MCP servers, the telemetry DSN and intake's grants wait on a press. A box whose `tade` is not on the
PATH an SSH command gets takes `--tade ~/.local/bin/tade`.

**Several remotes**: run `tade remote add` once for each. `tade remote list` names them, `tade remote
remove vps` signs this Mac out of one. While the window is open it holds one SSH connection to each
and dials again by itself after a dropped network, and at once when the lid opens.

**From the Mac you see all of it** ([Many projects](#many-projects-many-tasks) has the pictures):

- each machine's projects as tabs under its name, with its agents' marks — `○` and `as of 13:52`
  while its link is down;
- an agent there opened here: its screen, steer, park, stop, allow or deny, and Enter types into it
  over SSH, or mosh where both machines have it;
- that machine's orchestrator on a tab beside the Mac's;
- its checks, schedules, documents and findings on its project tabs, and its spend as a row of its
  own;
- notes shared both ways, and the collision forecast across both machines' branches of one
  repository;
- work handed over: **Hand \<task\> to vps** on that machine's menu for a running task, **Start on
  vps** on a queued card, and a whole project moved in Settings › Remotes.

**With the laptop shut**, the VPS carries on: its agents, queue, schedules, watches and intake run
under systemd with nobody connected — and each project's watches run on one machine, the VPS by
default (Settings › Projects). Hand anything still running on the Mac to the VPS before the lid
closes. When it opens, each machine's tab says what happened since you were last at the keyboard —
what waits on you, what finished, what is held, what it cost — and the notes taken in between are on
both. While you are at the keyboard, the phone's notifications wait.

### Connecting GitHub, Slack and Linear

Each is a guided page on the machine that watches, `/connect`:

```sh
tade remote connect vps   # from the Mac: the VPS's own pages, in this Mac's browser, until ctrl+c
tade web connect          # on the box: where they answer, to open there or through ssh -L
```

Each makes an app of your own — a read-only GitHub App, an internal Slack app, a private Linear app
that may only read — from a manifest, says what it asks for before you press, and ticks off
installing it and its first delivery. With a public name, a signed webhook to
`https://<name>/hooks/github`, `/hooks/slack` or `/hooks/linear` makes the watch look at once, and
its poll slows to hourly. `tade intake status` says what each source still needs. Connecting grants
nobody anything; whose requests count is still yours to write
([A software factory](#a-software-factory-work-that-arrives-on-its-own)).

### Pairing a phone

```sh
tade web pair             # on the box, over SSH: a code to scan, good once, for five minutes
tade web devices          # who is paired, and what each may do
tade web revoke <device>  # pull the plug on one; --all for every device and unused code
```

Scan the code and the page opens on your public name, pairs, and asks the phone for a **passkey** —
a face, a fingerprint, a passcode. From then on it acts from the public name only within 12 hours of
using it (Settings › Away view › *Passkey before acting*); a session copied off the phone reads and
cannot act. Your own phone, paired with full access — what pairing gives unless you untick
something — **is you**: whatever you can do at that machine, it can. If it is lost, revoke it; that
needs no network. On a Mac, a phone pairs from the code in the window
([A remote control](#a-remote-control-while-the-window-is-open)).

### Backups and upgrades

```sh
tade host backup --init sftp:u1@u1.your-storagebox.de:tade   # where (a folder, SFTP, S3, REST); prints the password once
tade host backup                                             # one now
tade host backup --timer                                     # every hour, as a systemd timer
tade host restore --from sftp:u1@u1.your-storagebox.de:tade  # on a new box: the latest back, writing over nothing
tade host upgrade                                            # Tade forward in place, a backup first, no agent ended
```

Backups are restic's, encrypted: Tade's home and each harness's conversations, never the journal's
index or the worktrees, and each one says which checkouts hold work pushed nowhere. A restore prints
the `git clone` for each checkout it does not find. `tade host upgrade` asks the new Tade to start
before the service restarts onto it, and says the version and lanes it came up with. From the Mac,
when a box's Tade is behind, Settings › Remotes has **Upgrade Tade there**. On the Mac itself it is
the `updates` chip ([Up to date](#up-to-date-and-honest-about-it)).

### What the rehearsal proved

The whole story above was rehearsed from nothing: two fresh Debian 12 boxes as the VPSes and an
isolated Mac, each installed from the tarball a release would publish, with pi on a local stand-in
model so agents could work with no key. Every step worked — install, setup over SSH, the service, a
stand-in domain, Caddy, pairing through Caddy, `tade remote add` for both boxes, agents started from
the Mac and seen finishing, "since you were here" and a box's notes after the window had been
closed, a running task handed to a box, a box's checks, schedules and documents read from the Mac,
and a signed GitHub webhook through Caddy waking a watch. The twenty rough edges it hit were fixed,
one commit each.

It is held by `packages/app/test/wire/rehearsal.test.ts`, which runs in CI — two real `tade serve`
through a real sshd, paired by the real `tade remote add` — and by `scripts/rehearse-remote.sh up`,
`mac`, `hook` and `down`, which needs docker. Not yet proved on a real VPS with a real domain: a
Let's Encrypt certificate and its CAA record, real DNS records and DNSSEC, real GitHub, Slack and
Linear webhooks, a real phone's passkey and push notifications, mosh across a real network, real
harness sign-ins and a real model, and `tade host upgrade` from npm under systemd.

macOS Terminal puts its own parts around the title Tade sets — the folder, the program and its
arguments (`node …/pnpm.cjs run tade` under `pnpm tade`), the size — and for a title that is only
Tade's, `⠏ tade · 2 working`, untick *Working directory or document*, *Active process name*,
*Arguments* and *Dimensions* under Settings → Profiles → Window → Title.

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

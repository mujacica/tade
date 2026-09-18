# Naming: what to call this thing instead of Wilco

Research, not a decision. Nothing in the code is renamed by this document.

Checks run **2026-09-18**. Availability rots fast, so every command used is written down; any line
here can be re-run before anyone acts on it.

**Revision:** a first pass optimised for a *brandable* name and produced long, careful words
(Watchwright, Yardmaster, Airboss). That was the wrong target. This product is **spoken to** — you
hold `ctrl+space` and talk, and you will want to say "Hey ⟨name⟩" next to "Hey Claude" and "Hey
Gemini" without either of them answering. So callability now leads, and the long names are kept in
[Appendix A](#appendix-a--the-longer-brandable-names) for the record.

## 1. What is being named

- A **voice-first control room**: an orchestrator you talk to, which starts, steers and stops other
  agents, runs commands in terminals, and shows its work.
- **Lanes**: agents are pi processes in terminals, many at once, in the checkout or a worktree each.
- **Status is derived, never remembered**: git, processes, tests and liveness are probed and reduced
  by a pure function. It owns no state of its own.
- **A queue, schedules and watches**; **extensions, telemetry, spend, approvals**.

Which means the name must carry: **many workers, one place you watch them from, and a voice.**
"Wilco" — one radio word meaning *I will comply* — names a single obedient agent: the name of the
smallest version of this product.

### Why Wilco has to go

| Collision | What it is |
|---|---|
| `wilco.com` | **WILCO AG**, Swiss maker of container-closure inspection machines. Live site, real mark. |
| Wilco | The band. Owns the word in search and on Wikipedia. |
| `trywilco.com` / `wilco.gg` | **Wilco**, the developer-upskilling startup — now a goodbye page ("joining Lemonade"). A funded dev-tools company used this name in this market. |
| npm `wilco` | Taken since 2015 (a CSS linter). |
| GitHub `wilco` | Taken; `SonnyBonds/wilco` is a C++ build generator. |
| Wilco Publishing | Flight-sim add-on publisher — the same aviation-radio well. |

Spoken, it fails too: "Hey Wilco" is four syllables of which two are a *procedure word most people
have to be taught*, and "Wilco" sounds like "Wilkins", "Willow", "Wilco" the band, and a Dutch first
name. Checked with `registry.npmjs.org`, `gh api users/wilco`, GitHub repo search, Wikipedia search
and `<title>` fetches of all four domains.

## 2. What the name has to do — in priority order

1. **Survive "Hey ⟨name⟩"** next to Claude, Gemini, Siri and Codex in the same room. Concretely:
   - **2–3 syllables in the whole phrase.** "Hey Siri" is three; "Hey Sarge" is three; "Hey
     Watchwright" is five and nobody will say it twice.
   - **At least one stop or affricate** (`p t k b d g tʃ dʒ`) so an onset detector has something to
     bite on. All-sonorant names ("Nolan", "Arlo", "Vela") are mush at low volume.
   - **Not a word you say in normal dev speech**, or it fires by accident: "Hey Deck", "Hey Copy",
     "Hey Chief", "Hey Watch" are all things you would otherwise say mid-sentence.
   - **Phonetically far from the assistants beside it.** Claude, Codex, Cursor, Copilot all open on
     /k/ + a back vowel; Gemini opens on /dʒ/ + front vowels. A name opening on **s-, f-, t-, b-,
     j-** with a different vowel spine is least likely to cross-trigger.
   - **Spellable after hearing it once**, or people can't find the docs.
2. **Understood in one beat.** No footnote, no etymology lesson. If it takes a sentence to explain,
   it is a worse name than one that takes none.
3. **Typed constantly.** ≤ 6 characters for the binary is comfortable; the binary may be a clipped
   form of the name (Foxtrot → `fox`), which is normal (Kubernetes → `kubectl`).
4. **Clear in *this* market** — dev tools and AI agents. A hardware company or a comic strip with
   the same word is noise; a Rust crate with 4k stars or an agent framework is a real problem.
5. **A domain we'd be happy to print.** Deliberately fourth: see §4.

## 3. How checks were run

Each endpoint was **control-tested** against a known-registered and a known-free name before its
answers were trusted. This matters: `www.registry.google/rdap/domain/<x>.dev` returns `404` for
*everything* (it claims `web.dev` is free), which invalidated an entire first pass of `.dev` results.

| Check | Command | Semantics |
|---|---|---|
| `.com` | `curl https://rdap.verisign.com/com/v1/domain/<n>.com` | 404 free, 200 registered |
| `.dev` | `curl https://pubapi.registry.google/rdap/domain/<n>.dev` | as above (control: `web.dev` → 200) |
| `.io` | `curl https://rdap.identitydigital.services/rdap/domain/<n>.io` | as above |
| `.ai`, `.sh` | `whois -h whois.nic.ai <n>.ai` · `whois -h whois.nic.sh <n>.sh` | "Domain not found" = free |
| `.app .run .tools .works .team` | `curl -L https://rdap.org/domain/<n>.<tld>`, throttled ≥ 3 s (it 429s) | 404 free |
| npm package | `https://registry.npmjs.org/<n>` | 404 free; publish dates read to see if it is abandoned |
| npm scope | `https://registry.npmjs.org/-/v1/search?text=scope:<n>` | `total: 0` = nothing published under it |
| GitHub | `gh api users/<n>` · `gh api search/repositories -f q='<n> in:name' -f sort=stars` | handle + top repos read by hand |
| PyPI / crates.io | `pypi.org/pypi/<n>/json` · `crates.io/api/v1/crates/<n>` | 404 free |
| Products/companies | `<title>` of `<n>.com` and `<n>.ai`; Wikipedia `list=search` | who actually holds it |

**Limits, stated plainly.**

- **No trademark register was searchable.** Justia is behind Cloudflare (403), USPTO's search API
  refuses anonymous queries, TSDR needs a key, WIPO needs JavaScript. Every "trademark" note below is
  an *inference* from registrants, live sites and public knowledge — **not clearance.** Whatever is
  chosen needs a real search (USPTO + EUIPO, classes 9 and 42) before money is spent.
- **npm *scope* registration can't be verified**; `npmjs.com/org/<n>` returns 403 to scripts. "Scope
  clean" below means *nothing has been published under it*, which is not the same as the handle
  being free. Find out by trying to create it.
- **Web search was mostly unavailable** (DuckDuckGo's HTML endpoint answered once then CAPTCHA'd;
  Bing served unrelated pages; Mojeek and Qwant challenged; Google needs JS). GitHub, npm, PyPI,
  crates.io, Wikipedia and homepage titles did the collision work. They cover software collisions
  well and consumer brands badly.
- My own knowledge of companies has a cutoff, so "no product I know of" is weaker than a registry
  result and is labelled where it is all there is.

## 4. Three facts that decide this

**(a) A short name has no exact-match domain. Anywhere. In any TLD.** Of roughly 140 names checked,
every 1–2 syllable real word was registered in `.com`, `.dev`, `.ai`, `.sh` *and* `.io`
simultaneously: tower, deck, chief, sarge*, gaffer, skipper, bravo, foxtrot, roger, parley, marshal,
shep, kelpie, drover, holler, herald, houston, baton, rondo, vigo, marco, capo, wren, rudder, tiller,
cleat, pennant, burgee, depot, roost, loft, vela, petrel, corvo, sula, orla, tova … (*`sarge.sh`,
`jackdaw.sh`, `mizzen.sh`, `talko.sh`, `aviso.sh`, `krewe.sh` are the only free `.sh`s found among
them.) Four-letter invented strings are gone too (`nalo`, `rilo`, `vardo`, `parla`: `.com` taken,
nothing on it). Even most `hey<word>.com` are taken — only `heyfoxtrot`, `heymizzen`, `heytalko`,
`heydrover`, `heykelpie`, `heycapcom` were free.

**(b) So the domain must not veto the name — because it never has in this category.** `bun.sh`,
`go.dev`, `deno.com`, `astral.sh` (uv/ruff) all resolve today; Go shipped on `golang.org` because
Disney had `go.com`, Rust on `rust-lang.org`, Zig on `ziglang.org`, ripgrep and fd have no domain at
all. And the bare npm name is optional: a package published as `@name/cli` can still install a
`name` binary, which is what this repo already does (20 packages under `@wilco/*`, `bin: wilco`).
Treating `<word>.com` + `npm i -g <word>` as requirements is what forces you into eleven-letter
coinages nobody will say out loud.

**(c) The obvious metaphor space is being colonised right now, by tools exactly like this one.** All
found while checking, all 2025–2026: `watchbill.ai` ("the operating layer for Supervised Autonomy") ·
`sortie-ai/sortie` ★187 ("turn tracker tickets into autonomous agent sessions") · npm `ringdown` ("a
switchboard for coding agents and their humans") · npm `quarterdeck` ("a quarterdeck foundation for
coding agents") · npm `pitwall` (Claude Code session reviewer) · `racecraft-lab/Paddock` ("AI software
factory control plane") · `TraceRt314/airboss` ("control tower TUI for Claude Code and Codex") ·
`aethrox/laneward` (runs agents in worktrees) · `gw7523/watchbill` ("cockpit CLI … coding-agent
fleets") · `NVIDIA-NeMo/Switchyard` ★3148. Re-verify on the day, and take the name's handles in one
sitting.

## 5. Short, callable candidates

Wake-word column: syllables of the full "Hey ⟨name⟩" phrase / onset consonant / false-trigger risk.
Availability: `✓` free, `✗` taken. "npm" is the bare package name; a scoped `@name/cli` is always
available as a fallback, so `✗` is a nuisance, not a blocker.

| # | Name | Say it | Binary | Wake word | npm | `.sh` | Domain plan | Market collision |
|---|---|---|---|---|---|---|---|---|
| 1 | **Sarge** | "Hey Sarge" | `sarge` | 3 syl · /s/ · very low | ✗ (dead 2017) | **✓** | `sarge.sh`, `getsarge.com` ✓ | **none in dev/AI** |
| 2 | **Foxtrot** | "Hey Foxtrot" | `fox` | 4 syl · /f/ · none | ✗ (dead 2014) | ✗ | `foxtrot.ai` **for sale**, `heyfoxtrot.com` ✓ | comic strip; Bevy demo ★871 |
| 3 | **Talko** | "Hey Talko" | `talko` | 4 syl · /t/ · none | **✓** | **✓** | `talko.sh` ✓, `heytalko.com` ✓, `talko.ai` for sale | dead MS/Ray Ozzie app (2015) |
| 4 | Tower | "Hey Tower" | `tower` | 4 syl · /t/ · medium | ✗ | ✗ | nothing | **fatal**: `tower-rs` ★4296, Git Tower, `tower.dev` |
| 5 | Baton | "Hey Baton" | `baton` | 4 syl · /b/ · low | ✗ (squatted) | ✗ | nothing | django-baton ★999, AmEx baton ★289 |
| 6 | Houston | "Hey Houston" | `hou` | 5 syl · /h/ · low | ✗ | ✗ | nothing | city (geographic mark), Astronomer's Houston API |
| 7 | Chief | "Hey Chief" | `chief` | 3 syl · /tʃ/ · **high** | ✗ | ✗ | nothing | generic; and you are the chief |
| 8 | Skipper | "Hey Skipper" | `skip` | 4 syl · /sk/ · low | ✗ (live) | ✗ | nothing | Zalando Skipper (k8s ingress), Sails skipper |
| 9 | Gaffer | "Hey Gaffer" | `gaffer` | 4 syl · /g/ · low | ✗ | ✗ | nothing | Gaffer graph DB (UK gov) |
| 10 | Parley | "Hey Parley" | `parley` | 4 syl · /p/ · low | ✗ (live) | ✗ | nothing | small npm flow-control lib |
| 11 | Marshal | "Hey Marshal" | `mar` | 4 syl · /m/ · low | ✗ | ✗ | nothing | *marshalling* = serialisation |
| 12 | Jackdaw | "Hey Jackdaw" | `jack` | 4 syl · /dʒ/ · none | ✗ | **✓** | `jackdaw.sh` ✓ | Kafka lib ★379, AD recon ★587 |
| 13 | Mizzen | "Hey Mizzen" | `mizzen` | 4 syl · /m/ · none | ✗ | **✓** | `mizzen.sh` ✓, `heymizzen.com` ✓ | none found (meaning opaque) |
| 14 | Aviso | "Hey Aviso" | `aviso` | 5 syl · /ə/ · none | **✓** | **✓** | `aviso.sh` ✓ | none in dev/AI (stress on 2nd syllable) |
| 15 | Kelpie | "Hey Kelpie" | `kelpie` | 4 syl · /k/ · none | ✗ | ✗ | `heykelpie.com` ✓ | `kelpie.ai` is a live platform |
| 16 | Drover | "Hey Drover" | `drover` | 4 syl · /dr/ · none | ✗ | ✗ | `heydrover.com` ✓ | none found |
| 17 | Krewe | "Hey Krewe" | `krewe` | 3 syl · /kr/ · low | ✗ | **✓** | `krewe.sh` ✓ | homophone of *crew*; CrewAI next door |
| 18 | Fulmar | "Hey Fulmar" | `fulmar` | 4 syl · /f/ · none | **✓** | ✗ | thin | none found (meaning opaque) |

### 1. Sarge — *the one who makes the squad move* · binary `sarge` · "Hey Sarge"

**Meaning, in one beat.** A sergeant runs the crew and answers to you. Nobody needs it explained, in
any English-speaking country, and it names the right thing: not the work, not the workers — the one
in the middle who takes your intent and turns it into other people's tasks. Which is the product.

**As a wake word.** "Hey Sarge" is three syllables, same as "Hey Siri". Opens on /s/ and closes on
the affricate /dʒ/ — two features a detector likes, and neither shared with Claude, Codex, Cursor
(all /k/-onset) or Gemini. It is not a word that occurs in normal dev speech, so false triggers are
near zero. Five letters, spells itself, survives any accent.

**Market collision: none that matters.** npm `sarge` exists but has not been published since **2017**
("custom search indexers"); the top GitHub repos are `jhalterman/sarge` (JVM supervision, ★126) and a
C++ argument parser (★91). No AI product, no agent framework, no dev-tools brand. `sarge.com` is a
small live site; Debian 3.1 was codenamed Sarge in 2005. PyPI and crates.io are both **taken** —
irrelevant for a Node CLI, but it means the word is not ownable across ecosystems — and the GitHub
handle `sarge` is an active user (26 repos), so the org would have to be `sarge-sh` or `getsarge`.

**Domains.** `sarge.sh` **free**, plus `.tools`, `.team`, `.run` free; `getsarge.com`, `sargecli.com`,
`hisarge.com` free. `.com`/`.dev`/`.ai`/`.io` taken. Plan: **`sarge.sh`**, `getsarge.com` redirecting.

**Risks, honestly.** It is a nickname, so a weak mark (hard for us to own; equally hard for anyone to
stop us). "Sarge" is also a character name at Disney (*Cars*) and Hasbro (G.I. Joe) — character marks
exist, in toys and film, not software. And the military register won't be to everyone's taste.

### 2. Foxtrot — *the radio alphabet, which is where Wilco came from* · binary `fox` · "Hey Foxtrot"

**Meaning.** NATO "F". The whole point of the spelling alphabet is *to be unmistakable over a noisy
voice channel* — which is literally the design brief for a wake word, and a straight-faced way to
keep Wilco's radio lineage while dropping its baggage.

**As a wake word.** The best phonetic profile in the list: /f/ + /ks/ + /tr/ + /t/, four consonant
landmarks, no other assistant anywhere near it, and nobody says "foxtrot" by accident. Four syllables
in the phrase; two in the name; stress on the first.

**Binary `fox`** — three characters, a real word, unclaimed on a normal PATH: `fox status`, `fox brief`.

**Market collision.** `foxtrot.com` is Bill Amend's *FoxTrot* comic strip; npm `foxtrot` has not moved
since **2014**; GitHub has a Bevy 3D demo (★871) and a STEP file viewer (★341); PyPI and crates.io are
taken; the `foxtrot` GitHub handle is an active user (10 repos). Nothing in agents or orchestration.
Foxtrot Market (the US grocery chain) is the consumer-brand echo.

**Domains.** **`foxtrot.ai` is listed for sale** (Spaceship) and `heyfoxtrot.com` is free; `.com`,
`.dev`, `.sh`, `.io`, `.tools`, `.team`, `.run` all taken. Plan: buy `foxtrot.ai`, or `heyfoxtrot.com`
with `fox.sh`-style alternatives explored.

**Risks.** Two syllables that mean "the letter F" — evocative but not descriptive; and the dance and
the comic will always share the word.

### 3. Talko — *it talks* · binary `talko` · "Hey Talko"

**Meaning.** Coined, but transparent on hearing: *talk* + o. The only candidate that is punchy **and**
fully ownable — which, after §4(a), is rare enough to matter.

**As a wake word.** Two plosives (/t/, /k/), first-syllable stress, open vowel ending — the Alexa/
Cortana shape. Four syllables in the phrase, no false triggers, spells itself (though "Talco" will
happen).

**Market collision.** npm `talko` **free**, `@talko` scope clean, **PyPI and crates.io free**,
`talko.sh` free, `heytalko.com` free, `talko.ai` listed for sale, GitHub handle near-dormant (one
public repo; the loudest `talko` repo is a ★40 Python chat app). The echo is
**Talko**, Ray Ozzie's voice app, acquired and shut down by Microsoft in 2015 — a dead product, not a
live brand, and thematically adjacent enough to be a story rather than a problem.

**Risks.** Reads like a consumer chat app rather than a control room, and says nothing about
orchestration. Weakest *meaning* of the three, strongest *ownership*.

### The one that got away

**Capcom** — in mission control the *capsule communicator* is the single person who speaks to the
crew, because a crew being talked at by twenty flight controllers is a crew that crashes. That is
this product in one word, it is two punchy syllables, and it belongs to a $10bn game publisher.
Dead on arrival; noted so nobody spends a day rediscovering it.

Same graveyard: **Tower** (`tower-rs` ★4296 + Git Tower), **Yarn** (the package manager), **Crew**
(CrewAI), **Argo** (Argo CD), **Zulu** (Azul's JDK), **Falco**, **Echo**, **Helm**, **Radar**,
**Sonar**, **Maestro** (mobile.dev), **Bosun** (npm `bosun` is *already* an AI-agent executor),
**Corvid** (sounds like covid), **Tern** (homophone of "turn" — in a voice product).

## 6. Shortlist and recommendation

| | **Sarge** | **Foxtrot** | **Talko** |
|---|---|---|---|
| Understood with no explanation | yes | partly ("the letter F") | partly ("it talks") |
| Wake-word phrase | "Hey Sarge" (3 syl) | "Hey Foxtrot" (4 syl) | "Hey Talko" (4 syl) |
| Cross-trigger with Claude/Gemini/Codex | very low | lowest | low |
| False trigger in normal speech | very low | none | none |
| Binary | `sarge` (5) | `fox` (3) | `talko` (5) |
| npm bare name | dead since 2017 | dead since 2014 | **free** |
| PyPI / crates | taken / taken | taken / taken | **free / free** |
| GitHub handle | active user → needs a variant | active user → needs a variant | near-dormant (1 repo) |
| Domain | **`sarge.sh`** + `getsarge.com` | `foxtrot.ai` (for sale) / `heyfoxtrot.com` | **`talko.sh` + `heytalko.com`** |
| Dev/AI collision | **none found** | none (comic, game demo) | none (dead MS app) |
| Trademark position | weak mark, low conflict | shared word, low conflict | coined — strongest |

**Recommendation: Sarge.** Binary `sarge`, wake word "Hey Sarge", home `sarge.sh`, packages
`@sarge/*` with `@sarge/cli` providing the binary.

Because it is the only candidate that needs **no explanation at all** and still says the right thing:
a sergeant is the one who takes an officer's intent and makes a squad execute it, reports back what
the state of things actually is, and is addressed by a nickname rather than a title — which is exactly
the register of a tool you talk to all day. It is three syllables to summon, five characters to type,
phonetically clear of every assistant likely to be listening in the same room, and it has no
competitor in dev tools or AI: the only npm claim is abandoned since 2017 and the loudest GitHub
repo has 126 stars. `sarge.sh` is free today, which is more than can be said for any other
one-or-two-syllable word checked.

- **Take Foxtrot if the radio lineage matters** — it is the strongest wake word here on phonetics
  alone, `fox` is the nicest binary in the document, and it keeps continuity with Wilco's own origin
  (one spelling-alphabet word replacing one procedure word). Buy `foxtrot.ai` before someone else
  does.
- **Take Talko if owning the word outright matters most** — npm, `.sh`, `hey*.com` and the GitHub
  handle are all obtainable today, and a coined name is the only genuinely defensible trademark.
- **Whichever it is, register in one sitting** (npm scope, `.sh`, the `hey*.com`, and a GitHub org —
  expect to need a variant like `sarge-sh` for the handle) and re-run §3's checks the same morning.
  §4(c) is why.

## 7. What a rename would touch

Measured, not estimated: **2881 occurrences of "wilco" (case-insensitive) across 380 tracked files.**
Grouped by what breaks if you get it wrong. (Examples use `sarge`.)

**Free to change — cosmetic, nothing depends on it**

| Thing | Where |
|---|---|
| Binary `wilco` → `sarge` | `packages/cli/package.json` (`bin`), root `pnpm wilco` script, README install/use |
| `wilco attach <lane>` default | `packages/drivers/pty/src/index.ts` |
| ASCII banner and the "will comply" tagline | `README.md`, `packages/app/src/screen.ts` — **the pun dies with the name; a new line is needed** |
| Docs | `README.md`, `AGENTS.md`, `CLAUDE.md` (a link), 22 markdown files, 16 recipes in `.claude/skills/` |
| Notices | `THIRD_PARTY_NOTICES.md` + `scripts/notices.ts` (`pnpm notices` regenerates) |
| Prompts saying the agent "runs in Wilco" | `composeAgentPrompt`, orchestrator prompt — re-run the live test afterwards: it is the only evidence a model still picks the right tool from the new words |

**Mechanical but wide — one sweep, then `pnpm check`**

| Thing | Count |
|---|---|
| `@wilco/*` scope → `@sarge/*` | 20 workspace packages + every import |
| Root package name | 1 |
| `WILCO_*` env vars | 20 distinct (`WILCO_HOME`, `WILCO_TELEMETRY_DSN`, `WILCO_LIVE`, `WILCO_SOCKET`, `WILCO_TASK_ID`, …). Two are documented for users, so accept both spellings for a release. |

**Careful — these strand work that is running or already on disk**

| Thing | Where | Why it needs a compatibility path |
|---|---|---|
| `~/.wilco` home | `wilcoHome()`, `packages/core/src/config.ts` | Holds `config.yaml`, `memory.jsonl` (notes — nothing can recover them), `events.jsonl` + its SQLite index, `schedules.jsonl`, `lanes.json`, `window.json`, `skills/`, `extensions/active|proposed/`. Move on first start, or read the old path when the new one is absent. |
| Per-project `.wilco/` | 141 references in `.ts` alone; `tasks/<name>/task.yaml`, `context.md`, `mkrepo` fixtures | Every existing task lives there, and a task's id is in its file, not its branch. |
| Branch prefix `wilco/` | `TASK_BRANCH_PREFIX` in `packages/status/src/status.ts` and `packages/workbench/src/tasks.ts`, `app.ts`, `mkrepo.ts` | Branches already pushed keep the old prefix; status must accept both, probably forever. |
| pi session ids `wilco-<task>` | `sessionIdFor()`, `packages/harnesses/pi/src/adapter.ts` | The id is what makes reopening ordinary. Change the formula and every existing agent loses its conversation — and task names are never reused, so there is no second chance. Keep the old prefix for tasks that already have a session. |
| tmux `-L wilco`, session `wilco`, `@wilco-lane` / `@wilco-spec` | `packages/drivers/tmux/src/index.ts` | A window that renames these cannot `list` or `adopt` the lanes the previous one left running — healthy agents would be reported gone. Adopt the old names too, or drain before upgrading. |
| Event kinds `wilco_opened`, `wilco_closing` | `packages/core/src/events.ts`, workbench | `events.jsonl` is the truth and is append-only: add new kinds, keep reading the old. |
| Tool names `wilco_*` | 36 distinct (`wilco_status`, `wilco_plan`, `wilco_task_create`, `wilco_run_start`, `wilco_done`, …) | This is the model's vocabulary. `wilco_done` is what every agent is told to call; renaming it mid-flight leaves running agents calling a tool that no longer exists. Rename with the prompts, in one release. |
| Telemetry | `telemetry/shape.ts` (`KEPT`), Sentry project/environment naming, README's `projects: { wilco: … }` | The allow-list is names-only by design; renaming keys changes what is sendable. |

**Order.** Secure the name (npm scope + package, GitHub org, `sarge.sh`, `getsarge.com`) → rename the
outward-facing surface, keeping `wilco` as an alias for one release → rename the scope and env vars,
accepting both → leave the on-disk and protocol names behind compatibility readers, and delete those
readers only once no machine has an old home on it.

---

## Appendix A — the longer, brandable names

From the first pass, when `.com` availability and trademark strength were weighted above being
callable. Useful if the decision goes the other way — or as a company name over a product called
Sarge.

**Watchwright** (binary `wright`) was the pick: a *watch* is the shift that is awake and answerable,
a *wright* is one who makes and keeps a thing working, and it is the only name found with **nothing
taken anywhere** — `.com`, `.dev`, `.ai`, `.sh`, `.io`, npm, scope, GitHub org, PyPI, crates all free,
no Wikipedia entry, no repos. Being coined also makes it the strongest mark available. It fails §2:
eleven letters, three syllables, five in "Hey Watchwright".

**Airboss** (binary `airboss`) — the officer who runs a carrier's flight deck by radio. The best
*meaning* in either list, npm + scope + PyPI + crates free, `airboss.dev` and `.sh` free. Risks:
AirBoss of America (a listed manufacturer) owns `airboss.com` and the mark, and a hobby "control
tower TUI for Claude Code" already uses the word.

**Yardmaster** (binary `ym`) — the one who decides which train takes which track: the plainest
English for lanes + a queue + derived status. npm + scope free, `yardmaster.sh` free. Weak as a mark
(occupational term) and ten letters with no good short form (`yard` is Ruby's YARD binary).

Also checked and written up in that pass: Earshot · Lanewright · Orderwire · Flightline · Dogwatch ·
Fairlead · Hawser · Marshaller · Binnacle · Pelorus · Quarterdeck · Wheelhouse · Interlock · Apron ·
Sitrep · Muster · Reeve · Paddock · Pitwall · Switchyard · Conn. The short version of why each lost:
`pelorus` is a live DORA-metrics tool; `quarterdeck`, `pitwall` and `paddock` are already coding-agent
tools on npm or GitHub; `switchyard` is an NVIDIA project with 3k stars; `wheelhouse` means a
directory of Python wheels; `interlock`, `apron`, `sitrep`, `muster`, `reeve` and `conn` are buried in
search; `earshot` collides with a voice-activity-detection library in our own niche; `binnacle`'s npm
name belongs to a dead logging SaaS.

---

*Nothing was renamed in the process of writing this. The only file added is this one.*

# Naming: what to call this thing instead of Wilco

Research, not a decision. Nothing in the code is renamed by this document.

Checks run **2026-09-18**. Availability rots fast, so every command used is written down; any line
here can be re-run before anyone acts on it.

**Revisions.** Pass 1 optimised for a *brandable* name and produced long, careful words
(Watchwright, Yardmaster, Airboss) — the wrong target: this product is **spoken to**, and you will
want to say "Hey ⟨name⟩" next to "Hey Claude" and "Hey Gemini" without either of them answering.
Pass 2 put callability first and landed on **Sarge**. Pass 3 added **softness** as a hard criterion,
because Sarge is a bark: /sɑːrdʒ/ ends in an affricate after an r-colored vowel, the harshest shape
English has — that set is §6. Pass 4 asked for a name **out of the work itself** — the IDE, the
workshop, the crew of agents — which is §7, and its recommendation (**Andon**) turned out to be an
AI company, which is why §3 now includes a **company and launch sniff** and why everything earlier
was re-checked with it. Pass 5 asks whether the product should be branded an **"Agentic Terminal
IDE"** — §8 — because the positioning decides which shelf the name comes off. §9 is the shortlist:
**Jig** if it is an IDE, **Sarge** if it is a crew you talk to, **Talko** or **Obeya** if owning the
word matters most. The long brandable names stay in
[Appendix A](#appendix-a--the-longer-brandable-names).

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
2. **Be soft in the mouth.** A name you say fifty times a day should not be a bark. What makes a
   word hard: an **affricate or hard stop in the coda** (`-rge`, `-ck`, `-tch`, `-x`), an
   **r-colored vowel** before it (`ar`, `er`, `or`), and clustered consonants. What makes one soft:
   **nasals and laterals** (`m n l`), an **open vowel ending**, a single light stop *in the middle*
   rather than at the end — the Siri / Alexa / Cortana / Jules shape. Ranked: `Sarge` /sɑːrdʒ/ and
   `Foxtrot` are hard; `Talko`, `Marlo`, `Wilkie`, `Mabel` are soft with a plosive; `Willa`, `Navvy`,
   `Aviso` are softest and have no stop at all.
3. **Understood in one beat.** No footnote, no etymology lesson. If it takes a sentence to explain,
   it is a worse name than one that takes none.
4. **Typed constantly.** ≤ 6 characters for the binary is comfortable; the binary may be a clipped
   form of the name (Foxtrot → `fox`), which is normal (Kubernetes → `kubectl`).
5. **Clear in *this* market** — dev tools and AI agents. A hardware company or a comic strip with
   the same word is noise; a Rust crate with 4k stars or an agent framework is a real problem.
6. **A domain we'd be happy to print.** Deliberately last: see §4.

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
| **Company sniff** | `<title>` of `<n>.ai`, `<n>labs.com`, `<n>ai.com`, `use<n>.com`, `get<n>.com` | **the AI land grab lives here** |
| **Launch sniff** | `hn.algolia.com/api/v1/search?query=<n>&tags=story` | Show HN / Launch HN, with points |

**Why those last two exist.** Pass 4 recommended **Andon** — and Andon was already **Andon Labs**
(`andonlabs.com`, the AI-evals lab behind Vending-Bench, ~1,300 points across its HN launches) and
**Andon AI** (`andonai.com`, "Production AI for complex operations"). Neither had an npm package, a
GitHub org, or a `.com`/`.dev` that said anything, so every check in the table above passed. With no
working web search (see the limits below), a name can look clean and be a company. The `<n>labs.com`
/ `<n>ai.com` / `use<n>.com` title fetch plus HN's open Algolia index is the cheap substitute, and it
is now run on every candidate. **Everything recommended before pass 5 was re-checked with it**, which
is how `marloai.com` and `usemarlo.com` turned up (see §9).

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

## 5. Short and punchy — the hard-mouthed set

These are the pass-2 candidates: crisp, consonant-heavy, memorable. Keep reading to §6 if, like
Sarge, they land too hard — the consonant that makes them cut is the same one that makes them bark.

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
exist, in toys and film, not software.

**And the real objection: it is hard in the mouth.** /sɑːrdʒ/ is a fricative, an r-colored vowel and
an affricate in one syllable — English's harshest available shape, which is why it cuts through and
also why it barks. Said fifty times a day at a machine that is meant to feel like a colleague, it is
a drill sergeant every time, and the letters look it: S-A-R-G-E. §6 keeps everything that works about
it — short, human, a role you call out — and drops the bark.

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

## 6. Short and soft — the same idea without the bark

Sarge works because it is **short, human, and a role you call out to**. Nothing about that requires
harsh consonants. Two ways to keep it and lose the bark:

- **A soft role** — same job, gentler word: the mate, the minder, the navvy, the ensign.
- **A soft first name** — which is what every assistant you speak to is called. Siri, Alexa,
  Cortana, Claude, Gemini, Jules: none of them describe a function, they are all *someone*. For a
  thing you talk to all day, personality is the meaning.

Same checks, same day. “Softness” below is my phonetic read: no r-colored vowel, no final affricate,
nasal or lateral consonants, open ending.

| # | Name | Say it | Binary | Softness | npm | `.sh` | Other domains | Market collision |
|---|---|---|---|---|---|---|---|---|
| 1 | **Marlo** | "Hey Marlo" | `marlo` | soft (one `r`, open ending) | **✓** | **✓** | crates ✓, `.com/.dev/.ai/.io` ✗ | npm dormant; Marlowe (Cardano DSL) ★175 |
| 2 | **Wilkie** | "Hey Wilkie" | `wilkie` | soft, no `r` | **✓** | **✓** | `heywilkie.com` ✓ | none in dev/AI; Willkie Farr (law firm, two Ls) |
| 3 | **Talko** | "Hey Talko" | `talko` | soft, no `r` | **✓** | **✓** | PyPI ✓ crates ✓ `heytalko.com` ✓ `.ai` for sale | dead MS/Ray Ozzie app |
| 4 | Willa | "Hey Willa" | `willa` | softest (no stop) | ✗ (UI lib) | **✓** | PyPI ✓ crates ✓ | `willa.ai` live; Kafka DSL ★138; invoicing app |
| 5 | Mabel | "Hey Mabel" | `mabel` | soft, no `r` | ✗ | **✓** | — | singer, cartoon; GH handle active (34 repos) |
| 6 | Navvy | "Hey Navvy" | `navvy` | softest (no stop) | ✗ (dormant) | **✓** | **`.dev` ✓**, `heynavvy.com` ✓ | Ruby job processor ★211 — adjacent |
| 7 | Ensign | "Hey Ensign" | `ensign` | soft, no `r` | ✗ | **✓** | `heyensign.com` ✓ | Ensign Group (NASDAQ), LDS magazine, Star Trek |
| 8 | Mizzen | "Hey Mizzen" | `mizzen` | soft, no `r` | ✗ | **✓** | `heymizzen.com` ✓ | **Mizzen AI** ships a `mizzen-cli`; Mizzen+Main |
| 9 | Aviso | "Hey Aviso" | `aviso` | softest (no stop) | **✓** | **✓** | — | none in dev/AI, but a common Spanish word |
| 10 | Marlow | "Hey Marlow" | `marlow` | soft (one `r`) | ✗ | **✓** | — | same Marlowe echo; GH org exists |
| — | ~~Mate~~ | | | softest | ✗ | ✗ | — | MATE desktop; "hey mate" is a greeting → false triggers |
| — | ~~Minder~~ | | | soft | ✗ | ✗ | `heyminder.com` ✓ | `mindersec/minder` ★421 supply-chain platform |
| — | ~~Keeper~~ | | | soft | ✗ | ✗ | — | Keeper Security (password manager, big) |
| — | ~~Yeoman~~ | | | soft | ✗ | ✓ | — | **Yeoman** is a JS scaffolding tool — fatal |
| — | ~~Collie~~ | | | soft | ✗ | ✗ | — | nothing free; reads as a pet |
| — | ~~Butler / Porter / Steward~~ | | | soft | ✗ | ✗ | — | crowded everywhere; "AI butler" is a cliché |

### 1. Marlo — *the one you send to find out what's really going on* · binary `marlo` · "Hey Marlo"

**Why it works.** It sounds like a competent colleague, which is the register that fits a thing you
talk to — and it has a lineage that happens to describe the product: Conrad's **Marlow** is the
sailor who goes upriver and comes back to tell you plainly what he found; Chandler's **Marlowe** is
the one you hire to discover what is actually true. This tool's whole thesis is *status derived from
reality rather than remembered*. That is Marlo's job description.

**In the mouth.** /ˈmɑːrloʊ/ — nasal onset, lateral middle, open vowel ending, stress on the first
syllable. It has one `r`, but between `m` and `l` and followed by an open `o` it never hardens; there
is no affricate anywhere. "Hey Marlo" is four syllables and lands soft. Distinct from Claude, Codex,
Cursor (/k/-onset) and Gemini (/dʒ/). Five letters, spells itself, no plural or possessive trouble.

**Ownership — the best of the soft set.** npm `marlo` **free**, `@marlo` scope clean, crates.io
**free**, **`marlo.sh` free**, GitHub handle exists but has **zero public repos**. PyPI taken;
`.com` (1995), `.dev`, `.ai`, `.io` taken; `heymarlo.com` taken.

**Collisions.** npm `marlo` is free; the dormant `marlow` package is a "hardboiled node framework"
(same joke). The real echo is **Marlowe**, IOG's smart-contract DSL for Cardano (★175 + ★100) —
different spelling, different world, no overlap in search for `marlo cli`. `marlow.com` doesn't
resolve; Marlow Ropes and Marlow, Buckinghamshire are the non-software noise.

**Risks.** It means nothing on first hearing — you buy personality and pay in description. And people
will type `marlow` sometimes, so own both spellings where cheap.

### 2. Wilkie — *the same name, grown up* · binary `wilkie` · "Hey Wilkie"

**Why it works.** It keeps the first syllable of Wilco, so everything already written, said and
remembered still points here — and it is a **nickname**, which is exactly what Sarge got right about
register, minus the parade ground. "Hey Wilkie" is affectionate rather than obedient: the same
friendly acknowledgment as *wilco*, said by someone you like.

**In the mouth.** /ˈwɪlki/ — no r-colored vowel, no final consonant cluster, a single light /k/ in the
middle for the detector to catch, open `-ie` ending. Six letters, two syllables, four in the phrase.
It is the softest name here that still has a stop in it, which is the sweet spot.

**Ownership.** npm `wilkie` **free**, `@wilkie` clean, **`wilkie.sh` free**, **`heywilkie.com` free**.
`.com` is **Willkie Farr & Gallagher** — a large New York law firm, spelled with two Ls, so not our
word. The GitHub handle `wilkie` is an active developer (133 repos), so the org needs a variant.

**Collisions.** Nothing in dev tools or AI: the loudest `wilkie` repos are a sky-simulation algorithm
(★44) and a hobby OS. Wilkie Collins (Victorian novelist) is the search competition, which is thin.

**Risks.** Diminutives can read unserious — "Wilkie" is charming on a laptop and possibly twee in a
procurement conversation. And it is one letter from the name you are leaving, which is either the
best thing about it (continuity) or the worst (you wanted a clean break).

### 3. Talko — *it talks* · binary `talko` · "Hey Talko"

Unchanged from §5 and still the most ownable name in this document: npm, `@talko`, PyPI, crates,
`talko.sh`, `heytalko.com` all free and `talko.ai` for sale. Softer than Sarge (two light stops, open
ending, no `r`), transparent on hearing, and coined — so the strongest trademark position. It reads
more like a consumer chat app than a control room, which is the price.

### Also worth a look

**Navvy** — a navvy built the canals and railways: the one who does the digging. Softest possible
mouth-feel, `navvy.dev` **and** `navvy.sh` **and** `heynavvy.com` all free, and it quietly says
*navigate* and *labour* at once. Held back by a ★211 Ruby **background-job processor** of the same
name — uncomfortably adjacent to what we do — and by being a British term few others know.

**Ensign** — two soft syllables meaning both *the officer standing the watch* and *the flag a ship
flies*, which is a good pair for a tool that watches and shows identity. `ensign.sh` and
`heyensign.com` free. Held back by the NASDAQ-listed Ensign Group and a Star Trek shadow.

**Willa** — softest of all and keeps Wilco's `Wil-`, PyPI and crates free, `willa.sh` free. Held back
by `willa.ai` already resolving, a Kafka DSL at ★138, and an invoicing product of the same name.

## 7. Short and from the work — workshop, IDE and agent vocabulary

A name out of the world the tool lives in, rather than a ship or a squad. Three sub-registers were
checked: **the IDE** (caret, palette, gutter, minimap, pane, lane, buffer, scratch), **the workshop**
(bench, anvil, smithy, kiln, forge, foundry, atelier, jig, lathe, trestle, tenon, mallet, spindle,
bobbin, heddle, weft, loom, shuttle, wright, cartwright, mason, sawyer, weaver, draper, scribe), and
**the agent collective** (crew, swarm, fleet, guild, squad, roster, cohort, troupe).

**The finding: this is the most picked-over vocabulary on the internet**, because it is the dev-tool
namespace itself. Of roughly fifty words checked, **one** had a free npm name (`cartwright`) and
**one** had a free `.sh` (`mallet`). Worse, the good ones are owned by tools people already use:

| Word | Why it's gone |
|---|---|
| Bench | **In an AI context "bench" reads as *benchmark*** (AgentBench, SWE-bench) — fatal, before you even reach Bench Accounting |
| Forge · Foundry | SourceForge/Forgejo; Palantir Foundry **and** Foundry (the Ethereum toolkit) |
| Anvil | `anvil.works` (Python app platform) **and** `anvil`, Foundry's own local node |
| Smithy | AWS Smithy (API modelling language) |
| Kilim | `kilim/kilim` ★1783 — *lightweight threads for Java*: the same concept as lanes |
| Shoji | `ShojiWM` ★658 — a Wayland compositor, i.e. panes and windows |
| Loom · Mux · Trunk | Atlassian's Loom; mux.com; trunk.io |
| Dojo · Kata | Dojo Toolkit and Starknet Dojo; Kata Containers |
| Artisan · Scratch · Buffer · Caret | Laravel's `artisan`; MIT Scratch; Buffer; a Chrome editor |
| Crew · Swarm · Fleet · Guild | CrewAI; OpenAI Swarm; JetBrains Fleet; Guild Education |

### The second wall: the AI land grab

**Andon is dead** — `andonlabs.com` is the AI-evals lab (Vending-Bench, Pion, ~1,300 HN points) and
`andonai.com` is "Production AI for complex operations". It passed every registry check and was still
taken, which is what added the company sniff in §3. Run on this whole register, the sniff kills most
of it:

| Word | What the sniff found |
|---|---|
| Andon | **Andon Labs** + **Andon AI** — both in AI agents |
| Cradle | `cradle.ai`, `cradlelabs.com`, `usecradle.com` (Cradle, the protein-design company) |
| Easel | `easel.com` is Inventables' CNC software; `easellabs.com`; Show HN "Easel" ★346p |
| Mallet | `mallet.ai`, `malletai.com`, plus MALLET the NLP toolkit |
| Gimlet | `gimlet.ai`, Gimlet Media (Spotify) |
| Loupe | `loupe.ai`, `loupelabs.com`, Etsy's Loupe monitoring stack |
| Skein | `skein.ai`, **Skein Labs**, **Skein AI Systems**, Schneier's Skein hash |
| Kerf | `kerfai.com`, and Kerf the array language |
| Holdfast | **HoldFast AI** (`holdfastai.com`), `useholdfast.com` |
| Sawhorse | `sawhorse.ai` — "your quotes, with a brain" |
| Docket | **DocketLabs**, **DocketAI**, `usedocket.com` |
| Millwright | Show HN: "Millwright — self-hosted LLM router"; "Millwright: Smarter Tool Selection from Agent Experience" |
| Lanework | `lanework.ai`, and one letter from **Lacework** (the $8.3bn security company) |
| Collet | `usecollet.com`; and Yann Collet is a household name in this field (zstd) |
| Galley | `galley.ai`, `galleylabs.com`, HN: "Galley: orchestrator for local Docker containers" |
| Steno · Platen · Stave · Kumiko · Tiro | `steno.ai` · `platen.ai` · `stave.ai` + Stave Labs · `kumiko.ai` + **Kumiko Labs** · `tiro.com` = Tiro Typeworks |

**Take this as the rule, not the exception: every short concrete noun now has an `X.ai` or an
`X Labs` on it.** Which means a short real word can only be chosen with eyes open — the question is
whether its namesake is a *company in our market* (fatal) or a *parked page* (survivable).

### What survived the sniff

| Name | Meaning in one beat | npm | `.sh` | `hey*.com` | AI-space sniff |
|---|---|---|---|---|---|
| **Jig** | the shop-built fixture that holds the work so every part comes out right | ✗ dormant 2013 | ✗ | **✓** | **clean** — no Jig AI, no Jig Labs, `jig.ai` for sale |
| **Obeya** | "big room": the one room where the whole project's state is on the walls | **✓** | **✓** | **✓** | **clean** — nothing on `.ai`, no Labs, nothing on HN |
| **Dado** | the groove cut across a board that another piece seats into | ✗ | **✓** | **✓** | **clean** — nothing anywhere; GitHub handle empty |
| **Cartwright** | the wright who builds what the work rides on | **✓** | ✗ | **✓** | clean (`.com` is a for-sale parking page) |
| **Intarsia** | many small pieces inlaid to make one surface | **✓** | **✓** | **✓** | `intarsia.ai` resolves (no content) |
| **Bodkin** | the blunt needle that opens a way without cutting threads | **✓** | **✓** | **✓** | `bodkinai.com` "coming soon", `bodkinlabs.com` live |

### Jig — the strongest of them, and its three honest costs

A jig is the fixture a shop builds *for itself* so that every repetition of a job comes out the same.
It is already a programmer's metaphor — Rob Napier's "Go Is a Shop-Built Jig" is a well-read essay
(★145p on HN) — and it is what this product physically does: a worktree, a lane and a harness are the
jig that holds an agent's work steady. `jig` is also the best binary in this document: three
characters, a real word, free on any normal PATH.

The costs, in order:

1. **Thin ownership.** `jig.com` is JigSpace (AR presentations), `.dev`/`.sh`/`.io` are taken, npm
   `jig` is dormant since 2013 (a Jenkins-IRC bridge) → ship `@jig/cli`. Free: `heyjig.com`, and
   `jig.ai` is listed for sale. No Jig Labs, no Jig AI — rarer than it sounds.
2. **One syllable is a weak wake word.** "Hey Jig" is three syllables total with a /dʒ/ onset shared
   with Gemini; short wake words false-accept more often than long ones.
3. **Two brand-safety flags to clear before it goes on a website.** The idiom **"the jig is up"**
   (≈ *you have been rumbled, it's over*) will follow the name around; and "jig" carries a dated
   ethnic-slur sense in some English dictionaries. Neither is a reason to stop — both are a reason to
   put it through a brand review rather than falling in love first.

### The dog register — and why the terrier should be the mascot, not the name

A Jack Russell is uncannily on-brief for this product: a small, tireless worker, sent down the hole
alone, directed at a distance **by voice**, who comes back and tells you what is down there. That is
an agent in a worktree. So the register was checked properly — the breed, the dog's name, the
handling vocabulary — and it is as grabbed as every other:

| Name | What the sniff found |
|---|---|
| **Keen** | **Keen Technologies** — Carmack's AGI company (★461p), plus Keen.io and Commander Keen |
| **Spry** | the **Spry programming language** (★135p + ★134p), SPRYLAB, `spryai.com`, `usespry.com` |
| **Fido** | the **FIDO Alliance** — three HN stories over 270p; the word belongs to authentication |
| **Pike** | **Rob Pike** (★1958p, ★1550p, ★1020p) — fatal by association — plus the Pike language |
| **Jack** | JACK Audio Connection Kit; every domain taken |
| **Tyke** | `tykeai.com` = TykeAI |
| **Russ** | drowned in search by Russia |
| Tug · Kip · Mush · Yip · Lair | `.ai` squatters on all of them |
| Pip · Dig · Pack · Sled | **already binaries on every dev machine** (Python, BIND, Buildpacks, the sled DB) |

**Spike itself** is usable but not clean: **`spike.dev` is free** and npm `spike` has been dormant
since 2018 (a webpack static-site tool), but `spike.sh` is a **live error-monitoring product** — a
dev-tools collision, the most confusing kind — Paramount's Spike TV holds the `.com`, and
`spikeai.com`, `usespike.com`, `spikelabs.com` and `getspike.com` all resolve. It is also five
letters, and in operations "a spike" means *something just went wrong*, which is a strange note for a
tool whose job is steady supervision. The redeeming twist: in this industry a **spike** is already a
time-boxed investigation — *"run a spike on it"* — which is exactly what an agent is sent to do.

**The better move is to stop asking the name to carry the meaning.** Every dev tool people love has a
mascot doing that work: Docker's whale, Go's gopher, Rust's Ferris, Linux's Tux, GitHub's Octocat,
Bun's bun, Ghostty's ghost. A real Jack Russell called Spike gives this product a logo, a voice, a
paragraph of copy and a true story on day one — *named after the terrier who supervises the office* —
and it works with **any** name. Then the name only has to be short, sayable and ownable, which after
six passes is the only thing still hard to find.

### The five-letter wall, and the mask register

Asked for **five letters, explanatory, nice-sounding**, 35 plain English words in the supervision /
control-room / crew register were run through a cheap triage — npm, `.dev`, GitHub handle:

> cadre · drove · pacer · braid · chord · weave · usher · posse · leash · chore · shift · scope ·
> focus · order · locus · pulse · relay · slate · panel · gauge · datum · truss · strut · rivet ·
> lever · gavel · hoist · winch · crane · feist · scamp · augur · perch · tutor · coach

**All 35 were taken on all three axes.** The deep-vetted ones went the same way: `brief` (brief.ai
for sale, BriefLabs, briefai.com) · `spool` (spool.ai, usespool.com) · `steer` (steer.ai, SteerLabs,
steerai.com) · `squad` (**squad.com is "your team of AI agents"**, squad.ai is Chutes) · `board`
(**board.com is "The Agentic Planning Platform"**) · `probe` (ProbeLabs is "Code Intelligence for
Engineering Teams") · `staff`, `guide` (both live products, though `staff.dev` and the `staff` and
`guide` GitHub handles are free).

**The mask register** — prompted by a Jack Russell with tan eyebrow pips and a bandit mask — was
checked too, and it is the same story, with specific dev collisions worth recording:

| Word | What holds it |
|---|---|
| **Bandit** | `bandit` is the Python security linter (PyCQA) |
| **Domino** | Domino Data Lab (MLOps) — and Domino's |
| **Blaze** | Google's internal name for Bazel; Firebase's Blaze plan; Blaze.ai |
| **Zorro** | Zorro Productions enforces the mark; npm, `.dev`, handle all taken |
| **Glyph · Sigil · Rune** | Glyphs (font editor) · Sigil (epub editor) · Rune Labs |
| **Shadow · Shade · Badge · Guise · Speck · Specs** | all taken on npm, `.dev` **and** the handle |
| **Umber · Kajal · Brindle · Masko · Volto** | npm free, but `.dev` and the handle gone |
| **Bauta** (the Venetian mask) | **npm, `.dev`, `.sh`, `heybauta.com` all free** — but `bauta.ai` is a live Norwegian product, and English speakers cannot guess the pronunciation |

Also killed on sight: **Crewe** — npm, `.dev`, `.sh` and `heycrewe.com` are all free, and it is
pronounced exactly like *crew* with a railway-works pedigree, but **CrewAI** owns that sound in
multi-agent tooling and the name would read as a knockoff forever.

**And one correction:** `spike.dev` is **free** — verified 404 three times against two independent
RDAP servers after a transient said otherwise.

### What is actually still standing at five letters

| Name | Explains itself as | Free | Cost |
|---|---|---|---|
| **Spike** | *a spike* — a time-boxed investigation, which is what an agent is sent to do; and the dog, mask and all | **`spike.dev`**, npm dormant since 2018 | `spike.sh` is a live error-monitoring product; Spike TV holds `.com` |
| **Talko** | *it talks* | npm · PyPI · crates · `.sh` · `heytalko.com`; `.ai` for sale | reads consumer; only echo is Ray Ozzie's dead app |
| **Obeya** | *the big room where all the work is visible* — literally this product | npm · `.sh` · `heyobeya.com`; nothing in AI | one pronunciation to teach (oh-BAY-uh) |
| **Bauta** | *the mask* | npm · `.dev` · `.sh` · `hey*.com` | unguessable spelling-to-sound; a Norwegian `bauta.ai` |

Roughly **250 names** have now been through the pipeline. The pattern does not change with more
guessing: at four or five letters, a real English word with an obvious meaning is owned by someone,
usually an AI company. The three ways out remain **a word whose namesakes sit outside dev and AI**, a
**coinage** with the mascot carrying the meaning, or a **compound** (Jigsmith-class) — and the choice
between them is a taste decision that no further search will make.

## 8. Positioning: is "Agentic Terminal IDE" the right frame?

Partly, and the two halves fail differently.

**"Terminal" is the true and defensible part.** It is where the product actually lives — lanes are
terminals, the drivers are tmux and pty, the window is a TUI — and it separates this from every
GUI-fork competitor. Keep it.

**"Agentic" is commodity, and worse, it is someone else's claim.** "Agentic IDE" is Windsurf's launch
phrase and AWS **Kiro**'s headline ("a new agentic IDE", ★1063p on HN); "agentic development
environment" now belongs to **JetBrains** (`air.dev`), Spotify's **Xirp**, **OpenChamber** and
**Emdash** (★206p). There is even a Show HN for an "OSS agent-first terminal IDE". Adopting the
phrase puts this product inside a frame owned by companies with a hundred times the marketing budget,
and invites the one comparison it loses.

**"IDE" is a useful category borrow that overclaims.** An IDE is where *you* write code: editor,
completion, LSP, debugger, refactoring. This has a file **viewer**, git, changes, terminals, search
and a conversation — it is where you *supervise people writing code*. Call it an IDE and the first
thing a sceptic does is try to edit a file, fail, and file it as a bad IDE. Two ways out: build
editing and earn the word, or use IDE only comparatively ("an IDE for supervising agents, not writing
code").

**What I would actually do.** Split the two audiences:

- **For search and strangers** (GitHub description, meta title, HN title): keep it plain and
  category-borrowing but not their exact phrase — *"a terminal IDE for a crew of coding agents"*.
- **For humans** (README first line, the app itself): the thing only this product is — *"the control
  room for the coding agents on your machine"*. Voice, many lanes, derived status. That is a category
  you can own rather than one you are renting.

**And it changes the name class.** An IDE is named like a *place or an instrument* — Vim, Zed, Helix,
Fleet, Kiro, Warp, Zellij, Ghostty. A colleague is named like a *person* — Claude, Devin, Jules,
Marlo. If the branding leads with "terminal IDE", a person-name works against it, and §7's set (Jig,
Obeya, Dado) is the right shelf. If the branding leads with the voice and the crew, §5–§6 (Sarge,
Marlo, Wilkie) is. **Pick the positioning first; the name follows from it.**

### The category label: three words, not five

"Orchestrated terminal agentic IDE" is five words of jargon, and a label nobody can repeat is not a
label. Rules that hold up: **one borrowed noun** (IDE — free comprehension), **one true modifier**
(terminal, *or* agents — not both plus two more), and **orchestration belongs in the verb, not the
label**, because it is what the product *does*, not what it *is*.

| Label | Verdict |
|---|---|
| "agentic IDE" | **taken** — Kiro's headline and Windsurf's launch phrase |
| "agentic development environment" (ADE) | **taken** — JetBrains `air.dev`, Spotify's Xirp, OpenChamber, Emdash ★206p |
| "orchestrated terminal agentic IDE" | unrepeatable; four modifiers, no claim |
| **"terminal IDE for coding agents"** | clear, searchable, and not anyone's slogan yet |
| **"agent orchestration IDE"** | the most accurate three words; "orchestration IDE" is claimed only by a ★3p Show HN, while "agent orchestration" is live generic category language (Google's Scion ★230p, Hephaestus ★81p) — exactly what you want to be *found* by rather than to own |
| "agent orchestration terminal IDE" | accurate but four stacked modifiers; fine as a GitHub/meta description, unsayable as a line. Put *terminal* in the sentence, not the stack |
| **"agent control room"** | the human-facing line — a category you own rather than rent |

Evidence that the orchestration words are worth taking: **`tutti.com` is parked for sale and
advertised as "AI Agent Orchestration"**. Domainers have already priced this category.

So: *"⟨Name⟩ — the terminal IDE for orchestrating coding agents"* for search and strangers, and
*"the control room for the coding agents on your machine"* for humans. Same product, two audiences,
neither sentence borrowed from Kiro.

## 9. Shortlist and recommendation

**Decide the positioning first (§8), because it picks the shelf.**

| If the branding leads with… | then the name should be… | finalists |
|---|---|---|
| a **terminal IDE for agents** | a place or an instrument | **Jig** · Obeya · Dado |
| a **crew you talk to** | a person or a role | **Sarge** · Wilkie · (Marlo) |
| **neither — own the word outright** | coined | **Talko** · Watchwright |

| | **Jig** §7 | **Sarge** §5 | **Obeya** §7 | **Talko** §5 |
|---|---|---|---|---|
| What it says | the fixture that holds the work | the one who runs your crew | the room where all the work is visible | it talks |
| Fits "terminal IDE" | **yes** | no (sounds like an assistant) | yes | half |
| Understood with no explanation | after one sentence | **yes** | after one sentence | partly |
| Wake phrase | "Hey Jig" (3 syl, weakest) | "Hey Sarge" (3 syl) | "Hey Obeya" (5 syl) | "Hey Talko" (4 syl) |
| Binary | **`jig` (3)** | `sarge` (5) | `obeya` (5) | `talko` (5) |
| npm bare name | ✗ dormant 2013 | ✗ dormant 2017 | **✓** | **✓** |
| `.sh` · `hey*.com` | ✗ · **✓** | **✓** · `getsarge.com` | **✓** · **✓** | **✓** · **✓** |
| AI-space sniff | **clean** (`jig.ai` for sale) | parked pages only (`sarge.ai`, `sargelabs.com`) | **clean** | dead MS app only |
| Watch out for | "the jig is up"; slur sense to clear | the bark | pronunciation | says nothing |

**Two corrections this pass forced, both from the §3 sniff:**

- **Andon is out.** Andon Labs and Andon AI, both in AI agents. It was the pass-4 recommendation.
- **Marlo is demoted.** `marloai.com` is "Marlo, the marketing operating system for consumer brands"
  and `usemarlo.com` is "Marlo – AI Powered Brochure Generator" — two live AI products. Not in dev
  tools, so not fatal, but it is no longer the clean name it looked like in §6. **Sarge**'s namesakes,
  by contrast, are parked pages with no titles.

**My call, given the "Agentic Terminal IDE" direction: Jig**, with the brand-safety check run first
and `@jig/cli` + `heyjig.com` + a bid on `jig.ai` as the plan. It is the only name here that sounds
like a terminal tool, means something true about the product, gives a three-character binary, and is
clean in AI space. **If the slur sense or "the jig is up" is a no, take Obeya** — same shelf, better
ownership (npm, `.sh`, `hey*.com` all free), one pronunciation to teach. **If you go back to leading
with the voice, it is Sarge**, for the reason it has always been: it is the only name in five passes
that a stranger understands without a sentence of help.

### A brand over a tool: `jig` plus something that owns the `.ai`

Splitting the two is normal and it solves Jig's ownership problem: **Bun** ships from **Oven**, `uv`
and `ruff` from **Astral**, `docker` from Docker Inc, `zed` from Zed Industries. The binary stays
three characters; the brand carries the website, the npm scope and the trademark.

| Brand candidate | npm | `.dev` | `.sh` | **`.ai`** | `hey*.com` | GitHub handle | Note |
|---|---|---|---|---|---|---|---|
| **Jigsmith** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓ free** | `.com` is a ceilidh band — and a jig *is* a dance. Otherwise a clean sweep. |
| Jigs (plural) | ✗ | ✗ | **✓** | ✗ | **✓** | ✗ (user) | **`jigs.ai` and `jigsai.com` both render "JigsAI"** — the brand is already reserved in AI space. See below. |
| **Jigantic** | **✓** | **✓** | **✓** | **✓** | **✓** | **✓** (0 repos) | `.com` registered but dead. Availability is excellent; the meaning fights us (see below). |
| **Shopbuilt** | **✓** | **✓** | **✓** | ✗ | **✓** | ✓ (0 repos) | From "Go Is a Shop-Built Jig" (★145p + ★103p). Says *we build our own tools*. |
| Toolroom | ✓ | ✗ | ✓ | ✗ | ✓ | org, 8 repos | `toolroomai.com` is live; Toolroom Records. |
| Jigwright | ✗ | ✗ | ✓ | ✓ | ✓ | org | `jigwright.com` is live: "tools for people who build things". |
| Shopwright · Benchwright | ✓ · ✗ | ✓ · ✗ | ✓ · ✓ | ✗ · ✗ | ✓ · ✓ | — | `shopwright.ai` and `benchwright.ai` are both live products. |

**Jigsmith is the pick**: the smith who makes the jigs, which is precisely the relationship between
the company and the tool, and it is the **first name in five passes with `.ai` free** — along with
npm, `.dev`, `.sh`, the `hey*.com` and an unclaimed GitHub handle. Coinage is why: every short real
noun has an `X.ai` on it (§7), and a compound of two real words still reads instantly.

**On Jigantic.** Structurally fine and unusually available, but the semantics work against the
product: it means *gigantic*, and this thing's whole boast is that it is light — *"Wilco stays light,
and proves it"*, one `ps` for the whole process table, no daemon, no state of its own. It is also a
pun, which caps how serious the brand can sound, gets misspelled as *gigantic*, and mis-hears on a
podcast. Keep it if playful is the intent (Bun, Yarn and Ghostty are playful and did fine); choose
**Jigsmith** or **Shopbuilt** if the brand has to carry credibility with a sceptical engineer.

**On Jigs (the plural).** The semantics are better than the singular — *one jig per agent*, which is
literally how lanes work — but it costs more than it gains:

1. **Someone already reserved it in AI space.** `jigs.ai` and `jigsai.com` both resolve to a page
   that says only "JigsAI": a placeholder, no product, nothing on HN — but the brand is sat on, and
   `.ai` is the one domain a name like this wants. By contrast `jig.ai` is merely *for sale*, and
   `jigsmith.ai` is free. npm `jigs`, `.com` and `.dev` are taken too, and the GitHub handle is a
   real user; only `jigs.sh` and `heyjigs.com` are free.
2. **"Jigs" and "gigs" are a minimal pair**, and *gigs* is everywhere in this industry (gig, gigs of
   RAM). In a voice-first product whose wake phrase is "Hey ⟨name⟩", handing the recogniser a
   one-phoneme distinction from a common word is the one collision you cannot ship around.
3. **Plurals fight the prose and the CLI.** "Jigs is an agent orchestration IDE" reads wrong to half
   your readers, forever; and `jigs status` parses as *list the jigs*, where `jig status` reads as an
   instrument being asked a question.

The plural is worth keeping — in the copy, not the name: **Jigsmith**, the binary `jig`, and "a jig
for every agent" in the first paragraph. `jig ls` can list them.

### The lockup, if this direction wins

> **Jigsmith** — the agent orchestration IDE for your terminal.
> `jig status` · `jig brief` · "Hey Jig"
> *For humans: the control room for the coding agents on your machine.*

Brand carries the site, the npm scope (`@jigsmith/*`) and the mark, all of which are free including
`jigsmith.ai` and the GitHub handle; the binary stays three characters. Clear the two Jig
brand-safety flags (§7) before any of it goes public.

### Nicer-sounding alternatives that survived the §3 sniff

If `jig` itself is out, these are the ones left standing — all checked against npm, domains, GitHub,
HN and the `X.ai` / `X Labs` sniff:

| Name | Meaning in one beat | Free |
|---|---|---|
| **Obeya** | the big room where all the work is visible | npm · `.sh` · `heyobeya.com` |
| **Descant** | the independent line sung above the others | npm · `.sh` · `heydescant.com` (only `descantlabs.com` exists) — but near-homophone of *descent* |
| **Dado** | the groove another piece seats into | `.sh` · `heydado.com` · empty GitHub handle; nothing anywhere else |
| **Intarsia** | many small pieces inlaid into one surface | npm · `.dev` · `.sh` · `hey*.com` |
| **Cartwright** | the wright who builds what the work rides on | npm · `hey*.com` |
| **Talko** | it talks | npm · PyPI · crates · `.sh` · `hey*.com`, `.ai` for sale |

The music register is otherwise gone: **Clef** (Clef Labs + the 2FA startup), **Fugue** (Snyk's
acquisition + the CRDT algorithm), **Rostrum** (Rostrum AI + Rostrum Labs + Rostrum Records),
**Divisi** (`divisi.ai`), **Tutti** (parked as "AI Agent Orchestration"), **Pronto** (Pronto.ai),
**Baton**, **Maestro**, **Coda**, **Presto**, **Allegro** — all taken in or near this market.

### If it has to be four letters

Across every pass, these are the only ≤ 4-letter names that survived the §3 sniff. At this length
every real word is gone and coinages carry no meaning — which is the argument for letting the
**mascot** carry it (§7):

| Name | Meaning | Free | Cost |
|---|---|---|---|
| **Dado** | the groove another piece seats into | `.sh` · `heydado.com` · **empty GitHub handle** · nothing on HN, no `X.ai` content, no `X Labs` | npm taken; meaning needs one sentence |
| **Luff** | the leading edge of a sail; to steer into the wind | `.sh` · `heyluff.com` | npm taken; mis-hears as *love* / *laugh* |
| **Kerf** | the slot a blade cuts | **npm** | `.sh` and `.com` taken, `kerfai.com` live, and the Kerf array language exists |
| *(Spike)* | their dog; and a time-boxed investigation | **`.dev`** · npm dormant since 2018 | five letters; `spike.sh` is a live dev product |

**Dado is the cleanest four-letter name in this document** — nothing anywhere, an unclaimed GitHub
handle, and two soft open syllables that spell themselves. It says nothing on its own, which is
exactly what a mascot is for.

#### The four-letter wall

About forty four-letter candidates have now been run through the full §3 pipeline, and **not one has
npm, a domain and a GitHub handle free at the same time.** The ones with *obvious* meaning are the
worst off — every one of them has a live `.ai`, an `X Labs`, or a dev-tool namesake:

| Wanted for its plain meaning | What holds it |
|---|---|
| **Aide** | `useaide.com` = "Aide: Agentic AI Platform", and **Aider** owns "AI pair programming in your terminal" (★432p) |
| **Keep** | Google Keep; `keep.ai` for sale |
| **Tend** | `tend.com` farm software, `tend.ai`, `tendai.com`, TendLabs |
| **Mind** | `mind.com`, `usemind.com` |
| **Herd** | Laravel **Herd**, and **"Herdr: one terminal to rule them all"** (★404p) |
| **Brio** | BrioDocs ("Private AI"), Brio Labs, and Brioche the package manager (★168p) |
| **Hail** | `hail.com`, `usehail.com`, plus Broad Institute's Hail |
| **Romp** | `romp.ai` for sale, `romplabs.com`; and the word's other sense dominates search |
| **Koda** | **`koda.ai` is a live voice-AI company** — the worst possible overlap |
| Bodi · Tovi · Jigo | BODi (Beachbody) · Tovi Labs · `jigo.ai` |

**So at four letters there are only three honest paths:** take a word whose namesakes sit *outside*
dev and AI and ship on `.dev`/`.sh` with a scoped package (**Mush** — `.sh` and `heymush.com` free,
only parked pages elsewhere, and it is the command that starts a dog team; or **Tyke** — same
freedoms, a placeholder "TykeAI" the only shadow); coin four letters and let the mascot carry the
meaning, as Zed, Bun, Deno, Kiro and Vite all do; or accept **five**, where the room measurably
opens up — `spike.dev`, Obeya, Talko.

- **Register in one sitting** — npm package + scope, GitHub org (expect a variant), `.sh`, `hey*.com`
  — and re-run §3, including the company and launch sniffs, the same morning.
- **Settle it out loud.** Say "Hey ⟨name⟩, brief me" and "Hey ⟨name⟩, stop the deps agent" fifteen
  times in a real session. The one that stops registering as a word after an hour is the one.

## 10. What a rename would touch

Measured, not estimated: **2881 occurrences of "wilco" (case-insensitive) across 380 tracked files.**
Grouped by what breaks if you get it wrong. (Examples use `marlo`; substitute whichever wins.)

**Free to change — cosmetic, nothing depends on it**

| Thing | Where |
|---|---|
| Binary `wilco` → `marlo` | `packages/cli/package.json` (`bin`), root `pnpm wilco` script, README install/use |
| `wilco attach <lane>` default | `packages/drivers/pty/src/index.ts` |
| ASCII banner and the "will comply" tagline | `README.md`, `packages/app/src/screen.ts` — **the pun dies with the name; a new line is needed** |
| Docs | `README.md`, `AGENTS.md`, `CLAUDE.md` (a link), 22 markdown files, 16 recipes in `.claude/skills/` |
| Notices | `THIRD_PARTY_NOTICES.md` + `scripts/notices.ts` (`pnpm notices` regenerates) |
| Prompts saying the agent "runs in Wilco" | `composeAgentPrompt`, orchestrator prompt — re-run the live test afterwards: it is the only evidence a model still picks the right tool from the new words |

**Mechanical but wide — one sweep, then `pnpm check`**

| Thing | Count |
|---|---|
| `@wilco/*` scope → `@marlo/*` | 20 workspace packages + every import |
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

**Order.** Secure the name (npm package + scope, GitHub org, `marlo.sh`) → rename the
outward-facing surface, keeping `wilco` as an alias for one release → rename the scope and env vars,
accepting both → leave the on-disk and protocol names behind compatibility readers, and delete those
readers only once no machine has an old home on it.

---

## Appendix A — the longer, brandable names

From the first pass, when `.com` availability and trademark strength were weighted above being
callable. Useful if the decision goes the other way — or as a company name over a product called
Marlo.

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

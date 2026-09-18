# Naming: what to call this thing instead of Wilco

Research, not a decision. Nothing in the code is renamed by this document.

Checks run **2026-09-18**. Availability rots fast, so every command used is written down; any line
here can be re-run before anyone acts on it.

**Revisions.** Pass 1 optimised for a *brandable* name and produced long, careful words
(Watchwright, Yardmaster, Airboss) — the wrong target: this product is **spoken to**, and you will
want to say "Hey ⟨name⟩" next to "Hey Claude" and "Hey Gemini" without either of them answering.
Pass 2 put callability first and landed on **Sarge**. Pass 3 — this one — keeps that register (short,
human, a role you can call out) but adds **softness** as a hard criterion, because Sarge is a bark:
/sɑːrdʒ/ ends in an affricate after an r-colored vowel, which is the harshest shape English has.
So §6 is a new set of soft-mouthed candidates and a new recommendation; the hard ones stay in §5 and
the long ones in [Appendix A](#appendix-a--the-longer-brandable-names).

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

## 7. Shortlist and recommendation

| | **Marlo** | **Wilkie** | **Talko** | *(Sarge)* |
|---|---|---|---|---|
| Register | a colleague | the same name, softened | a product | a drill sergeant |
| Soft in the mouth | yes (one `r`, open ending) | **yes** (no `r`, light `k`) | yes | **no** — /sɑːrdʒ/ |
| Wake phrase | "Hey Marlo" (4 syl) | "Hey Wilkie" (4 syl) | "Hey Talko" (4 syl) | "Hey Sarge" (3 syl) |
| Cross-trigger risk | low | low | low | very low |
| False trigger in speech | none | none | none | very low |
| Binary | `marlo` (5) | `wilkie` (6) | `talko` (5) | `sarge` (5) |
| npm bare name | **free** | **free** | **free** | dead since 2017 |
| crates / PyPI | free / taken | — / — | **free / free** | taken / taken |
| `.sh` | **free** | **free** | **free** | **free** |
| `hey*.com` | taken | **free** | **free** | `getsarge.com` free |
| GitHub handle | exists, **0 repos** | active user → variant | near-dormant (1 repo) | active user → variant |
| Dev/AI collision | none (Marlowe DSL is adjacent noise) | **none found** | none (dead MS app) | none found |
| Explains itself | no | no | partly | **yes** |

**Recommendation: Marlo.** Binary `marlo`, wake word "Hey Marlo", home `marlo.sh`, packages
`@marlo/*` with `@marlo/cli` providing the binary.

It keeps everything that made Sarge right — two syllables, human, a name you call out rather than a
feature you describe — and none of what made it hard: no affricate, no clipped ending, nothing that
sounds like an order being given. "Hey Marlo, brief me" is a sentence you can say a hundred times a
day without flinching, and `marlo status` is five letters. It is also the most **ownable** name in
the soft set: npm, `@marlo`, crates.io and `marlo.sh` are all free today, and the GitHub handle sits
empty. The one thing it does not do is explain itself — but neither does Claude, Siri, Alexa or
Jules, and for a thing you speak to, being *someone* is the meaning. If anyone asks, the answer is
short and true: **Marlo is who you send to find out what's really happening.**

- **Take Wilkie if continuity matters** — it is the softest name here that still has a stop in it, it
  keeps Wilco's first syllable so nothing already said about the product goes stale, and npm, `.sh`
  and `heywilkie.com` are all free. It is the warmest option and the least serious-sounding.
- **Take Talko if owning the word outright matters most** — npm, PyPI, crates, `.sh` and `hey*.com`
  all free, `.ai` for sale, and a coined word is the only genuinely defensible trademark.
- **Keep Sarge only if the bark is the point** — it is the one name that needs no explanation, and
  §5 still makes its case. Everything above exists because "Hey Sarge" fifty times a day is a lot of
  sergeant.
- **Whichever it is, register in one sitting** (npm scope, `.sh`, the `hey*.com`, a GitHub org —
  expect to need a variant for the handle) and re-run §3's checks the same morning. §4(c) is why.

## 8. What a rename would touch

Measured, not estimated: **2881 occurrences of "wilco" (case-insensitive) across 380 tracked files.**
Grouped by what breaks if you get it wrong. (Examples use `marlo`.)

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

import { z } from 'zod'

// The sentences about the away view that have to be said where somebody is
// deciding, and that may never get more comfortable.
//
// **Why they live in the domain and not in `@tade/web`.** Three of them belong
// on a *control*: the one that turns a LAN bind on, and the one that lists the
// devices that have been let in. A control's words are a `Setting`'s `means`
// (`settings.ts`), and `@tade/core` cannot import `@tade/web` — the arrow goes
// the other way and a test holds it. So the choice was a second spelling of
// each sentence beside the control, or one spelling here with `@tade/web`
// re-exporting it. A second spelling is the exact failure these sentences
// exist to prevent: somebody edits the one on the page, the comfortable half
// survives, and the honest half is still true in a file nobody reads.
//
// This is `KEYS_AND_AGENTS`'s treatment (`secrets.ts`) applied to the same
// kind of claim, and said the same way round: **the fact, then the way out, in
// one breath.** A warning with nothing to do about it is one people learn to
// scroll past.
//
// `packages/web/test/separation.test.ts` holds each of them to its words.

/**
 * What is true of a `lan` bind, said on the control that turns one on.
 *
 * It does not say "use HTTPS for security"; it says what anybody on the wifi
 * can read, because the person deciding has to be able to picture it. And the
 * way out is in the same breath.
 */
export const LAN_IS_PLAINTEXT =
  'On your network this is plain HTTP: anybody on the same wifi can read every page it serves ' +
  'and the session cookie with it. `tailscale serve localhost:7654` gives a phone HTTPS while ' +
  'Tade keeps listening on this machine alone, which is a smaller surface than this one.'

/**
 * Why a cookie prefix is not the answer to a port, said where somebody would
 * otherwise believe it is.
 *
 * `__Host-` requires `Secure`, `Path=/` and no `Domain`, and gives real
 * guarantees about all three. It gives **nothing** about ports: RFC 6265 §8.5
 * is unchanged by it. So the honest mitigations are named instead, and this
 * sentence exists because "the prefix fixes it" is what a reader of the
 * attribute list would conclude.
 */
export const COOKIES_IGNORE_PORTS =
  'Cookies are not isolated by port, and no cookie prefix changes that: anything else listening ' +
  'on this address can be sent this session cookie, and can overwrite it. What stands against ' +
  'that is the session being bound to the exact host it was paired for, and TLS, which removes ' +
  'the plaintext the other thing would be reading.'

/**
 * What `HttpOnly` does and what it does not, said once because the short
 * version of it is wrong.
 *
 * It stops a script *reading* the cookie. It does not stop injected script
 * calling `fetch` from the page's own origin with the page's own token — so it
 * is not a defence against cross-site scripting, only against the theft of a
 * credential. What is a defence is the page never building markup: no
 * `innerHTML`, no Markdown, a content policy with nothing inline.
 */
export const HTTPONLY_IS_NOT_XSS =
  'HttpOnly keeps a script from reading this session cookie. It does not keep one from using it: ' +
  'script that got onto the page can call Tade with the page’s own credentials. What stands ' +
  'against that is that the page builds no markup at all.'

/**
 * What is true of every paired device, said wherever one is granted or listed.
 *
 * The same treatment `KEYS_AND_AGENTS` gets, for the same reason: the fact,
 * then the way out, in one breath. Nothing in the file can answer it, so it is
 * said instead.
 */
export const DEVICES_AND_AGENTS =
  'Paired devices and the digests of their credentials live in `web-devices.jsonl`, `0600` — ' +
  'which keeps them from other people, and an agent is not another person. An agent on this ' +
  'machine runs as you with nothing containing it, so it can append a line to that file and pair ' +
  'itself. What stands against that: the device list here shows every device there is, every act ' +
  'one takes is in the journal under its id, and “Disconnect everything” needs no network.'

/** The short clause, for the one line a control gets. */
export const DEVICES_SEEN_BY_AGENTS = 'an agent on this machine could pair itself'

/**
 * What the away view is, said where somebody is turning it on.
 *
 * The two facts a person needs before the switch and not after it: that it
 * dies with the window, so a bookmark tapped with Tade closed is a connection
 * error and not an empty control room; and that it can change nothing, which
 * is what makes turning it on a small decision.
 */
export const AWAY_IS_WHILE_OPEN =
  'The away view answers only while this window is open: close Tade and nothing is listening, ' +
  'which is also why closing Tade is harmless.'

/**
 * What a paired device may and may not do, said where acting is turned on.
 *
 * The same shape as the sentences above: the fact, then what stands against
 * it, in one breath. Three facts, and the middle one is the one a person
 * deciding has to be able to picture — a request from a phone runs in the same
 * conversation as the things they said at the keyboard, and the only thing
 * keeping last week's *turn the checks off* from authorising it is that the
 * refusal is in code rather than in a prompt.
 */
export const ACTING_IS_NOT_YOU =
  'A request from a paired device is never your own words. On work you already set up it can ' +
  'answer what an agent is waiting on, tell one something, hold or release queued work, add a ' +
  'note or a line to what a task is told, mark work finished, and approve a request a grant ' +
  'here already allowed. It can never change a setting, read a credential, run a command, ' +
  'start an agent, push, merge or overrule a check. Acting needs this machine itself or an https ' +
  'origin you named in Trusted hostnames, so a credential that crossed a network in the clear ' +
  'never buys one — and every act is in the journal under the device that took it.'

/** The short clause, for the one line a control gets. */
export const ACTING_IS_NOT_YOU_SHORT = 'a device acts as a request, never as your own words'

/**
 * What stays an act at this machine, however much a device is granted.
 *
 * The line the factory surface is read against, and it is a *list* rather
 * than a promise about care: publishing a workflow decides what every future
 * run of it does, granting a source decides whose words become work here,
 * granting an account or a tool decides what an agent runs as, and changing
 * what a device may do is the authority deciding about itself. None of them
 * has a route, and `packages/web/test/separation.test.ts` reads this list
 * against the route table rather than trusting the sentence.
 *
 * It is said with what a device *can* do in the same breath, because a page
 * that only listed refusals would read as a surface nobody finished.
 */
export const LOCAL_ONLY_ACTS =
  'Publishing a workflow or a persona, turning a source on, granting an account or a tool, and ' +
  'changing what a device may do are acts at this machine and have no route at all. A granted ' +
  'device can read what has been handed over, approve a request a grant here already allowed, ' +
  'follow what the work does, and save a draft nobody has published.'

/** The short clause, for the one line a control gets. */
export const LOCAL_ONLY_SHORT = 'publishing and granting stay acts at the machine'

/**
 * What saving a draft from a device is, said where that is turned on.
 *
 * The same shape as the three sentences above: the fact, then what stands
 * against it, in one breath. The fact a person has to be able to picture is
 * that a draft is a file in Tade's home that nothing runs — and that the thing
 * which *would* make it run is the one act this can never reach.
 *
 * It names the bound rather than describing it, because "bounded" is the word
 * a comfortable version of this sentence would keep while dropping what the
 * bound is.
 */
export const DRAFTS_ARE_NOT_PUBLISHED =
  'A draft is a file in Tade’s home that no run reads. Saving one from a device fills in fields ' +
  'of a workflow that is already drafted — one field at a time, through the same validator the ' +
  'file goes through — and it can never publish one, make one, rename one, delete one, or touch ' +
  'a published version, which never changes once it is out. Publishing is an act at this ' +
  'machine, so what a device saves waits there until somebody here reads it.'

/** The short clause, for the one line a control gets. */
export const DRAFTS_ARE_NOT_PUBLISHED_SHORT = 'a draft is a file no run reads until it is published'

/**
 * What installing this needs of the origin, said where somebody turns it on.
 *
 * The fact first, because it is the one that surprises people: `localhost` is
 * a secure origin and a private address on your own wifi is not. A service
 * worker, Cache Storage and an install all require a *potentially trustworthy*
 * origin — `https`, or this machine's own loopback — so a `lan` bind cannot be
 * installed however many settings are on, and the browser does not explain
 * itself when it refuses.
 *
 * And the way out in the same breath, with the half people get wrong attached
 * to it: a new name is a **new pairing**. A session is bound to the exact host
 * it was minted for, port and all, so a phone paired on `localhost` has no
 * session on the tailnet name and is not meant to — moving a credential
 * between origins is the thing that is never done here.
 */
export const OFFLINE_NEEDS_HTTPS =
  'Installing this, and opening it with nothing to ask, need a secure origin: this machine’s own ' +
  'localhost, or an https name. A plain http address on your network is not one, whatever it is ' +
  'bound to, and the browser refuses without saying why. `tailscale serve localhost:7654`, or a ' +
  'reverse proxy whose name you put in Trusted hostnames, is what gives a phone one — and the ' +
  'device pairs again there, because a session is bound to the exact host it was paired on and ' +
  'nothing is carried across.'

/** The short clause, for the one line a control gets. */
export const OFFLINE_NEEDS_HTTPS_SHORT = 'needs https or this machine itself; a LAN address is not'

/**
 * What Tade cannot promise about a shell on somebody's phone.
 *
 * The same treatment `KEYS_AND_AGENTS` and `DEVICES_AND_AGENTS` get: the fact,
 * then what stands instead, in one breath. The fact is unusual enough to be
 * worth the words — a 404 on the worker's script does **not** remove it. The
 * service worker specification was asked to unregister on 404 and 410 and
 * decided against it in 2017 (w3c/ServiceWorker issue 204), because a bad
 * afternoon at a data centre would otherwise unregister everybody. So the only
 * deactivation that works is one the device is told, and it only lands when
 * that device next reaches this machine.
 *
 * What stands instead is what the shell *is*: markup, styles, script and two
 * icons. There is no projection in it and no route in it, so a phone in a
 * drawer holds a page that can draw nothing until something answers it.
 */
export const INSTALLED_IS_NOT_REVOCABLE =
  'A shell a device has downloaded is on that device. Turning this off serves it an uninstalling ' +
  'worker — which deletes every cache of Tade’s and removes itself the next time that device ' +
  'reaches this machine — because a 404 would not: a worker whose script cannot be fetched is ' +
  'left exactly where it was. A device that never comes back keeps what it had, and what it had ' +
  'is the page and nothing else: no project, no task, no note, no figure, and no way to read one ' +
  'without a session.'

/** The short clause, for the one line a control gets. */
export const INSTALLED_IS_NOT_REVOCABLE_SHORT =
  'a downloaded shell comes off when that device next reaches you, and not before'

/**
 * What a device may keep on its own disk, said where that is turned on.
 *
 * Named rather than described, for the reason `DRAFTS_ARE_NOT_PUBLISHED` names
 * its bound: *minimal* and *redacted* are the words a comfortable version of
 * this sentence would keep while dropping what was actually kept. So the list
 * is the sentence, and `packages/web/test/offline.test.ts` holds the record to
 * it.
 */
export const LAST_VIEW_IS_A_COPY =
  'What a device may keep is counts and the moment they were true — how many are working, how ' +
  'many want you, how many are queued — and no text at all: no title, no intent, no note, no ' +
  'request, no name. It is drawn with its age on it and nothing can be acted on from it. It is ' +
  'still a copy on a phone: signing that device out clears it the next time it reaches this ' +
  'machine, and what was already downloaded cannot be taken back.'

/** The short clause, for the one line a control gets. */
export const LAST_VIEW_IS_A_COPY_SHORT = 'counts and a timestamp on that device’s disk, no text'

/**
 * The away view's own config block: `surfaces.web`.
 *
 * Here rather than in `config.ts` for the reason the sentences above are here:
 * every one of these keys is a decision about who can reach the control room
 * and what they may do with it, and the words that have to be said about each
 * are three lines away instead of in another file. `config.ts` composes it the
 * way it composes `IntakeSurface`, and `surfaceOf` (`@tade/web`'s
 * `surface.ts`) is still the one reader.
 *
 * **Off, and the default is the decision.** `enabled` is a listener on this
 * machine; `bind` is whether that listener is on your network; `acting` is
 * whether a paired device may change anything at all; `orchestrator` is
 * whether one may say something to the model that holds the tools. Four
 * decisions, never one, because conflating the first two is how a laptop in a
 * cafe serves its control room to the cafe, conflating the third with either
 * is how reading from the sofa turns into acting from anywhere, and the fourth
 * is a different kind of thing again — eight bounded verbs against free text.
 * All of them are `never` in `reach.ts` by subtree: each changes who can reach
 * Tade, or what they can do.
 */
export const WebSurface = z
  .strictObject({
    /** Serve it at all. Nothing listens while this is false. */
    enabled: z.boolean().default(false),
    /**
     * `loopback` is this machine alone, and is a secure context, so
     * every browser capability works. `lan` is every interface, in the
     * clear, and is a **read-only transport**: a session minted over
     * plain HTTP off this machine can never act, whatever is turned on
     * later (`scopesOn`).
     */
    bind: z.enum(['loopback', 'lan']).default('loopback'),
    /**
     * Unassigned in IANA's registry, which is the whole of why it is
     * this number. Already in use is a **named warning** and nothing
     * listens — never a quiet bind elsewhere, which is a URL in
     * somebody's hand that goes nowhere.
     */
    port: z.int().min(1).max(65535).default(7654),
    /**
     * Names beyond this machine's own addresses that may reach it: a
     * tailnet, a tunnel. An `https` one of these is also the only
     * origin off this machine a device may ever *act* from, which is
     * what makes a trusted path a prerequisite rather than a nicety.
     */
    trusted_hosts: z.array(z.string().min(1)).default([]),
    /**
     * Whether a paired device may change anything at all.
     *
     * **A third decision, and `false` is the whole of Phase 1's guarantee.**
     * With this off there is no acting route in the table at all
     * (`routesFor`), so a crafted call is the same `404` as a path nobody
     * built — read-only is enforced by absence rather than by a flag a bug
     * could get past. It is not enough on its own either: a device still
     * needs the scope a person granted it at the machine, and the request
     * still needs a trusted origin. `ACTING_IS_NOT_YOU` is the sentence that
     * goes with it, and what acting can never reach is in it rather than left
     * to be inferred.
     *
     * Turning it **on** takes effect the next time Tade starts, because the
     * route table is built with the listener. Turning it **off** is read at
     * every act, which is the asymmetry worth having: the direction that
     * takes away authority is immediate.
     */
    acting: z.boolean().default(false),
    /**
     * Whether a paired device may talk to the orchestrator.
     *
     * **A fourth decision, and the one that is categorically different from
     * the other three.** `acting`'s verbs are bounded: each names a target and
     * the state it expects, each is enumerable, and the worst a crafted one
     * can do is the thing it says on it. This hands **free text to a model
     * that holds tools**, which is the difference between answering a question
     * and being able to ask for anything — so it is its own setting, its own
     * event type and its own provenance, and it must never share a switch with
     * `acting` (DESIGN.md Phase 3).
     *
     * What makes it safe is not the sentence Tade prepends to the turn. It is
     * that while a remote turn is in flight the orchestrator's own tools are
     * narrowed to a closed list — `@tade/orchestrator`'s `origin.ts` — and
     * everything unnamed is refused at the two gates the model calls through,
     * so an old `said` line of the person's and an `open`-tier setting are both
     * out of reach however the request is worded. A harness that cannot be
     * narrowed that way serves no remote turn at all and says so, rather than
     * running one unrestricted.
     *
     * Turning it **on** takes effect the next time Tade starts, for the reason
     * `acting` does: the route table is built with the listener. Turning it
     * **off** is read at every turn, so the direction that takes authority
     * away is immediate.
     */
    orchestrator: z.boolean().default(false),
    /**
     * Whether a paired device may save a draft workflow.
     *
     * **A fifth decision, and the one whose bound is the thing it writes
     * rather than the words it takes.** `acting`'s verbs are about work that
     * exists; `orchestrator` is free text to a model. This is neither: it
     * fills in a field of a template **draft**, which is a file in Tade's home
     * that no run reads, through the same pure validator the file goes through
     * (`editWorkflow`) and the one writer that cannot name a published version
     * (`writeDraft`).
     *
     * What it can never do is the half worth a setting: there is no route that
     * publishes, that makes a draft, that renames or deletes one, or that
     * touches a published version — `DRAFTS_ARE_NOT_PUBLISHED` says so, and
     * the route table is the enforcement. So the worst a crafted call can do
     * is leave a draft nobody published in a state somebody at this machine
     * reads before publishing it.
     *
     * Turning it **on** takes effect the next time Tade starts, for the reason
     * `acting` does: the route table is built with the listener. Turning it
     * **off** is read at every save, so the direction that takes authority
     * away is immediate.
     */
    drafts: z.boolean().default(false),
    /**
     * Whether a device may install the shell and open it with nothing
     * to ask.
     *
     * **A sixth decision, and the only one whose effect outlives the
     * machine saying so.** The five above are reached at the moment of
     * a request; this one puts files on somebody else's phone. What
     * those files are is the whole of why it is a small decision: the
     * static page — markup, styles, modules, two icons — which carries
     * no projection, is the same bytes for every device, and can draw
     * nothing at all without a session.
     *
     * What it cannot be is quietly undone. A worker's script answering
     * `404` leaves the installed worker exactly where it was
     * (w3c/ServiceWorker issue 204), so turning this off serves an
     * *uninstalling* worker instead, and that lands the next time the
     * device reaches this machine. `INSTALLED_IS_NOT_REVOCABLE` says
     * so where somebody is deciding.
     *
     * It is also the one key a browser can refuse: all of it needs a
     * secure origin, which is this machine's own loopback or an https
     * name and never a plain address on a network
     * (`OFFLINE_NEEDS_HTTPS`).
     */
    install: z.boolean().default(false),
    /**
     * Whether a device may keep a few counts on its own disk.
     *
     * **A seventh decision, narrowed under the sixth**, because what it
     * is for is the cold open and there is no cold open without a shell
     * to open — a key that could be on while nothing could read it is a
     * setting Tade accepts and ignores. What may be kept is counts and
     * a moment and no text whatever, which is `LAST_VIEW_IS_A_COPY`'s
     * list and not a promise about care.
     */
    offline: z.boolean().default(false),
  })
  .prefault({})

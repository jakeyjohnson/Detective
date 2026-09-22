# Play Detective

*An Interactive Show.*

A live gameshow quiz platform. Write the quiz, put it on a projector,
run it from a private control room, let the room answer on their phones,
and pull the leaderboard up whenever you want it.

Static HTML, CSS and JavaScript. No build step, no framework, no install.
Open it with any web server and it works.

---

## The five minute version

```bash
python3 -m http.server 8000
```

Then:

1. **http://localhost:8000/build.html** — press **Load the 50-question starter
   pack**, or write your own. The passphrase is `lestrade` until you change it in
   `assets/js/config.js`.
2. **http://localhost:8000/host.html** — pick the case, press **Start show**.
3. The control room gives you a link for the **projection screen**. Open it
   on the second screen and press **F** for full screen.
4. Press **Space** to move the show forward.

That is a complete working show. Teams are added in the control room and you
mark them with the `+` and `−` buttons — good for a room with a projector and
teams answering on paper.

To have the room answer on **their own phones**, do the Supabase setup below.

---

## The pages

| Page | Who opens it | What it is |
|---|---|---|
| `index.html` | Players | Type the code and a team name to join |
| `build.html` | You, privately | The quiz builder |
| `host.html` | You, privately | The control room that drives the show |
| `present.html` | The projector | Full-screen game board. No cursor, no scrolling |
| `play.html` | Players' phones | Answer the question |
| `leaderboard.html` | Anyone, any time | Live standings |

`build.html` and `host.html` sit behind a gate. The other four do not, on
purpose: the projector, the join page and the leaderboard all need to be
openable by whoever is standing in front of them.

---

## Branding

The look is taken from the show's logo: antique gold on near-black, a ring
of lit marquee bulbs, and a cream plate for the moments the room is meant to
look up. Every colour, size and duration lives in `assets/css/tokens.css` —
nothing below it hardcodes a value, so the whole system re-skins from that
one file.

The marquee ring is CSS, not an image: four repeating radial gradients on one
pseudo-element, one per edge, so a frame of any size gets evenly spaced bulbs.
The fingerprint is `assets/img/fingerprint.svg`, loaded as a CSS mask so it
takes its colour from context — gold on black in the topbar, black on cream
on a plate, from one file.

**To use the real logo**, put the file in `assets/img/` and set `logoUrl` in
`assets/js/config.js`:

```js
logoUrl: 'assets/img/logo.png',
```

The join page and the lobby screen then show it in place of the built-in
fingerprint and wordmark. Use a transparent PNG or an SVG — it sits on the
near-black ground, so a logo with a white box baked in will show that box.

The cream plate is rationed deliberately. It is the brightest thing the system
can put on a screen, so it marks the round card and the winner — beats a few
seconds long — and never a whole page. A projector in a dark room would blow
out a full cream screen, and the questions themselves stay light-on-dark.

---

## How people get in

The projection screen shows a QR code, the address in plain text, the five-character
game code and tonight's venue password. Scanning takes a phone to the sign-up page
with the code already filled in, so all anyone types is **their name and the venue
password**.

Set the password on the control room's setup screen before you start the show, or
leave it empty for no password at all. **Suggest one** gives you something easy to
shout across a noisy room.

The typed route stays on screen next to the QR on purpose. A phone camera that will
not focus in a dark venue must not be the end of somebody's night.

### Where the password lives, and where it does not

The point of a venue password is that only people in your room can play. That only
holds if the password cannot be looked up, so:

- It is stored in `quiz_session_keys`, a table with **no policies at all**. Row
  level security is on and nothing grants access, so the table is unreachable by
  every client — player, control room, and signed-in host alike. Nobody reads a
  venue password back out; you set a new one.
- It is reached only by two `security definer` functions, which run as their owner
  and so sit outside those policies: `quiz_set_venue_password()` writes one, and
  `quiz_join_team()` checks one while joining. Players have no insert permission on
  the teams table, so there is no way round the check.
- It is **never** in the state the screens read. It reaches the projection through
  the link the control room gives you (`present.html?code=…&vp=…`). Someone who
  opens the projection with just the code sees no password.

Two things in that list are there because running the schema against a real
PostgreSQL disproved the earlier version. The table first used a single `FOR ALL`
policy for the host — and `FOR ALL` covers `SELECT`, so any signed-in account could
read every venue password, while this README claimed none could. Closing that then
broke writing, because PostgREST compiles an upsert to `INSERT ... ON CONFLICT DO
UPDATE`, which has to read the row it conflicts with; a table nothing may read
cannot be upserted into. Hence the setter function.

It could not have gone on the session row: that row is world-readable, which is how
the projection and the leaderboard work at all, so a password there would be visible
to precisely the person holding a second-hand join code.

Comparison ignores capitals and surrounding spaces. It is a word read off a screen,
and `"Lamplight "` failing is a person who cannot play.

Treat it as a door policy rather than authentication: one shared word, on a screen,
that the whole room can see.

### The QR code

Generated in the browser by `assets/js/qr.js` — no service, no network call, nothing
to fail on the night. It is tested by decoding the output back through an independent
reader and checking the Reed-Solomon syndromes are zero, because a wrong QR code
still looks exactly like a QR code.

If your address is long, set `joinUrl` in `assets/js/config.js` to something short
and typable. That value is what goes in the QR and what the room reads off the screen.

---

## Live vote percentages

While a question is open, the projection and every phone show the percentage behind
each option, filling as answers arrive. It is a per-quiz setting, on by default,
under **How the show runs** in the builder.

Worth knowing before you use it: people can see it while they vote, so a clear early
lead pulls the undecided towards it. Turn it off for a round where you want
independent answers.

It cannot leak the answer. The payload it is drawn from carries option ids, counts
and shares, and nothing else — no correctness, not even indirectly. It is a separate
function from the reveal breakdown rather than a filtered copy of it, precisely so
that no future change to the reveal can quietly start feeding the live display; the
tests assert the serialised payload contains no correctness at all and that it is
absent in every phase except an open question.

---

## Question types

Every type can carry a video, audio or image alongside the question, and every
one can have its own points and its own clock.

| Type | How it is answered | Marked |
|---|---|---|
| **Standard** | Type the answer | Automatically |
| **Multiple choice** | Pick from 2–6 options, one or several correct | Automatically |
| **True or false** | Two fixed options | Automatically |
| **Video** | Clip plays, then pick or type | Automatically |
| **Audio** | Sound plays, then pick or type | Automatically |
| **Image** | Photo, map or document, then pick or type | Automatically |
| **Put in order** | Arrange items into a sequence | Automatically, part marks per item in place |
| **Closest number** | Enter a number | Automatically — nearest guess, or within a margin you set |
| **Final wager** | Stake points, then answer | You rule, the stake moves both ways |
| **Open answer** | Type anything | You rule, with a right and wrong button per team |
| **Talking point** | Nothing collected | Goes on screen so you can talk to the room |

Typed answers ignore capitals, punctuation, accents, a leading "the", and `&`
versus "and". "the Mona Lisa!" and "mona lisa" are the same answer. Leave
**Forgive spelling slips** on and a typo is still accepted, with the tolerance
scaled to the length of the answer — one slip in "Poirot", two in
"Chandleresque", none at all in a three-letter answer where a single letter
would turn "cat" into "bat".

### Media has to be a file, not a page

Link to the file itself — something ending `.mp4`, `.mp3`, `.jpg`. A YouTube or
Spotify **page** is refused, and the builder tells you so. This is not
awkwardness for its own sake: an embedded player cannot be cued to a start
point, stopped on your cue, or kept from showing a grid of related-video
thumbnails to your audience mid-question. Download the clip, host the file,
link the file. You can also set a start and stop point in seconds, so one long
track can serve six questions.

Play every clip through once in the builder before the show. A clip that fails
in the venue is a dead question.

---

## The starter pack

**Load the 50-question starter pack** in the builder gives you five rounds of ten:

| Round | What it is |
|---|---|
| Opening Statements | Ten easy ones on detective fiction |
| The Evidence | Ten picture questions — fingerprints, blood spatter, shoe treads, a cipher, Morse, a floor plan, a line-up, signatures |
| Method | Ten typed answers on forensics and real cases |
| Motive and Opportunity | An alibi timeline, two ordering questions, four numbers |
| The Verdict | Nine harder ones, ending on a final wager |

About 33 minutes and 610 points. It loads as a **new** case every time, so nothing
you have written is overwritten and you can cut it up freely.

The pictures are SVGs generated by `tools/make-pack-images.py`, not stock
photographs. That means they work with no internet in the venue, nothing rots or
changes licence under you, and — mainly — each one is drawn so the question is
answerable from what is on screen. A photo of a fingerprint does not let a room pick
which of four is a whorl.

There are deliberately no audio or video questions in the pack: those need media
files this repository cannot ship, and a question with an empty URL is a dead
question. Adding one is a URL in the builder.

`test/pack.test.js` checks the content the way `test/engine.test.js` checks the code:
that every picture exists and is valid SVG, that no question contains its own answer,
that every multiple choice has exactly one right option and no duplicate wording,
that the marker accepts the pack's own typed answers, and that nothing about any
answer is pushed while a question is open. The first run of it caught a question
whose prompt named the district it was asking for.

To edit the pack at source rather than in the builder, change `tools/make-pack.py`
and re-run it.

---

## Running a show

The control room is built to be used while you are looking at the room rather
than at the screen.

| Key | Does |
|---|---|
| `Space` or `→` | Next step |
| `←` | Back |
| `R` | Reveal the answer |
| `B` | Leaderboard on screen |
| `L` | Lock or open the answers |
| `T` | Pause or restart the clock |

Shortcuts are ignored while you are typing in a box.

The show moves through: lobby → round card → question → answers locked →
answer revealed → (leaderboard) → next question → winner. The primary button
is always labelled with what the **next** press will do, so there is nothing
to remember. **Back** steps to the previous question rather than unwinding the
clock, because on stage "back" always means "I need that question again".

Time running out **locks** the answers. It does not reveal them — there is
usually a bit of theatre to do first, so the reveal is always your call.

Your own screen always shows the correct answer, whatever the room is looking
at. That is the confidence monitor, and it is the reason `host.html` is gated.

**Reloading the control room mid-show is safe.** The code is in the URL, so it
rejoins the running show rather than starting a new one.

### Export the results before you close the tab

The **Export results** button in the Standings panel gives you a CSV with a
column per question. In local mode the show lives in that browser only, so
this is the only copy of the scores.

---

## Local mode and cloud mode

The app picks its mode from whether `assets/js/config.js` has real Supabase
values in it. Nothing else changes.

**Local mode** — the default, zero setup. The control room, the projection and
the leaderboard talk to each other through the browser, so they must be
windows of the *same browser on the same machine*. Two screens off one laptop
is exactly the normal case. You add the teams and you mark them. Player
devices cannot join.

**Cloud mode** — adds the part local mode cannot do: players joining by code
from their own phones, anywhere, with answers collected and marked
automatically as they arrive.

### Setting up cloud mode

1. Make a project at [supabase.com](https://supabase.com) (the free tier is
   plenty — a show is a few hundred rows).
2. Open **SQL Editor → New query**, paste in all of `supabase/schema.sql`, run
   it. It is safe to re-run.
3. **Authentication → Users → Add user.** Give yourself an email and password.
   This is your host login.
4. **Authentication → Providers → Email** and turn **off** "Allow new users to
   sign up". This matters — see below.
5. In `assets/js/config.js` set `supabaseUrl`, `supabaseAnonKey` (both from
   **Project Settings → API**) and `requireLogin: true`.

Now `host.html` and `build.html` ask for that email and password, and players
can join from anywhere.

---

## Who can see what

The host page is the only thing that holds the quiz. It works out a *public
state* — what the room is allowed to know right now — and pushes that. The
projection, the leaderboard and every phone are views of that blob and nothing
else.

So a player who opens devtools mid-question finds no correct option, no
accepted answers, no numeric target, no explanation, and the items of an
ordering question in a scrambled order. None of it is sent until you reveal
it. This is tested rather than asserted: the browser tests read the pushed
state directly and fail if a correct answer appears in it before the reveal.

In cloud mode the database enforces the same thing:

- The quizzes table is **not readable** with the public key at all. Without a
  login the questions and answers are not hidden, they are not sent.
- A player can insert their own team and their own answer, and change their
  answer while the question is open.
- A player **cannot** set `points` or `correct` on an answer. The row-level
  security policy refuses it and a database trigger forces those columns back
  even against a crafted request. Marks are yours alone.

**Two things to be clear about.** The anon key in `config.js` is public by
design — that is how Supabase works, and the policies above are the actual
access control, not the secrecy of that key. Never put the `service_role` key
there; it bypasses every policy. And because every write policy checks "is
logged in" rather than "is this specific person", leaving public sign-up on
would let anyone who reads the page source register an account and gain write
access to your quizzes. That is why step 4 above is not optional.

**The passphrase gate is not security.** In local mode, or in cloud mode
without `requireLogin`, the gate is a word sitting in a file every browser
downloads. Its job is to keep the control room off the projector and turn away
someone who guesses the URL. The form says so. If the answers actually matter,
use cloud mode with a login.

---

## When the venue wifi is bad

Two things are deliberate:

- **The clock is skew-corrected.** The host publishes an absolute end time and
  the moment it was sent; each device works out the time left relative to when
  it received that. A phone with a wrong clock still counts down correctly.
- **Realtime has a poll underneath it.** Every screen re-reads every few
  seconds regardless. A dropped realtime message delays a screen by a moment
  instead of freezing it on question 3 while the room is on question 8. If a
  push fails outright the control room says so, loudly, rather than letting
  you carry on in front of a stale screen.

Measured on the test rig, a state change reaches a phone in well under
50ms; the poll is the floor, not the normal path. Briefly, on an
auto-marked question, a phone can show the reveal before its own verdict
arrives — it says "Checking your answer…" rather than guessing.

**Late answers still get marked.** The host reads the answers back from the
database before marking rather than trusting its own cached copy, and re-marks
if one lands after the reveal. This matters most for **closest number**, where
the marking is a comparison across the whole field: an answer still in flight
would otherwise be left out of that comparison and the points would go to the
wrong team, not merely be missing for one. `test/engine.test.js` pins that
down explicitly so the refetch does not get optimised away later.

### Sound on the projection screen

Browsers block audio until the page has been clicked. The projection screen
plays the clip muted and shows **"Click the screen once to allow sound"** if
that happens. Click it once when you set the screen up and it will not ask
again. Worth doing during setup rather than discovering it on question one.

---

## Tests

```bash
node test/engine.test.js    # 53 checks — scoring, redaction, phases
node test/qr.test.js        # 28 checks — the QR encoder, by decoding it back
node test/pack.test.js      # 14 checks — the starter pack's content
bash tools/test-schema.sh   # 42 checks — the database, against a real PostgreSQL
```

137 checks over the parts that quietly ruin a live show if they are wrong. The first
three run in plain node with no browser and no network:

- **engine** — scoring for every input mode, the redaction guarantees, tie handling,
  phase navigation, validation, clock-skew correction, the live vote payload and the
  results export.
- **qr** — every matrix decoded back through an independently written reader, with
  the Reed-Solomon syndromes checked at zero, plus the format information, version
  information, capacities and data-module counts cross-checked against the published
  values in ISO/IEC 18004 rather than against the encoder itself.
- **pack** — the content checks above.

The fourth needs PostgreSQL installed locally, and is the one worth explaining. The
security claims in this project are claims about the *database*: that a player
cannot read the questions, cannot award themselves points, and cannot get in without
the venue password. `tools/test-schema.sh` starts a throwaway PostgreSQL, supplies
only what Supabase supplies for you — the `anon` and `authenticated` roles,
`auth.uid()`, and the default table grants — runs `supabase/schema.sql` exactly as
shipped, and then tries all of it as a player and as a host. It rolls everything
back and throws the cluster away.

It found two real problems the first time it ran, both described under "Where the
password lives" above, and corrected one of my own assumptions: row level security
on `UPDATE` **filters** rather than raising, so a player's attempt to rewrite the
session state succeeds having changed nothing. Tests that expected an error were
passing for the wrong reason.

The browser tests that drive whole shows end to end are not in the repository,
because they need Playwright and a stand-in for Supabase. They were used to verify
this build — 33 checks in local mode and 50 in cloud mode, covering five devices
signing up with the venue password, a wrong password being refused, the live vote
split matching the votes cast, and the redaction checks run against the live pushed
state rather than against the pixels. The findings are in the commit history.

---

## Layout

```
index.html              Join page
build.html              Quiz builder
host.html               Control room
present.html            Projection screen
play.html               Player device
leaderboard.html        Public leaderboard

assets/css/tokens.css   Every colour, size, space and duration.
                          Nothing below it hardcodes a value
assets/css/app.css      Components for the operator-facing pages
assets/css/present.css  The projection screen, which is a different
                          medium: read from 10 metres, never scrolls,
                          has its own type scale

assets/img/fingerprint.svg  The brand mark, used as a CSS mask
assets/img/favicon.svg  The same mark with its colours baked in

assets/js/config.js     The only file you need to edit
assets/js/quiz-model.js Question types, answer matching, scoring,
                          standings, validation
assets/js/show.js       The redaction boundary and the phase machine.
                          Pure functions, no DOM, no storage
assets/js/store.js      One persistence API over two drivers
assets/js/gate.js       The login / passphrase gate
assets/js/ui.js         Small DOM and formatting helpers
assets/js/builder.js    The builder
assets/js/host.js       The control room
assets/js/present.js    The projection screen
assets/js/play.js       The player device
assets/js/leaderboard.js The leaderboard
assets/js/qr.js         QR encoder. No network, no service

content/starter-pack.json  Fifty questions, five rounds
assets/img/pack/        The picture round's evidence, as SVG

tools/make-pack.py      Rebuilds the starter pack
tools/make-pack-images.py  Redraws its pictures
tools/test-schema.sh    Runs schema.sql against a real PostgreSQL
tools/schema-test/      Its setup and assertions

supabase/schema.sql     Run once. Tables, security policies, the
                          join function that enforces the venue
                          password, and the trigger that protects
                          the marks

test/engine.test.js     node test/engine.test.js
test/qr.test.js         node test/qr.test.js
test/pack.test.js       node test/pack.test.js
```

Quizzes export and import as JSON, so a case can be moved between machines,
kept in version control, or written in a text editor.

### Adding a question type

Add an entry to `TYPES` in `assets/js/quiz-model.js` and, if it needs its own
marking, a branch in `scoreAnswer()`. The builder's type picker, the host, the
projection and the player device all read the registry, so nothing else needs
changing. `input` picks the answer widget: `choice`, `text`, `order`,
`number`, `judged` or `none`.

---

## Two external requests

The pages load `supabase-js` and two webfonts from a CDN. The QR code is generated
locally and needs neither. Neither request is required:
without the fonts the app falls back to the system stack, and without
`supabase-js` it drops to local mode and says so in the console rather than
breaking. If you are running a show somewhere with no internet, download both
and point the `<script>` and `<link>` tags at local copies.

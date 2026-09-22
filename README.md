# So You Want To Be A Detective

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

1. **http://localhost:8000/build.html** — write a case. The passphrase is
   `lestrade` until you change it in `assets/js/config.js`.
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

### Sound on the projection screen

Browsers block audio until the page has been clicked. The projection screen
plays the clip muted and shows **"Click the screen once to allow sound"** if
that happens. Click it once when you set the screen up and it will not ask
again. Worth doing during setup rather than discovering it on question one.

---

## Tests

```bash
node test/engine.test.js
```

46 checks over the parts that quietly ruin a live show if they are wrong:
scoring for every input mode, the redaction guarantees, tie handling,
phase navigation, validation, clock-skew correction and the results export.
They run in plain node with no browser and no network.

The browser tests that drive a whole show end to end — both modes, two player
devices, the redaction checks against the live pushed state — are not in the
repository, because they need Playwright and a stand-in for Supabase. They
were used to verify this build and the findings are in the commit history.

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

supabase/schema.sql     Run once. Tables, security policies, the
                          trigger that protects the marks
test/engine.test.js     node test/engine.test.js
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

The pages load `supabase-js` and two webfonts from a CDN. Neither is required:
without the fonts the app falls back to the system stack, and without
`supabase-js` it drops to local mode and says so in the console rather than
breaking. If you are running a show somewhere with no internet, download both
and point the `<script>` and `<link>` tags at local copies.

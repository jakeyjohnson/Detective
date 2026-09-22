/* =========================================================
   Starter pack tests.

   Content can be wrong in ways code cannot: a question that
   contains its own answer, a picture that does not exist, a
   multiple choice with two right answers. None of that shows up
   until a room of people is looking at it, so it is checked
   here.

   Run:  node test/pack.test.js
   ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const win = {};
win.window = win;
const sandbox = { window: win, console, Date, Math, JSON, Object, Array, String, Number, isFinite, RegExp, Error, Promise };
vm.createContext(sandbox);
for (const f of ['quiz-model.js', 'show.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', f), 'utf8'), sandbox, { filename: f });
}
const Model = win.DetectiveModel;
const Show = win.DetectiveShow;

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'starter-pack.json'), 'utf8'));
const quiz = Model.normaliseQuiz(raw);
const order = Model.runOrder(quiz);

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); }
}
function eq(a, e, what) {
  const as = JSON.stringify(a), es = JSON.stringify(e);
  if (as !== es) throw new Error(`${what || 'value'}: expected ${es}, got ${as}`);
}
function ok(c, what) { if (!c) throw new Error(`${what || 'condition'} was falsy`); }

check('the pack holds fifty questions across five rounds', () => {
  eq(Model.questionCount(quiz), 50, 'questions');
  eq(quiz.rounds.length, 5, 'rounds');
  eq(quiz.rounds.map(r => r.questions.length), [10, 10, 10, 10, 10], 'per round');
});

check('the pack passes the builder’s own validation with no errors', () => {
  const issues = Model.validate(quiz);
  const errors = issues.filter(i => i.level === 'error');
  eq(errors.map(i => i.message), [], 'errors');
});

check('every round and question is titled and worth something', () => {
  quiz.rounds.forEach((r, i) => {
    ok(String(r.title || '').trim(), `round ${i + 1} has a title`);
  });
  order.forEach(e => {
    ok(String(e.question.prompt || '').trim(), `Q${e.number} has a prompt`);
    /* Talking points and wagers are the only things worth zero;
       everything else must be worth marks. */
    if (e.question.type !== 'discussion' && e.question.type !== 'wager') {
      ok(Number(e.question.points) > 0, `Q${e.number} is worth points`);
    }
  });
});

check('every image referenced actually exists and is valid SVG', () => {
  let images = 0;
  order.forEach(e => {
    const url = e.question.media && e.question.media.url;
    if (!url) return;
    images++;
    const file = path.join(ROOT, url);
    ok(fs.existsSync(file), `Q${e.number} media exists: ${url}`);
    const body = fs.readFileSync(file, 'utf8');
    ok(/^<svg|^<\?xml/.test(body.trim()), `${url} looks like SVG`);
    /* SVG is XML, so a named HTML entity makes the whole file fail
       to parse and the picture silently does not appear. */
    const named = body.match(/&(?!#|amp;|lt;|gt;|quot;|apos;)[a-zA-Z]+;/);
    ok(!named, `${url} uses no undefined XML entity${named ? ' (found ' + named[0] + ')' : ''}`);
  });
  ok(images >= 10, `at least ten image questions, found ${images}`);
});

check('no question gives its own answer away in the prompt', () => {
  /* The check that caught the Whitechapel question: its prompt
     named the district it was asking for. */
  order.forEach(e => {
    const q = e.question;
    const prompt = String(q.prompt || '').toLowerCase();
    (q.answers || []).forEach(a => {
      const answer = String(a || '').trim().toLowerCase();
      if (answer.length < 5) return;         // short words appear innocently
      ok(!prompt.includes(answer),
        `Q${e.number} prompt contains its own answer "${a}"`);
    });
  });
});

check('every choice question has exactly one correct option, and four to pick from', () => {
  order.forEach(e => {
    const q = e.question;
    if (Model.inputMode(q) !== 'choice') return;
    const correct = q.options.filter(o => o.correct);
    eq(correct.length, 1, `Q${e.number} correct options`);
    ok(q.options.length === 2 || q.options.length === 4,
      `Q${e.number} offers 2 or 4 options, not ${q.options.length}`);
    q.options.forEach((o, i) => {
      ok(String(o.text || '').trim(), `Q${e.number} option ${i + 1} has text`);
    });
    /* Duplicate option text makes a question unanswerable. */
    const seen = new Set(q.options.map(o => o.text.trim().toLowerCase()));
    eq(seen.size, q.options.length, `Q${e.number} options are all different`);
  });
});

check('every typed question accepts at least one answer, and none is blank', () => {
  order.forEach(e => {
    const q = e.question;
    if (Model.inputMode(q) !== 'text') return;
    const answers = q.answers.filter(a => String(a).trim());
    ok(answers.length >= 1, `Q${e.number} has accepted answers`);
  });
});

check('ordering questions have enough items to be worth ordering', () => {
  order.forEach(e => {
    const q = e.question;
    if (Model.inputMode(q) !== 'order') return;
    ok(q.items.length >= 3, `Q${e.number} has at least three items`);
    const seen = new Set(q.items.map(i => i.text.trim().toLowerCase()));
    eq(seen.size, q.items.length, `Q${e.number} items are all different`);
  });
});

check('the typed answers the pack expects are actually accepted by the marker', () => {
  /* The answers in the pack have to survive the same
     normalisation a player's typing goes through. If the marker
     would reject the pack's own answer, the question is
     unwinnable. */
  order.forEach(e => {
    const q = e.question;
    if (Model.inputMode(q) !== 'text') return;
    q.answers.filter(a => String(a).trim()).forEach(a => {
      ok(Model.matchesText(a, q.answers, q.acceptClose),
        `Q${e.number}: the marker accepts its own answer "${a}"`);
    });
  });
});

check('numeric questions have a target that is not the default zero', () => {
  order.forEach(e => {
    const q = e.question;
    if (Model.inputMode(q) !== 'number') return;
    ok(Number(q.numeric.value) !== 0, `Q${e.number} has a real target`);
  });
});

check('nothing about any answer is pushed while a question is open', () => {
  /* Run the whole pack through the real state builder, one
     question at a time, and look for anything that should not
     have left the host's machine. */
  order.forEach(e => {
    const state = Show.buildState({
      code: 'TEST1', quiz, cursor: e.number - 1, phase: 'question',
      teams: [], answers: []
    });
    const wire = JSON.stringify(state);
    const q = e.question;

    eq(state.reveal, null, `Q${e.number} has no reveal payload`);
    ok(!/"correct"\s*:\s*true/.test(wire), `Q${e.number} pushes no correct flag`);

    (q.answers || []).forEach(a => {
      if (String(a).length <= 3) return;
      ok(!wire.includes(a), `Q${e.number} does not push its answer "${a}"`);
    });

    if (q.explanation && q.explanation.length > 12) {
      ok(!wire.includes(q.explanation.slice(0, 20)),
        `Q${e.number} does not push its explanation`);
    }

    if (Model.inputMode(q) === 'number') {
      ok(!wire.includes('"value":' + q.numeric.value),
        `Q${e.number} does not push its numeric target`);
    }
  });
});

check('the answer IS pushed once the show reaches the reveal', () => {
  /* The mirror of the check above: redaction that never lifts
     would be a projector that shows no answers. */
  order.forEach(e => {
    const state = Show.buildState({
      code: 'TEST1', quiz, cursor: e.number - 1, phase: 'reveal',
      teams: [], answers: []
    });
    ok(state.reveal, `Q${e.number} has a reveal payload`);
    if (Model.inputMode(e.question) !== 'none') {
      ok(String(state.reveal.answerText || '').trim() ||
         (state.reveal.correctOptionIds || []).length ||
         state.reveal.order,
        `Q${e.number} reveal names an answer`);
    }
  });
});

check('a full run of the show presents all fifty once, in order, and ends', () => {
  let cursor = -1, phase = 'lobby';
  const seen = [];
  for (let i = 0; i < 600 && phase !== 'ended'; i++) {
    const next = Show.nextPhase(quiz, cursor, phase);
    cursor = next.cursor;
    phase = next.phase;
    if (phase === 'question') seen.push(cursor);
  }
  eq(seen, Array.from({ length: 50 }, (_, i) => i), 'each question once, in order');
  eq(phase, 'ended', 'the show reaches its end');
});

check('the pack runs to a sensible length for one sitting', () => {
  const seconds = order.reduce((n, e) => n + (Number(e.question.timeLimit) || 0) + 8, 0);
  const minutes = Math.round(seconds / 60);
  ok(minutes > 20 && minutes < 75, `rough running time is ${minutes} min`);
});

console.log('');
if (failures.length) {
  console.log(`  ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach(f => console.log(`  ✗ ${f.name}\n      ${f.message}`));
  console.log('');
  process.exit(1);
} else {
  const seconds = order.reduce((n, e) => n + (Number(e.question.timeLimit) || 0) + 8, 0);
  const points = order.reduce((n, e) => n + (Number(e.question.points) || 0), 0);
  console.log(`  ${passed} checks passed.`);
  console.log(`  ${Model.questionCount(quiz)} questions, ${quiz.rounds.length} rounds, ` +
              `${points} points, about ${Math.round(seconds / 60)} minutes.\n`);
}

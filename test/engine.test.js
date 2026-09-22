/* =========================================================
   Engine tests — the scoring, redaction and phase logic.

   These are the parts that quietly ruin a live show if they
   are wrong: a mis-marked answer, a leaked correct option, a
   Next button that skips a question. They are pure functions,
   so they run in plain node with a stub `window` and no
   browser, no DOM and no network.

   Run:  node test/engine.test.js
   ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---- load the browser modules into a stub global ---- */
const win = {};
win.window = win;
const sandbox = { window: win, console, Date, Math, JSON, Object, Array, String, Number, isFinite, RegExp, Error, Promise };
vm.createContext(sandbox);

for (const f of ['quiz-model.js', 'show.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', f), 'utf8');
  vm.runInContext(src, sandbox, { filename: f });
}

const Model = win.DetectiveModel;
const Show = win.DetectiveShow;

/* ---- tiny assertion harness ---- */
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what || 'value'}: expected ${e}, got ${a}`);
}

function ok(cond, what) {
  if (!cond) throw new Error(`${what || 'condition'} was falsy`);
}

/* =========================================================
   Text answer matching
   ========================================================= */
check('text match is case, punctuation and article insensitive', () => {
  const accepted = ['The Mona Lisa'];
  ok(Model.matchesText('the mona lisa', accepted, false), 'lowercase');
  ok(Model.matchesText('Mona Lisa', accepted, false), 'article dropped');
  ok(Model.matchesText('  MONA   LISA!  ', accepted, false), 'spacing and punctuation');
  ok(!Model.matchesText('mona lise', accepted, false), 'wrong answer rejected when fuzzy is off');
});

check('text match strips accents and normalises ampersands', () => {
  ok(Model.matchesText('Poirot', ['Poirot'], false), 'plain');
  ok(Model.matchesText('Hercule Poirot', ['Hercule Poirot'], false), 'two words');
  ok(Model.matchesText('cafe', ['café'], false), 'accent on the accepted answer');
  ok(Model.matchesText('Holmes and Watson', ['Holmes & Watson'], false), 'ampersand');
});

check('fuzzy matching forgives typos in proportion to length', () => {
  ok(Model.matchesText('Poirott', ['Poirot'], true), 'one slip in a 6-char answer');
  ok(Model.matchesText('Chandlaresque', ['Chandleresque'], true), 'one slip in a long answer');
  /* Short answers get zero tolerance on purpose: with one slip
     allowed, "cat" would match "bat" and "rat". */
  ok(!Model.matchesText('bat', ['cat'], true), 'no tolerance on very short answers');
});

check('empty answers never match', () => {
  ok(!Model.matchesText('', ['anything'], true), 'empty given');
  ok(!Model.matchesText('   ', ['anything'], true), 'whitespace given');
  ok(!Model.matchesText('something', [''], true), 'empty accepted');
});

/* =========================================================
   Scoring by input mode
   ========================================================= */
function choiceQuestion(correctCount = 1) {
  const q = Model.newQuestion('multiple-choice');
  q.prompt = 'Who did it?';
  q.points = 10;
  q.options = [
    Model.newOption('Butler', correctCount >= 1),
    Model.newOption('Cook', correctCount >= 2),
    Model.newOption('Gardener', false),
    Model.newOption('Nephew', false)
  ];
  return q;
}

check('single-answer choice scores exactly right or zero', () => {
  const q = choiceQuestion(1);
  const right = Model.scoreAnswer(q, { value: [q.options[0].id] }, {});
  eq([right.correct, right.points], [true, 10], 'correct pick');

  const wrong = Model.scoreAnswer(q, { value: [q.options[2].id] }, {});
  eq([wrong.correct, wrong.points], [false, 0], 'wrong pick');
});

check('multi-answer choice needs the exact set, not a subset', () => {
  const q = choiceQuestion(2);
  const both = Model.scoreAnswer(q, { value: [q.options[0].id, q.options[1].id] }, {});
  eq(both.correct, true, 'both correct options');

  const orderSwapped = Model.scoreAnswer(q, { value: [q.options[1].id, q.options[0].id] }, {});
  eq(orderSwapped.correct, true, 'selection order must not matter');

  const partial = Model.scoreAnswer(q, { value: [q.options[0].id] }, {});
  eq([partial.correct, partial.points], [false, 0], 'half the set is not correct');

  const overshoot = Model.scoreAnswer(q, { value: [q.options[0].id, q.options[1].id, q.options[2].id] }, {});
  eq(overshoot.correct, false, 'picking everything is not correct');
});

check('no answer at all scores zero rather than throwing', () => {
  const q = choiceQuestion(1);
  eq(Model.scoreAnswer(q, null, {}), { correct: false, points: 0, partial: 0 }, 'null answer');
  eq(Model.scoreAnswer(q, { value: null }, {}), { correct: false, points: 0, partial: 0 }, 'null value');
});

check('ordering gives partial credit per item in place', () => {
  const q = Model.newQuestion('ordering');
  q.points = 12;
  q.items = ['A', 'B', 'C', 'D'].map(t => ({ id: 'i_' + t, text: t }));
  const right = ['i_A', 'i_B', 'i_C', 'i_D'];

  const perfect = Model.scoreAnswer(q, { value: right }, {});
  eq([perfect.correct, perfect.points], [true, 12], 'perfect order');

  /* Two of four in the right place = half marks, and crucially
     NOT "correct" — full points are for a perfect run. */
  const half = Model.scoreAnswer(q, { value: ['i_A', 'i_B', 'i_D', 'i_C'] }, {});
  eq([half.correct, half.points], [false, 6], 'two of four in place');

  const none = Model.scoreAnswer(q, { value: ['i_D', 'i_C', 'i_B', 'i_A'] }, {});
  eq([none.correct, none.points], [false, 0], 'fully reversed');
});

check('numeric with a tolerance is an absolute test', () => {
  const q = Model.newQuestion('numeric');
  q.points = 10;
  q.numeric = { value: 100, tolerance: 5 };

  eq(Model.scoreAnswer(q, { value: 103 }, {}).correct, true, 'inside tolerance');
  eq(Model.scoreAnswer(q, { value: 95 }, {}).correct, true, 'on the boundary');
  eq(Model.scoreAnswer(q, { value: 94 }, {}).correct, false, 'outside tolerance');
  eq(Model.scoreAnswer(q, { value: 'not a number' }, {}).correct, false, 'non-numeric input');
});

check('numeric without a tolerance awards the closest in the field', () => {
  const q = Model.newQuestion('numeric');
  q.points = 10;
  q.numeric = { value: 100, tolerance: null };

  const field = [{ value: 90 }, { value: 104 }, { value: 150 }];
  const ctx = { allAnswers: field };

  eq(Model.scoreAnswer(q, { value: 104 }, {}, ctx).correct, true, 'closest wins');
  eq(Model.scoreAnswer(q, { value: 90 }, {}, ctx).correct, false, 'second closest loses');
  eq(Model.scoreAnswer(q, { value: 150 }, {}, ctx).correct, false, 'far off loses');
});

check('closest-number marking depends on the WHOLE field being present', () => {
  /* This is why the host refetches the answers from the store
     before marking instead of trusting its cached copy. For every
     other type a missing answer only costs that one team. Here it
     silently moves the points to someone else: with only the
     far-off guess present, the far-off guess IS the closest. */
  const q = Model.newQuestion('numeric');
  q.points = 10;
  q.numeric = { value: 221, tolerance: null };

  const far = { value: 200 };
  const near = { value: 219 };

  const wholeField = { allAnswers: [far, near] };
  eq(Model.scoreAnswer(q, far, {}, wholeField).correct, false, 'with both answers in, the far guess loses');
  eq(Model.scoreAnswer(q, near, {}, wholeField).correct, true, 'and the near guess wins');

  const missingOne = { allAnswers: [far] };
  eq(Model.scoreAnswer(q, far, {}, missingOne).correct, true,
    'but alone in the field it would win — so the field must be complete before marking');
});

check('equally close numeric guesses both win', () => {
  const q = Model.newQuestion('numeric');
  q.points = 10;
  q.numeric = { value: 100, tolerance: null };
  const ctx = { allAnswers: [{ value: 95 }, { value: 105 }] };

  eq(Model.scoreAnswer(q, { value: 95 }, {}, ctx).correct, true, 'below, equally close');
  eq(Model.scoreAnswer(q, { value: 105 }, {}, ctx).correct, true, 'above, equally close');
});

check('speed bonus is opt-in, correct-only and capped at +50%', () => {
  const q = choiceQuestion(1);
  q.points = 10;
  q.timeLimit = 30;
  const right = { value: [q.options[0].id], elapsedMs: 0 };

  eq(Model.scoreAnswer(q, right, { speedBonus: false }).points, 10, 'off by default');
  eq(Model.scoreAnswer(q, right, { speedBonus: true }).points, 15, 'instant answer gets the full bonus');
  eq(Model.scoreAnswer(q, { value: [q.options[0].id], elapsedMs: 30000 }, { speedBonus: true }).points, 10,
    'answering on the buzzer gets no bonus');
  eq(Model.scoreAnswer(q, { value: [q.options[2].id], elapsedMs: 0 }, { speedBonus: true }).points, 0,
    'a fast wrong answer earns nothing');
});

check('host-judged and discussion questions are not auto-scored', () => {
  eq(Model.scoreAnswer(Model.newQuestion('host-judged'), { value: 'x' }, {}), null, 'open answer');
  eq(Model.scoreAnswer(Model.newQuestion('discussion'), { value: 'x' }, {}), null, 'talking point');
  eq(Model.isAutoScored(Model.newQuestion('wager')), false, 'wager');
});

check('wager moves the stake both ways', () => {
  const q = Model.newQuestion('wager');
  eq(Model.scoreWager(q, { wager: 250 }, true).points, 250, 'won');
  eq(Model.scoreWager(q, { wager: 250 }, false).points, -250, 'lost');
  eq(Model.scoreWager(q, { wager: -50 }, false).points, 0, 'a negative stake cannot be used to gain points');
  eq(Model.scoreWager(q, { wager: 'abc' }, true).points, 0, 'a junk stake is worth nothing');
});

/* =========================================================
   Standings
   ========================================================= */
function sessionWith(teams, answers, adjustments) {
  return { teams, answers, adjustments: adjustments || {} };
}

check('standings sum the answer log and sort by score', () => {
  const s = sessionWith(
    [
      { id: 't1', name: 'Baker Street', joinedAt: '2026-01-01T10:00:00Z' },
      { id: 't2', name: 'The Yard', joinedAt: '2026-01-01T10:01:00Z' }
    ],
    {
      q1: { t1: { points: 10, correct: true }, t2: { points: 0, correct: false } },
      q2: { t1: { points: 0, correct: false }, t2: { points: 10, correct: true } },
      q3: { t2: { points: 10, correct: true } }
    }
  );
  const rows = Model.standings(s);
  eq(rows.map(r => [r.name, r.score]), [['The Yard', 20], ['Baker Street', 10]], 'order and totals');
});

check('standings break ties on correct count, then join order', () => {
  const s = sessionWith(
    [
      { id: 't1', name: 'Early', joinedAt: '2026-01-01T10:00:00Z' },
      { id: 't2', name: 'Late', joinedAt: '2026-01-01T10:05:00Z' },
      { id: 't3', name: 'Accurate', joinedAt: '2026-01-01T10:09:00Z' }
    ],
    {
      /* All on 20, but Accurate got there on two correct answers
         rather than one big partial-credit score. */
      q1: { t1: { points: 20, correct: true }, t2: { points: 20, correct: true }, t3: { points: 10, correct: true } },
      q2: { t3: { points: 10, correct: true } }
    }
  );
  const rows = Model.standings(s);
  eq(rows.map(r => r.name), ['Accurate', 'Early', 'Late'], 'correct count then join order');
  /* All three really are on 20 points, so they all hold rank 1.
     The tiebreaks decide the order they are LISTED in, not their
     rank — a team is only ranked below another if it scored less. */
  eq(rows.map(r => r.rank), [1, 1, 1], 'equal scores share a rank however they are ordered');
});

check('rank skips the places taken by a tie', () => {
  const s = sessionWith(
    [
      { id: 't1', name: 'Joint first', joinedAt: '2026-01-01T10:00:00Z' },
      { id: 't2', name: 'Also first', joinedAt: '2026-01-01T10:01:00Z' },
      { id: 't3', name: 'Third', joinedAt: '2026-01-01T10:02:00Z' }
    ],
    {
      q1: { t1: { points: 20, correct: true }, t2: { points: 20, correct: true }, t3: { points: 10, correct: true } }
    }
  );
  /* Standard competition ranking: 1, 1, 3 — not 1, 1, 2. The team
     in third place is genuinely third, and a leaderboard that
     calls it second is the sort of thing a room notices. */
  eq(Model.standings(s).map(r => [r.name, r.rank]), [['Joint first', 1], ['Also first', 1], ['Third', 3]], 'ranks');
});

check('manual adjustments land in the total', () => {
  const s = sessionWith(
    [{ id: 't1', name: 'Docked', joinedAt: '' }],
    { q1: { t1: { points: 10, correct: true } } },
    { t1: -4 }
  );
  eq(Model.standings(s)[0].score, 6, 'adjustment applied');
});

check('a team that never answered still appears on zero', () => {
  const s = sessionWith([{ id: 't1', name: 'Silent', joinedAt: '' }], {});
  eq(Model.standings(s).map(r => [r.name, r.score, r.answered]), [['Silent', 0, 0]], 'present with nothing');
});

/* =========================================================
   Redaction — the security-relevant part
   ========================================================= */
check('a public question never carries the correct option', () => {
  const q = choiceQuestion(1);
  const pub = Show.publicQuestion(q, {});
  ok(pub.options.length === 4, 'options are present');
  ok(pub.options.every(o => !('correct' in o)), 'no correct flag on any option');
  ok(!('answers' in pub), 'no accepted-answers list');
  ok(!('explanation' in pub), 'no explanation');
  ok(!('numeric' in pub), 'no numeric target');
});

check('a public question drops blank options rather than showing empty boxes', () => {
  const q = choiceQuestion(1);
  q.options[3].text = '';
  eq(Show.publicQuestion(q, {}).options.length, 3, 'blank option omitted');
});

check('a text question leaks neither the answer nor the explanation', () => {
  const q = Model.newQuestion('standard');
  q.prompt = 'Name the detective';
  q.answers = ['Poirot'];
  q.explanation = 'Belgian, moustache.';
  const pub = Show.publicQuestion(q, {});
  const serialised = JSON.stringify(pub);
  ok(!serialised.includes('Poirot'), 'answer absent from the serialised payload');
  ok(!serialised.includes('moustache'), 'explanation absent');
});

check('ordering items are scrambled, not handed over in answer order', () => {
  const q = Model.newQuestion('ordering');
  q.items = 'ABCDEFGH'.split('').map(t => ({ id: 'i_' + t, text: t }));
  const pub = Show.publicQuestion(q, {});
  const given = pub.items.map(i => i.id).join(',');
  const answer = q.items.map(i => i.id).join(',');
  ok(given !== answer, 'scrambled relative to the stored answer order');
  eq(pub.items.length, 8, 'all items still present');
  eq(pub.items.map(i => i.id).sort(), q.items.map(i => i.id).sort(), 'same items, different order');
});

check('the scramble is identical on every device', () => {
  const q = Model.newQuestion('ordering');
  q.items = 'ABCDEFGH'.split('').map(t => ({ id: 'i_' + t, text: t }));
  const a = Show.publicQuestion(q, {}).items.map(i => i.id);
  const b = Show.publicQuestion(q, {}).items.map(i => i.id);
  eq(a, b, 'deterministic for a given question id');
});

check('state carries no reveal payload until the reveal phase', () => {
  const quiz = Model.newQuiz('Case');
  const q = choiceQuestion(1);
  q.explanation = 'It was the butler all along.';
  quiz.rounds[0].questions = [q];

  const ctxBase = { code: 'ABCDE', quiz, cursor: 0, teams: [], answers: [] };

  for (const phase of ['lobby', 'round-intro', 'question', 'closed']) {
    const state = Show.buildState({ ...ctxBase, phase });
    eq(state.reveal, null, `no reveal during "${phase}"`);
    ok(!JSON.stringify(state).includes('butler all along'), `explanation absent during "${phase}"`);
  }

  const revealed = Show.buildState({ ...ctxBase, phase: 'reveal' });
  ok(revealed.reveal, 'reveal payload present once revealed');
  eq(revealed.reveal.correctOptionIds, [q.options[0].id], 'correct option named');
  eq(revealed.reveal.answerText, 'Butler', 'answer spelled out');
});

/* =========================================================
   Run order and phase navigation
   ========================================================= */
function twoRoundQuiz() {
  const quiz = Model.newQuiz('Two rounds');
  quiz.rounds = [Model.newRound('Round 1'), Model.newRound('Round 2')];
  quiz.rounds[0].questions = [Model.newQuestion('standard'), Model.newQuestion('standard')];
  quiz.rounds[1].questions = [Model.newQuestion('standard')];
  quiz.settings.showBoardAfterRound = false;
  quiz.settings.showBoardAfterEach = false;
  return quiz;
}

check('run order flattens rounds and numbers questions from one', () => {
  const order = Model.runOrder(twoRoundQuiz());
  eq(order.map(e => e.number), [1, 2, 3], 'continuous numbering');
  eq(order.map(e => e.roundIndex), [0, 0, 1], 'round attribution');
  eq(order.map(e => e.indexInRound), [0, 1, 0], 'position within the round');
});

check('the show walks every question exactly once', () => {
  const quiz = twoRoundQuiz();
  let cursor = -1, phase = 'lobby';
  const seen = [];

  for (let i = 0; i < 40 && phase !== 'ended'; i++) {
    const next = Show.nextPhase(quiz, cursor, phase);
    cursor = next.cursor;
    phase = next.phase;
    if (phase === 'question') seen.push(cursor);
  }

  eq(seen, [0, 1, 2], 'each question presented once, in order');
  eq(phase, 'ended', 'the show reaches its end');
});

check('a round boundary shows a round card', () => {
  const quiz = twoRoundQuiz();
  /* Walk to the reveal of question 2, the last in round 1. */
  let s = { cursor: 1, phase: 'reveal' };
  s = Show.nextPhase(quiz, s.cursor, s.phase);
  eq([s.cursor, s.phase], [2, 'round-intro'], 'crossing into round 2 shows its card');
});

check('the leaderboard stop is honoured when configured', () => {
  const quiz = twoRoundQuiz();
  quiz.settings.showBoardAfterEach = true;

  let s = Show.nextPhase(quiz, 0, 'reveal');
  eq(s.phase, 'board', 'board after every question');

  s = Show.nextPhase(quiz, 0, 'board');
  eq([s.cursor, s.phase], [1, 'question'], 'then straight on to the next question');
});

check('the last reveal leads to the winner, not a fourth question', () => {
  const quiz = twoRoundQuiz();
  quiz.settings.showBoardAfterEach = true;
  const s = Show.nextPhase(quiz, 2, 'reveal');
  eq(s.phase, 'winner', 'end of the run order');
});

check('an empty quiz cannot be started', () => {
  const quiz = Model.newQuiz('Empty');
  quiz.rounds[0].questions = [];
  const s = Show.nextPhase(quiz, -1, 'lobby');
  eq([s.cursor, s.phase], [-1, 'lobby'], 'stays in the lobby');
});

check('back steps to the previous question rather than unwinding a timer', () => {
  const quiz = twoRoundQuiz();
  eq(Show.prevPhase(quiz, 2, 'question'), { cursor: 1, phase: 'reveal' }, 'from a question');
  eq(Show.prevPhase(quiz, 1, 'reveal'), { cursor: 1, phase: 'question' }, 'from a reveal, re-ask it');
  eq(Show.prevPhase(quiz, 0, 'question'), { cursor: -1, phase: 'lobby' }, 'from the first question');
});

/* =========================================================
   Marking a whole question
   ========================================================= */
check('marking a question returns one row per submitted answer', () => {
  const q = choiceQuestion(1);
  const rows = [
    { id: 'a1', questionId: q.id, teamId: 't1', value: [q.options[0].id] },
    { id: 'a2', questionId: q.id, teamId: 't2', value: [q.options[1].id] },
    { id: 'a3', questionId: 'other', teamId: 't3', value: [] }
  ];
  const marks = Show.markQuestion(q, rows, {});
  eq(marks.length, 2, 'answers for other questions are left alone');
  eq(marks.find(m => m.id === 'a1').points, 10, 'correct team scored');
  eq(marks.find(m => m.id === 'a2').points, 0, 'wrong team zeroed');
});

check('re-marking a wager keeps the host rulings already made', () => {
  const q = Model.newQuestion('wager');
  const rows = [
    { id: 'a1', questionId: q.id, teamId: 't1', wager: 100, correct: true },
    { id: 'a2', questionId: q.id, teamId: 't2', wager: 100, correct: false },
    { id: 'a3', questionId: q.id, teamId: 't3', wager: 100, correct: null }
  ];
  const marks = Show.markQuestion(q, rows, {});
  eq(marks.length, 2, 'unruled answers are left for the host');
  eq(marks.find(m => m.id === 'a1').points, 100, 'won the stake');
  eq(marks.find(m => m.id === 'a2').points, -100, 'lost the stake');
});

check('a host override recomputes points from the question', () => {
  const q = choiceQuestion(1);
  q.points = 25;
  const row = { id: 'a1', questionId: q.id, teamId: 't1', value: [] };
  eq(Show.overrideAnswer(q, row, true), { id: 'a1', points: 25, correct: true }, 'marked right');
  eq(Show.overrideAnswer(q, row, false), { id: 'a1', points: 0, correct: false }, 'marked wrong');
});

/* =========================================================
   Answer distribution
   ========================================================= */
check('distribution counts the split across options', () => {
  const q = choiceQuestion(1);
  const session = {
    teams: [],
    answers: {
      [q.id]: {
        t1: { value: [q.options[0].id] },
        t2: { value: [q.options[1].id] },
        t3: { value: [q.options[1].id] }
      }
    }
  };
  const dist = Model.distribution(q, session);
  eq(dist.total, 3, 'three teams answered');
  eq(dist.rows.map(r => r.count), [1, 2, 0, 0], 'per-option counts');
  eq(dist.rows[0].correct, true, 'the correct option is flagged for the reveal');
  eq(Math.round(dist.rows[1].share * 100), 67, 'share as a percentage');
});

check('distribution is undefined for non-choice questions', () => {
  eq(Model.distribution(Model.newQuestion('standard'), { answers: {} }), null, 'text question');
});

/* =========================================================
   Validation
   ========================================================= */
check('validation catches the mistakes that break a live show', () => {
  const quiz = Model.newQuiz('Case');
  const blankChoice = choiceQuestion(1);
  blankChoice.prompt = '';
  const noCorrect = choiceQuestion(0);
  noCorrect.prompt = 'Who?';
  const videoNoUrl = Model.newQuestion('video');
  videoNoUrl.prompt = 'What happens next?';
  const textNoAnswers = Model.newQuestion('standard');
  textNoAnswers.prompt = 'Name them';

  quiz.rounds[0].questions = [blankChoice, noCorrect, videoNoUrl, textNoAnswers];
  const issues = Model.validate(quiz);
  const messages = issues.map(i => i.message).join(' | ');

  ok(/Q1 has no question text/.test(messages), 'missing prompt');
  ok(/Q2 has no correct option/.test(messages), 'no correct option marked');
  ok(/Q3 is a video question with no media URL/.test(messages), 'missing media');
  ok(/Q4 has no accepted answers/.test(messages), 'unmarkable text question');
});

check('a complete quiz validates clean', () => {
  const quiz = Model.newQuiz('Good case');
  const q = choiceQuestion(1);
  q.prompt = 'Who did it?';
  quiz.rounds[0].questions = [q];
  eq(Model.validate(quiz).filter(i => i.level === 'error'), [], 'no errors');
});

/* =========================================================
   Normalisation — loading older or hand-edited quiz JSON
   ========================================================= */
check('a minimal quiz object is filled out to a complete one', () => {
  const quiz = Model.normaliseQuiz({ title: 'Imported', rounds: [{ questions: [{ type: 'standard', prompt: 'Hi' }] }] });
  ok(quiz.settings, 'settings defaulted');
  ok(quiz.rounds[0].id, 'round given an id');
  const q = quiz.rounds[0].questions[0];
  ok(q.id, 'question given an id');
  eq(q.points, 10, 'points defaulted');
  eq(q.media.kind, 'none', 'media defaulted');
  eq(q.options, [], 'options defaulted to an empty list');
});

check('junk and empty input do not throw', () => {
  ok(Model.normaliseQuiz(null).rounds.length === 1, 'null becomes a usable empty quiz');
  ok(Model.normaliseQuiz({}).rounds.length === 1, 'empty object gets a first round');
  eq(Model.normaliseQuestion({ answers: ['ok', 42, null] }).answers, ['ok'], 'non-string answers dropped');
});

/* =========================================================
   Timer skew correction
   ========================================================= */
check('remaining time is corrected for clock skew between devices', () => {
  const now = Date.now();
  const state = {
    pushedAt: new Date(now + 60000).toISOString(),   // host clock runs a minute fast
    timer: { running: true, endsAt: new Date(now + 60000 + 30000).toISOString(), duration: 30 }
  };
  /* Received "now" on this device. The 60s skew must cancel out
     and leave the real 30 seconds. */
  const remaining = Show.remainingMs(state, Date.now());
  ok(Math.abs(remaining - 30000) < 250, `expected about 30000ms, got ${remaining}`);
});

check('a paused timer holds its remaining time', () => {
  const state = { pushedAt: new Date().toISOString(), timer: { paused: true, remainingMs: 12000 } };
  eq(Show.remainingMs(state, Date.now()), 12000, 'held');
});

check('a question with no timer reports no remaining time', () => {
  eq(Show.remainingMs({ pushedAt: new Date().toISOString(), timer: null }, Date.now()), null, 'no timer');
  eq(Show.remainingMs({}, Date.now()), null, 'no state');
});

/* =========================================================
   Join codes
   ========================================================= */
check('join codes avoid characters that get misread off a projector', () => {
  for (let i = 0; i < 300; i++) {
    const code = Model.makeCode(5);
    eq(code.length, 5, 'length');
    ok(!/[IO01]/.test(code), `"${code}" contains an ambiguous character`);
    ok(/^[A-Z2-9]+$/.test(code), `"${code}" is not uppercase alphanumeric`);
  }
});

/* =========================================================
   Results export
   ========================================================= */
check('the results CSV has a column per question and escapes commas', () => {
  const quiz = Model.newQuiz('Export');
  const q1 = choiceQuestion(1);
  const q2 = choiceQuestion(1);
  quiz.rounds[0].questions = [q1, q2];

  const teams = [{ id: 't1', name: 'Smith, Jones & Co', joinedAt: '' }];
  const rows = [
    { id: 'a1', questionId: q1.id, teamId: 't1', points: 10, correct: true },
    { id: 'a2', questionId: q2.id, teamId: 't1', points: 0, correct: false }
  ];

  const csv = Show.resultsCsv(quiz, teams, rows, {});
  const lines = csv.split('\n');
  eq(lines[0], 'Rank,Team,Total,Q1,Q2', 'header');
  eq(lines[1], '1,"Smith, Jones & Co",10,10,0', 'row with an escaped team name');
});

/* =========================================================
   Report
   ========================================================= */
console.log('');
if (failures.length) {
  console.log(`  ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach(f => console.log(`  ✗ ${f.name}\n      ${f.message}`));
  console.log('');
  process.exit(1);
} else {
  console.log(`  ${passed} checks passed.\n`);
}

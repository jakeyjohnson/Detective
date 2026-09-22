/* =========================================================
   Quiz model — question types, defaults, scoring.

   This file is the single place question types are defined.
   Adding a type means adding one entry to TYPES plus a case
   in scoreAnswer(); the builder, host, projection and player
   views all read the registry and need no changes. See
   README.md "Adding a question type".
   ========================================================= */
(function (window) {
  'use strict';

  var Model = {};

  /* ---------------------------------------------------------
     Question type registry
     ---------------------------------------------------------
     label    what the builder calls it
     blurb    one line of help in the type picker
     media    'none' | 'optional' | 'required' — whether this type
              carries a video/audio/image stimulus
     mediaKind for types whose media is the point ('video','audio','image')
     input    how the player answers:
                'choice'  pick from options (one or many correct)
                'text'    type an answer, auto-marked
                'order'   arrange items into a sequence
                'number'  enter a number, closest wins
                'judged'  type an answer, host marks it by hand
                'none'    no player input at all (host scores off-app)
     answerModes  types that can be asked either way (the media
              types) list the input modes they support; the
              question's own `input` field picks one.
     autoScored  whether the engine can mark it without the host
  */
  var TYPES = {
    'standard': {
      label: 'Standard',
      blurb: 'Type the answer. Auto-marked against your accepted answers.',
      media: 'optional',
      input: 'text',
      autoScored: true
    },
    'multiple-choice': {
      label: 'Multiple choice',
      blurb: 'Two to six options. One or several can be correct.',
      media: 'optional',
      input: 'choice',
      autoScored: true
    },
    'true-false': {
      label: 'True or false',
      blurb: 'Two fixed options. Fastest round-filler there is.',
      media: 'optional',
      input: 'choice',
      autoScored: true,
      fixedOptions: ['True', 'False']
    },
    'video': {
      label: 'Video',
      blurb: 'Play a clip, then ask. Answer by choice or typing.',
      media: 'required',
      mediaKind: 'video',
      input: 'choice',
      answerModes: ['choice', 'text', 'judged'],
      autoScored: true
    },
    'audio': {
      label: 'Audio',
      blurb: 'Play a sound or track. Name that tune, name that voice.',
      media: 'required',
      mediaKind: 'audio',
      input: 'text',
      answerModes: ['choice', 'text', 'judged'],
      autoScored: true
    },
    'image': {
      label: 'Image',
      blurb: 'Show a photo, map, document or crime scene.',
      media: 'required',
      mediaKind: 'image',
      input: 'choice',
      answerModes: ['choice', 'text', 'judged'],
      autoScored: true
    },
    'ordering': {
      label: 'Put in order',
      blurb: 'Arrange events, suspects or clues into the right sequence.',
      media: 'optional',
      input: 'order',
      autoScored: true
    },
    'numeric': {
      label: 'Closest number',
      blurb: 'Nearest guess takes it. Good for a tie-breaker.',
      media: 'optional',
      input: 'number',
      autoScored: true
    },
    'wager': {
      label: 'Final wager',
      blurb: 'Teams stake points before seeing the question. Right doubles it, wrong loses it.',
      media: 'optional',
      input: 'judged',
      answerModes: ['text', 'judged', 'choice'],
      autoScored: false
    },
    'host-judged': {
      label: 'Open answer',
      blurb: 'Long or subjective answers. You mark them yourself.',
      media: 'optional',
      input: 'judged',
      autoScored: false
    },
    'discussion': {
      label: 'Talking point',
      blurb: 'No answers collected. Put something on screen and talk to the room.',
      media: 'optional',
      input: 'none',
      autoScored: false
    }
  };

  Model.TYPES = TYPES;
  Model.typeList = function () {
    return Object.keys(TYPES).map(function (k) {
      var t = TYPES[k];
      return { key: k, label: t.label, blurb: t.blurb };
    });
  };
  Model.type = function (key) { return TYPES[key] || TYPES['standard']; };

  /* Effective input mode for a question: its own override if the
     type allows alternatives, otherwise the type's default. */
  Model.inputMode = function (q) {
    var t = Model.type(q.type);
    if (t.answerModes && q.input && t.answerModes.indexOf(q.input) !== -1) return q.input;
    return t.input;
  };

  Model.isAutoScored = function (q) {
    if (Model.inputMode(q) === 'judged') return false;
    if (Model.inputMode(q) === 'none') return false;
    return Model.type(q.type).autoScored !== false;
  };

  Model.collectsAnswers = function (q) {
    return Model.inputMode(q) !== 'none';
  };

  /* ---------------------------------------------------------
     IDs
     ---------------------------------------------------------
     Short, collision-resistant enough for a quiz document that
     will hold hundreds of items, not millions. Not a security
     token — never used for access control. */
  Model.uid = function (prefix) {
    return (prefix || 'id') + '_' +
      Date.now().toString(36).slice(-5) +
      Math.random().toString(36).slice(2, 7);
  };

  /* Join codes deliberately skip I, O, 0, 1 — they get misread
     off a projector from the back of a room, and a mistyped code
     is a player who can't play. */
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  Model.makeCode = function (len) {
    var n = len || 5, out = '';
    for (var i = 0; i < n; i++) {
      out += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    return out;
  };

  /* ---------------------------------------------------------
     Factories
     --------------------------------------------------------- */
  Model.newOption = function (text, correct) {
    return { id: Model.uid('o'), text: text || '', correct: !!correct };
  };

  Model.newQuestion = function (type) {
    var key = TYPES[type] ? type : 'standard';
    var t = TYPES[key];
    var q = {
      id: Model.uid('q'),
      type: key,
      prompt: '',
      points: 10,
      timeLimit: 30,
      explanation: '',
      media: { kind: t.mediaKind || 'none', url: '', startAt: null, endAt: null, autoplay: true, loop: false },
      options: [],
      answers: [],
      acceptClose: true,     // fuzzy text matching — forgives a typo
      items: [],
      numeric: { value: 0, tolerance: null },
      wager: { min: 0, max: null },
      input: t.input
    };

    if (key === 'true-false') {
      q.options = [Model.newOption('True', true), Model.newOption('False', false)];
      q.timeLimit = 15;
    } else if (Model.inputMode(q) === 'choice') {
      q.options = [Model.newOption('', true), Model.newOption(''), Model.newOption(''), Model.newOption('')];
    } else if (key === 'ordering') {
      q.items = [
        { id: Model.uid('i'), text: '' },
        { id: Model.uid('i'), text: '' },
        { id: Model.uid('i'), text: '' },
        { id: Model.uid('i'), text: '' }
      ];
      q.timeLimit = 60;
    } else if (key === 'wager') {
      q.points = 0;            // the stake is the score here
      q.timeLimit = 90;
      q.wager = { min: 0, max: null };
    } else if (key === 'video' || key === 'audio') {
      q.timeLimit = 45;
    } else if (key === 'discussion') {
      q.timeLimit = 0;         // 0 = no timer, host moves on manually
      q.points = 0;
    }

    return q;
  };

  Model.newRound = function (title) {
    return {
      id: Model.uid('r'),
      title: title || 'New round',
      description: '',
      questions: []
    };
  };

  Model.newQuiz = function (title) {
    var r = Model.newRound('Round 1');
    return {
      id: Model.uid('quiz'),
      title: title || 'Untitled case',
      subtitle: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: {
        speedBonus: false,        // award up to +50% for answering early
        showBoardAfterEach: false,// leaderboard between every question
        showBoardAfterRound: true,
        shuffleOptions: false,
        allowLateJoin: true
      },
      rounds: [r]
    };
  };

  /* ---------------------------------------------------------
     Normalising a loaded quiz
     ---------------------------------------------------------
     Quizzes are stored as JSON and may have been written by an
     older version of this app (or hand-edited, or imported).
     Everything downstream assumes a complete shape, so fill in
     anything missing here rather than defending against nulls
     in five different views. */
  Model.normaliseQuiz = function (raw) {
    var base = Model.newQuiz();
    var q = Object.assign({}, base, raw || {});
    q.settings = Object.assign({}, base.settings, (raw && raw.settings) || {});
    q.rounds = ((raw && raw.rounds) || []).map(function (r) {
      return {
        id: r.id || Model.uid('r'),
        title: r.title || 'Round',
        description: r.description || '',
        questions: (r.questions || []).map(Model.normaliseQuestion)
      };
    });
    if (!q.rounds.length) q.rounds = [Model.newRound('Round 1')];
    return q;
  };

  Model.normaliseQuestion = function (raw) {
    var base = Model.newQuestion(raw && raw.type);
    var q = Object.assign({}, base, raw || {});
    q.media = Object.assign({}, base.media, (raw && raw.media) || {});
    q.numeric = Object.assign({}, base.numeric, (raw && raw.numeric) || {});
    q.wager = Object.assign({}, base.wager, (raw && raw.wager) || {});
    q.options = ((raw && raw.options) || []).map(function (o) {
      return { id: o.id || Model.uid('o'), text: o.text || '', correct: !!o.correct };
    });
    q.items = ((raw && raw.items) || []).map(function (i) {
      return { id: i.id || Model.uid('i'), text: i.text || '' };
    });
    q.answers = ((raw && raw.answers) || []).filter(function (a) { return typeof a === 'string'; });
    if (!q.id) q.id = Model.uid('q');
    return q;
  };

  /* ---------------------------------------------------------
     Flattening
     ---------------------------------------------------------
     Rounds are how a show is written; a flat running order is
     how it's played. Every consumer of "what's question 7"
     uses this. */
  Model.runOrder = function (quiz) {
    var out = [];
    (quiz.rounds || []).forEach(function (round, ri) {
      (round.questions || []).forEach(function (q, qi) {
        out.push({
          question: q,
          round: round,
          roundIndex: ri,
          indexInRound: qi,
          number: out.length + 1
        });
      });
    });
    return out;
  };

  Model.questionCount = function (quiz) {
    return (quiz.rounds || []).reduce(function (n, r) {
      return n + ((r.questions || []).length);
    }, 0);
  };

  /* ---------------------------------------------------------
     Validation — surfaced in the builder as warnings, never as
     a hard block. A half-written quiz must stay saveable; the
     host is often still writing questions an hour before doors.
     --------------------------------------------------------- */
  Model.validate = function (quiz) {
    var issues = [];
    if (!String(quiz.title || '').trim()) {
      issues.push({ level: 'warn', where: 'quiz', message: 'The case has no title.' });
    }
    if (!Model.questionCount(quiz)) {
      issues.push({ level: 'error', where: 'quiz', message: 'No questions yet.' });
    }

    Model.runOrder(quiz).forEach(function (entry) {
      var q = entry.question;
      var at = 'Q' + entry.number;
      var mode = Model.inputMode(q);
      var t = Model.type(q.type);

      if (!String(q.prompt || '').trim()) {
        issues.push({ level: 'error', where: q.id, message: at + ' has no question text.' });
      }
      if (t.media === 'required' && !String(q.media.url || '').trim()) {
        issues.push({ level: 'error', where: q.id, message: at + ' is a ' + t.label.toLowerCase() + ' question with no media URL.' });
      }
      if (mode === 'choice') {
        var filled = q.options.filter(function (o) { return String(o.text || '').trim(); });
        if (filled.length < 2) {
          issues.push({ level: 'error', where: q.id, message: at + ' needs at least two options.' });
        }
        if (!q.options.some(function (o) { return o.correct && String(o.text || '').trim(); })) {
          issues.push({ level: 'error', where: q.id, message: at + ' has no correct option marked.' });
        }
      }
      if (mode === 'text' && !q.answers.filter(function (a) { return a.trim(); }).length) {
        issues.push({ level: 'error', where: q.id, message: at + ' has no accepted answers, so nothing can be marked right.' });
      }
      if (mode === 'order' && q.items.filter(function (i) { return i.text.trim(); }).length < 2) {
        issues.push({ level: 'error', where: q.id, message: at + ' needs at least two items to order.' });
      }
      if (mode === 'judged' && !String(q.explanation || '').trim() && !q.answers.length) {
        issues.push({ level: 'warn', where: q.id, message: at + ' is host-marked but has no answer noted for you to mark against.' });
      }
    });

    return issues;
  };

  /* ---------------------------------------------------------
     Text answer matching
     --------------------------------------------------------- */

  /* Normalise for comparison: case, accents, punctuation, leading
     articles and internal whitespace all stop mattering. A team
     typing "the Mona Lisa!" and one typing "mona lisa" gave the
     same answer and a quiz that says otherwise loses the room. */
  function normaliseText(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents
      .toLowerCase()
      .replace(/[‘’‚‛]/g, "'")        // smart quotes
      .replace(/[“”„]/g, '"')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9'\s-]/g, ' ')                     // drop punctuation
      .replace(/\b(the|a|an)\b/g, ' ')                     // leading articles
      .replace(/\s+/g, ' ')
      .trim();
  }
  Model.normaliseText = normaliseText;

  /* Levenshtein with an early-exit ceiling. Quiz answers are
     short, and bailing as soon as the distance exceeds what we'd
     accept keeps this cheap even when marking 60 teams at once. */
  function editDistance(a, b, ceiling) {
    if (a === b) return 0;
    var al = a.length, bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    if (Math.abs(al - bl) > ceiling) return ceiling + 1;

    var prev = new Array(bl + 1), curr = new Array(bl + 1), i, j;
    for (j = 0; j <= bl; j++) prev[j] = j;

    for (i = 1; i <= al; i++) {
      curr[0] = i;
      var rowMin = curr[0];
      for (j = 1; j <= bl; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > ceiling) return ceiling + 1;
      var tmp = prev; prev = curr; curr = tmp;
    }
    return prev[bl];
  }

  /* Tolerance scales with answer length: one typo in "Poirot",
     two in "Chandleresque". Fixed thresholds either reject real
     typos on long answers or accept wrong short ones. */
  function allowedSlips(len) {
    if (len <= 4) return 0;
    if (len <= 8) return 1;
    if (len <= 14) return 2;
    return 3;
  }

  Model.matchesText = function (given, accepted, acceptClose) {
    var g = normaliseText(given);
    if (!g) return false;
    for (var i = 0; i < accepted.length; i++) {
      var a = normaliseText(accepted[i]);
      if (!a) continue;
      if (g === a) return true;
      if (acceptClose) {
        var ceiling = allowedSlips(a.length);
        if (ceiling && editDistance(g, a, ceiling) <= ceiling) return true;
      }
    }
    return false;
  };

  /* ---------------------------------------------------------
     Scoring one answer
     ---------------------------------------------------------
     Returns { correct, points, partial } or null when the
     question can't be auto-marked (host-judged / no input).

     `answer.value` shape by input mode:
       choice  → array of option ids
       text    → string
       order    → array of item ids, in the player's order
       number  → number
     `context` carries what a question needs beyond its own
     answer, currently only { allAnswers } for 'numeric', where
     "closest" is only knowable across the whole field.
     --------------------------------------------------------- */
  Model.scoreAnswer = function (question, answer, quizSettings, context) {
    var q = question;
    var mode = Model.inputMode(q);
    var settings = quizSettings || {};
    var ctx = context || {};
    if (!Model.isAutoScored(q)) return null;
    if (!answer || answer.value == null) return { correct: false, points: 0, partial: 0 };

    var base = Number(q.points) || 0;
    var result = { correct: false, points: 0, partial: 0 };

    if (mode === 'choice') {
      var chosen = [].concat(answer.value).map(String).sort();
      var correctIds = q.options.filter(function (o) { return o.correct; }).map(function (o) { return String(o.id); }).sort();
      result.correct = chosen.length === correctIds.length &&
        chosen.every(function (id, i) { return id === correctIds[i]; });
      result.partial = result.correct ? 1 : 0;

    } else if (mode === 'text') {
      result.correct = Model.matchesText(answer.value, q.answers, q.acceptClose);
      result.partial = result.correct ? 1 : 0;

    } else if (mode === 'order') {
      /* Partial credit by item-in-right-place, because all-or-
         nothing on a six-item ordering question is brutal and
         teams stop trying. Full points only for a perfect run. */
      var want = q.items.map(function (i) { return String(i.id); });
      var got = [].concat(answer.value).map(String);
      var hits = 0;
      want.forEach(function (id, i) { if (got[i] === id) hits++; });
      result.partial = want.length ? hits / want.length : 0;
      result.correct = hits === want.length && want.length > 0;
      result.points = Math.round(base * result.partial);

    } else if (mode === 'number') {
      var target = Number(q.numeric.value);
      var given = Number(answer.value);
      if (!isFinite(given)) return result;
      var tol = q.numeric.tolerance;

      if (tol != null && tol !== '' && isFinite(Number(tol))) {
        /* Explicit tolerance: absolute test, no competition. */
        result.correct = Math.abs(given - target) <= Number(tol);
        result.partial = result.correct ? 1 : 0;
      } else {
        /* No tolerance set: closest guess in the field wins. Ties
           all win — two teams equally close both earned it. */
        var all = (ctx.allAnswers || []).map(function (a) { return Number(a && a.value); })
          .filter(function (n) { return isFinite(n); });
        var mine = Math.abs(given - target);
        var best = all.length
          ? all.reduce(function (m, n) { return Math.min(m, Math.abs(n - target)); }, Infinity)
          : mine;
        result.correct = mine <= best;
        result.partial = result.correct ? 1 : 0;
      }
    }

    if (mode !== 'order') {
      result.points = result.correct ? base : 0;
    }

    /* Speed bonus: up to +50%, linear in time remaining, correct
       answers only. Off by default — it rewards fast fingers over
       knowledge, which suits some formats and ruins others. */
    if (settings.speedBonus && result.correct && q.timeLimit > 0 && answer.elapsedMs != null) {
      var frac = 1 - Math.min(1, Math.max(0, answer.elapsedMs / (q.timeLimit * 1000)));
      result.points += Math.round(base * 0.5 * frac);
    }

    return result;
  };

  /* Wager scoring is separate: the stake, not the question's
     points, is what moves, and it moves both ways. */
  Model.scoreWager = function (question, answer, judgedCorrect) {
    var stake = Math.max(0, Math.round(Number(answer && answer.wager) || 0));
    return {
      correct: !!judgedCorrect,
      points: judgedCorrect ? stake : -stake,
      partial: judgedCorrect ? 1 : 0
    };
  };

  /* ---------------------------------------------------------
     Standings
     ---------------------------------------------------------
     Built from the answer log rather than an incrementing score
     column, so re-marking a question (host overrides a judged
     answer, or fixes a typo'd accepted answer mid-show) always
     produces a correct board instead of needing the running
     total unwound. */
  Model.standings = function (session) {
    var teams = session.teams || [];
    var answers = session.answers || {};
    var manual = session.adjustments || {};

    var rows = teams.map(function (team) {
      var score = 0, right = 0, answered = 0;
      Object.keys(answers).forEach(function (qid) {
        var a = answers[qid] && answers[qid][team.id];
        if (!a) return;
        answered++;
        if (a.points) score += Number(a.points) || 0;
        if (a.correct) right++;
      });
      score += Number(manual[team.id] || 0);
      return {
        id: team.id,
        name: team.name,
        score: score,
        correct: right,
        answered: answered,
        joinedAt: team.joinedAt || ''
      };
    });

    rows.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (b.correct !== a.correct) return b.correct - a.correct;
      /* Still level: earlier joiner first. Arbitrary but stable —
         a board that reshuffles equal teams on every repaint looks
         broken from the back of the room. */
      return String(a.joinedAt).localeCompare(String(b.joinedAt));
    });

    /* Shared rank for genuine ties. */
    var lastScore = null, lastRank = 0;
    rows.forEach(function (r, i) {
      if (r.score === lastScore) {
        r.rank = lastRank;
      } else {
        r.rank = i + 1;
        lastRank = r.rank;
        lastScore = r.score;
      }
    });

    return rows;
  };

  /* What the room sees at reveal: how the field split across the
     options. Only meaningful for choice questions. */
  Model.distribution = function (question, session) {
    if (Model.inputMode(question) !== 'choice') return null;
    var byQ = (session.answers || {})[question.id] || {};
    var counts = {};
    question.options.forEach(function (o) { counts[o.id] = 0; });
    var total = 0;
    Object.keys(byQ).forEach(function (teamId) {
      var v = byQ[teamId] && byQ[teamId].value;
      if (v == null) return;
      total++;
      [].concat(v).forEach(function (id) {
        if (counts[id] != null) counts[id]++;
      });
    });
    return {
      total: total,
      rows: question.options.map(function (o) {
        return {
          id: o.id, text: o.text, correct: !!o.correct,
          count: counts[o.id] || 0,
          share: total ? (counts[o.id] || 0) / total : 0
        };
      })
    };
  };

  window.DetectiveModel = Model;
})(window);

/* =========================================================
   Show engine.

   Turns (quiz + where we are + who has answered) into the
   "public state" blob that the projection, leaderboard and
   player pages render. This module is the redaction boundary:
   it is the only place that decides what leaves the host's
   machine, and it never emits a correct answer until the host
   has moved the show into the reveal phase.

   It is pure: no DOM, no storage, no clock of its own beyond
   the timestamps it stamps. That makes the whole scoring and
   phase model testable without a browser (see test/).
   ========================================================= */
(function (window) {
  'use strict';

  var Model = window.DetectiveModel;
  var Show = {};

  Show.STATE_VERSION = 1;

  /* Phases, in running order. The host moves forward through
     these; 'board' and 'round-intro' are optional stops. */
  Show.PHASES = {
    LOBBY: 'lobby',
    ROUND_INTRO: 'round-intro',
    QUESTION: 'question',
    CLOSED: 'closed',       // time up / answers locked, not yet revealed
    REVEAL: 'reveal',
    BOARD: 'board',
    WINNER: 'winner',
    ENDED: 'ended'
  };

  /* ---------------------------------------------------------
     Redaction
     ---------------------------------------------------------
     What a player's phone and the projector are allowed to
     know about a question before the reveal. Note what is
     absent: option.correct, answers[], numeric.value,
     explanation, and the correct order of `items`.
     --------------------------------------------------------- */
  Show.publicQuestion = function (q, opts) {
    if (!q) return null;
    var o = opts || {};
    var mode = Model.inputMode(q);

    var pub = {
      id: q.id,
      type: q.type,
      input: mode,
      prompt: q.prompt,
      points: q.points,
      timeLimit: q.timeLimit,
      media: null,
      options: null,
      items: null,
      wager: null
    };

    if (q.media && q.media.url && q.media.kind && q.media.kind !== 'none') {
      pub.media = {
        kind: q.media.kind,
        url: q.media.url,
        autoplay: !!q.media.autoplay,
        loop: !!q.media.loop,
        startAt: q.media.startAt == null ? null : Number(q.media.startAt),
        endAt: q.media.endAt == null ? null : Number(q.media.endAt)
      };
    }

    if (mode === 'choice') {
      var opts_ = (q.options || []).filter(function (x) { return String(x.text || '').trim(); });
      if (o.shuffleOptions) opts_ = shuffleWithSeed(opts_, q.id);
      pub.options = opts_.map(function (x) { return { id: x.id, text: x.text }; });
    }

    if (mode === 'order') {
      /* Presented in a scrambled order — the stored order IS the
         answer, so handing it over unshuffled would give the game
         away on the player's screen. Seeded by question id so
         every device shows the same scramble and a reconnecting
         phone doesn't get a different one. */
      var items = (q.items || []).filter(function (x) { return String(x.text || '').trim(); });
      pub.items = shuffleWithSeed(items, q.id + ':order').map(function (x) {
        return { id: x.id, text: x.text };
      });
    }

    if (q.type === 'wager') {
      pub.wager = {
        min: Number(q.wager && q.wager.min) || 0,
        max: q.wager && q.wager.max != null ? Number(q.wager.max) : null
      };
    }

    return pub;
  };

  /* Deterministic shuffle. A seeded PRNG rather than
     Math.random so the same question scrambles identically on
     the host, the projector and every phone. */
  function shuffleWithSeed(arr, seed) {
    var out = arr.slice();
    var h = 2166136261;
    var s = String(seed);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    var rand = function () {
      h ^= h << 13; h >>>= 0;
      h ^= h >> 17;
      h ^= h << 5;  h >>>= 0;
      return (h >>> 0) / 4294967296;
    };
    for (var j = out.length - 1; j > 0; j--) {
      var k = Math.floor(rand() * (j + 1));
      var t = out[j]; out[j] = out[k]; out[k] = t;
    }
    return out;
  }
  Show.shuffleWithSeed = shuffleWithSeed;

  /* ---------------------------------------------------------
     Reveal payload — only ever attached in the reveal phases.
     --------------------------------------------------------- */
  Show.revealPayload = function (q, session, pubQuestion) {
    var mode = Model.inputMode(q);
    var payload = {
      explanation: q.explanation || '',
      correctOptionIds: [],
      answerText: '',
      order: null,
      distribution: null
    };

    if (mode === 'choice') {
      payload.correctOptionIds = (q.options || []).filter(function (o) { return o.correct; })
        .map(function (o) { return o.id; });
      /* Spell the answer out as text too. The projection shows
         the lit option, but the host's confidence monitor and the
         player's phone both want "The answer was B — Arsenic". */
      payload.answerText = (q.options || []).filter(function (o) { return o.correct; })
        .map(function (o) { return o.text; }).join(', ');
      payload.distribution = Model.distribution(q, session);

    } else if (mode === 'text' || mode === 'judged') {
      payload.answerText = (q.answers || []).filter(function (a) { return String(a).trim(); }).join(' / ');

    } else if (mode === 'number') {
      payload.answerText = String(q.numeric.value);

    } else if (mode === 'order') {
      /* The correct sequence, using the ids the players were
         given so their own arrangement can be diffed against it. */
      var items = (q.items || []).filter(function (x) { return String(x.text || '').trim(); });
      payload.order = items.map(function (x) { return { id: x.id, text: x.text }; });
      payload.answerText = items.map(function (x) { return x.text; }).join(' → ');
    }

    return payload;
  };

  /* ---------------------------------------------------------
     Build the public state.
     ---------------------------------------------------------
     ctx = {
       code, quiz, cursor, phase, timer, teams, answers,
       adjustments, mediaState, boardLimit
     }
     `answers` is the flat row list from the store; it gets
     reshaped into the nested form the model's scoring and
     standings functions expect.
     --------------------------------------------------------- */
  Show.nestAnswers = function (rows) {
    var out = {};
    (rows || []).forEach(function (r) {
      if (!out[r.questionId]) out[r.questionId] = {};
      out[r.questionId][r.teamId] = r;
    });
    return out;
  };

  Show.buildState = function (ctx) {
    var quiz = ctx.quiz;
    var order = Model.runOrder(quiz);
    var phase = ctx.phase || Show.PHASES.LOBBY;
    var cursor = typeof ctx.cursor === 'number' ? ctx.cursor : -1;
    var entry = order[cursor] || null;

    var sessionShape = {
      teams: ctx.teams || [],
      answers: Show.nestAnswers(ctx.answers),
      adjustments: ctx.adjustments || {}
    };

    var revealed = phase === Show.PHASES.REVEAL ||
                   phase === Show.PHASES.BOARD ||
                   phase === Show.PHASES.WINNER ||
                   phase === Show.PHASES.ENDED;

    var pubQ = entry ? Show.publicQuestion(entry.question, {
      shuffleOptions: !!(quiz.settings && quiz.settings.shuffleOptions)
    }) : null;

    var answeredCount = 0;
    if (entry) {
      var byQ = sessionShape.answers[entry.question.id] || {};
      answeredCount = Object.keys(byQ).length;
    }

    var standings = Model.standings(sessionShape);
    var limit = ctx.boardLimit == null ? 10 : ctx.boardLimit;

    var state = {
      v: Show.STATE_VERSION,
      code: ctx.code,
      showName: ctx.showName || '',
      quizTitle: quiz.title || '',
      quizSubtitle: quiz.subtitle || '',
      joinUrl: ctx.joinUrl || '',

      /* The riddle, not its answer. Safe to publish: it is written
         to be read by the whole room off a projector. The answer
         never leaves the database, which is what makes a riddle a
         better door than a word — a photograph of the screen
         still leaves you with a riddle to solve. */
      venueRiddle: ctx.venueRiddle || '',

      phase: phase,
      cursor: cursor,
      number: entry ? entry.number : 0,
      total: order.length,

      round: entry ? {
        index: entry.roundIndex,
        count: (quiz.rounds || []).length,
        title: entry.round.title,
        description: entry.round.description || '',
        numberInRound: entry.indexInRound + 1,
        sizeOfRound: (entry.round.questions || []).length
      } : null,

      question: pubQ,

      /* Timer is expressed as an absolute end time PLUS the
         moment this state was stamped. A client computes
         remaining as (endsAt - pushedAt) - (its own now - when
         it received this), which cancels out clock skew between
         the host laptop and a player's phone. */
      timer: ctx.timer ? {
        duration: ctx.timer.duration || 0,
        endsAt: ctx.timer.endsAt || null,
        running: !!ctx.timer.running,
        paused: !!ctx.timer.paused,
        remainingMs: ctx.timer.remainingMs == null ? null : ctx.timer.remainingMs
      } : null,

      /* Live vote split, only while the question is open and only
         when the quiz asks for it. Carries no correctness — see
         Model.liveVotes. */
      votes: (phase === Show.PHASES.QUESTION && entry &&
              quiz.settings && quiz.settings.liveVotes)
        ? Model.liveVotes(entry.question, sessionShape)
        : null,

      accepting: phase === Show.PHASES.QUESTION && !!ctx.accepting,
      mediaState: ctx.mediaState || 'idle',

      reveal: revealed && entry ? Show.revealPayload(entry.question, sessionShape, pubQ) : null,

      board: standings.slice(0, limit).map(function (r) {
        return { rank: r.rank, name: r.name, score: r.score, correct: r.correct };
      }),
      boardTruncated: Math.max(0, standings.length - limit),

      counts: {
        teams: sessionShape.teams.length,
        answered: answeredCount
      },

      winner: standings.length ? { name: standings[0].name, score: standings[0].score } : null,

      pushedAt: new Date().toISOString(),
      message: ctx.message || ''
    };

    return state;
  };

  /* Remaining milliseconds on a received state, skew-corrected.
     `receivedAt` is the local Date.now() at the moment the state
     arrived. */
  Show.remainingMs = function (state, receivedAt) {
    if (!state || !state.timer) return null;
    var t = state.timer;
    if (t.paused) return t.remainingMs == null ? null : t.remainingMs;
    if (!t.running || !t.endsAt) return null;

    var pushed = Date.parse(state.pushedAt || '');
    var ends = Date.parse(t.endsAt);
    if (!isFinite(pushed) || !isFinite(ends)) return null;

    var budget = ends - pushed;                       // host-clock duration left when pushed
    var since = Date.now() - (receivedAt || Date.now()); // local elapsed since receipt
    return Math.max(0, budget - since);
  };

  /* ---------------------------------------------------------
     Marking
     ---------------------------------------------------------
     Marks every submitted answer for one question and returns
     the rows to write back. Auto-scored types are marked here;
     judged types come back with points 0 and correct null for
     the host to rule on, except where they've already been
     ruled on (so re-marking a question doesn't wipe the host's
     decisions).
     --------------------------------------------------------- */
  Show.markQuestion = function (question, answerRows, quizSettings) {
    var rows = (answerRows || []).filter(function (r) { return r.questionId === question.id; });
    var settings = quizSettings || {};

    if (question.type === 'wager') {
      /* Wagers are the host's call on correctness, but the points
         follow mechanically from the stake once they've ruled. */
      return rows.filter(function (r) { return r.correct != null; }).map(function (r) {
        var res = Model.scoreWager(question, r, r.correct);
        return { id: r.id, points: res.points, correct: res.correct };
      });
    }

    if (!Model.isAutoScored(question)) return [];

    var ctx = { allAnswers: rows };
    return rows.map(function (r) {
      var res = Model.scoreAnswer(question, r, settings, ctx);
      if (!res) return null;
      return { id: r.id, points: res.points, correct: res.correct };
    }).filter(Boolean);
  };

  /* A host override on a single answer. Points are recomputed
     from the question rather than taken on trust, so "mark this
     right" always awards exactly what the question is worth. */
  Show.overrideAnswer = function (question, answerRow, correct) {
    if (question.type === 'wager') {
      var res = Model.scoreWager(question, answerRow, correct);
      return { id: answerRow.id, points: res.points, correct: res.correct };
    }
    return {
      id: answerRow.id,
      points: correct ? (Number(question.points) || 0) : 0,
      correct: !!correct
    };
  };

  /* ---------------------------------------------------------
     Navigation. Pure: takes where we are, returns where next.
     Kept here rather than in the host page so the phase rules
     are in one place and testable.
     --------------------------------------------------------- */
  Show.nextPhase = function (quiz, cursor, phase) {
    var P = Show.PHASES;
    var order = Model.runOrder(quiz);
    var settings = quiz.settings || {};

    function entryAt(i) { return order[i] || null; }

    if (phase === P.LOBBY) {
      if (!order.length) return { cursor: -1, phase: P.LOBBY };
      /* Lead with the round card if the first round is titled —
         it frames the round for the room before the first
         question lands. */
      return { cursor: 0, phase: P.ROUND_INTRO };
    }

    if (phase === P.ROUND_INTRO) return { cursor: cursor, phase: P.QUESTION };
    if (phase === P.QUESTION) return { cursor: cursor, phase: P.CLOSED };
    if (phase === P.CLOSED) return { cursor: cursor, phase: P.REVEAL };

    if (phase === P.REVEAL) {
      var here = entryAt(cursor);
      var next = entryAt(cursor + 1);
      if (!next) return { cursor: cursor, phase: P.WINNER };

      var endOfRound = here && next.roundIndex !== here.roundIndex;
      if (settings.showBoardAfterEach || (endOfRound && settings.showBoardAfterRound)) {
        return { cursor: cursor, phase: P.BOARD };
      }
      return { cursor: cursor + 1, phase: endOfRound ? P.ROUND_INTRO : P.QUESTION };
    }

    if (phase === P.BOARD) {
      var cur = entryAt(cursor);
      var nxt = entryAt(cursor + 1);
      if (!nxt) return { cursor: cursor, phase: P.WINNER };
      var crossesRound = cur && nxt.roundIndex !== cur.roundIndex;
      return { cursor: cursor + 1, phase: crossesRound ? P.ROUND_INTRO : P.QUESTION };
    }

    if (phase === P.WINNER) return { cursor: cursor, phase: P.ENDED };
    return { cursor: cursor, phase: phase };
  };

  Show.prevPhase = function (quiz, cursor, phase) {
    var P = Show.PHASES;
    var order = Model.runOrder(quiz);

    /* Back is deliberately coarse: it steps to the previous
       question's reveal rather than unwinding phase by phase.
       On stage, "back" means "I need the last question again",
       never "put the timer back to 4 seconds". */
    if (phase === P.QUESTION || phase === P.ROUND_INTRO || phase === P.CLOSED) {
      if (cursor <= 0) return { cursor: -1, phase: P.LOBBY };
      return { cursor: cursor - 1, phase: P.REVEAL };
    }
    if (phase === P.REVEAL || phase === P.BOARD) return { cursor: cursor, phase: P.QUESTION };
    if (phase === P.WINNER || phase === P.ENDED) {
      return { cursor: Math.max(0, order.length - 1), phase: P.REVEAL };
    }
    return { cursor: cursor, phase: phase };
  };

  /* Human-readable phase, for the host's status line. */
  var PHASE_LABELS = {
    'lobby': 'Lobby — waiting to start',
    'round-intro': 'Round card on screen',
    'question': 'Question live, answers open',
    'closed': 'Answers locked',
    'reveal': 'Answer revealed',
    'board': 'Leaderboard on screen',
    'winner': 'Winner on screen',
    'ended': 'Show over'
  };
  Show.phaseLabel = function (phase) {
    return PHASE_LABELS[phase] || phase;
  };

  /* ---------------------------------------------------------
     Results export — the sheet the venue wants afterwards.
     --------------------------------------------------------- */
  Show.resultsCsv = function (quiz, teams, answerRows, adjustments) {
    var order = Model.runOrder(quiz);
    var nested = Show.nestAnswers(answerRows);
    var standings = Model.standings({
      teams: teams, answers: nested, adjustments: adjustments || {}
    });

    function cell(v) {
      var s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    var header = ['Rank', 'Team', 'Total'].concat(order.map(function (e) { return 'Q' + e.number; }));
    var lines = [header.map(cell).join(',')];

    standings.forEach(function (row) {
      var cells = [row.rank, row.name, row.score];
      order.forEach(function (e) {
        var a = (nested[e.question.id] || {})[row.id];
        cells.push(a ? a.points : '');
      });
      lines.push(cells.map(cell).join(','));
    });

    return lines.join('\n');
  };

  window.DetectiveShow = Show;
})(window);

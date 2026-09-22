/* =========================================================
   Host control room.

   The host page is the authority for the whole show. It holds
   the only copy of the full quiz, decides what phase the show
   is in, marks the answers, and pushes a redacted public state
   for the projection, leaderboard and player devices to render.

   Design priorities, in order:
   1. Nothing surprises the host mid-show. The transport
      buttons never move or change meaning, destructive actions
      confirm, and the current question and its answer are
      always on screen without scrolling.
   2. Every state change is pushed. If a push fails, the host
      is told loudly, because a projector showing question 3
      while the room is on question 8 is the worst outcome
      this app has.
   3. Recoverable. Reloading the page mid-show rejoins the
      running session rather than starting a new one.
   ========================================================= */
(function (window) {
  'use strict';

  var UI = window.DetectiveUI;
  var Model = window.DetectiveModel;
  var Show = window.DetectiveShow;
  var Store = window.DetectiveStore;
  var cfg = window.DETECTIVE_CONFIG || {};
  var P = Show.PHASES;

  /* ---------------------------------------------------------
     Live show state (host-side)
     --------------------------------------------------------- */
  var show = {
    code: null,
    quiz: null,
    cursor: -1,
    phase: P.LOBBY,
    accepting: false,
    mediaState: 'idle',
    teams: [],
    answers: [],
    adjustments: {},
    timer: { duration: 0, endsAt: null, running: false, paused: false, remainingMs: null }
  };

  var unsubscribes = [];
  var tickHandle = null;
  var els = {};

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  function boot() {
    els.setup = UI.$('#setup');
    els.live = UI.$('#live');
    els.quizPicker = UI.$('#quiz-picker');
    els.now = UI.$('#now');
    els.transport = UI.$('#transport');
    els.side = UI.$('#side');
    els.status = UI.$('#show-status');
    els.links = UI.$('#links');

    window.DetectiveGate.require(UI.$('#host-app')).then(function () {
      var resumeCode = UI.param('code');
      if (resumeCode) return resume(resumeCode);
      return showSetup();
    }).catch(function (err) {
      UI.toast(err.message || 'Something went wrong.', 'error');
    });

    /* Transport shortcuts. The host is often looking at the room,
       not the screen, so space/arrows matter more than buttons. */
    UI.shortcuts({
      'Space': function () { if (show.code) advance(); },
      'ArrowRight': function () { if (show.code) advance(); },
      'ArrowLeft': function () { if (show.code) goBack(); },
      'r': function () { if (show.code) setPhase(show.cursor, P.REVEAL); },
      'b': function () { if (show.code) setPhase(show.cursor, P.BOARD); },
      'l': function () { if (show.code) toggleAnswers(); },
      't': function () { if (show.code) show.timer.running ? pauseTimer() : startTimer(); }
    });
  }

  /* ---------------------------------------------------------
     Setup: pick a case, start a show
     --------------------------------------------------------- */
  function showSetup() {
    els.setup.classList.remove('is-hidden');
    els.live.classList.add('is-hidden');

    return Store.quizzes.list().then(function (list) {
      if (!list.length) {
        UI.replace(els.quizPicker, [
          UI.el('div.empty', {}, [
            UI.el('h3', { text: 'No cases written yet' }),
            UI.el('p', { text: 'Write one first, then come back here to run it.' }),
            UI.el('a.btn.btn--primary', { href: 'build.html', text: 'Write a case', style: 'margin-top: var(--sp-4)' })
          ])
        ]);
        return;
      }

      var preselect = UI.param('quiz');

      UI.replace(els.quizPicker, list.map(function (item) {
        var count = Model.questionCount(item);
        var problems = Model.validate(item).filter(function (i) { return i.level === 'error'; }).length;

        return UI.el('div.panel.row.row--between', { style: 'gap: var(--sp-4)' }, [
          UI.el('div', { style: 'min-width: 0' }, [
            UI.el('h3', { text: item.title || 'Untitled case' }),
            UI.el('p.label', {
              style: 'margin-top: var(--sp-2)',
              text: UI.plural(count, 'question') + ' · ' + UI.plural((item.rounds || []).length, 'round') +
                    (problems ? ' · ' + problems + ' to fix' : '')
            })
          ]),
          UI.el('div.row', { style: 'flex: 0 0 auto' }, [
            UI.el('a.btn.btn--sm', { href: 'build.html?quiz=' + encodeURIComponent(item.id), text: 'Edit' }),
            UI.el('button.btn' + (item.id === preselect ? '.btn--primary' : ''), {
              type: 'button',
              text: 'Start show',
              disabled: !count,
              onclick: function () { startShow(item.id); }
            })
          ])
        ]);
      }));
    });
  }

  function startShow(quizId) {
    Store.quizzes.get(quizId).then(function (quiz) {
      if (!quiz) throw new Error('That case has gone missing.');

      show.quiz = quiz;
      show.code = Model.makeCode(5);
      show.cursor = -1;
      show.phase = P.LOBBY;
      show.teams = [];
      show.answers = [];
      show.adjustments = {};
      resetTimer();

      return Store.session.create({
        code: show.code,
        quizId: quiz.id,
        quizTitle: quiz.title,
        state: buildState()
      });
    }).then(function () {
      /* Put the code in the URL so a reload rejoins this show
         instead of starting a second one with a new code. */
      var url = new URL(window.location.href);
      url.searchParams.set('code', show.code);
      url.searchParams.delete('quiz');
      window.history.replaceState({}, '', url.toString());

      subscribe();
      goLive();
      push();
    }).catch(function (err) {
      UI.toast(err.message || 'Could not start the show.', 'error');
    });
  }

  function resume(code) {
    return Store.session.read(code).then(function (session) {
      if (!session) {
        UI.toast('No running show with code ' + code + '. Start a new one.', 'error');
        var url = new URL(window.location.href);
        url.searchParams.delete('code');
        window.history.replaceState({}, '', url.toString());
        return showSetup();
      }

      return Store.quizzes.get(session.quizId).then(function (quiz) {
        if (!quiz) throw new Error('The case this show was built from has been deleted.');

        show.quiz = quiz;
        show.code = code;

        /* Pick the show back up exactly where the pushed state
           says it was — not at the start. */
        var st = session.state || {};
        show.cursor = typeof st.cursor === 'number' ? st.cursor : -1;
        show.phase = st.phase || P.LOBBY;
        show.adjustments = st.adjustments || {};
        resetTimer();

        return Promise.all([
          Store.session.teams(code),
          Store.session.answers(code)
        ]).then(function (res) {
          show.teams = res[0];
          show.answers = res[1];
          subscribe();
          goLive();
          UI.toast('Rejoined show ' + code + '.');
        });
      });
    });
  }

  function goLive() {
    els.setup.classList.add('is-hidden');
    els.live.classList.remove('is-hidden');
    renderAll();
    if (!tickHandle) tickHandle = window.setInterval(tick, 250);
  }

  /* ---------------------------------------------------------
     Subscriptions — teams joining and answers arriving
     --------------------------------------------------------- */
  function subscribe() {
    unsubscribes.forEach(function (fn) { fn(); });
    unsubscribes = [];

    unsubscribes.push(Store.session.watchTeams(show.code, function (teams) {
      if (!teams) return;
      var before = show.teams.length;
      show.teams = teams;
      renderSide();
      /* The roster is on the projection during the lobby, so a
         new team has to be pushed to be seen. */
      if (show.phase === P.LOBBY || teams.length !== before) push();
    }));

    unsubscribes.push(Store.session.watchAnswers(show.code, function (answers) {
      if (!answers) return;
      show.answers = answers;
      renderNow();
      renderSide();
      /* The "12 of 20 answered" counter lives in the pushed state
         so the projection can show it too. */
      if (show.phase === P.QUESTION) pushThrottled();
    }));
  }

  /* Answers can land in a burst when a room of 60 all press at
     once. Throttling the re-push keeps that to a few writes
     rather than sixty. */
  var pushThrottled = (function () {
    var pending = false;
    return function () {
      if (pending) return;
      pending = true;
      window.setTimeout(function () {
        pending = false;
        push();
      }, 500);
    };
  })();

  /* ---------------------------------------------------------
     Pushing state
     --------------------------------------------------------- */
  function buildState() {
    return Show.buildState({
      code: show.code,
      quiz: show.quiz,
      cursor: show.cursor,
      phase: show.phase,
      accepting: show.accepting,
      mediaState: show.mediaState,
      teams: show.teams,
      answers: show.answers,
      adjustments: show.adjustments,
      timer: show.timer,
      showName: cfg.showName || '',
      joinUrl: joinUrl()
    });
  }

  var pushFailed = false;

  function push() {
    if (!show.code) return Promise.resolve();
    var state = buildState();
    state.adjustments = show.adjustments;  // carried so a host reload restores them

    return Store.session.pushState(show.code, state)
      .then(function () {
        if (pushFailed) {
          pushFailed = false;
          renderStatus();
        }
      })
      .catch(function (err) {
        pushFailed = true;
        renderStatus();
        UI.toast('The screens did not update: ' + (err.message || 'connection lost'), 'error');
      });
  }

  function joinUrl() {
    if (cfg.joinUrl) return cfg.joinUrl;
    try {
      var u = new URL(window.location.href);
      return u.host + u.pathname.replace(/host\.html$/, '');
    } catch (e) {
      return '';
    }
  }

  /* ---------------------------------------------------------
     Phase control
     --------------------------------------------------------- */
  function setPhase(cursor, phase) {
    var order = Model.runOrder(show.quiz);
    show.cursor = cursor;
    show.phase = phase;

    var entry = order[cursor] || null;
    var q = entry ? entry.question : null;

    if (phase === P.QUESTION && q) {
      show.accepting = Model.collectsAnswers(q);
      show.mediaState = q.media && q.media.url && q.media.autoplay ? 'playing' : 'idle';
      /* Start the clock with the question. A host who wants to
         read it out first pauses, which is one keystroke. */
      if (q.timeLimit > 0) startTimer(q.timeLimit);
      else resetTimer();
    } else {
      show.accepting = false;
      show.mediaState = 'idle';
      if (phase !== P.CLOSED) resetTimer();
      else stopTimer();
    }

    /* Mark on the way into the reveal, so the leaderboard the
       room sees next is already right. */
    if (phase === P.REVEAL && q) {
      markCurrent().then(push);
    } else {
      push();
    }

    renderAll();
  }

  function advance() {
    var next = Show.nextPhase(show.quiz, show.cursor, show.phase);
    if (next.cursor === show.cursor && next.phase === show.phase) {
      if (show.phase === P.LOBBY) UI.toast('This case has no questions.', 'error');
      return;
    }
    setPhase(next.cursor, next.phase);
  }

  function goBack() {
    var prev = Show.prevPhase(show.quiz, show.cursor, show.phase);
    setPhase(prev.cursor, prev.phase);
  }

  function toggleAnswers() {
    if (show.phase !== P.QUESTION) return;
    show.accepting = !show.accepting;
    if (!show.accepting) stopTimer();
    push();
    renderAll();
  }

  /* ---------------------------------------------------------
     Timer
     ---------------------------------------------------------
     The host holds the clock and publishes an absolute end
     time. Clients correct for skew (see Show.remainingMs), so
     a phone with a wrong clock still counts down correctly.
     --------------------------------------------------------- */
  function startTimer(seconds) {
    var dur = seconds != null ? seconds : (show.timer.duration || 0);
    if (!dur) return;

    var remaining = show.timer.paused && show.timer.remainingMs != null
      ? show.timer.remainingMs
      : dur * 1000;

    show.timer = {
      duration: dur,
      endsAt: new Date(Date.now() + remaining).toISOString(),
      running: true,
      paused: false,
      remainingMs: remaining
    };
    push();
    renderNow();
  }

  function pauseTimer() {
    if (!show.timer.running) return;
    show.timer.remainingMs = Math.max(0, Date.parse(show.timer.endsAt) - Date.now());
    show.timer.running = false;
    show.timer.paused = true;
    push();
    renderNow();
  }

  function stopTimer() {
    show.timer.running = false;
    show.timer.paused = false;
    show.timer.endsAt = null;
  }

  function resetTimer() {
    show.timer = { duration: 0, endsAt: null, running: false, paused: false, remainingMs: null };
  }

  function addTime(seconds) {
    if (!show.timer.endsAt) return;
    show.timer.endsAt = new Date(Date.parse(show.timer.endsAt) + seconds * 1000).toISOString();
    show.timer.remainingMs = Math.max(0, Date.parse(show.timer.endsAt) - Date.now());
    push();
    renderNow();
  }

  /* Drives the host's own countdown display and locks the
     answers when time runs out. Runs at 4Hz so the number never
     visibly stalls, but only re-renders the timer element. */
  function tick() {
    if (!show.timer.running || !show.timer.endsAt) return;
    var left = Date.parse(show.timer.endsAt) - Date.now();

    if (left <= 0) {
      stopTimer();
      show.accepting = false;
      /* Time up locks the answers but does NOT reveal. The host
         decides when the answer goes on screen — there is usually
         a bit of theatre to do first. */
      if (show.phase === P.QUESTION) {
        show.phase = P.CLOSED;
        markCurrent().then(push);
        renderAll();
      } else {
        push();
        renderAll();
      }
      return;
    }
    renderTimer(left);
  }

  /* ---------------------------------------------------------
     Marking
     --------------------------------------------------------- */
  function currentEntry() {
    return Model.runOrder(show.quiz)[show.cursor] || null;
  }

  function markCurrent() {
    var entry = currentEntry();
    if (!entry) return Promise.resolve();

    var marks = Show.markQuestion(entry.question, show.answers, show.quiz.settings);
    if (!marks.length) return Promise.resolve();

    /* Apply locally first so the host's board is right straight
       away rather than after the round trip. */
    var byId = {};
    marks.forEach(function (m) { byId[m.id] = m; });
    show.answers.forEach(function (a) {
      if (byId[a.id]) {
        a.points = byId[a.id].points;
        a.correct = byId[a.id].correct;
      }
    });

    return Store.session.markAnswers(show.code, marks).catch(function (err) {
      UI.toast('Could not save the marks: ' + (err.message || 'connection lost'), 'error');
    });
  }

  function overrideAnswer(answerRow, correct) {
    var entry = currentEntry();
    if (!entry) return;
    var mark = Show.overrideAnswer(entry.question, answerRow, correct);

    answerRow.points = mark.points;
    answerRow.correct = mark.correct;
    renderNow();
    renderSide();

    Store.session.markAnswers(show.code, [mark])
      .then(push)
      .catch(function (err) {
        UI.toast('Could not save that mark: ' + (err.message || 'connection lost'), 'error');
      });
  }

  /* ---------------------------------------------------------
     Render
     --------------------------------------------------------- */
  function renderAll() {
    renderStatus();
    renderNow();
    renderTransport();
    renderSide();
    renderLinks();
  }

  function renderStatus() {
    var order = Model.runOrder(show.quiz);
    UI.replace(els.status, [
      UI.el('span.tag' + (pushFailed ? '.tag--wrong' : '.tag--live'), {}, [
        pushFailed ? null : UI.el('span.pulse'),
        UI.el('span', { text: pushFailed ? 'Screens out of sync' : 'Live' })
      ]),
      UI.el('span.label', { text: 'Code ' + show.code }),
      UI.el('span.label', {
        text: show.cursor >= 0 ? 'Q' + (show.cursor + 1) + ' of ' + order.length : 'Not started'
      }),
      UI.el('span.label.label--accent', { text: Show.phaseLabel(show.phase) })
    ]);
  }

  function renderTimer(leftMs) {
    var el = UI.$('#timer');
    if (!el) return;
    var secs = Math.ceil(Math.max(0, leftMs) / 1000);
    el.textContent = UI.clock(secs);
    el.className = 'timer' + (secs <= 5 ? ' timer--urgent' : (secs <= 10 ? ' timer--warn' : ''));
  }

  function renderNow() {
    var entry = currentEntry();

    /* Once the show is over, the cursor still points at the last
       question — but showing it, with a frozen "time left", reads
       as though the question is still live. Show the result. */
    if (show.phase === P.WINNER || show.phase === P.ENDED) {
      var final = Model.standings({
        teams: show.teams,
        answers: Show.nestAnswers(show.answers),
        adjustments: show.adjustments
      });
      UI.replace(els.now, [
        UI.el('span.label.label--accent', { text: 'The case is closed' }),
        UI.el('h2', { style: 'margin-top: var(--sp-3)', text: final.length ? final[0].name : 'Show over' }),
        UI.el('p.muted', {
          style: 'margin-top: var(--sp-3)',
          text: final.length
            ? 'Winners on ' + final[0].score + ' points. Export the results before you close this tab.'
            : 'Nobody played.'
        })
      ]);
      return;
    }

    if (!entry) {
      UI.replace(els.now, [
        UI.el('span.label.label--accent', { text: show.phase === P.LOBBY ? 'Lobby' : Show.phaseLabel(show.phase) }),
        UI.el('h2', {
          style: 'margin-top: var(--sp-3)',
          text: show.phase === P.LOBBY
            ? 'Waiting to start'
            : (show.phase === P.WINNER || show.phase === P.ENDED ? 'Show over' : '—')
        }),
        UI.el('p.muted', {
          style: 'margin-top: var(--sp-3)',
          text: show.phase === P.LOBBY
            ? 'The join code is on the projection screen. Press Start when the room is in.'
            : ''
        })
      ]);
      return;
    }

    var q = entry.question;
    var mode = Model.inputMode(q);
    var answersForQ = show.answers.filter(function (a) { return a.questionId === q.id; });

    var children = [
      UI.el('div.row.row--wrap', {}, [
        UI.el('span.label.label--accent', { text: entry.round.title }),
        UI.el('span.label', { text: 'Question ' + entry.number + ' of ' + Model.runOrder(show.quiz).length }),
        UI.el('span.tag', { text: Model.type(q.type).label }),
        UI.el('span.tag', { text: (q.points || 0) + ' pts' })
      ]),
      UI.el('p.now__q', { text: q.prompt || '(no question text)' })
    ];

    /* The host's media preview is muted and separate from the
       projector's copy. Two audible copies of the same clip in
       one room is a mess, and the host only needs to see where
       the clip is up to. */
    if (q.media && q.media.url && q.media.kind !== 'none') {
      children.push(UI.el('div.row.row--wrap', {}, [
        UI.el('span.label', { text: 'Media: ' + q.media.kind }),
        UI.el('span.label', { text: q.media.url.length > 60 ? q.media.url.slice(0, 57) + '…' : q.media.url })
      ]));
    }

    /* Timer + answered counter */
    var live = UI.el('div.row.row--between', { style: 'margin-top: var(--sp-4)' }, [
      UI.el('div.row', {}, [
        UI.el('div', {}, [
          UI.el('span.label', { text: q.timeLimit ? 'Time left' : 'No timer' }),
          UI.el('div.timer', { id: 'timer', text: q.timeLimit ? UI.clock(q.timeLimit) : '∞' })
        ])
      ]),
      UI.el('div', { style: 'text-align: right' }, [
        UI.el('span.label', { text: 'Answered' }),
        UI.el('div.timer', {
          text: Model.collectsAnswers(q)
            ? answersForQ.length + ' / ' + show.teams.length
            : '—'
        })
      ])
    ]);
    children.push(live);

    /* The answer. Always visible to the host, whatever phase the
       room is in — this is the confidence monitor. */
    var answerText = '';
    if (mode === 'choice') {
      answerText = q.options.filter(function (o) { return o.correct; })
        .map(function (o, i) {
          var idx = q.options.indexOf(o);
          return UI.optionLetter(idx) + ' — ' + o.text;
        }).join('   ·   ');
    } else if (mode === 'order') {
      answerText = q.items.map(function (i) { return i.text; }).join('  →  ');
    } else if (mode === 'number') {
      answerText = String(q.numeric.value) +
        (q.numeric.tolerance != null && q.numeric.tolerance !== '' ? '  (± ' + q.numeric.tolerance + ')' : '  (closest wins)');
    } else {
      answerText = q.answers.filter(function (a) { return String(a).trim(); }).join('  /  ') || '(nothing noted)';
    }

    if (mode !== 'none') {
      children.push(UI.el('div.now__answer', { style: 'margin-top: var(--sp-4)' }, [
        UI.el('span.label', { text: 'Answer' }),
        UI.el('div', { text: answerText }),
        q.explanation ? UI.el('p.muted', { style: 'margin: var(--sp-3) 0 0; font-size: var(--fs-200)', text: q.explanation }) : null
      ]));
    }

    UI.replace(els.now, children);

    if (show.timer.running && show.timer.endsAt) {
      renderTimer(Date.parse(show.timer.endsAt) - Date.now());
    } else if (show.timer.paused && show.timer.remainingMs != null) {
      renderTimer(show.timer.remainingMs);
    }
  }

  function renderTransport() {
    var entry = currentEntry();
    var q = entry ? entry.question : null;
    var order = Model.runOrder(show.quiz);
    var atEnd = show.phase === P.ENDED;

    /* Primary action label tells the host what the NEXT press
       does, which is the only thing they need to know on stage. */
    var nextLabel = ({
      'lobby': 'Start the show',
      'round-intro': 'Ask the question',
      'question': 'Lock the answers',
      'closed': 'Reveal the answer',
      'reveal': 'Next →',
      'board': 'Next →',
      'winner': 'Finish',
      'ended': 'Finished'
    })[show.phase] || 'Next →';

    var buttons = [
      UI.el('button.btn.btn--primary.btn--lg', {
        type: 'button', text: nextLabel, disabled: atEnd,
        onclick: advance
      }),
      UI.el('button.btn', {
        type: 'button', text: '← Back',
        disabled: show.phase === P.LOBBY,
        onclick: goBack
      }),
      UI.el('button.btn', {
        type: 'button',
        text: show.accepting ? 'Lock answers' : 'Open answers',
        disabled: show.phase !== P.QUESTION || !q || !Model.collectsAnswers(q),
        onclick: toggleAnswers
      }),
      UI.el('button.btn', {
        type: 'button', text: 'Show leaderboard',
        disabled: show.cursor < 0 || atEnd,
        onclick: function () { setPhase(show.cursor, P.BOARD); }
      })
    ];

    /* Timer controls only exist while there is a clock to
       control, rather than sitting there permanently disabled. */
    if (q && q.timeLimit > 0 && (show.phase === P.QUESTION || show.phase === P.CLOSED)) {
      buttons.push(UI.el('button.btn', {
        type: 'button',
        text: show.timer.running ? 'Pause clock' : (show.timer.paused ? 'Resume clock' : 'Restart clock'),
        onclick: function () {
          if (show.timer.running) pauseTimer();
          else startTimer(show.timer.duration || q.timeLimit);
        }
      }));
      buttons.push(UI.el('button.btn', {
        type: 'button', text: '+15s',
        disabled: !show.timer.endsAt,
        onclick: function () { addTime(15); }
      }));
    }

    buttons.push(UI.el('button.btn.btn--danger', {
      type: 'button', text: 'End the show',
      disabled: atEnd,
      onclick: function () {
        if (!UI.confirm('End the show? The screens will go to the final leaderboard.')) return;
        setPhase(Math.max(0, order.length - 1), P.WINNER);
      }
    }));

    UI.replace(els.transport, buttons);
  }

  function renderLinks() {
    var base = window.location.href.replace(/host\.html.*$/, '');
    var links = [
      { label: 'Projection screen', href: 'present.html?code=' + show.code, hint: 'Put this on the projector, then press F for full screen' },
      { label: 'Leaderboard', href: 'leaderboard.html?code=' + show.code, hint: 'Anyone can open this at any time' }
    ];
    if (Store.isCloud) {
      links.push({ label: 'Player join page', href: 'index.html?code=' + show.code, hint: 'What the room types in' });
    }

    UI.replace(els.links, [
      UI.el('span.label.label--bright', { text: 'Open on other screens' })
    ].concat(links.map(function (l) {
      return UI.el('div.stack.stack--tight', {}, [
        UI.el('div.row.row--between', {}, [
          UI.el('a', { href: l.href, target: '_blank', rel: 'noopener', text: l.label }),
          UI.el('button.btn.btn--sm', {
            type: 'button', text: 'Copy link',
            onclick: function () {
              UI.copy(base + l.href)
                .then(function () { UI.toast('Link copied.'); })
                .catch(function (e) { UI.toast(e.message, 'error'); });
            }
          })
        ]),
        UI.el('p.field__hint', { text: l.hint })
      ]);
    })).concat([
      Store.isCloud ? null : UI.el('div.notice.notice--accent', {}, [
        UI.el('div', {}, [
          UI.el('strong', { text: 'Local mode. ' }),
          'Player devices cannot join. Open the projection on a second screen from this ' +
          'same browser, keep score yourself with the +/− buttons below, and see ' +
          'README.md to switch on player devices.'
        ])
      ])
    ]));
  }

  function renderSide() {
    var entry = currentEntry();
    var panels = [];

    /* Judging panel — only when there is something to judge. */
    if (entry && Model.inputMode(entry.question) === 'judged') {
      panels.push(renderJudgePanel(entry.question));
    }

    panels.push(renderBoardPanel());
    panels.push(renderTeamsPanel());
    UI.replace(els.side, panels);
  }

  function renderJudgePanel(q) {
    var rows = show.answers.filter(function (a) { return a.questionId === q.id; });
    var teamsById = {};
    show.teams.forEach(function (t) { teamsById[t.id] = t; });

    var body = rows.length
      ? rows.map(function (row) {
          var team = teamsById[row.teamId];
          var cls = row.correct === true ? '.judge--correct' : (row.correct === false ? '.judge--wrong' : '');
          return UI.el('div.judge' + cls, {}, [
            UI.el('span.judge__team', { text: team ? team.name : 'unknown team' }),
            UI.el('span.judge__answer', {
              text: (row.value == null || row.value === '' ? '(no answer)' : String(row.value)) +
                    (row.wager != null ? '   [staked ' + row.wager + ']' : '')
            }),
            UI.el('span.row', { style: 'flex: 0 0 auto' }, [
              UI.el('button.btn.btn--icon', {
                type: 'button', text: '✓', title: 'Mark right',
                'aria-label': 'Mark right',
                onclick: function () { overrideAnswer(row, true); }
              }),
              UI.el('button.btn.btn--icon.btn--danger', {
                type: 'button', text: '×', title: 'Mark wrong',
                'aria-label': 'Mark wrong',
                onclick: function () { overrideAnswer(row, false); }
              })
            ])
          ]);
        })
      : [UI.el('div.empty', {}, [UI.el('p', { text: 'No answers in yet.' })])];

    var unmarked = rows.filter(function (r) { return r.correct == null; }).length;

    return UI.el('div.panel.panel--flush', {}, [
      UI.el('div.panel__head', {}, [
        UI.el('span.label.label--bright', { text: 'Mark these' }),
        UI.el('span.spacer'),
        UI.el('span.tag' + (unmarked ? '.tag--accent' : '.tag--correct'), {
          text: unmarked ? unmarked + ' to go' : 'all marked'
        })
      ]),
      UI.el('div', {}, body)
    ]);
  }

  function renderBoardPanel() {
    var standings = Model.standings({
      teams: show.teams,
      answers: Show.nestAnswers(show.answers),
      adjustments: show.adjustments
    });

    var body = standings.length
      ? UI.el('div.board', {}, standings.map(function (row) {
          return UI.el('div.board__row' + (row.rank === 1 ? '.board__row--top' : ''), {}, [
            UI.el('span.board__rank', { text: String(row.rank) }),
            UI.el('span.board__team', { text: row.name }),
            UI.el('span.board__score', { text: String(row.score) })
          ]);
        }))
      : UI.el('div.empty', {}, [UI.el('p', { text: 'No teams yet.' })]);

    return UI.el('div.panel.stack', {}, [
      UI.el('div.row.row--between', {}, [
        UI.el('span.label.label--bright', { text: 'Standings' }),
        UI.el('button.btn.btn--sm', {
          type: 'button', text: 'Export results',
          disabled: !standings.length,
          onclick: function () {
            var csv = Show.resultsCsv(show.quiz, show.teams, show.answers, show.adjustments);
            var name = (show.quiz.title || 'results').toLowerCase().replace(/[^a-z0-9]+/g, '-');
            UI.download(name + '-results.csv', csv, 'text/csv');
          }
        })
      ]),
      body
    ]);
  }

  function renderTeamsPanel() {
    var addForm = UI.el('form.row', { style: 'gap: var(--sp-2)' });
    var nameInput = UI.el('input.input', {
      type: 'text', placeholder: 'Add a team by hand', 'aria-label': 'New team name'
    });
    addForm.appendChild(nameInput);
    addForm.appendChild(UI.el('button.btn.btn--sm', { type: 'submit', text: 'Add' }));
    addForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = nameInput.value.trim();
      if (!name) return;
      Store.session.joinTeam(show.code, name)
        .then(function () {
          nameInput.value = '';
          return Store.session.teams(show.code);
        })
        .then(function (teams) {
          show.teams = teams;
          renderSide();
          push();
        })
        .catch(function (err) { UI.toast(err.message, 'error'); });
    });

    var rows = show.teams.map(function (team) {
      var adj = Number(show.adjustments[team.id] || 0);
      return UI.el('div.row.row--between', { style: 'padding: var(--sp-2) 0; border-bottom: 1px solid var(--line-secondary)' }, [
        UI.el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: team.name }),
        UI.el('span.row', { style: 'flex: 0 0 auto; gap: var(--sp-1)' }, [
          adj ? UI.el('span.label.label--accent', { text: UI.signed(adj) }) : null,
          UI.el('button.btn.btn--icon', {
            type: 'button', text: '−', title: 'Take off 5 points', 'aria-label': 'Take 5 points off ' + team.name,
            onclick: function () { adjust(team.id, -5); }
          }),
          UI.el('button.btn.btn--icon', {
            type: 'button', text: '+', title: 'Give 5 points', 'aria-label': 'Give 5 points to ' + team.name,
            onclick: function () { adjust(team.id, 5); }
          }),
          UI.el('button.btn.btn--icon.btn--danger', {
            type: 'button', text: '×', title: 'Remove team', 'aria-label': 'Remove ' + team.name,
            onclick: function () {
              if (!UI.confirm('Remove "' + team.name + '" and their answers?')) return;
              Store.session.removeTeam(show.code, team.id)
                .then(function () { return Store.session.teams(show.code); })
                .then(function (teams) {
                  show.teams = teams;
                  delete show.adjustments[team.id];
                  renderSide();
                  push();
                })
                .catch(function (err) { UI.toast(err.message, 'error'); });
            }
          })
        ])
      ]);
    });

    return UI.el('div.panel.stack', {}, [
      UI.el('div.row.row--between', {}, [
        UI.el('span.label.label--bright', { text: 'Teams' }),
        UI.el('span.tag', { text: String(show.teams.length) })
      ]),
      rows.length ? UI.el('div', {}, rows) : UI.el('p.field__hint', { text: 'Nobody yet.' }),
      addForm,
      UI.el('p.field__hint', {
        text: Store.isCloud
          ? 'Teams join with the code. Add one by hand if someone has no phone.'
          : 'Add every team here, then mark them with the + and − buttons as you go.'
      })
    ]);
  }

  function adjust(teamId, delta) {
    show.adjustments[teamId] = Number(show.adjustments[teamId] || 0) + delta;
    if (!show.adjustments[teamId]) delete show.adjustments[teamId];
    renderSide();
    push();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);

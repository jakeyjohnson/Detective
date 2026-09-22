/* =========================================================
   Player device.

   Phone-first. The whole interaction is: see the question,
   answer it, find out if you were right. Everything else is
   noise on a 5-inch screen in a dark room.

   Answers are submitted as the player taps rather than behind
   a separate Submit button, and can be changed until the host
   locks the question — which is what people expect from a
   quiz app, and avoids a team losing a question because they
   picked C and never pressed Send.
   ========================================================= */
(function (window) {
  'use strict';

  var UI = window.DetectiveUI;
  var Show = window.DetectiveShow;
  var Store = window.DetectiveStore;

  var code = (UI.param('code', '') || '').toUpperCase();
  var me = code ? UI.identity.get(code) : null;

  var state = null;
  var receivedAt = 0;
  var lastSignature = '';

  /* The player's answer to the question currently on screen,
     held locally so the UI reflects a tap instantly rather than
     waiting for the round trip. */
  var draft = { questionId: null, value: null, wager: null, sentAt: null };
  var myAnswers = {};    // questionId -> marked answer row, for the reveal
  var myScore = 0;

  var els = {};

  function boot() {
    els.main = UI.$('#play-main');
    els.team = UI.$('#play-team');
    els.score = UI.$('#play-score');
    els.status = UI.$('#play-status');

    if (!code) return fatal('No game code', 'Open the join page and enter the code from the screen.');
    if (!Store.isCloud) {
      return fatal('Player devices are off',
        'This show is running in local mode, so the host is keeping score. Nothing to do here.');
    }
    if (!me) return fatal('Not joined yet', 'Go back and join with the game code and your team name.');

    els.team.textContent = me.name;

    Store.session.read(code).then(function (session) {
      if (!session) return fatal('No game ' + code, 'That show is not running.');
      apply(session.state);

      Store.session.watch(code, function (s) {
        if (s && s.state) apply(s.state);
      });

      /* Watch our own marked answers so the reveal can say
         whether WE got it right, not just what the answer was. */
      Store.session.watchAnswers(code, function (rows) {
        if (!rows) return;
        myAnswers = {};
        rows.forEach(function (r) {
          if (r.teamId === me.id) myAnswers[r.questionId] = r;
        });
        recomputeScore();
        if (state && (state.phase === 'reveal' || state.phase === 'board')) render();
      });

      Store.session.answers(code).then(function (rows) {
        rows.forEach(function (r) {
          if (r.teamId === me.id) myAnswers[r.questionId] = r;
        });
        recomputeScore();
        render();
      });
    }).catch(function () {
      fatal('Cannot reach the game', 'Check your signal and reload.');
    });

    window.setInterval(tick, 250);
  }

  /* Score from our own answer rows plus whatever the board says,
     preferring the board because it includes any manual
     adjustment the host made. */
  function recomputeScore() {
    var fromRows = Object.keys(myAnswers).reduce(function (n, qid) {
      return n + (Number(myAnswers[qid].points) || 0);
    }, 0);

    var onBoard = null;
    if (state && state.board) {
      state.board.forEach(function (row) {
        if (row.name === me.name) onBoard = row.score;
      });
    }
    myScore = onBoard == null ? fromRows : onBoard;
    if (els.score) els.score.textContent = String(myScore);
  }

  function apply(next) {
    if (!next) return;
    state = next;
    receivedAt = Date.now();

    var sig = [
      state.phase, state.cursor,
      state.question ? state.question.id : '',
      state.accepting ? '1' : '0',
      state.reveal ? '1' : '0'
    ].join('|');

    /* A new question clears the draft. Without this, tapping
       answer B on question 4 would still be highlighted on
       question 5. */
    if (state.question && state.question.id !== draft.questionId) {
      draft = { questionId: state.question.id, value: null, wager: null, sentAt: null };
      var existing = myAnswers[state.question.id];
      if (existing) {
        draft.value = existing.value;
        draft.wager = existing.wager;
        draft.sentAt = existing.submittedAt;
      }
    }

    recomputeScore();

    if (sig !== lastSignature) {
      lastSignature = sig;
      render();
    } else {
      renderStatus();
      updateVotes();
    }
  }

  function fatal(title, body) {
    UI.replace(els.main, [
      UI.el('div.empty', {}, [
        UI.el('h3', { text: title }),
        UI.el('p', { text: body }),
        UI.el('a.btn', { href: 'index.html', text: 'Back to the join page', style: 'margin-top: var(--sp-4)' })
      ])
    ]);
  }

  /* ---------------------------------------------------------
     Submitting
     --------------------------------------------------------- */
  var sendDebounced = UI.debounce(function () { send(); }, 500);

  function send() {
    if (!state || !state.question || !state.accepting) return;
    if (draft.value == null || draft.value === '') return;

    var elapsed = null;
    if (state.timer && state.timer.duration) {
      var remaining = Show.remainingMs(state, receivedAt);
      if (remaining != null) elapsed = (state.timer.duration * 1000) - remaining;
    }

    Store.session.submitAnswer(code, {
      questionId: state.question.id,
      teamId: me.id,
      value: draft.value,
      wager: draft.wager,
      elapsedMs: elapsed
    }).then(function (row) {
      myAnswers[row.questionId] = row;
      draft.sentAt = row.submittedAt;
      renderStatus();
    }).catch(function (err) {
      UI.toast(err.message || 'That did not send. Try again.', 'error');
    });
  }

  /* ---------------------------------------------------------
     Render
     --------------------------------------------------------- */
  function render() {
    if (!state) return;

    var q = state.question;

    if (state.phase === 'lobby') {
      UI.replace(els.main, [
        UI.el('div.center.stack', {}, [
          UI.el('p.label.label--accent', { text: 'You are in' }),
          UI.el('h2', { text: me.name }),
          UI.el('p.muted', { text: 'Keep this page open. The first question will appear here.' })
        ])
      ]);
    } else if (state.phase === 'round-intro') {
      UI.replace(els.main, [
        UI.el('div.center.stack', {}, [
          UI.el('p.label.label--accent', { text: 'Round ' + (state.round ? state.round.index + 1 : 1) }),
          UI.el('h2', { text: state.round ? state.round.title : '' }),
          state.round && state.round.description ? UI.el('p.muted', { text: state.round.description }) : null
        ])
      ]);
    } else if (state.phase === 'board') {
      renderBoard();
    } else if (state.phase === 'winner' || state.phase === 'ended') {
      UI.replace(els.main, [
        UI.el('div.center.stack', {}, [
          UI.el('p.label.label--accent', { text: 'The case is closed' }),
          UI.el('h2', { text: state.winner ? state.winner.name + ' win' : 'Show over' }),
          UI.el('p.play__score', { text: 'You finished on ' + myScore }),
          UI.el('a.btn', { href: 'leaderboard.html?code=' + code, text: 'Final standings' })
        ])
      ]);
    } else if (!q) {
      UI.replace(els.main, [UI.el('div.center', {}, [UI.el('p.muted', { text: 'Stand by…' })])]);
    } else if (state.phase === 'reveal') {
      renderReveal();
    } else {
      renderQuestion();
    }

    renderStatus();
    updateVotes();
  }

  function renderQuestion() {
    var q = state.question;
    var locked = !state.accepting;

    var children = [
      UI.el('p.label.label--accent', { text: 'Question ' + state.number + ' · ' + (q.points || 0) + ' points' }),
      UI.el('h2.play__q', { text: q.prompt })
    ];

    /* Media is NOT played on the player's device. Fifty phones
       playing the same clip a half-second apart is unusable, and
       the room already has speakers. The phone says where to look. */
    if (q.media) {
      children.push(UI.el('div.notice.notice--accent', {}, [
        UI.el('div', {
          text: q.media.kind === 'audio' ? 'Listen to the room.' : 'Watch the big screen.'
        })
      ]));
    }

    if (q.input === 'none') {
      children.push(UI.el('p.muted', { text: 'Nothing to answer here. Listen to the host.' }));
      return UI.replace(els.main, children);
    }

    if (locked) {
      children.push(UI.el('div.notice', {}, [
        UI.el('div', { text: 'Answers are locked. Waiting for the reveal.' })
      ]));
    }

    if (q.input === 'choice') children.push(choiceInput(q, locked));
    else if (q.input === 'order') children.push(orderInput(q, locked));
    else if (q.input === 'number') children.push(numberInput(q, locked));
    else children.push(textInput(q, locked));

    if (q.wager) children.unshift(wagerInput(q, locked));

    UI.replace(els.main, children);
  }

  function choiceInput(q, locked) {
    /* The host decides whether several answers are right, and we
       are not told — so the phone allows one pick and the engine
       marks an exact-set match. A multi-answer question is asked
       as "pick all that apply" in its own wording, and the model
       accepts an array either way. */
    return UI.el('div.answer-list', {}, q.options.map(function (opt, i) {
      var chosen = [].concat(draft.value || []).indexOf(opt.id) !== -1;

      var children = [
        UI.el('span.answer-btn__key', { text: UI.optionLetter(i) }),
        UI.el('span', { style: 'flex: 1 1 auto; min-width: 0', text: opt.text })
      ];

      /* The live split, on the device people are voting from.
         Carries no correctness — the payload it reads has none. */
      if (state.votes) {
        children.push(UI.el('span.answer-btn__pct', { dataset: { pct: opt.id }, text: '' }));
        children.push(UI.el('span.answer-btn__bar', {}, [
          UI.el('span.answer-btn__bar-fill', { dataset: { bar: opt.id } })
        ]));
      }

      return UI.el('button.answer-btn', {
        type: 'button',
        'aria-pressed': chosen ? 'true' : 'false',
        disabled: locked,
        onclick: function () {
          draft.value = [opt.id];
          render();
          send();
        }
      }, children);
    }));
  }

  /* Update the vote bars without re-rendering.
     A re-render would rebuild the buttons under the player's
     thumb every time somebody else votes, which on a phone means
     a mis-tap. */
  function updateVotes() {
    if (!state || !state.votes) return;
    var total = state.votes.total || 0;
    state.votes.rows.forEach(function (row) {
      var pct = UI.$('[data-pct="' + row.id + '"]');
      var bar = UI.$('[data-bar="' + row.id + '"]');
      if (pct) pct.textContent = total ? Math.round(row.share * 100) + '%' : '';
      if (bar) bar.style.transform = 'scaleX(' + (total ? row.share : 0).toFixed(3) + ')';
    });
  }

  function textInput(q, locked) {
    var input = UI.el('input.input', {
      type: 'text',
      value: draft.value == null ? '' : draft.value,
      placeholder: 'Your answer',
      disabled: locked,
      autocomplete: 'off',
      autocapitalize: 'sentences'
    });
    input.addEventListener('input', function () {
      draft.value = input.value;
      renderStatus();
      sendDebounced();
    });

    var form = UI.el('form.stack', {}, [
      input,
      UI.el('button.btn.btn--primary.btn--lg.btn--block', {
        type: 'submit', text: 'Lock it in', disabled: locked
      })
    ]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      send();
      input.blur();
      UI.toast('Answer sent.');
    });
    return form;
  }

  function numberInput(q, locked) {
    var input = UI.el('input.input', {
      type: 'number', inputmode: 'decimal',
      value: draft.value == null ? '' : draft.value,
      placeholder: 'A number',
      disabled: locked
    });
    input.addEventListener('input', function () {
      draft.value = input.value === '' ? null : Number(input.value);
      renderStatus();
      sendDebounced();
    });

    var form = UI.el('form.stack', {}, [
      input,
      UI.el('button.btn.btn--primary.btn--lg.btn--block', {
        type: 'submit', text: 'Lock it in', disabled: locked
      })
    ]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      send();
      input.blur();
      UI.toast('Answer sent.');
    });
    return form;
  }

  function orderInput(q, locked) {
    /* Move up / move down rather than drag. Drag-and-drop on
       touch is unreliable and impossible by keyboard, and a quiz
       answer must not be a test of dexterity. */
    var current = [].concat(draft.value || q.items.map(function (i) { return i.id; }));
    var byId = {};
    q.items.forEach(function (i) { byId[i.id] = i; });

    function move(index, delta) {
      var target = index + delta;
      if (target < 0 || target >= current.length) return;
      var item = current.splice(index, 1)[0];
      current.splice(target, 0, item);
      draft.value = current;
      render();
      send();
    }

    return UI.el('div.stack.stack--tight', {}, current.map(function (id, i) {
      return UI.el('div.order-item', {}, [
        UI.el('span.order-item__pos', { text: String(i + 1) }),
        UI.el('span.order-item__text', { text: byId[id] ? byId[id].text : '?' }),
        UI.el('span.order-item__moves', {}, [
          UI.el('button.btn', {
            type: 'button', text: '↑', 'aria-label': 'Move up', disabled: locked || i === 0,
            onclick: function () { move(i, -1); }
          }),
          UI.el('button.btn', {
            type: 'button', text: '↓', 'aria-label': 'Move down',
            disabled: locked || i === current.length - 1,
            onclick: function () { move(i, 1); }
          })
        ])
      ]);
    }));
  }

  function wagerInput(q, locked) {
    var max = q.wager.max == null ? myScore : Math.min(Number(q.wager.max), myScore);
    var min = Number(q.wager.min) || 0;

    var input = UI.el('input.input', {
      type: 'number', inputmode: 'numeric',
      value: draft.wager == null ? '' : draft.wager,
      min: String(min), max: String(Math.max(min, max)),
      placeholder: 'Points to stake',
      disabled: locked
    });
    input.addEventListener('input', function () {
      var v = input.value === '' ? null : Math.round(Number(input.value));
      /* Clamped here as well as on the host, so a team cannot
         stake more than they have by editing the field. */
      if (v != null) v = Math.max(min, Math.min(Math.max(min, max), v));
      draft.wager = v;
      renderStatus();
      sendDebounced();
    });

    return UI.el('div.panel.panel--inset.stack', {}, [
      UI.el('span.label.label--accent', { text: 'Stake your points' }),
      input,
      UI.el('p.field__hint', {
        text: 'You have ' + myScore + '. Right and you gain what you staked, wrong and you lose it.'
      })
    ]);
  }

  function renderReveal() {
    var q = state.question;
    var r = state.reveal;
    var mine = myAnswers[q.id];

    var verdict;
    if (!mine || mine.value == null || mine.value === '') {
      verdict = UI.el('div.notice', {}, [UI.el('div', { text: 'You did not answer this one.' })]);
    } else if (mine.correct === true) {
      verdict = UI.el('div.notice.notice--correct', {}, [
        UI.el('div', { text: 'Right. ' + UI.signed(Number(mine.points) || 0) + ' points.' })
      ]);
    } else if (mine.correct === false) {
      verdict = UI.el('div.notice.notice--wrong', {}, [
        UI.el('div', {
          text: (Number(mine.points) || 0) < 0
            ? 'Wrong. ' + mine.points + ' points.'
            : 'Not this time.'
        })
      ]);
    } else if (q.input === 'judged') {
      verdict = UI.el('div.notice.notice--accent', {}, [
        UI.el('div', { text: 'Your answer is with the host.' })
      ]);
    } else {
      /* The reveal arrives as its own push and the marks arrive as
         separate rows, so for a moment an auto-marked question is
         revealed but this device does not yet know its own
         verdict. Saying "with the host" there would be wrong — it
         is being marked automatically and will land shortly. */
      verdict = UI.el('div.notice.notice--accent', {}, [
        UI.el('div', { text: 'Checking your answer…' })
      ]);
    }

    var children = [
      UI.el('p.label.label--accent', { text: 'Question ' + state.number }),
      UI.el('h2.play__q', { text: q.prompt }),
      verdict,
      UI.el('div.panel.panel--inset', {}, [
        UI.el('span.label.label--bright', { text: 'The answer' }),
        UI.el('p', { style: 'margin: var(--sp-2) 0 0; font-size: var(--fs-400)', text: r.answerText || '—' })
      ])
    ];

    if (r.explanation) children.push(UI.el('p.muted', { text: r.explanation }));

    UI.replace(els.main, children);
  }

  function renderBoard() {
    var board = state.board || [];
    UI.replace(els.main, [
      UI.el('p.label.label--accent', { text: 'Standings' }),
      UI.el('div.board', {}, board.map(function (row) {
        var isMe = row.name === me.name;
        return UI.el('div.board__row' + (isMe ? '.board__row--top' : ''), {}, [
          UI.el('span.board__rank', { text: String(row.rank) }),
          UI.el('span.board__team', { text: row.name }),
          UI.el('span.board__score', { text: String(row.score) })
        ]);
      })),
      UI.el('a.btn.btn--block', { href: 'leaderboard.html?code=' + code, text: 'Full leaderboard' })
    ]);
  }

  function renderStatus() {
    if (!els.status || !state) return;

    var bits = [];

    if (state.phase === 'question' && state.question && state.question.input !== 'none') {
      if (!state.accepting) {
        bits.push(UI.el('span.tag', { text: 'Locked' }));
      } else if (draft.sentAt) {
        bits.push(UI.el('span.tag.tag--correct', { text: 'Answer in' }));
      } else {
        bits.push(UI.el('span.tag.tag--accent', { text: 'Not answered' }));
      }
    }

    if (state.timer && state.timer.duration) {
      var remaining = Show.remainingMs(state, receivedAt);
      if (remaining != null) {
        bits.push(UI.el('span.tag' + (remaining <= 5000 ? '.tag--wrong' : ''), {
          id: 'play-clock', text: UI.clock(remaining / 1000)
        }));
      }
    }

    UI.replace(els.status, bits);
  }

  function tick() {
    if (!state || !state.timer) return;
    var el = UI.$('#play-clock');
    if (!el) return;
    var remaining = Show.remainingMs(state, receivedAt);
    if (remaining == null) return;
    el.textContent = UI.clock(remaining / 1000);
    el.className = 'tag' + (remaining <= 5000 ? ' tag--wrong' : '');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);

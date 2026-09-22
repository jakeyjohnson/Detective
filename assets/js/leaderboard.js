/* =========================================================
   Public leaderboard.

   Deliberately the one page with no gate, no join and no
   state of its own: anyone with the code can pull it up at
   any point, on any device, and it will be current. It is a
   read-only view of the same pushed state the projection
   uses.

   It is also the page most likely to be open on a phone at
   the bar for twenty minutes, so it polls gently, survives
   the connection dropping, and prints cleanly for the venue's
   results sheet.
   ========================================================= */
(function (window) {
  'use strict';

  var UI = window.DetectiveUI;
  var Store = window.DetectiveStore;
  var cfg = window.DETECTIVE_CONFIG || {};

  var code = (UI.param('code', '') || '').toUpperCase();
  var state = null;
  var previousRanks = {};   // team name -> last rank, for movement arrows
  var unwatch = null;

  var els = {};

  function boot() {
    els.board = UI.$('#board');
    els.meta = UI.$('#board-meta');
    els.head = UI.$('#board-head');
    els.form = UI.$('#code-form');
    els.input = UI.$('#code-input');

    els.form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = els.input.value.trim().toUpperCase();
      if (!v) return;
      var url = new URL(window.location.href);
      url.searchParams.set('code', v);
      window.location.href = url.toString();
    });

    if (!code) {
      els.form.classList.remove('is-hidden');
      els.input.focus();
      UI.replace(els.board, [
        UI.el('div.empty', {}, [
          UI.el('h3', { text: 'Which game?' }),
          UI.el('p', { text: 'Enter the code from the screen to see the standings.' })
        ])
      ]);
      return;
    }

    UI.$('#board-code').textContent = code;
    load();
  }

  function load() {
    Store.session.read(code).then(function (session) {
      if (!session) {
        UI.replace(els.board, [
          UI.el('div.empty', {}, [
            UI.el('h3', { text: 'No game ' + code }),
            UI.el('p', { text: 'Check the code on the screen. A finished show is cleared away.' })
          ])
        ]);
        els.form.classList.remove('is-hidden');
        return;
      }

      apply(session.state);

      unwatch = Store.session.watch(code, function (s) {
        if (s && s.state) apply(s.state);
      });
    }).catch(function () {
      UI.replace(els.meta, [
        UI.el('span.tag.tag--wrong', { text: 'Connection lost — retrying' })
      ]);
      window.setTimeout(load, 5000);
    });
  }

  function apply(next) {
    if (!next) return;
    state = next;
    render();
  }

  function render() {
    var board = state.board || [];

    UI.replace(els.head, [
      UI.el('span.label', { text: state.showName || cfg.showName || '' }),
      UI.el('h1', { text: state.quizTitle || 'Standings' })
    ]);

    var phaseText = ({
      'lobby': 'Not started yet',
      'round-intro': state.round ? state.round.title : 'Between rounds',
      'question': 'Question ' + state.number + ' of ' + state.total + ' in play',
      'closed': 'Question ' + state.number + ' — answers locked',
      'reveal': 'Question ' + state.number + ' revealed',
      'board': 'Question ' + state.number + ' of ' + state.total,
      'winner': 'Final result',
      'ended': 'Final result'
    })[state.phase] || '';

    var final = state.phase === 'winner' || state.phase === 'ended';

    UI.replace(els.meta, [
      UI.el('span.tag' + (final ? '.tag--accent' : '.tag--live'), {}, [
        final ? null : UI.el('span.pulse'),
        UI.el('span', { text: final ? 'Final' : 'Live' })
      ]),
      UI.el('span.label', { text: phaseText }),
      UI.el('span.label', { text: UI.plural(state.counts ? state.counts.teams : 0, 'team') })
    ]);

    if (!board.length) {
      UI.replace(els.board, [
        UI.el('div.empty', {}, [
          UI.el('h3', { text: 'No scores yet' }),
          UI.el('p', { text: 'Standings appear as soon as the first question is marked.' })
        ])
      ]);
      return;
    }

    UI.replace(els.board, board.map(function (row) {
      /* Movement since the last time this page saw the board.
         Only meaningful once we have a previous reading, so the
         first render shows nothing rather than a row of dashes. */
      var was = previousRanks[row.name];
      var moved = was != null && was !== row.rank ? was - row.rank : 0;

      return UI.el('div.board__row' + (row.rank === 1 ? '.board__row--top' : ''), {}, [
        UI.el('span.board__rank', { text: String(row.rank) }),
        UI.el('span.board__team', {}, [
          UI.el('span', { text: row.name }),
          moved > 0 ? UI.el('span.board__delta', { text: '▲' + moved }) : null,
          moved < 0 ? UI.el('span.board__delta.board__delta--none', { text: '▼' + Math.abs(moved) }) : null
        ]),
        UI.el('span.board__score', { text: String(row.score) })
      ]);
    }));

    var nextRanks = {};
    board.forEach(function (row) { nextRanks[row.name] = row.rank; });
    previousRanks = nextRanks;

    if (state.boardTruncated) {
      els.board.appendChild(UI.el('p.field__hint.center', {
        text: '+ ' + UI.plural(state.boardTruncated, 'more team') + ' not shown'
      }));
    }
  }

  window.addEventListener('beforeunload', function () {
    if (unwatch) unwatch();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);

/* =========================================================
   Projection screen.

   A pure view of the host's pushed state. It holds no quiz,
   makes no decisions and never writes anything — which is
   also why it is safe to have it open on a screen the whole
   room can see.

   Two things it does own, because they have to happen locally:
   the countdown (interpolated between pushes so the number
   ticks smoothly rather than jumping every push), and media
   playback (the host cannot play a video on another machine
   remotely; it can only say "the clip should be playing now").
   ========================================================= */
(function (window) {
  'use strict';

  var UI = window.DetectiveUI;
  var Show = window.DetectiveShow;
  var Store = window.DetectiveStore;
  var cfg = window.DETECTIVE_CONFIG || {};

  var code = (UI.param('code', '') || '').toUpperCase();

  var state = null;
  var receivedAt = 0;
  var lastSignature = '';     // what's rendered, so we only rebuild on real change
  var mediaEl = null;
  var audioBlocked = false;

  var els = {};

  function boot() {
    els.main = UI.$('#stage-main');
    els.top = UI.$('#stage-top');
    els.bottom = UI.$('#stage-bottom');
    els.alert = UI.$('#stage-alert');

    if (!code) {
      renderMessage('No game code', 'Open this screen from the control room so it knows which show to follow.');
      return;
    }

    UI.$('#show-name').textContent = cfg.showName || 'Detective';

    Store.session.read(code).then(function (session) {
      if (!session) {
        renderMessage('No game ' + code, 'That show is not running. Start it in the control room.');
        return;
      }
      apply(session.state);
      Store.session.watch(code, function (s) {
        if (s && s.state) apply(s.state);
      });
    }).catch(function () {
      renderMessage('Cannot reach the show', 'Check the connection and reload.');
    });

    /* The projector is normally driven by the host's machine, but
       whoever sets the screen up needs full screen and a way to
       unblock audio. F and click are the only two interactions
       this page has. */
    UI.shortcuts({
      'f': function () { UI.fullscreen.toggle(); },
      'F': function () { UI.fullscreen.toggle(); }
    });

    document.addEventListener('click', function () {
      /* A click is the user gesture browsers need before audio
         may play. Retry whatever is loaded and clear the warning. */
      if (audioBlocked && mediaEl) {
        mediaEl.muted = false;
        mediaEl.play().then(function () {
          audioBlocked = false;
          renderAlert();
        }).catch(function () { /* still blocked */ });
      }
      UI.fullscreen.enter();
    });

    window.setInterval(tick, 200);
  }

  /* ---------------------------------------------------------
     Applying a new state
     ---------------------------------------------------------
     Scenes are rebuilt only when something structural changes,
     identified by a signature. Without this, a state push every
     half second while answers arrive would restart the scene
     animation and retrigger media constantly.
     --------------------------------------------------------- */
  function apply(next) {
    if (!next) return;
    state = next;
    receivedAt = Date.now();

    var sig = [
      state.phase,
      state.cursor,
      state.question ? state.question.id : '',
      state.reveal ? '1' : '0',
      state.accepting ? '1' : '0',
      state.mediaState
    ].join('|');

    if (sig !== lastSignature) {
      lastSignature = sig;
      renderScene();
    } else {
      /* Same scene, fresher numbers: update in place. The scenes
         built FROM the standings are the exception — the lobby
         roster grows as teams join, and the board moves as
         answers are marked, neither of which changes the
         signature. */
      updateCounts();
      if (state.phase === 'lobby' || state.phase === 'board' ||
          state.phase === 'winner' || state.phase === 'ended') {
        renderScene();
      }
    }

    renderChrome();
  }

  /* ---------------------------------------------------------
     Chrome — the thin top and bottom bars
     --------------------------------------------------------- */
  function renderChrome() {
    if (!state) return;

    UI.replace(els.top, [
      UI.el('span.stage__show', { text: state.showName || cfg.showName || '' }),
      UI.el('span.spacer'),
      state.round ? UI.el('span', { text: state.round.title }) : null
    ]);

    var right = [];
    if (state.question && state.phase !== 'lobby') {
      right.push(UI.el('span', { text: 'Question ' + state.number + ' of ' + state.total }));
    }
    if (state.counts && state.counts.teams) {
      right.push(UI.el('span', { id: 'answered-count', text: answeredText() }));
    }

    UI.replace(els.bottom, [
      UI.el('span', { text: state.code ? 'Code ' + state.code : '' }),
      UI.el('span.spacer'),
      UI.el('span.row', { style: 'gap: var(--sp-5)' }, right)
    ]);

    renderAlert();
  }

  function answeredText() {
    if (!state || !state.counts) return '';
    if (state.phase !== 'question' || !state.accepting) return UI.plural(state.counts.teams, 'team');
    return state.counts.answered + ' of ' + state.counts.teams + ' in';
  }

  function updateCounts() {
    var el = UI.$('#answered-count');
    if (el) el.textContent = answeredText();
  }

  function renderAlert() {
    if (audioBlocked) {
      els.alert.textContent = 'Click the screen once to allow sound';
      els.alert.classList.remove('is-hidden');
      return;
    }
    els.alert.classList.add('is-hidden');
  }

  /* ---------------------------------------------------------
     Scenes
     --------------------------------------------------------- */
  function renderScene() {
    stopMedia();

    var scene;
    switch (state.phase) {
      case 'lobby':       scene = sceneLobby(); break;
      case 'round-intro': scene = sceneRound(); break;
      case 'question':
      case 'closed':      scene = sceneQuestion(); break;
      case 'reveal':      scene = sceneReveal(); break;
      case 'board':       scene = sceneBoard(); break;
      case 'winner':
      case 'ended':       scene = sceneWinner(); break;
      default:            scene = sceneHold('Stand by');
    }

    UI.replace(els.main, [scene]);
  }

  function panel(children, wide) {
    return UI.el('div.stage__panel' + (wide ? '.stage__panel--wide' : ''), {}, [
      UI.el('div.scene', {}, children)
    ]);
  }

  function sceneHold(text) {
    return panel([UI.el('p.stage__hold', { text: text })]);
  }

  function renderMessage(title, body) {
    UI.replace(els.main, [panel([
      UI.el('p.stage__hold', { text: title }),
      UI.el('p.stage__explain', { text: body })
    ])]);
  }

  function sceneLobby() {
    var joinTarget = state.joinUrl || '';
    var children = [
      UI.el('p.stage__qmeta', { text: 'Join the game' })
    ];

    /* The real logo if one is configured, otherwise the built-in
       fingerprint. This is the one screen with room for it. */
    children.unshift(cfg.logoUrl
      ? UI.el('img.stage__logo', { src: cfg.logoUrl, alt: '' })
      : UI.el('div.stage__mark', { 'aria-hidden': 'true' }));

    if (Store.isCloud) {
      children.push(UI.el('p.stage__joinurl', { text: joinTarget }));
      children.push(UI.el('div.marquee.marquee--stage', { style: 'width: auto' }, [
        UI.el('div.marquee__inner', {}, [
          UI.el('p.stage__code', { text: state.code })
        ])
      ]));
    } else {
      /* Local mode has nothing for the room to type, so the
         projector shows the show title instead of a code nobody
         can use. */
      children.push(UI.el('p.stage__winner-name', { text: state.quizTitle || cfg.showName || '' }));
      if (state.quizSubtitle) children.push(UI.el('p.stage__explain', { text: state.quizSubtitle }));
    }

    var board = state.board || [];
    if (board.length) {
      children.push(UI.el('div.stage__roster' + (board.length > 12 ? '.is-crowded' : ''), {},
        board.map(function (t) {
          return UI.el('span.stage__roster-item', { text: t.name });
        })
      ));
      if (state.boardTruncated) {
        children.push(UI.el('p.stage__explain', {
          text: '+ ' + UI.plural(state.boardTruncated, 'more team')
        }));
      }
    } else if (Store.isCloud) {
      children.push(UI.el('p.stage__explain', { text: 'Waiting for the first team…' }));
    }

    return panel(children, true);
  }

  function sceneRound() {
    var title = state.round ? String(state.round.title || '') : '';
    var number = 'Round ' + (state.round ? state.round.index + 1 : 1);
    /* Most hosts leave the round titled "Round 2", which would
       otherwise print above a heading that says the same thing. */
    var showNumber = title.replace(/\s+/g, ' ').toLowerCase() !== number.toLowerCase();

    /* The round card is one of the two moments the show puts the
       cream plate up — it is a beat between questions, short
       enough that the brightness is a punctuation mark rather
       than something the room sits in front of. */
    return panel([
      marqueePlate([
        showNumber ? UI.el('p.stage__qmeta', {}, [UI.el('strong', { text: number })]) : null,
        UI.el('h1.stage__question', { text: title }),
        state.round && state.round.description
          ? UI.el('p.stage__explain', { text: state.round.description })
          : null,
        UI.el('p.stage__qmeta', {
          text: state.round ? UI.plural(state.round.sizeOfRound, 'question') : ''
        })
      ])
    ]);
  }

  /* A bulb-lit gold frame around the cream plate, straight off
     the logo. Used for the round card and the winner. */
  function marqueePlate(children) {
    return UI.el('div.marquee.marquee--stage', {}, [
      UI.el('div.marquee__inner', {}, [
        UI.el('div.plate.plate--stage', {}, children)
      ])
    ]);
  }

  function sceneQuestion() {
    var q = state.question;
    if (!q) return sceneHold('Stand by');

    var children = [
      UI.el('p.stage__qmeta', {}, [
        UI.el('strong', { text: 'Q' + state.number }),
        UI.el('span', { text: (q.points || 0) + ' points' }),
        state.phase === 'closed'
          ? UI.el('span', { text: 'Answers locked' })
          : (q.input === 'none' ? null : UI.el('span', { text: 'Answers open' }))
      ]),
      questionHeading(q.prompt)
    ];

    if (q.media) children.push(mediaNode(q.media));

    if (q.input === 'choice' && q.options) {
      children.push(optionsGrid(q.options, null));
    } else if (q.input === 'order' && q.items) {
      /* Show the items so the room can see what is being ordered,
         but numbered as a list rather than in the answer shape —
         the arranging happens on the players' own devices. */
      children.push(UI.el('div.stage__options', { dataset: { count: '2' } },
        q.items.map(function (item) {
          return UI.el('div.stage__option', {}, [
            UI.el('span.stage__option-key', { text: '·' }),
            UI.el('span.stage__option-text', { text: item.text })
          ]);
        })
      ));
    }

    if (q.timeLimit > 0) {
      children.push(UI.el('div.stage__progress', {}, [
        UI.el('div.stage__progress-bar', { id: 'progress' })
      ]));
      children.push(UI.el('p.stage__timer', { id: 'countdown', text: UI.clock(q.timeLimit) }));
    }

    return panel(children, q.input === 'choice');
  }

  /* Step the heading down a size or two for long questions so it
     always fits one screen without scrolling. */
  function questionHeading(text) {
    var t = String(text || '');
    var cls = t.length > 180 ? '.is-very-long' : (t.length > 90 ? '.is-long' : '');
    return UI.el('h1.stage__question' + cls, { text: t });
  }

  function optionsGrid(options, correctIds) {
    var reveal = Array.isArray(correctIds);
    return UI.el('div.stage__options', { dataset: { count: String(options.length) } },
      options.map(function (opt, i) {
        var isCorrect = reveal && correctIds.indexOf(opt.id) !== -1;
        var cls = reveal ? (isCorrect ? '.stage__option--correct' : '.stage__option--dim') : '';
        return UI.el('div.stage__option' + cls, {}, [
          UI.el('span.stage__option-key', { text: UI.optionLetter(i) }),
          UI.el('span.stage__option-text', { text: opt.text })
        ]);
      })
    );
  }

  function sceneReveal() {
    var q = state.question;
    var r = state.reveal;
    if (!q || !r) return sceneHold('Stand by');

    var children = [
      UI.el('p.stage__qmeta', {}, [
        UI.el('strong', { text: 'Q' + state.number }),
        UI.el('span', { text: 'The answer' })
      ]),
      questionHeading(q.prompt)
    ];

    if (q.input === 'choice' && q.options) {
      children.push(optionsGrid(q.options, r.correctOptionIds || []));
      /* The split across the options, when anyone answered. This
         is the bit the room reacts to. */
      if (r.distribution && r.distribution.total) {
        children.push(distributionNode(r.distribution));
      }
    } else {
      children.push(UI.el('p.stage__answer', { text: r.answerText || '—' }));
    }

    if (r.explanation) children.push(UI.el('p.stage__explain', { text: r.explanation }));

    return panel(children, q.input === 'choice');
  }

  function distributionNode(dist) {
    return UI.el('div.stage__dist', {}, dist.rows.map(function (row, i) {
      var bar = UI.el('div.stage__dist-fill' + (row.correct ? '.stage__dist-fill--correct' : ''));
      /* Set the scale after insertion so the transition runs and
         the bars grow rather than appearing full length. */
      bar.style.transform = 'scaleX(0)';
      window.setTimeout(function () {
        bar.style.transform = 'scaleX(' + row.share.toFixed(3) + ')';
      }, 250);

      return UI.el('div.stage__dist-row', {}, [
        UI.el('span', { text: UI.optionLetter(i) }),
        UI.el('div.stage__dist-bar', {}, [bar]),
        UI.el('span', { text: String(row.count) })
      ]);
    }));
  }

  function sceneBoard() {
    var board = state.board || [];
    if (!board.length) return sceneHold('No scores yet');

    /* Bottom-up so the staggered CSS animation lands on the
       leader last. The array is rank order, so reverse it for
       the DOM and let the row styling keep the ranks honest. */
    var rows = board.slice().reverse().map(function (row) {
      return UI.el('div.stage__board-row' + (row.rank === 1 ? '.stage__board-row--lead' : ''), {}, [
        UI.el('span.stage__board-rank', { text: String(row.rank) }),
        UI.el('span.stage__board-team', { text: row.name }),
        UI.el('span.stage__board-score', { text: String(row.score) })
      ]);
    });

    return panel([
      UI.el('p.stage__qmeta', { text: 'Standings' }),
      UI.el('div.stage__board', {}, rows),
      state.boardTruncated
        ? UI.el('p.stage__explain', { text: '+ ' + UI.plural(state.boardTruncated, 'more team') })
        : null
    ], true);
  }

  function sceneWinner() {
    if (!state.winner) return sceneHold('Show over');
    var board = state.board || [];
    return panel([
      marqueePlate([
        UI.el('p.stage__qmeta', { text: 'The case is closed' }),
        UI.el('p.stage__winner-name', { text: state.winner.name }),
        UI.el('p.stage__winner-score', { text: state.winner.score + ' points' })
      ]),
      board.length > 1
        ? UI.el('div.stage__board', { style: 'margin-top: var(--sp-6)' },
            board.slice(1, 4).map(function (row) {
              return UI.el('div.stage__board-row', {}, [
                UI.el('span.stage__board-rank', { text: String(row.rank) }),
                UI.el('span.stage__board-team', { text: row.name }),
                UI.el('span.stage__board-score', { text: String(row.score) })
              ]);
            }))
        : null
    ], true);
  }

  /* ---------------------------------------------------------
     Media
     ---------------------------------------------------------
     The projector is the machine with the speakers, so this is
     where a clip actually plays. `startAt`/`endAt` are honoured
     locally; the host's mediaState only says whether it should
     be running.
     --------------------------------------------------------- */
  function mediaNode(media) {
    if (media.kind === 'image') {
      return UI.el('div.stage__media', {}, [
        UI.el('img', { src: media.url, alt: '' })
      ]);
    }

    if (media.kind === 'audio') {
      /* Audio has nothing to look at, so the stage shows a level
         meter stand-in and the element itself stays hidden. */
      var audio = UI.el('audio', { src: media.url, preload: 'auto' });
      mediaEl = audio;
      var meter = UI.el('div.stage__audio', {},
        [1, 2, 3, 4, 5, 6, 7].map(function () { return UI.el('div.stage__audio-bar'); })
      );
      wireMedia(audio, media, meter);
      return UI.el('div.stage__media', {}, [meter, audio]);
    }

    var video = UI.el('video', {
      src: media.url, preload: 'auto', playsinline: 'playsinline'
    });
    mediaEl = video;
    wireMedia(video, media, null);
    return UI.el('div.stage__media', {}, [video]);
  }

  function wireMedia(el, media, meter) {
    el.loop = !!media.loop;

    function markIdle(idle) {
      if (meter) meter.classList.toggle('is-idle', idle);
    }
    markIdle(true);

    el.addEventListener('loadedmetadata', function () {
      if (media.startAt) {
        try { el.currentTime = Number(media.startAt); } catch (e) { /* unseekable stream */ }
      }
      if (media.autoplay && state && state.mediaState === 'playing') attemptPlay();
    });

    /* Stop at the out point. `loop` sends it back to the in point
       rather than to zero, so a looped 20s excerpt of a 4 minute
       track stays on the excerpt. */
    if (media.endAt != null) {
      el.addEventListener('timeupdate', function () {
        if (el.currentTime >= Number(media.endAt)) {
          if (media.loop) {
            el.currentTime = Number(media.startAt || 0);
          } else {
            el.pause();
            markIdle(true);
          }
        }
      });
    }

    el.addEventListener('playing', function () { markIdle(false); });
    el.addEventListener('pause', function () { markIdle(true); });
    el.addEventListener('ended', function () { markIdle(true); });

    el.addEventListener('error', function () {
      /* A broken media URL must not leave the room staring at a
         blank screen with no explanation. */
      var note = UI.el('p.stage__explain', {
        text: 'That clip would not load. Check the link in the case file.'
      });
      if (el.parentNode) el.parentNode.appendChild(note);
    });

    function attemptPlay() {
      var p = el.play();
      if (p && p.catch) {
        p.catch(function () {
          /* Blocked because the page has had no user gesture.
             Play it muted so the room at least sees the picture,
             and ask for a click to bring the sound in. */
          el.muted = true;
          audioBlocked = true;
          renderAlert();
          el.play().catch(function () { /* nothing more to try */ });
        });
      }
    }
  }

  function stopMedia() {
    if (mediaEl) {
      try {
        mediaEl.pause();
        mediaEl.removeAttribute('src');
        mediaEl.load();
      } catch (e) { /* already torn down */ }
      mediaEl = null;
    }
    audioBlocked = false;
  }

  /* ---------------------------------------------------------
     Countdown, interpolated locally
     --------------------------------------------------------- */
  function tick() {
    if (!state) return;
    var el = UI.$('#countdown');
    if (!el) return;

    var remaining = Show.remainingMs(state, receivedAt);
    if (remaining == null) return;

    var secs = Math.ceil(remaining / 1000);
    el.textContent = UI.clock(secs);
    el.className = 'stage__timer' + (secs <= 5 ? ' stage__timer--urgent' : (secs <= 10 ? ' stage__timer--warn' : ''));

    var bar = UI.$('#progress');
    if (bar && state.timer && state.timer.duration) {
      var frac = Math.max(0, Math.min(1, remaining / (state.timer.duration * 1000)));
      bar.style.transform = 'scaleX(' + frac.toFixed(3) + ')';
      bar.className = 'stage__progress-bar' + (secs <= 5 ? ' stage__progress-bar--urgent' : '');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);

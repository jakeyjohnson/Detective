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

  /* Tonight's venue password, passed in the link the control room
     hands out. Deliberately NOT read from the pushed state: that
     is world-readable by anyone holding the join code, which is
     the very person a venue password exists to turn away. So the
     big screen can show it and a stranger's browser cannot. */
  var venuePassword = (UI.param('vp', '') || '').trim();

  var state = null;
  var receivedAt = 0;
  var lastSignature = '';     // which scene is rendered
  var lastContentSig = '';    // and what data it was drawn from
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

    /* A second signature over the DATA a scene draws, so that a
       scene is rebuilt when its content really changed and not
       merely because another push arrived. Every rebuild restarts
       the scene's fade-in; with a room of people signing up at
       once that turned the lobby into a strobe. */
    var contentSig = (state.board || []).map(function (r) {
      return r.name + ':' + r.score;
    }).join('|') + '#' + (state.boardTruncated || 0);

    if (sig !== lastSignature) {
      lastSignature = sig;
      lastContentSig = contentSig;
      renderScene();
    } else {
      /* Same scene, fresher numbers: update in place. */
      updateCounts();
      updateVotes();

      if (contentSig !== lastContentSig) {
        lastContentSig = contentSig;
        if (state.phase === 'lobby') {
          /* The roster is patched rather than rebuilt, so only the
             name that just arrived animates in. */
          updateRoster();
          fitScene();
        } else if (state.phase === 'board' || state.phase === 'winner' ||
                   state.phase === 'ended') {
          renderScene();
        }
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
    if (state.phase !== 'question' || !state.accepting) {
      return UI.plural(state.counts.teams, 'player');
    }
    /* When the live split is on screen it already carries the
       running tally, centre-screen and far more legibly. Printing
       it in the footer as well is just the same number twice. */
    if (state.votes) return UI.plural(state.counts.teams, 'player');
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

    /* Seed from the state the scene was built with, so a screen
       that joins mid-question shows the split already at its
       current level rather than at zero, and a lobby opened after
       people signed up shows them. */
    updateVotes();
    updateRoster();

    /* Twice: once now, and once after the browser has laid the
       scene out and any pictures have arrived. */
    fitScene();
    fitWhenMediaLoads();
    window.requestAnimationFrame(fitScene);
  }

  function panel(children, wide) {
    /* Two layers on purpose: .scene carries the entry animation
       (which uses transform), and .scene__fit carries the
       shrink-to-fit transform. One element cannot do both. */
    return UI.el('div.stage__panel' + (wide ? '.stage__panel--wide' : ''), {}, [
      UI.el('div.scene', {}, [
        UI.el('div.scene__fit', {}, children)
      ])
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
    var children = [];

    /* The real logo if one is configured, otherwise the built-in
       fingerprint. This is the one screen with room for it. */
    children.push(cfg.logoUrl
      ? UI.el('img.stage__logo', { src: cfg.logoUrl, alt: '' })
      : UI.el('div.stage__mark', { 'aria-hidden': 'true' }));

    if (!Store.isCloud) {
      /* Local mode has nothing for the room to scan or type, so
         the projector shows the show title rather than a code
         nobody can use. */
      children.push(UI.el('p.stage__winner-name', { text: state.quizTitle || cfg.showName || '' }));
      if (state.quizSubtitle) children.push(UI.el('p.stage__explain', { text: state.quizSubtitle }));
      children.push(rosterNode());
      return panel(children, true);
    }

    children.push(UI.el('p.stage__qmeta', { text: 'Scan to play' }));

    /* The QR, on a cream plate. A code needs light quiet space
       around it to scan, and a bright plate reads at the back of a
       room where a dark one does not. */
    var url = signupUrl();
    var qr = null;
    if (window.DetectiveQR && url) {
      try {
        qr = UI.el('div.stage__qr', { html: window.DetectiveQR.svg(url, { label: 'Scan to play' }) });
      } catch (e) {
        qr = null;    // falls back to the code below, which always works
      }
    }
    if (qr) children.push(qr);

    /* The typed route always stays on screen next to the QR. Some
       phones will not scan in a dark venue, and a camera that
       will not focus must not be the end of someone's night. */
    children.push(UI.el('div.stage__joinrow', {}, [
      UI.el('div', {}, [
        UI.el('p.stage__joinlabel', { text: 'or go to' }),
        UI.el('p.stage__joinurl', { text: displayUrl() })
      ]),
      UI.el('div', {}, [
        UI.el('p.stage__joinlabel', { text: 'code' }),
        UI.el('p.stage__joincode', { text: state.code })
      ]),
      venuePassword
        ? UI.el('div', {}, [
            UI.el('p.stage__joinlabel', { text: 'password' }),
            UI.el('p.stage__joincode', { text: venuePassword })
          ])
        : null
    ]));

    children.push(UI.el('p.stage__explain', {
      id: 'roster-waiting', text: 'Waiting for the first player…'
    }));
    children.push(rosterNode());

    return panel(children, true);
  }

  /* Who has signed up so far. Always rendered, even when empty,
     so that the first arrival can be patched in without having to
     rebuild the scene to make room for it. */
  function rosterNode() {
    return UI.el('div.stack.stack--tight', { id: 'roster-wrap', style: 'align-items: center' }, [
      UI.el('div.stage__roster', { id: 'roster' }),
      UI.el('p.stage__explain', { id: 'roster-more', text: '' })
    ]);
  }

  /* Patch the roster in place: add the names that are new, drop
     the ones that have gone, leave the rest alone. Only a new
     name animates, and the scene around it never restarts. */
  function updateRoster() {
    var host = UI.$('#roster');
    if (!host) return;

    var board = state.board || [];
    var wanted = board.map(function (t) { return t.name; });

    var existing = {};
    UI.$$('.stage__roster-item', host).forEach(function (node) {
      existing[node.dataset.name] = node;
    });

    wanted.forEach(function (name) {
      if (existing[name]) {
        delete existing[name];
        return;
      }
      host.appendChild(UI.el('span.stage__roster-item', {
        dataset: { name: name }, text: name
      }));
    });

    /* Anything left in `existing` is a player the host removed. */
    Object.keys(existing).forEach(function (name) {
      var node = existing[name];
      if (node.parentNode) node.parentNode.removeChild(node);
    });

    host.classList.toggle('is-crowded', wanted.length > 12);

    var more = UI.$('#roster-more');
    if (more) {
      more.textContent = state.boardTruncated
        ? '+ ' + UI.plural(state.boardTruncated, 'more player')
        : '';
    }

    var waiting = UI.$('#roster-waiting');
    if (waiting) waiting.classList.toggle('is-hidden', wanted.length > 0);
  }

  /* The URL the QR encodes. Built the same way the control room
     builds it, so the two always agree. */
  function signupUrl() {
    var base = state.joinUrl || '';
    if (base) {
      if (!/^https?:\/\//.test(base)) base = 'https://' + base;
      if (!/\.html$/.test(base)) {
        if (!/\/$/.test(base)) base += '/';
        base += 'index.html';
      }
    } else {
      base = window.location.href.split('?')[0].replace(/present\.html$/, 'index.html');
    }
    return base + '?code=' + encodeURIComponent(state.code || '');
  }

  /* What the room reads, rather than what the QR encodes: no
     scheme, no filename, no query string. Nobody types
     "https://" off a screen. */
  function displayUrl() {
    return signupUrl()
      .replace(/^https?:\/\//, '')
      .replace(/index\.html.*$/, '')
      .replace(/\/$/, '');
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
      questionHeading(q.prompt, !!q.media)
    ];

    if (q.media) children.push(mediaNode(q.media, q.input === 'choice' && q.options));

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

    /* The running tally is dropped when a picture is on screen:
       the percentages against each option already say it, and the
       evidence needs the height more. */
    if (state.votes && !q.media) {
      children.push(UI.el('p.stage__votetotal', { id: 'vote-total', text: '' }));
    }

    if (q.timeLimit > 0) {
      children.push(UI.el('div.stage__progress', {}, [
        UI.el('div.stage__progress-bar', { id: 'progress' })
      ]));
      children.push(UI.el('p.stage__timer' + (q.media ? '.stage__timer--compact' : ''),
        { id: 'countdown', text: UI.clock(q.timeLimit) }));
    }

    return panel(children, q.input === 'choice');
  }

  /* Step the heading down a size or two for long questions so it
     always fits one screen without scrolling. */
  function questionHeading(text, crowded) {
    var t = String(text || '');
    /* Sharing the screen with a picture leaves far less room, so
       the same length of question steps down a size sooner. */
    var long = crowded ? 55 : 90;
    var veryLong = crowded ? 110 : 180;
    var cls = t.length > veryLong ? '.is-very-long' : (t.length > long ? '.is-long' : '');
    return UI.el('h1.stage__question' + cls, { text: t });
  }

  function optionsGrid(options, correctIds) {
    var reveal = Array.isArray(correctIds);
    return UI.el('div.stage__options', { dataset: { count: String(options.length) } },
      options.map(function (opt, i) {
        var isCorrect = reveal && correctIds.indexOf(opt.id) !== -1;
        var cls = reveal ? (isCorrect ? '.stage__option--correct' : '.stage__option--dim') : '';

        var children = [
          UI.el('span.stage__option-key', { text: UI.optionLetter(i) }),
          UI.el('span.stage__option-text', { text: opt.text })
        ];

        /* The live vote share, while people are still voting. The
           percentage sits to the right of the option and a bar
           fills along the bottom edge; both are neutral gold,
           because nothing here knows which option is right. */
        if (!reveal && state.votes) {
          children.push(UI.el('span.stage__option-pct', {
            dataset: { pct: opt.id }, text: ''
          }));
          children.push(UI.el('span.stage__option-bar', {}, [
            UI.el('span.stage__option-bar-fill', { dataset: { bar: opt.id } })
          ]));
        }

        return UI.el('div.stage__option' + cls, { dataset: { opt: opt.id } }, children);
      })
    );
  }

  /* Update the vote bars in place.
     ---------------------------------------------------------
     Called on every state push while a question is open. It must
     not rebuild the scene: that would restart the entry
     animation and, on a media question, retrigger the clip —
     several times a second as answers arrive. */
  function updateVotes() {
    if (!state || !state.votes) return;
    var total = state.votes.total || 0;

    state.votes.rows.forEach(function (row) {
      var pct = UI.$('[data-pct="' + row.id + '"]');
      var bar = UI.$('[data-bar="' + row.id + '"]');
      /* Percentages of nothing are noise, so until the first
         answer lands the row shows nothing at all. */
      var share = total ? Math.round(row.share * 100) : 0;
      if (pct) pct.textContent = total ? share + '%' : '';
      if (bar) bar.style.transform = 'scaleX(' + (total ? row.share : 0).toFixed(3) + ')';
    });

    var tally = UI.$('#vote-total');
    if (tally) {
      tally.textContent = total
        ? total + ' of ' + (state.counts ? state.counts.teams : total) + ' in'
        : '';
    }
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
      questionHeading(q.prompt, false)
    ];

    /* The picture stays up for the reveal. On "which of these
       four fingerprints is a whorl", lighting up option B while
       the evidence is off screen tells the room nothing. */
    if (q.media) children.push(mediaNode(q.media, q.input === 'choice' && q.options));

    if (q.input === 'choice' && q.options) {
      children.push(optionsGrid(q.options, r.correctOptionIds || []));
      /* The split across the options, when anyone answered — the
         bit the room reacts to. Dropped when a picture is also on
         screen: all three together will not fit, and the room has
         been watching the same split fill up live all through the
         question anyway. */
      if (r.distribution && r.distribution.total && !q.media) {
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
     Shrink to fit
     ---------------------------------------------------------
     A projection screen must never clip. No amount of CSS can
     promise that, because the host writes the content: a question
     can run to three lines, an explanation to four, and a picture
     round puts a picture, six options and a clock on one screen.

     So the scene measures itself after every render and scales
     down uniformly if it does not fit. Scaling rather than
     re-flowing keeps the proportions the design was drawn at, and
     shrinking slightly is always better than losing the bottom of
     the screen — which is where the clock lives.
     --------------------------------------------------------- */
  function fitScene() {
    var fit = UI.$('.scene__fit');
    if (!fit || !els.main) return;

    fit.style.transform = '';          // measure at natural size

    var main = els.main.getBoundingClientRect();
    var rect = fit.getBoundingClientRect();
    if (!main.height || !rect.height) return;

    /* Scale down only when it genuinely does not fit. Floored,
       because past a point the room cannot read it anyway and the
       real answer is a shorter question. */
    var k = rect.height > main.height
      ? Math.max(0.55, (main.height - 8) / rect.height)
      : 1;

    /* Then centre it by measurement rather than trusting the
       containers to have done it. The scene is the only thing on
       the screen; it being a few pixels low is the difference
       between the clock being visible and the clock being cut in
       half, and that is not worth leaving to a stack of nested
       flex and grid boxes. */
    var centreNow = rect.top + rect.height / 2;
    var centreWanted = main.top + main.height / 2;
    var dy = centreWanted - centreNow;

    if (k === 1 && Math.abs(dy) < 1) return;
    fit.style.transform = 'translateY(' + dy.toFixed(1) + 'px) scale(' + k.toFixed(4) + ')';
  }

  /* Pictures have no height until they load, so the first measure
     is taken before they arrive. Re-fit as each one lands. */
  function fitWhenMediaLoads() {
    UI.$$('.scene__fit img, .scene__fit video').forEach(function (node) {
      if (node.complete) return;
      node.addEventListener('load', fitScene, { once: true });
      node.addEventListener('loadedmetadata', fitScene, { once: true });
      node.addEventListener('error', fitScene, { once: true });
    });
  }

  window.addEventListener('resize', function () {
    window.setTimeout(fitScene, 60);
  });

  /* ---------------------------------------------------------
     Media
     ---------------------------------------------------------
     The projector is the machine with the speakers, so this is
     where a clip actually plays. `startAt`/`endAt` are honoured
     locally; the host's mediaState only says whether it should
     be running.
     --------------------------------------------------------- */
  function mediaNode(media, sharesWithOptions) {
    /* At the reveal the clip has already been heard or watched,
       so a still frame is shown rather than playing it again over
       the host talking. */
    var replay = state && state.phase === 'reveal';
    /* A picture that shares the screen with four answers gets a
       smaller share of it, so the answers are never squeezed off
       the bottom. */
    var cls = '.stage__media' + (sharesWithOptions ? '.stage__media--with-options' : '');

    if (media.kind === 'image') {
      return UI.el('div' + cls, {}, [
        UI.el('img', { src: media.url, alt: '' })
      ]);
    }

    if (media.kind === 'audio') {
      /* Audio has nothing to look at, so the stage shows a level
         meter stand-in and the element itself stays hidden. */
      var audio = UI.el('audio', { src: media.url, preload: 'auto' });
      mediaEl = audio;
      if (replay) media = Object.assign({}, media, { autoplay: false });
      var meter = UI.el('div.stage__audio', {},
        [1, 2, 3, 4, 5, 6, 7].map(function () { return UI.el('div.stage__audio-bar'); })
      );
      wireMedia(audio, media, meter);
      return UI.el('div' + cls, {}, [meter, audio]);
    }

    var video = UI.el('video', {
      src: media.url, preload: 'auto', playsinline: 'playsinline'
    });
    mediaEl = video;
    wireMedia(video, Object.assign({}, media, replay ? { autoplay: false } : {}), null);
    return UI.el('div' + cls, {}, [video]);
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
    /* Keep whatever size the scene chose; only the colour changes
       as the clock runs down. */
    var compact = el.classList.contains('stage__timer--compact') ? ' stage__timer--compact' : '';
    el.className = 'stage__timer' + compact +
      (secs <= 5 ? ' stage__timer--urgent' : (secs <= 10 ? ' stage__timer--warn' : ''));

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

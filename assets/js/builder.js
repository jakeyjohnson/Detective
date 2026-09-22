/* =========================================================
   Quiz builder.

   Editing model: one in-memory quiz object, mutated in place,
   autosaved on a debounce. Every input writes straight to the
   object on `input` — there is no save button to forget and no
   separate form state to drift out of sync with what's on
   screen.

   Re-rendering: targeted, not wholesale. Retyping a question
   must not rebuild the DOM, because that would blur the field
   the host is typing into and lose their cursor position. So
   text inputs update the model silently, and only structural
   changes (add, delete, move, change type) re-render.
   ========================================================= */
(function (window) {
  'use strict';

  var UI = window.DetectiveUI;
  var Model = window.DetectiveModel;
  var Store = window.DetectiveStore;
  var cfg = window.DETECTIVE_CONFIG || {};

  var quiz = null;
  var dirty = false;
  var saving = false;

  var els = {};

  /* ---------------------------------------------------------
     Autosave
     ---------------------------------------------------------
     Debounced so typing a question is one write, not sixty.
     The status line is the only feedback — a toast on every
     save would be unbearable. */
  var save = UI.debounce(function () {
    if (!quiz) return;
    saving = true;
    renderStatus();
    Store.quizzes.save(quiz)
      .then(function () {
        dirty = false;
        saving = false;
        renderStatus();
      })
      .catch(function (err) {
        saving = false;
        renderStatus();
        UI.toast(err.message || 'Could not save.', 'error');
      });
  }, 600);

  function touch(structural) {
    dirty = true;
    quiz.updatedAt = new Date().toISOString();
    renderStatus();
    save();
    if (structural) render();
    else renderSidebar();
  }

  /* Leaving with an unsaved edit in flight would lose it. The
     debounce is only 600ms, so this fires rarely, but a lost
     question an hour before a show is not recoverable. */
  window.addEventListener('beforeunload', function (ev) {
    if (dirty) {
      ev.preventDefault();
      ev.returnValue = '';
      return '';
    }
  });

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  function boot() {
    /* The case files include the answers, so the builder is
       behind the same gate as the control room. In cloud mode
       this is load-bearing: the quizzes table is not served to
       an unauthenticated client at all. */
    window.DetectiveGate.require(UI.$('#builder-app')).then(start);
  }

  function start() {
    els.rounds = UI.$('#rounds');
    els.status = UI.$('#save-status');
    els.title = UI.$('#quiz-title');
    els.subtitle = UI.$('#quiz-subtitle');
    els.sidebar = UI.$('#sidebar');
    els.picker = UI.$('#type-picker');
    els.quizList = UI.$('#quiz-list');

    var id = UI.param('quiz');

    (id ? Store.quizzes.get(id) : Promise.resolve(null))
      .then(function (loaded) {
        if (id && !loaded) {
          UI.toast('That case could not be found — started a new one.', 'error');
        }
        quiz = loaded || Model.newQuiz();

        /* A brand new quiz is saved immediately so the URL can
           carry its id. Otherwise a reload loses everything and
           "Run this show" has nothing to point at. */
        if (!loaded) {
          return Store.quizzes.save(quiz).then(function () {
            var url = new URL(window.location.href);
            url.searchParams.set('quiz', quiz.id);
            window.history.replaceState({}, '', url.toString());
          });
        }
      })
      .then(function () {
        wireChrome();
        render();
        renderQuizList();
      })
      .catch(function (err) {
        UI.toast(err.message || 'Could not load.', 'error');
      });
  }

  function wireChrome() {
    els.title.value = quiz.title;
    els.subtitle.value = quiz.subtitle || '';

    els.title.addEventListener('input', function () {
      quiz.title = els.title.value;
      touch(false);
    });
    els.subtitle.addEventListener('input', function () {
      quiz.subtitle = els.subtitle.value;
      touch(false);
    });

    UI.$('#add-round').addEventListener('click', function () {
      quiz.rounds.push(Model.newRound('Round ' + (quiz.rounds.length + 1)));
      touch(true);
    });

    UI.$('#export').addEventListener('click', function () {
      var name = (quiz.title || 'case').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      UI.download((name || 'case') + '.json', JSON.stringify(quiz, null, 2));
    });

    UI.$('#import-file').addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      UI.readFile(file)
        .then(function (text) {
          var parsed = JSON.parse(text);
          var incoming = Model.normaliseQuiz(parsed);
          /* Imported as a NEW case rather than overwriting this
             one. Importing over the top of an hour's work by
             accident is unrecoverable; a duplicate is not. */
          incoming.id = Model.uid('quiz');
          incoming.title = (incoming.title || 'Imported case');
          return Store.quizzes.save(incoming).then(function () {
            window.location.href = 'build.html?quiz=' + encodeURIComponent(incoming.id);
          });
        })
        .catch(function () {
          UI.toast('That file is not a case export.', 'error');
        });
      ev.target.value = '';
    });

    UI.$('#new-quiz').addEventListener('click', function () {
      window.location.href = 'build.html';
    });

    UI.$('#run-show').addEventListener('click', function () {
      var errors = Model.validate(quiz).filter(function (i) { return i.level === 'error'; });
      if (errors.length && !UI.confirm(
        errors.length + ' problem' + (errors.length === 1 ? '' : 's') +
        ' still to fix. Run the show anyway?')) return;
      window.location.href = 'host.html?quiz=' + encodeURIComponent(quiz.id);
    });

    /* Settings checkboxes are declared in the HTML with a
       data-setting attribute so adding one needs no JS change. */
    UI.$$('[data-setting]').forEach(function (input) {
      var key = input.dataset.setting;
      input.checked = !!quiz.settings[key];
      input.addEventListener('change', function () {
        quiz.settings[key] = input.checked;
        touch(false);
      });
    });

    renderTypePicker();
  }

  /* ---------------------------------------------------------
     Status line
     --------------------------------------------------------- */
  function renderStatus() {
    if (!els.status) return;
    var text = saving ? 'Saving…' : (dirty ? 'Unsaved changes' : 'Saved');
    els.status.textContent = text;
    els.status.className = 'label' + (dirty || saving ? '' : ' label--accent');
  }

  /* ---------------------------------------------------------
     Type picker — drives "add a question". Reads the registry,
     so a new question type appears here with no change to this
     file.
     --------------------------------------------------------- */
  var pickerTargetRound = 0;

  function renderTypePicker() {
    UI.replace(els.picker, Model.typeList().map(function (t) {
      return UI.el('button.type-btn', {
        type: 'button',
        title: t.blurb,
        onclick: function () {
          var round = quiz.rounds[pickerTargetRound] || quiz.rounds[0];
          var q = Model.newQuestion(t.key);
          q.points = cfg.defaultPoints != null && t.key !== 'wager' && t.key !== 'discussion'
            ? cfg.defaultPoints : q.points;
          round.questions.push(q);
          openNext = q.id;
          touch(true);
        }
      }, [
        UI.el('strong', { text: t.label }),
        UI.el('span', { text: t.blurb })
      ]);
    }));
  }

  /* A newly added question is expanded automatically — nobody
     adds a question in order to leave it blank. */
  var openNext = null;

  /* ---------------------------------------------------------
     Render
     --------------------------------------------------------- */
  function render() {
    var openIds = UI.$$('.qrow[open]', els.rounds).map(function (n) { return n.dataset.qid; });
    if (openNext) openIds.push(openNext);

    UI.replace(els.rounds, quiz.rounds.map(function (round, ri) {
      return renderRound(round, ri, openIds);
    }));

    if (openNext) {
      var node = UI.$('.qrow[data-qid="' + openNext + '"]', els.rounds);
      if (node) {
        var input = UI.$('.js-prompt', node);
        if (input) input.focus();
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      openNext = null;
    }

    renderSidebar();
    renderStatus();
  }

  function renderRound(round, ri, openIds) {
    var titleInput = UI.el('input.round__title', {
      type: 'text', value: round.title, 'aria-label': 'Round title',
      placeholder: 'Round title'
    });
    titleInput.addEventListener('input', function () {
      round.title = titleInput.value;
      touch(false);
    });

    var head = UI.el('div.round__head', {}, [
      UI.el('span.label', { text: 'Round ' + (ri + 1) }),
      titleInput,
      UI.el('span.tag', { text: UI.plural(round.questions.length, 'question') }),
      moveButton(quiz.rounds, ri, -1, 'Move round up'),
      moveButton(quiz.rounds, ri, 1, 'Move round down'),
      UI.el('button.btn.btn--icon.btn--danger', {
        type: 'button', title: 'Delete round', 'aria-label': 'Delete round ' + (ri + 1),
        text: '×',
        onclick: function () {
          var warn = round.questions.length
            ? 'Delete "' + round.title + '" and its ' + UI.plural(round.questions.length, 'question') + '?'
            : 'Delete "' + round.title + '"?';
          if (!UI.confirm(warn)) return;
          quiz.rounds.splice(ri, 1);
          if (!quiz.rounds.length) quiz.rounds.push(Model.newRound('Round 1'));
          touch(true);
        }
      })
    ]);

    var descInput = UI.el('input.input', {
      type: 'text', value: round.description || '',
      placeholder: 'Round description, shown on the round card (optional)'
    });
    descInput.addEventListener('input', function () {
      round.description = descInput.value;
      touch(false);
    });

    var body = UI.el('div.round__body', {}, [
      UI.el('div.stack.stack--tight', {}, [descInput]),
      UI.el('div', { style: 'height: var(--sp-4)' }),
      round.questions.length
        ? UI.el('div', {}, round.questions.map(function (q, qi) {
            return renderQuestion(q, round, qi, openIds);
          }))
        : UI.el('div.empty', {}, [
            UI.el('p', { text: 'No questions in this round yet. Pick a type from the panel to add one.' })
          ]),
      UI.el('div.row', { style: 'margin-top: var(--sp-4)' }, [
        UI.el('button.btn.btn--sm', {
          type: 'button',
          text: '+ Add question here',
          onclick: function () {
            pickerTargetRound = ri;
            highlightPicker(round.title);
          }
        })
      ])
    ]);

    return UI.el('section.round', { dataset: { rid: round.id } }, [head, body]);
  }

  function highlightPicker(roundTitle) {
    UI.$('#picker-target').textContent = roundTitle;
    els.picker.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    /* Brief brass flash so it's obvious the panel now targets a
       different round — the panel itself doesn't move. */
    var panel = UI.$('#picker-panel');
    panel.style.transition = 'border-color var(--dur-base) var(--ease-out)';
    panel.style.borderColor = 'var(--accent)';
    window.setTimeout(function () { panel.style.borderColor = ''; }, 700);
  }

  /* Move an item within its array. Returns a disabled button at
     the ends rather than hiding it, so the row's controls don't
     reflow as you move things around. */
  function moveButton(arr, index, delta, title) {
    var target = index + delta;
    var can = target >= 0 && target < arr.length;
    return UI.el('button.btn.btn--icon', {
      type: 'button',
      title: title,
      'aria-label': title,
      text: delta < 0 ? '↑' : '↓',
      disabled: !can,
      onclick: function () {
        if (!can) return;
        var item = arr.splice(index, 1)[0];
        arr.splice(target, 0, item);
        touch(true);
      }
    });
  }

  /* ---------------------------------------------------------
     One question editor
     --------------------------------------------------------- */
  function renderQuestion(q, round, qi, openIds) {
    var type = Model.type(q.type);
    var mode = Model.inputMode(q);

    var summary = UI.el('summary.qrow__summary', {}, [
      UI.el('span.qrow__n', { text: String(qi + 1) }),
      UI.el('span.tag' + (mode === 'judged' ? '' : '.tag--accent'), { text: type.label }),
      UI.el('span.qrow__text', { text: q.prompt || '' }),
      UI.el('span.label.nowrap', { text: q.points ? q.points + ' pts' : '—' }),
      UI.el('span.label.nowrap', { text: q.timeLimit ? q.timeLimit + 's' : 'no timer' })
    ]);

    var controls = UI.el('div.row.row--end', {}, [
      moveButton(round.questions, qi, -1, 'Move question up'),
      moveButton(round.questions, qi, 1, 'Move question down'),
      UI.el('button.btn.btn--sm', {
        type: 'button', text: 'Duplicate',
        onclick: function () {
          var copy = Model.normaliseQuestion(JSON.parse(JSON.stringify(q)));
          /* Fresh ids throughout: reusing an option id across two
             questions would cross-contaminate the answer log. */
          copy.id = Model.uid('q');
          copy.options = copy.options.map(function (o) { return { id: Model.uid('o'), text: o.text, correct: o.correct }; });
          copy.items = copy.items.map(function (i) { return { id: Model.uid('i'), text: i.text }; });
          round.questions.splice(qi + 1, 0, copy);
          openNext = copy.id;
          touch(true);
        }
      }),
      UI.el('button.btn.btn--sm.btn--danger', {
        type: 'button', text: 'Delete',
        onclick: function () {
          if (!UI.confirm('Delete this question?')) return;
          round.questions.splice(qi, 1);
          touch(true);
        }
      })
    ]);

    var body = UI.el('div.qrow__body', {}, [
      field('Question', textarea(q, 'prompt', 'What do you want to ask?', 'js-prompt')),
      typeAndScoring(q),
      mediaEditor(q),
      answerEditor(q),
      field('Note for the reveal (optional)',
        textarea(q, 'explanation', 'Shown under the answer. "Arsenic — the Victorian poisoner’s favourite."')),
      controls
    ]);

    return UI.el('details.qrow', {
      dataset: { qid: q.id },
      open: openIds.indexOf(q.id) !== -1
    }, [summary, body]);
  }

  function field(labelText, control, hint) {
    return UI.el('div.field', {}, [
      UI.el('label.label', { text: labelText }),
      control,
      hint ? UI.el('p.field__hint', { text: hint }) : null
    ]);
  }

  /* Bound text input: writes to the model on every keystroke but
     never triggers a re-render, so focus and caret survive. */
  function boundInput(obj, key, placeholder, className, type) {
    var input = UI.el('input.input' + (className ? '.' + className : ''), {
      type: type || 'text',
      value: obj[key] == null ? '' : obj[key],
      placeholder: placeholder || ''
    });
    input.addEventListener('input', function () {
      obj[key] = type === 'number'
        ? (input.value === '' ? null : Number(input.value))
        : input.value;
      touch(false);
    });
    return input;
  }

  function textarea(obj, key, placeholder, className) {
    var ta = UI.el('textarea.textarea' + (className ? '.' + className : ''), {
      placeholder: placeholder || '', rows: 2
    });
    ta.value = obj[key] == null ? '' : obj[key];
    ta.addEventListener('input', function () {
      obj[key] = ta.value;
      touch(false);
    });
    return ta;
  }

  function typeAndScoring(q) {
    var type = Model.type(q.type);

    var typeSelect = UI.el('select.select', { 'aria-label': 'Question type' },
      Model.typeList().map(function (t) {
        return UI.el('option', { value: t.key, text: t.label, selected: t.key === q.type });
      }));
    typeSelect.addEventListener('change', function () {
      /* Changing type rebuilds the type-specific fields but keeps
         the prompt, points, timing, media and reveal note — those
         are the parts that took work to write. */
      var fresh = Model.newQuestion(typeSelect.value);
      fresh.id = q.id;
      fresh.prompt = q.prompt;
      fresh.explanation = q.explanation;
      fresh.media = q.media;
      if (q.points) fresh.points = q.points;
      if (q.timeLimit) fresh.timeLimit = q.timeLimit;

      /* Carry the answer across where the new type can still use
         it, so switching standard → audio doesn't lose the typing. */
      if (q.answers.length) fresh.answers = q.answers.slice();
      if (q.options.length && Model.inputMode(fresh) === 'choice' && fresh.type !== 'true-false') {
        fresh.options = q.options.map(function (o) { return { id: o.id, text: o.text, correct: o.correct }; });
      }

      var round = quiz.rounds.filter(function (r) {
        return r.questions.indexOf(q) !== -1;
      })[0];
      if (round) round.questions[round.questions.indexOf(q)] = fresh;
      openNext = fresh.id;
      touch(true);
    });

    var children = [
      field('Type', typeSelect),
      field('Points', boundInput(q, 'points', '10', 'input--num', 'number')),
      field('Seconds', boundInput(q, 'timeLimit', '30', 'input--num', 'number'),
        '0 for no timer — you move on by hand.')
    ];

    /* Media types can be asked as a choice, as typing, or left for
       the host to mark. Only offered where the type supports it. */
    if (type.answerModes) {
      var modeSelect = UI.el('select.select', { 'aria-label': 'How players answer' },
        type.answerModes.map(function (m) {
          return UI.el('option', {
            value: m,
            text: { choice: 'Pick an option', text: 'Type the answer', judged: 'Type it, you mark it' }[m],
            selected: m === Model.inputMode(q)
          });
        }));
      modeSelect.addEventListener('change', function () {
        q.input = modeSelect.value;
        if (q.input === 'choice' && !q.options.length) {
          q.options = [Model.newOption('', true), Model.newOption(''), Model.newOption(''), Model.newOption('')];
        }
        openNext = q.id;
        touch(true);
      });
      children.push(field('Answered by', modeSelect));
    }

    return UI.el('div.field-grid', {}, children);
  }

  /* ---------------------------------------------------------
     Media
     --------------------------------------------------------- */
  function mediaEditor(q) {
    var type = Model.type(q.type);
    if (type.media === 'none') return null;

    var urlInput = boundInput(q.media, 'url',
      'https://…/clip.mp4 — a direct file link, not a YouTube page');

    var preview = UI.el('div.stack.stack--tight');

    function refresh() {
      var kind = UI.mediaKind(q.media.url);
      /* Keep the stored kind in step with the URL so the
         projection knows which element to build. A required-media
         type keeps its own kind when the box is empty. */
      if (kind === 'video' || kind === 'audio' || kind === 'image') q.media.kind = kind;
      else if (!q.media.url) q.media.kind = type.mediaKind || 'none';

      UI.clear(preview);

      if (!q.media.url) {
        if (type.media === 'required') {
          preview.appendChild(UI.el('p.field__error', {
            text: 'A ' + type.label.toLowerCase() + ' question needs a media URL.'
          }));
        }
        return;
      }

      if (kind === 'embed') {
        /* Deliberately refused rather than embedded. An iframe
           can't be cued, stopped or timed by the host, and an
           autoplaying YouTube player shows related-video
           thumbnails to a room mid-question. */
        preview.appendChild(UI.el('div.notice.notice--wrong', {}, [
          UI.el('div', {}, [
            UI.el('strong', { text: 'That is a page, not a media file. ' }),
            'Download the clip and host the file, then link to the file itself ' +
            '(ending .mp4, .mp3, .jpg and so on). The show needs to start and stop ' +
            'the clip on your cue, which an embedded player will not do.'
          ])
        ]));
        return;
      }

      if (kind === 'unknown') {
        preview.appendChild(UI.el('p.field__hint', {
          text: 'Cannot tell what kind of file that is from the URL. It will be treated as ' +
                (type.mediaKind || 'video') + '.'
        }));
      }

      var frame = UI.el('div.media-frame' + (kind === 'audio' ? '.media-frame--audio' : ''));
      if (kind === 'audio') {
        frame.appendChild(UI.el('audio', { src: q.media.url, controls: 'controls', preload: 'metadata' }));
      } else if (kind === 'image') {
        frame.appendChild(UI.el('img', { src: q.media.url, alt: 'Question media preview' }));
      } else {
        frame.appendChild(UI.el('video', {
          src: q.media.url, controls: 'controls', preload: 'metadata',
          style: 'max-height: 14rem'
        }));
      }
      preview.appendChild(frame);
      preview.appendChild(UI.el('p.field__hint', {
        text: 'Play it through here now. A clip that fails in the venue is a dead question.'
      }));
    }

    urlInput.addEventListener('input', UI.debounce(refresh, 500));
    refresh();

    var opts = UI.el('div.row.row--wrap', {}, [
      checkbox(q.media, 'autoplay', 'Start automatically'),
      checkbox(q.media, 'loop', 'Loop until I move on'),
      UI.el('div.field', {}, [
        UI.el('label.label', { text: 'Start at (s)' }),
        boundInput(q.media, 'startAt', '0', 'input--num', 'number')
      ]),
      UI.el('div.field', {}, [
        UI.el('label.label', { text: 'Stop at (s)' }),
        boundInput(q.media, 'endAt', '—', 'input--num', 'number')
      ])
    ]);

    return UI.el('div.panel.panel--inset.stack', {}, [
      UI.el('span.label.label--bright', { text: 'Media' }),
      urlInput,
      preview,
      opts
    ]);
  }

  function checkbox(obj, key, labelText) {
    var input = UI.el('input', { type: 'checkbox', checked: !!obj[key] });
    input.addEventListener('change', function () {
      obj[key] = input.checked;
      touch(false);
    });
    return UI.el('label.check', {}, [input, UI.el('span.check__text', { text: labelText })]);
  }

  /* ---------------------------------------------------------
     Answer editors, one per input mode
     --------------------------------------------------------- */
  function answerEditor(q) {
    var mode = Model.inputMode(q);

    if (mode === 'choice') return choiceEditor(q);
    if (mode === 'text') return textAnswerEditor(q);
    if (mode === 'order') return orderEditor(q);
    if (mode === 'number') return numberEditor(q);
    if (mode === 'judged') return judgedEditor(q);

    return UI.el('div.notice.notice--accent', {}, [
      UI.el('div', { text: 'No answers are collected for this one. It goes on screen and you talk to the room.' })
    ]);
  }

  function choiceEditor(q) {
    var fixed = q.type === 'true-false';
    /* Multi-answer is a property of the question, not something
       inferred from how many options happen to be ticked — the
       author needs to be able to turn it on BEFORE ticking a
       second one. True/false is always single. */
    var multi = !fixed && !!q.multiCorrect;

    var rows = q.options.map(function (opt, i) {
      var box = UI.el('input', {
        type: multi ? 'checkbox' : 'radio',
        name: 'correct_' + q.id,
        checked: !!opt.correct,
        'aria-label': 'Mark option ' + UI.optionLetter(i) + ' correct',
        title: 'Mark correct'
      });
      box.addEventListener('change', function () {
        if (multi) {
          opt.correct = box.checked;
        } else {
          q.options.forEach(function (o) { o.correct = false; });
          opt.correct = true;
        }
        touch(true);
      });

      var text = UI.el('input.input', {
        type: 'text', value: opt.text,
        placeholder: 'Option ' + UI.optionLetter(i),
        disabled: fixed
      });
      text.addEventListener('input', function () {
        opt.text = text.value;
        touch(false);
      });

      return UI.el('div.opt' + (opt.correct ? '.opt--correct' : ''), {}, [
        UI.el('span.opt__key', { text: UI.optionLetter(i) }),
        box,
        text,
        fixed ? null : UI.el('button.btn.btn--icon.btn--danger', {
          type: 'button', text: '×', title: 'Remove option',
          'aria-label': 'Remove option ' + UI.optionLetter(i),
          disabled: q.options.length <= 2,
          onclick: function () {
            q.options.splice(i, 1);
            /* Never leave a question with nothing marked correct. */
            if (!q.options.some(function (o) { return o.correct; }) && q.options.length) {
              q.options[0].correct = true;
            }
            touch(true);
          }
        })
      ]);
    });

    var footer = fixed ? null : UI.el('div.row.row--wrap', {}, [
      UI.el('button.btn.btn--sm', {
        type: 'button', text: '+ Option',
        disabled: q.options.length >= 6,
        onclick: function () {
          q.options.push(Model.newOption(''));
          touch(true);
        }
      }),
      UI.el('label.check', {}, [
        (function () {
          var input = UI.el('input', { type: 'checkbox', checked: multi });
          input.addEventListener('change', function () {
            q.multiCorrect = input.checked;
            if (!input.checked) {
              /* Collapsing to single-answer: keep the first correct
                 one, so the question stays markable. */
              var first = q.options.filter(function (o) { return o.correct; })[0];
              q.options.forEach(function (o) { o.correct = false; });
              if (q.options.length) (first || q.options[0]).correct = true;
            }
            touch(true);
          });
          return input;
        })(),
        UI.el('span.check__text', { text: 'Several answers are correct' })
      ])
    ]);

    return UI.el('div.panel.panel--inset.stack', {}, [
      UI.el('span.label.label--bright', {
        text: fixed ? 'Mark the true one' : 'Options — tick the correct one' + (multi ? 's' : '')
      }),
      UI.el('div.stack.stack--tight', {}, rows),
      footer
    ]);
  }

  function textAnswerEditor(q) {
    var list = UI.el('div.stack.stack--tight', {}, q.answers.map(function (ans, i) {
      var input = UI.el('input.input', {
        type: 'text', value: ans,
        placeholder: i === 0 ? 'The answer' : 'Also accept…'
      });
      input.addEventListener('input', function () {
        q.answers[i] = input.value;
        touch(false);
      });
      return UI.el('div.opt', {}, [
        UI.el('span.opt__key', { text: i === 0 ? '=' : 'or' }),
        input,
        UI.el('button.btn.btn--icon.btn--danger', {
          type: 'button', text: '×', title: 'Remove',
          'aria-label': 'Remove accepted answer ' + (i + 1),
          onclick: function () {
            q.answers.splice(i, 1);
            touch(true);
          }
        })
      ]);
    }));

    if (!q.answers.length) {
      q.answers.push('');
      return textAnswerEditor(q);
    }

    return UI.el('div.panel.panel--inset.stack', {}, [
      UI.el('span.label.label--bright', { text: 'Accepted answers' }),
      list,
      UI.el('div.row.row--wrap', {}, [
        UI.el('button.btn.btn--sm', {
          type: 'button', text: '+ Also accept',
          onclick: function () {
            q.answers.push('');
            touch(true);
          }
        }),
        checkbox(q, 'acceptClose', 'Forgive spelling slips')
      ]),
      UI.el('p.field__hint', {
        text: 'Capitals, punctuation, accents and a leading "the" are ignored already. ' +
              'Add every wording you would accept out loud — "Conan Doyle" as well as "Arthur Conan Doyle".'
      })
    ]);
  }

  function orderEditor(q) {
    var rows = q.items.map(function (item, i) {
      var input = UI.el('input.input', {
        type: 'text', value: item.text, placeholder: 'Item ' + (i + 1)
      });
      input.addEventListener('input', function () {
        item.text = input.value;
        touch(false);
      });
      return UI.el('div.opt', {}, [
        UI.el('span.opt__key', { text: String(i + 1) }),
        input,
        moveButton(q.items, i, -1, 'Move up'),
        moveButton(q.items, i, 1, 'Move down'),
        UI.el('button.btn.btn--icon.btn--danger', {
          type: 'button', text: '×', title: 'Remove item',
          disabled: q.items.length <= 2,
          onclick: function () {
            q.items.splice(i, 1);
            touch(true);
          }
        })
      ]);
    });

    return UI.el('div.panel.panel--inset.stack', {}, [
      UI.el('span.label.label--bright', { text: 'The correct order, top to bottom' }),
      UI.el('div.stack.stack--tight', {}, rows),
      UI.el('button.btn.btn--sm', {
        type: 'button', text: '+ Item',
        disabled: q.items.length >= 8,
        onclick: function () {
          q.items.push({ id: Model.uid('i'), text: '' });
          touch(true);
        }
      }),
      UI.el('p.field__hint', {
        text: 'Players see these shuffled. Part marks are given per item in the right place.'
      })
    ]);
  }

  function numberEditor(q) {
    return UI.el('div.panel.panel--inset.stack', {}, [
      UI.el('span.label.label--bright', { text: 'The number' }),
      UI.el('div.field-grid', {}, [
        field('Correct value', boundInput(q.numeric, 'value', '0', null, 'number')),
        field('Allowed margin', boundInput(q.numeric, 'tolerance', 'closest wins', 'input--num', 'number'),
          'Leave empty and the nearest guess in the room takes the points.')
      ])
    ]);
  }

  function judgedEditor(q) {
    var isWager = q.type === 'wager';
    var children = [
      UI.el('span.label.label--bright', { text: 'You mark this one by hand' })
    ];

    if (isWager) {
      children.push(UI.el('div.field-grid', {}, [
        field('Smallest stake', boundInput(q.wager, 'min', '0', 'input--num', 'number')),
        field('Largest stake', boundInput(q.wager, 'max', 'their whole score', 'input--num', 'number'),
          'Leave empty to let teams stake everything they have.')
      ]));
    }

    var answerInput = UI.el('input.input', {
      type: 'text',
      value: q.answers[0] || '',
      placeholder: 'What you are marking against'
    });
    answerInput.addEventListener('input', function () {
      q.answers[0] = answerInput.value;
      touch(false);
    });
    children.push(field('The answer', answerInput,
      'Shown to you while marking, and on screen at the reveal.'));

    children.push(UI.el('p.field__hint', {
      text: isWager
        ? 'Teams stake points before the question. Right adds the stake, wrong takes it off.'
        : 'Every answer comes to your control room with a right and a wrong button next to it.'
    }));

    return UI.el('div.panel.panel--inset.stack', {}, children);
  }

  /* ---------------------------------------------------------
     Sidebar: counts, timing estimate, problems
     --------------------------------------------------------- */
  function renderSidebar() {
    if (!els.sidebar) return;

    var count = Model.questionCount(quiz);
    var order = Model.runOrder(quiz);

    /* Rough running time: the sum of the answer clocks, plus a
       flat allowance per question for reading it out and the
       reveal. Eight seconds is about right from rehearsal; the
       number is a planning aid, labelled as an estimate. */
    var seconds = order.reduce(function (n, e) {
      return n + (Number(e.question.timeLimit) || 0) + 8;
    }, 0);
    var minutes = Math.round(seconds / 60);

    var issues = Model.validate(quiz);
    var errors = issues.filter(function (i) { return i.level === 'error'; });
    var warns = issues.filter(function (i) { return i.level === 'warn'; });

    var problemList = issues.length
      ? UI.el('div.stack.stack--tight', {}, issues.slice(0, 12).map(function (i) {
          return UI.el('button.notice' + (i.level === 'error' ? '.notice--wrong' : '.notice--accent'), {
            type: 'button',
            style: 'text-align: left; cursor: pointer; width: 100%',
            onclick: function () {
              var node = UI.$('.qrow[data-qid="' + i.where + '"]');
              if (node) {
                node.open = true;
                node.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }
            }
          }, [UI.el('div', { text: i.message })]);
        }))
      : UI.el('div.notice.notice--correct', {}, [UI.el('div', { text: 'Ready to run.' })]);

    UI.replace(els.sidebar, [
      UI.el('div.panel.stack', {}, [
        UI.el('span.label.label--bright', { text: 'This case' }),
        UI.el('div.row.row--between', {}, [
          UI.el('span.muted', { text: 'Questions' }),
          UI.el('strong.mono', { text: String(count) })
        ]),
        UI.el('div.row.row--between', {}, [
          UI.el('span.muted', { text: 'Rounds' }),
          UI.el('strong.mono', { text: String(quiz.rounds.length) })
        ]),
        UI.el('div.row.row--between', {}, [
          UI.el('span.muted', { text: 'Points on offer' }),
          UI.el('strong.mono', {
            text: String(order.reduce(function (n, e) { return n + (Number(e.question.points) || 0); }, 0))
          })
        ]),
        UI.el('div.row.row--between', {}, [
          UI.el('span.muted', { text: 'Rough running time' }),
          UI.el('strong.mono', { text: minutes ? '~' + minutes + ' min' : '—' })
        ])
      ]),
      UI.el('div.panel.stack', {}, [
        UI.el('div.row.row--between', {}, [
          UI.el('span.label.label--bright', { text: 'Before you run it' }),
          UI.el('span.tag' + (errors.length ? '.tag--wrong' : (warns.length ? '' : '.tag--correct')), {
            text: errors.length ? errors.length + ' to fix' : (warns.length ? warns.length + ' to check' : 'clear')
          })
        ]),
        problemList
      ])
    ]);
  }

  /* ---------------------------------------------------------
     Saved cases list
     --------------------------------------------------------- */
  function renderQuizList() {
    Store.quizzes.list().then(function (list) {
      if (!list.length) {
        UI.replace(els.quizList, [UI.el('p.field__hint', { text: 'Nothing saved yet.' })]);
        return;
      }
      UI.replace(els.quizList, list.map(function (item) {
        var isCurrent = item.id === quiz.id;
        return UI.el('div.row.row--between', { style: 'gap: var(--sp-2)' }, [
          isCurrent
            ? UI.el('strong', { text: item.title || 'Untitled', style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' })
            : UI.el('a', {
                href: 'build.html?quiz=' + encodeURIComponent(item.id),
                text: item.title || 'Untitled',
                style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
              }),
          UI.el('span.row', { style: 'gap: var(--sp-1); flex: 0 0 auto' }, [
            UI.el('span.label', { text: UI.plural(Model.questionCount(item), 'q') }),
            UI.el('button.btn.btn--icon.btn--danger', {
              type: 'button', text: '×', title: 'Delete this case',
              'aria-label': 'Delete ' + (item.title || 'Untitled'),
              onclick: function () {
                if (!UI.confirm('Delete "' + (item.title || 'Untitled') + '" for good?')) return;
                Store.quizzes.remove(item.id).then(function () {
                  if (isCurrent) window.location.href = 'build.html';
                  else renderQuizList();
                });
              }
            })
          ])
        ]);
      }));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);

/* =========================================================
   Store — persistence and live sync, behind one API.

   ARCHITECTURE: the host is the only authority.

   The host page holds the full quiz (questions AND answers)
   and derives a "public state" blob from it, which it pushes
   on every change. The projection, leaderboard and player
   pages are pure views of that blob — they never load the
   quiz, so a player poking at devtools cannot read the
   answers to questions that haven't been revealed yet. The
   host also does all marking and writes the points back.

   Teams and answers are stored as individual rows, not inside
   the state blob, because players write those concurrently and
   a shared blob would have them clobbering each other.

   Two drivers, same API:
     local  no backend. One machine, tabs synced over
            BroadcastChannel. Host + projector + leaderboard,
            teams scored by the host. Works with zero setup.
     cloud  Supabase. Adds player phones joining by code from
            anywhere, live answer collection and auto-marking.
   The driver is chosen by whether supabase-config.js has real
   values in it. Nothing above this file knows which is active.
   ========================================================= */
(function (window) {
  'use strict';

  var Model = window.DetectiveModel;

  var LS_QUIZZES = 'dtv:quizzes';
  var LS_SESSION = 'dtv:session:';     // + CODE
  var LS_TEAMS = 'dtv:teams:';         // + CODE
  var LS_ANSWERS = 'dtv:answers:';     // + CODE
  var LS_INDEX = 'dtv:sessionIndex';   // codes -> updatedAt, for cleanup

  /* ---------------------------------------------------------
     localStorage helpers. Every read is defensive: a corrupt
     or absent key returns the fallback rather than throwing,
     because a JSON parse error mid-show must not take the
     projector down.
     --------------------------------------------------------- */
  function lsGet(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (raw == null) return fallback;
      var val = JSON.parse(raw);
      return val == null ? fallback : val;
    } catch (e) {
      console.warn('Store: could not read ' + key, e);
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      /* Almost always the 5MB quota, hit by embedding media as
         data: URLs instead of linking it. Say so, because the
         generic DOMException tells the user nothing. */
      console.error('Store: could not write ' + key, e);
      return false;
    }
  }

  /* ---------------------------------------------------------
     Cross-tab notification for the local driver.
     BroadcastChannel is the mechanism; the localStorage
     `storage` event is the fallback for browsers without it
     and, usefully, fires for tabs that missed a broadcast.
     --------------------------------------------------------- */
  var channel = null;
  try {
    if (typeof window.BroadcastChannel === 'function') {
      channel = new window.BroadcastChannel('detective');
    }
  } catch (e) { channel = null; }

  var listeners = { state: [], teams: [], answers: [] };

  /* The join function raises bare codes so that both drivers can
     produce the same wording. A player reading "duplicate key
     value violates unique constraint" learns nothing. */
  var JOIN_ERRORS = {
    NAME_REQUIRED:  'Give your team a name.',
    NAME_TAKEN:     'That name is taken. Pick another.',
    NO_SESSION:     'No game with that code. Check the screen and try again.',
    SESSION_ENDED:  'That game has finished.',
    BAD_PASSWORD:   'That is not tonight\u2019s venue password.'
  };

  function joinError(code) {
    return new Error(JOIN_ERRORS[code] || 'Could not join. Try again.');
  }

  /* Trimmed and case-insensitive, matching the database function.
     A venue password is a word shouted across a room, not a
     secret typed carefully. */
  function samePassword(given, required) {
    var a = String(given == null ? '' : given).trim().toLowerCase();
    var b = String(required == null ? '' : required).trim().toLowerCase();
    return a === b;
  }

  function emit(kind, code, payload) {
    (listeners[kind] || []).forEach(function (l) {
      if (l.code === code) {
        try { l.cb(payload); } catch (e) { console.error('Store listener failed', e); }
      }
    });
  }

  function broadcast(kind, code) {
    if (!channel) return;
    try { channel.postMessage({ kind: kind, code: code }); } catch (e) { /* channel closed */ }
  }

  function on(kind, code, cb) {
    var entry = { code: code, cb: cb };
    listeners[kind].push(entry);
    return function off() {
      var i = listeners[kind].indexOf(entry);
      if (i !== -1) listeners[kind].splice(i, 1);
    };
  }

  /* ---------------------------------------------------------
     Driver: local
     --------------------------------------------------------- */
  var localDriver = {
    name: 'local',

    quizzes: {
      list: function () {
        var all = lsGet(LS_QUIZZES, {});
        return Promise.resolve(
          Object.keys(all).map(function (id) { return all[id]; })
            .sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); })
        );
      },
      get: function (id) {
        var all = lsGet(LS_QUIZZES, {});
        return Promise.resolve(all[id] ? Model.normaliseQuiz(all[id]) : null);
      },
      save: function (quiz) {
        var all = lsGet(LS_QUIZZES, {});
        quiz.updatedAt = new Date().toISOString();
        all[quiz.id] = quiz;
        if (!lsSet(LS_QUIZZES, all)) {
          return Promise.reject(new Error(
            'Out of browser storage. This usually means media was pasted in as a data: URL — link to hosted files instead.'
          ));
        }
        return Promise.resolve(quiz);
      },
      remove: function (id) {
        var all = lsGet(LS_QUIZZES, {});
        delete all[id];
        lsSet(LS_QUIZZES, all);
        return Promise.resolve();
      }
    },

    session: {
      create: function (session) {
        lsSet(LS_SESSION + session.code, session);   // carries venuePassword when set
        lsSet(LS_TEAMS + session.code, []);
        lsSet(LS_ANSWERS + session.code, []);
        var idx = lsGet(LS_INDEX, {});
        idx[session.code] = new Date().toISOString();
        lsSet(LS_INDEX, idx);
        broadcast('state', session.code);
        return Promise.resolve(session);
      },

      pushState: function (code, state) {
        var s = lsGet(LS_SESSION + code, null);
        if (!s) return Promise.reject(new Error('No such session: ' + code));
        s.state = state;
        s.updatedAt = new Date().toISOString();
        lsSet(LS_SESSION + code, s);
        emit('state', code, s);
        broadcast('state', code);
        return Promise.resolve(s);
      },

      read: function (code) {
        return Promise.resolve(lsGet(LS_SESSION + code, null));
      },

      watch: function (code, cb) { return on('state', code, cb); },

      /* Local mode keeps the password alongside the session in
         this browser's storage. There is no server to hide it
         from and only one machine involved, so the check is a
         convenience rather than a control — said plainly in the
         README rather than implied to be more. */
      setVenuePassword: function (code, password) {
        var s = lsGet(LS_SESSION + code, null);
        if (!s) return Promise.reject(new Error('No such session: ' + code));
        s.venuePassword = String(password == null ? '' : password).trim();
        lsSet(LS_SESSION + code, s);
        return Promise.resolve();
      },

      joinTeam: function (code, name, password) {
        var session = lsGet(LS_SESSION + code, null);
        if (!session) return Promise.reject(joinError('NO_SESSION'));
        if (session.state && session.state.phase === 'ended') {
          return Promise.reject(joinError('SESSION_ENDED'));
        }

        var required = session.venuePassword || '';
        if (required && !samePassword(password, required)) {
          return Promise.reject(joinError('BAD_PASSWORD'));
        }

        var teams = lsGet(LS_TEAMS + code, []);
        var clean = String(name || '').trim().slice(0, 40);
        if (!clean) return Promise.reject(joinError('NAME_REQUIRED'));

        /* Names are the only way the host and the room tell teams
           apart, so duplicates are refused rather than silently
           allowed with two identical rows on the leaderboard. */
        var taken = teams.some(function (t) {
          return t.name.toLowerCase() === clean.toLowerCase();
        });
        if (taken) return Promise.reject(joinError('NAME_TAKEN'));

        var team = { id: Model.uid('t'), name: clean, joinedAt: new Date().toISOString() };
        teams.push(team);
        lsSet(LS_TEAMS + code, teams);
        emit('teams', code, teams);
        broadcast('teams', code);
        return Promise.resolve(team);
      },

      removeTeam: function (code, teamId) {
        var teams = lsGet(LS_TEAMS + code, []).filter(function (t) { return t.id !== teamId; });
        lsSet(LS_TEAMS + code, teams);
        emit('teams', code, teams);
        broadcast('teams', code);
        return Promise.resolve();
      },

      teams: function (code) { return Promise.resolve(lsGet(LS_TEAMS + code, [])); },
      watchTeams: function (code, cb) { return on('teams', code, cb); },

      submitAnswer: function (code, answer) {
        var all = lsGet(LS_ANSWERS + code, []);

        /* One answer per team per question. A resubmit replaces
           the previous row — teams change their mind before the
           timer runs out, and two rows would double-score. */
        var existing = all.findIndex(function (a) {
          return a.questionId === answer.questionId && a.teamId === answer.teamId;
        });
        var row = {
          id: existing !== -1 ? all[existing].id : Model.uid('a'),
          questionId: answer.questionId,
          teamId: answer.teamId,
          value: answer.value,
          wager: answer.wager == null ? null : answer.wager,
          elapsedMs: answer.elapsedMs == null ? null : answer.elapsedMs,
          points: 0,
          correct: null,        // null = not marked yet
          submittedAt: new Date().toISOString()
        };
        if (existing !== -1) all[existing] = row; else all.push(row);

        lsSet(LS_ANSWERS + code, all);
        emit('answers', code, all);
        broadcast('answers', code);
        return Promise.resolve(row);
      },

      markAnswers: function (code, marks) {
        var all = lsGet(LS_ANSWERS + code, []);
        var byId = {};
        marks.forEach(function (m) { byId[m.id] = m; });
        all.forEach(function (a) {
          if (byId[a.id]) {
            a.points = Number(byId[a.id].points) || 0;
            a.correct = !!byId[a.id].correct;
          }
        });
        lsSet(LS_ANSWERS + code, all);
        emit('answers', code, all);
        broadcast('answers', code);
        return Promise.resolve();
      },

      answers: function (code) { return Promise.resolve(lsGet(LS_ANSWERS + code, [])); },
      watchAnswers: function (code, cb) { return on('answers', code, cb); },

      destroy: function (code) {
        [LS_SESSION, LS_TEAMS, LS_ANSWERS].forEach(function (p) {
          try { window.localStorage.removeItem(p + code); } catch (e) { /* ignore */ }
        });
        var idx = lsGet(LS_INDEX, {});
        delete idx[code];
        lsSet(LS_INDEX, idx);
        broadcast('state', code);
        return Promise.resolve();
      }
    }
  };

  /* Wire the cross-tab plumbing into the local driver's emitters.
     A broadcast carries only "this changed" — every tab re-reads
     from localStorage, so there is one source of truth and no
     chance of a stale payload overwriting a fresher one. */
  if (channel) {
    channel.onmessage = function (ev) {
      var msg = ev && ev.data;
      if (!msg || !msg.code) return;
      if (msg.kind === 'state') emit('state', msg.code, lsGet(LS_SESSION + msg.code, null));
      else if (msg.kind === 'teams') emit('teams', msg.code, lsGet(LS_TEAMS + msg.code, []));
      else if (msg.kind === 'answers') emit('answers', msg.code, lsGet(LS_ANSWERS + msg.code, []));
    };
  }

  window.addEventListener('storage', function (ev) {
    if (!ev.key) return;
    if (ev.key.indexOf(LS_SESSION) === 0) {
      var c = ev.key.slice(LS_SESSION.length);
      emit('state', c, lsGet(ev.key, null));
    } else if (ev.key.indexOf(LS_TEAMS) === 0) {
      emit('teams', ev.key.slice(LS_TEAMS.length), lsGet(ev.key, []));
    } else if (ev.key.indexOf(LS_ANSWERS) === 0) {
      emit('answers', ev.key.slice(LS_ANSWERS.length), lsGet(ev.key, []));
    }
  });

  /* Local mode has no accounts. The host gate falls back to the
     passphrase in config.js, which gate.js handles. */
  localDriver.auth = {
    supported: false,
    user: function () { return Promise.resolve(null); },
    signIn: function () {
      return Promise.reject(new Error('Log in needs the Supabase setup in README.md.'));
    },
    signOut: function () { return Promise.resolve(); }
  };

  /* ---------------------------------------------------------
     Driver: cloud (Supabase)
     --------------------------------------------------------- */
  function makeCloudDriver(db) {
    function rowToQuiz(row) {
      var q = Model.normaliseQuiz(row.data || {});
      q.id = row.id;
      q.title = row.title || q.title;
      q.updatedAt = row.updated_at || q.updatedAt;
      return q;
    }

    function rowToTeam(row) {
      return { id: row.id, name: row.name, joinedAt: row.joined_at };
    }

    function rowToAnswer(row) {
      return {
        id: row.id,
        questionId: row.question_id,
        teamId: row.team_id,
        value: row.value,
        wager: row.wager,
        elapsedMs: row.elapsed_ms,
        points: row.points || 0,
        correct: row.correct,
        submittedAt: row.submitted_at
      };
    }

    /* Supabase realtime can drop a message on a flaky venue wifi,
       and a projection screen stuck on question 3 while the room
       is on question 8 is the worst thing this app could do. So
       every watcher also polls as a floor. Cheap: one small row. */
    function watchTable(table, filter, onChange, pollFn) {
      var chan = db.channel(table + ':' + filter.value + ':' + Math.random().toString(36).slice(2, 8))
        .on('postgres_changes',
          { event: '*', schema: 'public', table: table, filter: filter.column + '=eq.' + filter.value },
          function () { pollFn().then(onChange).catch(function () { /* transient */ }); })
        .subscribe();

      var poll = window.setInterval(function () {
        pollFn().then(onChange).catch(function () { /* transient */ });
      }, 4000);

      return function off() {
        window.clearInterval(poll);
        try { db.removeChannel(chan); } catch (e) { /* already gone */ }
      };
    }

    return {
      name: 'cloud',

      auth: {
        supported: true,

        /* Resolves to the signed-in user or null. Supabase
           restores a session from storage asynchronously, so this
           is the only safe way to ask "am I logged in" on load. */
        user: function () {
          return db.auth.getSession().then(function (res) {
            return (res && res.data && res.data.session && res.data.session.user) || null;
          }).catch(function () { return null; });
        },

        signIn: function (email, password) {
          return db.auth.signInWithPassword({ email: email, password: password })
            .then(function (res) {
              if (res.error) {
                /* Supabase says "Invalid login credentials" for a
                   wrong password AND for an address with no
                   account. Passing that through is honest and
                   gives nothing away. */
                throw new Error(res.error.message || 'Could not sign in.');
              }
              return res.data.user;
            });
        },

        signOut: function () {
          return db.auth.signOut().then(function () { return null; });
        }
      },

      quizzes: {
        list: function () {
          return db.from('quiz_quizzes').select('id,title,updated_at,data')
            .order('updated_at', { ascending: false })
            .then(function (res) {
              if (res.error) throw res.error;
              return (res.data || []).map(rowToQuiz);
            });
        },
        get: function (id) {
          return db.from('quiz_quizzes').select('id,title,updated_at,data').eq('id', id).maybeSingle()
            .then(function (res) {
              if (res.error) throw res.error;
              return res.data ? rowToQuiz(res.data) : null;
            });
        },
        save: function (quiz) {
          quiz.updatedAt = new Date().toISOString();
          return db.from('quiz_quizzes').upsert({
            id: quiz.id,
            title: quiz.title,
            data: quiz,
            updated_at: quiz.updatedAt
          }).then(function (res) {
            if (res.error) throw res.error;
            return quiz;
          });
        },
        remove: function (id) {
          return db.from('quiz_quizzes').delete().eq('id', id).then(function (res) {
            if (res.error) throw res.error;
          });
        }
      },

      session: {
        create: function (session) {
          return db.from('quiz_sessions').insert({
            code: session.code,
            quiz_id: session.quizId,
            quiz_title: session.quizTitle,
            state: session.state
          }).then(function (res) {
            if (res.error) throw res.error;
            return session;
          });
        },

        pushState: function (code, state) {
          return db.from('quiz_sessions')
            .update({ state: state, updated_at: new Date().toISOString() })
            .eq('code', code)
            .then(function (res) {
              if (res.error) throw res.error;
              return { code: code, state: state };
            });
        },

        read: function (code) {
          return db.from('quiz_sessions').select('code,quiz_id,quiz_title,state,updated_at')
            .eq('code', code).maybeSingle()
            .then(function (res) {
              if (res.error) throw res.error;
              if (!res.data) return null;
              return {
                code: res.data.code,
                quizId: res.data.quiz_id,
                quizTitle: res.data.quiz_title,
                state: res.data.state,
                updatedAt: res.data.updated_at
              };
            });
        },

        watch: function (code, cb) {
          var self = this;
          return watchTable('quiz_sessions', { column: 'code', value: code }, cb,
            function () { return self.read(code); });
        },

        /* Written through a database function, not a table write.
           The keys table has no policies at all, so nothing can
           read a venue password back — and an upsert against an
           unreadable table cannot work anyway, because ON CONFLICT
           DO UPDATE has to read the row it conflicts with. */
        setVenuePassword: function (code, password) {
          return db.rpc('quiz_set_venue_password', {
            p_code: String(code || '').trim().toUpperCase(),
            p_password: String(password == null ? '' : password)
          }).then(function (res) {
            if (res.error) {
              if (String(res.error.message || '').indexOf('NOT_SIGNED_IN') !== -1) {
                throw new Error('Sign in before setting a venue password.');
              }
              throw res.error;
            }
          });
        },

        /* Joining goes through the database function rather than a
           direct insert: that is what makes the venue password
           enforceable. Players have no insert policy on
           quiz_teams, so there is no way around it. */
        joinTeam: function (code, name, password) {
          return db.rpc('quiz_join_team', {
            p_code: String(code || '').trim().toUpperCase(),
            p_name: String(name || ''),
            p_password: String(password == null ? '' : password)
          }).then(function (res) {
            if (res.error) {
              /* The function raises bare codes; anything else is a
                 real fault worth surfacing as-is. */
              var msg = String((res.error && res.error.message) || '');
              var known = Object.keys(JOIN_ERRORS).filter(function (k) {
                return msg.indexOf(k) !== -1;
              })[0];
              if (known) throw joinError(known);
              throw res.error;
            }
            if (!res.data) throw joinError('NO_SESSION');
            return rowToTeam(res.data);
          });
        },

        removeTeam: function (code, teamId) {
          return db.from('quiz_teams').delete().eq('session_code', code).eq('id', teamId)
            .then(function (res) { if (res.error) throw res.error; });
        },

        teams: function (code) {
          return db.from('quiz_teams').select('id,name,joined_at')
            .eq('session_code', code).order('joined_at', { ascending: true })
            .then(function (res) {
              if (res.error) throw res.error;
              return (res.data || []).map(rowToTeam);
            });
        },

        watchTeams: function (code, cb) {
          var self = this;
          return watchTable('quiz_teams', { column: 'session_code', value: code }, cb,
            function () { return self.teams(code); });
        },

        submitAnswer: function (code, answer) {
          return db.from('quiz_answers').upsert({
            session_code: code,
            question_id: answer.questionId,
            team_id: answer.teamId,
            value: answer.value,
            wager: answer.wager == null ? null : answer.wager,
            elapsed_ms: answer.elapsedMs == null ? null : answer.elapsedMs,
            submitted_at: new Date().toISOString()
          }, { onConflict: 'session_code,question_id,team_id' })
            .select('id,question_id,team_id,value,wager,elapsed_ms,points,correct,submitted_at')
            .single()
            .then(function (res) {
              if (res.error) throw res.error;
              return rowToAnswer(res.data);
            });
        },

        markAnswers: function (code, marks) {
          if (!marks.length) return Promise.resolve();
          /* One request per row. Fine at gameshow scale (tens of
             teams) and it keeps the update policy simple; a bulk
             upsert would have to resend value/wager and risk
             overwriting a team's answer with a stale copy. */
          return Promise.all(marks.map(function (m) {
            return db.from('quiz_answers')
              .update({ points: Number(m.points) || 0, correct: !!m.correct })
              .eq('id', m.id);
          })).then(function (results) {
            var bad = results.filter(function (r) { return r && r.error; });
            if (bad.length) throw bad[0].error;
          });
        },

        answers: function (code) {
          return db.from('quiz_answers')
            .select('id,question_id,team_id,value,wager,elapsed_ms,points,correct,submitted_at')
            .eq('session_code', code)
            .then(function (res) {
              if (res.error) throw res.error;
              return (res.data || []).map(rowToAnswer);
            });
        },

        watchAnswers: function (code, cb) {
          var self = this;
          return watchTable('quiz_answers', { column: 'session_code', value: code }, cb,
            function () { return self.answers(code); });
        },

        destroy: function (code) {
          /* Teams and answers cascade from the session row. */
          return db.from('quiz_sessions').delete().eq('code', code)
            .then(function (res) { if (res.error) throw res.error; });
        }
      }
    };
  }

  /* ---------------------------------------------------------
     Driver selection
     --------------------------------------------------------- */
  function pickDriver() {
    var cfg = window.DETECTIVE_CONFIG || {};
    var lib = window.supabase;
    var url = cfg.supabaseUrl || '';
    var key = cfg.supabaseAnonKey || '';
    var configured = url && key &&
      url.indexOf('YOUR-PROJECT-REF') === -1 &&
      url.indexOf('http') === 0;

    if (!configured) return localDriver;

    if (!lib || typeof lib.createClient !== 'function') {
      console.warn('Detective: Supabase is configured but supabase-js did not load. ' +
        'Falling back to local mode — player devices will not be able to join.');
      return localDriver;
    }

    try {
      return makeCloudDriver(lib.createClient(url, key, {
        realtime: { params: { eventsPerSecond: 10 } }
      }));
    } catch (e) {
      console.error('Detective: could not start the Supabase client, falling back to local mode.', e);
      return localDriver;
    }
  }

  var driver = pickDriver();

  var Store = {
    mode: driver.name,
    isCloud: driver.name === 'cloud',
    quizzes: driver.quizzes,
    session: driver.session,
    auth: driver.auth,

    /* Exported for the builder's import/export and for tests. */
    _localDriver: localDriver
  };

  window.DetectiveStore = Store;
})(window);

/* =========================================================
   Gate — keeps the control room and the case files private.

   Two modes, picked automatically:

   LOGIN (cloud mode with requireLogin set)
     A real Supabase email/password login. This is the one that
     actually protects anything: the row-level security policies
     in supabase/schema.sql refuse to serve the quizzes table to
     anyone who is not authenticated, so without a login the
     questions and answers are not merely hidden, they are not
     sent.

   PASSPHRASE (local mode, or cloud without requireLogin)
     A shared word held in config.js. Its job is to stop the
     control room appearing on a projector and to turn away
     someone who guesses the URL. It is NOT security — the file
     is downloaded by every browser that loads the site — and
     the form says so rather than implying otherwise.

   Either way this module renders its own full-screen form, so
   a page only has to call DetectiveGate.require() and wait.
   ========================================================= */
(function (window) {
  'use strict';

  var UI = window.DetectiveUI;
  var Store = window.DetectiveStore;
  var cfg = window.DETECTIVE_CONFIG || {};

  var PASS_KEY = 'dtv:host-ok';

  var Gate = {};

  /* Which gate applies. Exposed because the builder wants to
     tell the user why it is asking. */
  Gate.mode = function () {
    if (Store.isCloud && cfg.requireLogin && Store.auth && Store.auth.supported) return 'login';
    if (cfg.hostPassphrase) return 'passphrase';
    return 'open';
  };

  /* ---------------------------------------------------------
     require(app)
     ---------------------------------------------------------
     `app` is the element to reveal once the gate is passed; it
     should start hidden in the HTML so the protected page never
     flashes up before the gate. Resolves with the signed-in
     user, or null when the gate was a passphrase.
     --------------------------------------------------------- */
  Gate.require = function (app) {
    var mode = Gate.mode();

    if (mode === 'open') {
      reveal(app);
      return Promise.resolve(null);
    }

    if (mode === 'login') {
      /* Already signed in from a previous visit? Supabase restores
         the session asynchronously, so this has to be awaited
         rather than checked synchronously. */
      return Store.auth.user().then(function (user) {
        if (user) {
          reveal(app);
          return user;
        }
        return askLogin(app);
      });
    }

    try {
      if (window.sessionStorage.getItem(PASS_KEY) === '1') {
        reveal(app);
        return Promise.resolve(null);
      }
    } catch (e) { /* private browsing — ask again */ }

    return askPassphrase(app);
  };

  Gate.signOut = function () {
    try { window.sessionStorage.removeItem(PASS_KEY); } catch (e) { /* ignore */ }
    if (Store.auth && Store.auth.supported) {
      return Store.auth.signOut().then(function () { window.location.reload(); });
    }
    window.location.reload();
    return Promise.resolve();
  };

  /* ---------------------------------------------------------
     Rendering
     --------------------------------------------------------- */
  function reveal(app) {
    var existing = UI.$('#gate-screen');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (app) app.classList.remove('is-hidden');
  }

  function screen(children) {
    var wrap = UI.el('section.hero', { id: 'gate-screen' }, [
      UI.el('div.hero__inner', {}, [
        UI.el('span.brand__mark', {
          'aria-hidden': 'true',
          style: 'margin: 0 auto var(--sp-5); width: 3rem; height: 3rem;'
        })
      ].concat(children))
    ]);
    document.body.appendChild(wrap);
    return wrap;
  }

  function askPassphrase(app) {
    return new Promise(function (resolve) {
      var input = UI.el('input.input.input--mono', {
        id: 'gate-pass', type: 'password', autocomplete: 'current-password',
        'aria-label': 'Passphrase'
      });
      var error = UI.el('p.field__error.is-hidden', { role: 'alert' });

      var form = UI.el('form.stack', {}, [
        UI.el('div.field', {}, [
          UI.el('label.label', { for: 'gate-pass', text: 'Passphrase' }),
          input
        ]),
        error,
        UI.el('button.btn.btn--primary.btn--lg.btn--block', { type: 'submit', text: 'Continue' })
      ]);

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (input.value === cfg.hostPassphrase) {
          try { window.sessionStorage.setItem(PASS_KEY, '1'); } catch (e) { /* ignore */ }
          reveal(app);
          resolve(null);
          return;
        }
        error.textContent = 'Not that one.';
        error.classList.remove('is-hidden');
        input.value = '';
        input.focus();
      });

      screen([
        UI.el('h1.hero__title', { style: 'font-size: clamp(1.75rem, 5vw, 3rem)', text: 'Host only' }),
        UI.el('p.hero__sub', { text: 'The control room and the case files live behind here.' }),
        form,
        UI.el('p.field__hint', {
          style: 'margin-top: var(--sp-5)',
          text: 'This keeps the control room off the projector and turns away anyone who ' +
                'guesses the address. It is not real security — the passphrase sits in a ' +
                'file your browser downloads. See README.md to set up a proper login.'
        })
      ]);

      input.focus();
    });
  }

  function askLogin(app) {
    return new Promise(function (resolve) {
      var email = UI.el('input.input', {
        id: 'gate-email', type: 'email', autocomplete: 'username',
        placeholder: 'you@example.com', 'aria-label': 'Email'
      });
      var pass = UI.el('input.input', {
        id: 'gate-password', type: 'password', autocomplete: 'current-password',
        'aria-label': 'Password'
      });
      var error = UI.el('p.field__error.is-hidden', { role: 'alert' });
      var submit = UI.el('button.btn.btn--primary.btn--lg.btn--block', { type: 'submit', text: 'Sign in' });

      var form = UI.el('form.stack', {}, [
        UI.el('div.field', {}, [
          UI.el('label.label', { for: 'gate-email', text: 'Email' }), email
        ]),
        UI.el('div.field', {}, [
          UI.el('label.label', { for: 'gate-password', text: 'Password' }), pass
        ]),
        error,
        submit
      ]);

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        error.classList.add('is-hidden');
        submit.disabled = true;
        submit.textContent = 'Signing in…';

        Store.auth.signIn(email.value.trim(), pass.value)
          .then(function (user) {
            reveal(app);
            resolve(user);
          })
          .catch(function (err) {
            error.textContent = err.message || 'Could not sign in.';
            error.classList.remove('is-hidden');
            submit.disabled = false;
            submit.textContent = 'Sign in';
            pass.value = '';
            pass.focus();
          });
      });

      screen([
        UI.el('h1.hero__title', { style: 'font-size: clamp(1.75rem, 5vw, 3rem)', text: 'Sign in' }),
        UI.el('p.hero__sub', { text: 'Your case files are only sent to a signed-in host.' }),
        form,
        UI.el('p.field__hint', {
          style: 'margin-top: var(--sp-5)',
          text: 'Accounts are created in the Supabase dashboard under Authentication > Users. ' +
                'There is no sign-up form here on purpose.'
        })
      ]);

      email.focus();
    });
  }

  window.DetectiveGate = Gate;
})(window);

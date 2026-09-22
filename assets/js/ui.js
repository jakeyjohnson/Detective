/* =========================================================
   Shared UI helpers. Small, dependency-free, used by every
   page. Nothing here knows about quizzes — it is all DOM and
   formatting plumbing.
   ========================================================= */
(function (window) {
  'use strict';

  var UI = {};
  var doc = window.document;

  /* ---------------------------------------------------------
     DOM
     --------------------------------------------------------- */
  UI.$ = function (sel, root) { return (root || doc).querySelector(sel); };
  UI.$$ = function (sel, root) {
    return Array.prototype.slice.call((root || doc).querySelectorAll(sel));
  };

  /* el('div.panel', {…attrs}, [children|string]) */
  UI.el = function (spec, attrs, children) {
    var parts = String(spec).split('.');
    var tag = parts.shift() || 'div';
    var node = doc.createElement(tag);
    if (parts.length) node.className = parts.join(' ');

    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = node.className ? node.className + ' ' + v : v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
      else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open' || k === 'multiple') node[k] = !!v;
      else node.setAttribute(k, v);
    });

    [].concat(children == null ? [] : children).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
    });

    return node;
  };

  UI.clear = function (node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  };

  UI.replace = function (node, children) {
    UI.clear(node);
    [].concat(children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    });
    return node;
  };

  /* ---------------------------------------------------------
     Query string
     --------------------------------------------------------- */
  UI.param = function (name, fallback) {
    try {
      var v = new URL(window.location.href).searchParams.get(name);
      return v == null || v === '' ? (fallback == null ? null : fallback) : v;
    } catch (e) {
      return fallback == null ? null : fallback;
    }
  };

  /* ---------------------------------------------------------
     Formatting
     --------------------------------------------------------- */
  UI.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  UI.clock = function (seconds) {
    var s = Math.max(0, Math.ceil(Number(seconds) || 0));
    var m = Math.floor(s / 60);
    return m > 0 ? m + ':' + UI.pad2(s % 60) : String(s);
  };

  UI.plural = function (n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  };

  UI.signed = function (n) { return (n > 0 ? '+' : '') + n; };

  /* ---------------------------------------------------------
     Toasts
     --------------------------------------------------------- */
  var toastHost = null;
  UI.toast = function (message, variant) {
    if (!toastHost) {
      toastHost = UI.el('div.toast-host', { 'aria-live': 'polite' });
      doc.body.appendChild(toastHost);
    }
    var t = UI.el('div.toast' + (variant === 'error' ? '.toast--wrong' : ''), { text: message });
    toastHost.appendChild(t);
    window.setTimeout(function () {
      t.style.opacity = '0';
      window.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
    }, variant === 'error' ? 5000 : 2600);
  };

  /* ---------------------------------------------------------
     Confirm. Uses the native dialog deliberately: a custom
     modal here would be one more thing to get wrong on stage,
     and the destructive actions it guards are rare.
     --------------------------------------------------------- */
  UI.confirm = function (message) {
    return window.confirm(message);
  };

  /* ---------------------------------------------------------
     Debounce — used for autosave in the builder so typing a
     question isn't 60 writes to storage.
     --------------------------------------------------------- */
  UI.debounce = function (fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { fn.apply(self, args); }, wait || 400);
    };
  };

  /* ---------------------------------------------------------
     Media kind sniffing.
     Extension first (reliable and cheap), then known embed
     hosts. YouTube and similar are reported as 'embed' so the
     builder can tell the user plainly that they need a direct
     file URL — an <iframe> cannot be frame-accurately cued or
     stopped by the host, which is the whole point of putting a
     clip in a gameshow.
     --------------------------------------------------------- */
  var EXT = {
    mp4: 'video', webm: 'video', ogv: 'video', mov: 'video', m4v: 'video',
    mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', oga: 'audio',
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image'
  };
  var EMBED_HOSTS = /(?:youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|soundcloud\.com|spotify\.com)/i;

  UI.mediaKind = function (url) {
    var u = String(url || '').trim();
    if (!u) return 'none';
    if (EMBED_HOSTS.test(u)) return 'embed';
    var m = u.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
    if (m && EXT[m[1].toLowerCase()]) return EXT[m[1].toLowerCase()];
    if (u.indexOf('data:video') === 0) return 'video';
    if (u.indexOf('data:audio') === 0) return 'audio';
    if (u.indexOf('data:image') === 0) return 'image';
    return 'unknown';
  };

  /* Option letters. A, B, C… for choice questions everywhere,
     so the host can say "the answer is C" and every screen
     agrees. */
  UI.optionLetter = function (i) {
    return String.fromCharCode(65 + (i % 26));
  };

  /* ---------------------------------------------------------
     Download a generated file (quiz export, results sheet).
     --------------------------------------------------------- */
  UI.download = function (filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = UI.el('a', { href: url, download: filename });
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  UI.readFile = function (file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('Could not read that file.')); };
      r.readAsText(file);
    });
  };

  /* ---------------------------------------------------------
     Copy to clipboard, with a fallback for pages not served
     over HTTPS (the clipboard API is secure-context only, and
     a venue laptop on http://localhost is a normal case).
     --------------------------------------------------------- */
  UI.copy = function (text) {
    if (window.navigator.clipboard && window.isSecureContext) {
      return window.navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = UI.el('textarea', { value: text, 'aria-hidden': 'true' });
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      doc.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
      doc.body.removeChild(ta);
      ok ? resolve() : reject(new Error('Copy failed — select the text and copy it by hand.'));
    });
  };

  /* ---------------------------------------------------------
     Keyboard shortcuts. Ignores keystrokes aimed at a field,
     so typing "n" into a question doesn't advance the show.
     --------------------------------------------------------- */
  UI.shortcuts = function (map) {
    doc.addEventListener('keydown', function (ev) {
      var t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

      var key = ev.key === ' ' ? 'Space' : ev.key;
      var fn = map[key] || map[key.toLowerCase()];
      if (fn) {
        ev.preventDefault();
        fn(ev);
      }
    });
  };

  /* ---------------------------------------------------------
     Fullscreen, for the projection screen.
     --------------------------------------------------------- */
  UI.fullscreen = {
    enter: function (node) {
      var el = node || doc.documentElement;
      var fn = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fn) { try { fn.call(el); } catch (e) { /* user gesture required */ } }
    },
    exit: function () {
      var fn = doc.exitFullscreen || doc.webkitExitFullscreen;
      if (fn && (doc.fullscreenElement || doc.webkitFullscreenElement)) {
        try { fn.call(doc); } catch (e) { /* ignore */ }
      }
    },
    toggle: function (node) {
      if (doc.fullscreenElement || doc.webkitFullscreenElement) UI.fullscreen.exit();
      else UI.fullscreen.enter(node);
    }
  };

  /* ---------------------------------------------------------
     Session-scoped identity for the player device, so a phone
     that locks and reopens is still the same team rather than
     joining twice under a new name.
     --------------------------------------------------------- */
  UI.identity = {
    key: function (code) { return 'dtv:me:' + code; },
    get: function (code) {
      try { return JSON.parse(window.localStorage.getItem(UI.identity.key(code)) || 'null'); }
      catch (e) { return null; }
    },
    set: function (code, team) {
      try { window.localStorage.setItem(UI.identity.key(code), JSON.stringify(team)); }
      catch (e) { /* private browsing — the player just re-joins */ }
    },
    clear: function (code) {
      try { window.localStorage.removeItem(UI.identity.key(code)); } catch (e) { /* ignore */ }
    }
  };

  window.DetectiveUI = UI;
})(window);

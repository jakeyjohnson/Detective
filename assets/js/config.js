/* =========================================================
   Configuration — Play Detective.

   The app runs with this file completely untouched — it just
   runs in LOCAL mode: one machine, the host window driving a
   projector window, teams scored by the host. Everything in
   the show works. What you don't get is player phones.

   Fill in the two Supabase values below to switch on CLOUD
   mode, which adds players joining by code from their own
   devices, live answer collection and automatic marking. See
   README.md and supabase/schema.sql.
   ========================================================= */
window.DETECTIVE_CONFIG = {

  /* --- Show identity, shown on the projection and the join page --- */
  showName: 'Play Detective',
  showTagline: 'An Interactive Show',

  /* Drop the real logo in here and the join page and the lobby
     screen use it in place of the built-in fingerprint mark.
     Put the file in assets/img/ and point at it, e.g.
     'assets/img/logo.png'. A transparent PNG or an SVG is best —
     it sits on the near-black ground, so a logo with a white box
     baked into it will show that box. Leave empty to use the
     fingerprint. */
  logoUrl: '',

  /* --- Supabase (optional) ---
     Project Settings > API in the Supabase dashboard. The anon
     key is designed to be public — it ships to every browser
     that loads this site, and access control is the row-level
     security policies in supabase/schema.sql, not secrecy of
     this key. Never put the service_role key here: it bypasses
     RLS entirely and must not reach a browser. */
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-KEY',

  /* --- Host gate ---
     Keeps the control room off the projector and out of the
     hands of a curious player who guesses the URL. In local
     mode this is all there is, and it is a speed bump, not
     security: the passphrase is in a file anyone can read.
     In cloud mode, set requireLogin below instead and the gate
     becomes a real Supabase email login. */
  hostPassphrase: 'lestrade',
  requireLogin: false,

  /* --- Join URL shown on the projection screen ---
     Leave empty and the projection works it out from the
     address it was opened on. Set it to something short and
     typable ('quiz.myshow.co.uk') when the real URL is long,
     since the room has to type this off a screen. */
  joinUrl: '',

  /* --- Defaults for new questions --- */
  defaultPoints: 10,
  defaultTimeLimit: 30
};

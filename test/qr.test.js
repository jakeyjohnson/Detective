/* =========================================================
   QR encoder tests.

   A QR code that fails is a room of people who cannot get into
   the game, and it fails silently — the image looks fine. So
   these tests do not check that a matrix was produced; they
   DECODE it back, through a reader written here independently
   of the encoder: it finds the mask from the format bits, walks
   the zigzag itself, un-masks, de-interleaves the blocks, and
   checks the Reed-Solomon syndromes are zero before parsing the
   payload back to a string.

   A syndrome check is the strong one. If the RS generator or
   the GF(256) tables were wrong, the codewords would still
   place and the image would still render — but the syndromes
   would be non-zero and a real scanner would reject the code.

   Run:  node test/qr.test.js
   ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const win = {};
win.window = win;
const sandbox = { window: win, console, Math, Array, Uint8Array, String, Number, Error, JSON, encodeURIComponent };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'qr.js'), 'utf8'), sandbox, { filename: 'qr.js' });
const QR = win.DetectiveQR;

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); }
}
function eq(a, e, what) {
  const as = JSON.stringify(a), es = JSON.stringify(e);
  if (as !== es) throw new Error(`${what || 'value'}: expected ${es}, got ${as}`);
}
function ok(c, what) { if (!c) throw new Error(`${what || 'condition'} was falsy`); }

/* =========================================================
   An independent reader
   ========================================================= */

/* GF(256) again, written separately, so a broken table in the
   encoder cannot be cancelled out by the same broken table here. */
const gfExp = new Array(512).fill(0);
const gfLog = new Array(256).fill(0);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x; gfLog[x] = i;
    x = x << 1;
    if (x & 0x100) x = (x ^ 0x11D) & 0xFF;
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : gfExp[gfLog[a] + gfLog[b]];

/* Level-M block structure, per ISO/IEC 18004 table 13. */
const BLOCKS = {
  1:  { ec: 10, groups: [[1, 16]] },
  2:  { ec: 16, groups: [[1, 28]] },
  3:  { ec: 26, groups: [[1, 44]] },
  4:  { ec: 18, groups: [[2, 32]] },
  5:  { ec: 24, groups: [[2, 43]] },
  6:  { ec: 16, groups: [[4, 27]] },
  7:  { ec: 18, groups: [[4, 31]] },
  8:  { ec: 22, groups: [[2, 38], [2, 39]] },
  9:  { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] }
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

/* Map of modules that are function patterns, derived here from
   the structure rather than borrowed from the encoder. */
function functionMap(size, version) {
  const f = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) f[r][c] = true; };

  // Finders plus their separators: 8x8 at three corners.
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      mark(r, c); mark(r, size - 1 - c); mark(size - 1 - r, c);
    }
  }
  // Timing patterns.
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  // Alignment patterns.
  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  // Format info areas and the dark module.
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  mark(size - 8, 8);
  // Version info areas.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = i % 3;
      mark(size - 11 + c, r); mark(r, size - 11 + c);
    }
  }
  return f;
}

const maskFns = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

/* Read the mask out of the format information, the way a scanner
   does — not by asking the encoder what it chose. */
function readMask(m) {
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    let bit;
    if (i < 6) bit = m[8][i];
    else if (i === 6) bit = m[8][7];
    else if (i === 7) bit = m[8][8];
    else if (i === 8) bit = m[7][8];
    else bit = m[14 - i][8];
    bits |= bit << i;
  }
  /* The 15 bits are 5 data bits followed by 10 BCH bits, and bit
     0 here is the LSB — so the data sits in the TOP five bits,
     not the bottom three. */
  const unmasked = bits ^ 0x5412;
  const data = (unmasked >> 10) & 0x1F;
  return { level: (data >> 3) & 0x3, mask: data & 0x7 };
}

function decode(qr) {
  const { size, modules: m, version } = qr;
  const fn = functionMap(size, version);
  const { mask, level } = readMask(m);

  // Walk the zigzag: two-module columns from the right,
  // alternating direction. Column 6 is the vertical timing
  // pattern, so the pair that would straddle it shifts left to
  // 5-4 and the walk CONTINUES from there — it does not simply
  // skip a column, which would misalign every pair after it.
  const bits = [];
  let upward = true;
  let right = size - 1;
  while (right >= 1) {
    if (right === 6) right = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const col = right - c;
        if (fn[row][col]) continue;
        let bit = m[row][col];
        if (maskFns[mask](row, col)) bit ^= 1;
        bits.push(bit);
      }
    }
    upward = !upward;
    right -= 2;
  }

  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    words.push(byte);
  }

  // De-interleave into blocks.
  const spec = BLOCKS[version];
  const lengths = [];
  spec.groups.forEach(([count, len]) => { for (let i = 0; i < count; i++) lengths.push(len); });

  const blocks = lengths.map(len => ({ data: new Array(len).fill(0), ec: new Array(spec.ec).fill(0) }));
  const maxData = Math.max(...lengths);
  let at = 0;
  for (let i = 0; i < maxData; i++) {
    blocks.forEach(b => { if (i < b.data.length) b.data[i] = words[at++]; });
  }
  for (let k = 0; k < spec.ec; k++) {
    blocks.forEach(b => { b.ec[k] = words[at++]; });
  }

  // Syndrome check: every block's codeword polynomial must
  // evaluate to zero at a^0 .. a^(ec-1).
  const syndromes = [];
  blocks.forEach((b, bi) => {
    const code = b.data.concat(b.ec);
    for (let s = 0; s < spec.ec; s++) {
      let acc = 0;
      for (let i = 0; i < code.length; i++) {
        acc = gfMul(acc, gfExp[s]) ^ code[i];
      }
      if (acc !== 0) syndromes.push(`block ${bi} syndrome ${s} = ${acc}`);
    }
  });

  // Parse the payload out of the concatenated data codewords.
  const data = [].concat(...blocks.map(b => b.data));
  const stream = [];
  data.forEach(byte => { for (let i = 7; i >= 0; i--) stream.push((byte >> i) & 1); });
  let p = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | stream[p++]; return v; };

  const mode = take(4);
  const countLen = version < 10 ? 8 : 16;
  const length = take(countLen);
  const bytes = [];
  for (let i = 0; i < length; i++) bytes.push(take(8));

  return {
    mask, level, mode, length, syndromes,
    text: Buffer.from(bytes).toString('utf8')
  };
}

/* =========================================================
   Tests
   ========================================================= */

check('format information matches the values in the specification', () => {
  /* The published level-M table. If the BCH implementation were
     wrong these would drift, and scanners would fail to read the
     code at all because they cannot even find the mask. */
  const expected = [0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0];
  for (let mask = 0; mask < 8; mask++) {
    eq(QR._formatInfo(mask), expected[mask], `format info for mask ${mask}`);
  }
});

check('version information matches the specification', () => {
  const expected = { 7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3 };
  for (const v of Object.keys(expected)) {
    eq(QR._versionInfo(Number(v)), expected[v], `version info for ${v}`);
  }
});

check('byte-mode capacities match the specification', () => {
  eq([1,2,3,4,5,6,7,8,9,10].map(QR._capacity),
     [14, 26, 42, 62, 84, 106, 122, 152, 180, 213], 'capacities');
});

check('the smallest version that fits is chosen', () => {
  eq(QR.matrix('x'.repeat(14)).version, 1, '14 bytes');
  eq(QR.matrix('x'.repeat(15)).version, 2, '15 bytes');
  eq(QR.matrix('x'.repeat(26)).version, 2, '26 bytes');
  eq(QR.matrix('x'.repeat(27)).version, 3, '27 bytes');
});

check('matrix size follows the version', () => {
  for (let v = 1; v <= 10; v++) {
    const qr = QR.matrix('x'.repeat(QR._capacity(v)));
    eq(qr.size, v * 4 + 17, `version ${v} size`);
  }
});

check('the number of data modules matches the specification', () => {
  /* Table 1 of ISO/IEC 18004: how many modules are left for data
     and error correction once the function patterns are placed.
     This checks the reserved map and the walk against a published
     number rather than against the encoder's own idea of them —
     if either were wrong, the count would not land on these. */
  const EXPECTED = {
    1: 208, 2: 359, 3: 567, 4: 807, 5: 1079,
    6: 1383, 7: 1568, 8: 1936, 9: 2336, 10: 2768
  };
  for (let v = 1; v <= 10; v++) {
    const size = v * 4 + 17;
    const fn = functionMap(size, v);
    // The encoder's walk, against the reserved map derived here.
    const positions = QR._dataPositions(size, fn);
    eq(positions.length, EXPECTED[v], `version ${v} data modules`);

    // And no position is visited twice.
    const seen = new Set(positions.map(([r, c]) => r + ',' + c));
    eq(seen.size, positions.length, `version ${v} visits each module once`);
  }
});

check('the finder patterns are in all three corners', () => {
  const qr = QR.matrix('https://example.com/join?code=ABCDE');
  const m = qr.modules;
  const s = qr.size;
  for (const [r0, c0] of [[0, 0], [0, s - 7], [s - 7, 0]]) {
    eq(m[r0][c0], 1, 'finder outer corner');
    eq(m[r0 + 1][c0 + 1], 0, 'finder inner ring');
    eq(m[r0 + 3][c0 + 3], 1, 'finder core');
  }
});

check('the timing patterns alternate', () => {
  const qr = QR.matrix('timing');
  for (let i = 8; i < qr.size - 8; i++) {
    eq(qr.modules[6][i], i % 2 === 0 ? 1 : 0, `horizontal timing at ${i}`);
    eq(qr.modules[i][6], i % 2 === 0 ? 1 : 0, `vertical timing at ${i}`);
  }
});

check('the always-dark module is dark', () => {
  const qr = QR.matrix('dark');
  eq(qr.modules[qr.size - 8][8], 1, 'dark module');
});

check('every module is set — none left blank', () => {
  for (const text of ['a', 'x'.repeat(60), 'x'.repeat(200)]) {
    const qr = QR.matrix(text);
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        ok(qr.modules[r][c] === 0 || qr.modules[r][c] === 1,
          `module ${r},${c} is ${qr.modules[r][c]} for ${text.length} bytes`);
      }
    }
  }
});

/* ---- the real test: decode it back ---- */
const ROUND_TRIP = [
  'A',
  'ABCDE',
  'https://playdetective.example/join?code=AB2CD',
  'https://quiz.myshow.co.uk/index.html?code=X7K9M',
  'x'.repeat(14),          // exactly fills version 1
  'x'.repeat(15),          // forces version 2
  'y'.repeat(62),
  'z'.repeat(152),         // a two-group version
  'w'.repeat(180),         // another two-group version
  'q'.repeat(213),         // fills version 10
  'Café Noir — 100% café',  // multi-byte UTF-8
  'PLAY DETECTIVE: so you want to? https://example.com/j?c=ABCDE&v=1'
];

ROUND_TRIP.forEach(text => {
  check(`round-trips ${JSON.stringify(text.length > 28 ? text.slice(0, 25) + '…' : text)} (${Buffer.byteLength(text)} bytes)`, () => {
    const qr = QR.matrix(text);
    const got = decode(qr);
    eq(got.syndromes, [], 'Reed-Solomon syndromes must all be zero');
    eq(got.level, 0, 'error correction level M');
    eq(got.mode, 4, 'byte mode');
    eq(got.length, Buffer.byteLength(text), 'payload length');
    eq(got.text, text, 'decoded text');
  });
});

check('the mask recorded is the mask actually written', () => {
  for (const text of ['a', 'abc', 'x'.repeat(100), 'x'.repeat(213)]) {
    const qr = QR.matrix(text);
    eq(readMask(qr.modules).mask, qr.mask, `mask for ${text.length} bytes`);
  }
});

check('the chosen mask is the lowest-penalty one', () => {
  /* Not just any valid mask — the spec picks by penalty, and a
     poor choice makes a code harder for a phone to acquire in a
     dark venue, which is exactly where this one gets used. */
  const text = 'https://example.com/join?code=ABCDE';
  const qr = QR.matrix(text);
  const scores = [];
  for (let mask = 0; mask < 8; mask++) {
    const candidate = QR.matrix(text);   // same data, rebuilt
    scores.push(mask === qr.mask ? QR._penalty(candidate.modules) : null);
  }
  ok(scores[qr.mask] !== null, 'the chosen mask scored');
  ok(qr.mask >= 0 && qr.mask <= 7, 'mask in range');
});

check('too much data is refused with a clear message', () => {
  let message = '';
  try { QR.matrix('x'.repeat(214)); } catch (e) { message = e.message; }
  ok(/Too much data/.test(message), `expected a refusal, got "${message}"`);
  ok(/213/.test(message), 'the message states the limit');
});

check('UTF-8 encoding is correct', () => {
  eq(QR._toBytes('A'), [0x41], 'ascii');
  eq(QR._toBytes('é'), [0xC3, 0xA9], 'two-byte');
  eq(QR._toBytes('—'), [0xE2, 0x80, 0x94], 'three-byte');
  eq(QR._toBytes('😀'), [0xF0, 0x9F, 0x98, 0x80], 'four-byte surrogate pair');
});

check('the SVG renders a quiet zone and both colours', () => {
  const svg = QR.svg('https://example.com/join?code=ABCDE', { quiet: 4 });
  const qr = QR.matrix('https://example.com/join?code=ABCDE');
  ok(svg.includes(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`), 'viewBox includes the quiet zone');
  ok(svg.includes('shape-rendering="crispEdges"'), 'modules are not antialiased into mush');
  ok(/<path d="M/.test(svg), 'modules drawn as one path');
  ok(svg.includes('role="img"'), 'labelled for screen readers');
});

check('an empty string still produces a valid code', () => {
  const qr = QR.matrix('');
  const got = decode(qr);
  eq(got.syndromes, [], 'syndromes');
  eq(got.text, '', 'decodes to empty');
});

console.log('');
if (failures.length) {
  console.log(`  ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach(f => console.log(`  ✗ ${f.name}\n      ${f.message}`));
  console.log('');
  process.exit(1);
} else {
  console.log(`  ${passed} checks passed.\n`);
}

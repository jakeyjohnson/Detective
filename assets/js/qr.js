/* =========================================================
   QR encoder — byte mode, error correction level M,
   versions 1 to 10 (up to 213 bytes, far more than a join URL
   needs).

   Self-contained on purpose. The alternative was a CDN script,
   and a QR code that silently fails is a room of people who
   cannot get into the game — so this is code that can be tested
   here rather than a dependency that cannot. test/qr.test.js
   round-trips every matrix back to the original string through
   an independent decode path.

   Reference: ISO/IEC 18004. The pieces, in order:
     1. GF(256) arithmetic and Reed-Solomon
     2. Data encoding (mode, length, payload, terminator, pad)
     3. Block splitting and interleaving
     4. Module placement (finders, timing, alignment, zigzag)
     5. Masking, chosen by the spec's four penalty rules
     6. Format and version information, via BCH
   ========================================================= */
(function (window) {
  'use strict';

  var QR = {};

  /* ---------------------------------------------------------
     1. GF(256), primitive polynomial 0x11D
     --------------------------------------------------------- */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function initTables() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* Generator polynomial for `degree` EC codewords:
     (x - a^0)(x - a^1)...(x - a^(degree-1)) */
  function rsGenerator(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var i = 0; i < poly.length; i++) {
        next[i] ^= poly[i];
        next[i + 1] ^= gmul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  /* Remainder of data * x^degree divided by the generator. */
  function rsEncode(data, degree) {
    var gen = rsGenerator(degree);
    var res = new Array(degree).fill(0);

    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (var j = 0; j < degree; j++) {
          res[j] ^= gmul(gen[j + 1], factor);
        }
      }
    }
    return res;
  }

  QR._rsEncode = rsEncode;

  /* ---------------------------------------------------------
     2. Version tables for level M
     ---------------------------------------------------------
     For each version: total codewords, EC codewords per block,
     and the block groups as [count, dataCodewordsPerBlock].
     --------------------------------------------------------- */
  var VERSIONS = {
    1:  { total: 26,  ec: 10, groups: [[1, 16]] },
    2:  { total: 44,  ec: 16, groups: [[1, 28]] },
    3:  { total: 70,  ec: 26, groups: [[1, 44]] },
    4:  { total: 100, ec: 18, groups: [[2, 32]] },
    5:  { total: 134, ec: 24, groups: [[2, 43]] },
    6:  { total: 172, ec: 16, groups: [[4, 27]] },
    7:  { total: 196, ec: 18, groups: [[4, 31]] },
    8:  { total: 242, ec: 22, groups: [[2, 38], [2, 39]] },
    9:  { total: 292, ec: 22, groups: [[3, 36], [2, 37]] },
    10: { total: 346, ec: 26, groups: [[4, 43], [1, 44]] }
  };

  var ALIGNMENT = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  QR._VERSIONS = VERSIONS;

  function dataCodewords(version) {
    return VERSIONS[version].groups.reduce(function (n, g) { return n + g[0] * g[1]; }, 0);
  }

  /* Byte mode's character-count field is 8 bits up to version 9
     and 16 bits from version 10. */
  function countBits(version) { return version < 10 ? 8 : 16; }

  function capacity(version) {
    return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
  }

  QR._capacity = capacity;

  function pickVersion(byteLength) {
    for (var v = 1; v <= 10; v++) {
      if (byteLength <= capacity(v)) return v;
    }
    return null;
  }

  /* ---------------------------------------------------------
     3. Encoding
     --------------------------------------------------------- */
  function toBytes(text) {
    /* UTF-8. A join URL is ASCII, but a show name in a QR should
       not corrupt if someone puts an accent in it. */
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) {
        /* Surrogate pair → one 4-byte sequence. */
        var lo = text.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  QR._toBytes = toBytes;

  function buildCodewords(bytes, version) {
    var bits = [];
    function push(value, length) {
      for (var i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
    }

    push(0x4, 4);                        // byte mode
    push(bytes.length, countBits(version));
    bytes.forEach(function (b) { push(b, 8); });

    var totalData = dataCodewords(version);
    var limit = totalData * 8;

    /* Terminator: up to four zero bits, then pad to a byte. */
    var terminator = Math.min(4, limit - bits.length);
    for (var t = 0; t < terminator; t++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    var words = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      words.push(byte);
    }

    /* Pad codewords alternate 0xEC / 0x11 per the spec. */
    var pads = [0xEC, 0x11];
    var p = 0;
    while (words.length < totalData) words.push(pads[p++ % 2]);

    return words;
  }

  /* Split into blocks, RS-encode each, then interleave data and
     EC codewords in the order the spec requires. */
  function interleave(words, version) {
    var spec = VERSIONS[version];
    var blocks = [];
    var offset = 0;

    spec.groups.forEach(function (group) {
      for (var b = 0; b < group[0]; b++) {
        var data = words.slice(offset, offset + group[1]);
        offset += group[1];
        blocks.push({ data: data, ec: rsEncode(data, spec.ec) });
      }
    });

    var out = [];
    var maxData = blocks.reduce(function (m, b) { return Math.max(m, b.data.length); }, 0);
    for (var i = 0; i < maxData; i++) {
      blocks.forEach(function (b) { if (i < b.data.length) out.push(b.data[i]); });
    }
    for (var k = 0; k < spec.ec; k++) {
      blocks.forEach(function (b) { out.push(b.ec[k]); });
    }
    return out;
  }

  QR._interleave = interleave;
  QR._buildCodewords = buildCodewords;

  /* ---------------------------------------------------------
     4. BCH for format and version information
     ---------------------------------------------------------
     Computed rather than tabulated: a mistyped table entry
     produces a code that scanners reject for reasons that are
     very hard to see by eye.
     --------------------------------------------------------- */
  function bch(value, generator, genBits) {
    var v = value << (genBits - 1);
    while (bitLength(v) >= genBits) {
      v ^= generator << (bitLength(v) - genBits);
    }
    return v;
  }

  function bitLength(v) {
    var n = 0;
    while (v !== 0) { n++; v >>>= 1; }
    return n;
  }

  /* 15-bit format info: 5 data bits (2 EC level + 3 mask),
     10 BCH bits, the whole thing XORed with 0x5412. */
  function formatInfo(mask) {
    var data = (0x0 << 3) | mask;        // 0b00 = level M
    return ((data << 10) | bch(data, 0x537, 11)) ^ 0x5412;
  }

  /* 18-bit version info: 6 data bits, 12 BCH bits. v7+ only. */
  function versionInfo(version) {
    return (version << 12) | bch(version, 0x1F25, 13);
  }

  QR._formatInfo = formatInfo;
  QR._versionInfo = versionInfo;

  /* ---------------------------------------------------------
     5. Module placement
     --------------------------------------------------------- */
  function blankMatrix(size) {
    var m = [];
    for (var r = 0; r < size; r++) {
      m.push(new Array(size).fill(null));   // null = not yet set
    }
    return m;
  }

  function placeFinder(m, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var onRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6));
        var inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = (onRing || inCore) ? 1 : 0;
      }
    }
  }

  function placeAlignment(m, version) {
    var centres = ALIGNMENT[version];
    var size = m.length;
    centres.forEach(function (r) {
      centres.forEach(function (c) {
        /* Skipped where a finder pattern already sits. */
        if ((r === 6 && c === 6) ||
            (r === 6 && c === size - 7) ||
            (r === size - 7 && c === 6)) return;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var ring = Math.max(Math.abs(dr), Math.abs(dc));
            m[r + dr][c + dc] = (ring === 1) ? 0 : 1;
          }
        }
      });
    });
  }

  function placeTiming(m) {
    var size = m.length;
    for (var i = 8; i < size - 8; i++) {
      var bit = (i % 2 === 0) ? 1 : 0;
      if (m[6][i] === null) m[6][i] = bit;
      if (m[i][6] === null) m[i][6] = bit;
    }
  }

  /* Reserve the format/version areas so the data walk skips them. */
  function reserveInfo(m, version) {
    var size = m.length;
    for (var i = 0; i <= 8; i++) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
    for (var j = 0; j < 8; j++) {
      if (m[8][size - 1 - j] === null) m[8][size - 1 - j] = 0;
      if (m[size - 1 - j][8] === null) m[size - 1 - j][8] = 0;
    }
    m[size - 8][8] = 1;                   // the always-dark module

    if (version >= 7) {
      for (var k = 0; k < 18; k++) {
        var r = Math.floor(k / 3), c = k % 3;
        if (m[size - 11 + c][r] === null) m[size - 11 + c][r] = 0;
        if (m[r][size - 11 + c] === null) m[r][size - 11 + c] = 0;
      }
    }
  }

  /* The zigzag: two-module columns from the right, alternating
     upward and downward, skipping column 6 (vertical timing). */
  function dataPositions(size, reserved) {
    var out = [];
    var upward = true;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;         // skip the timing column
      for (var i = 0; i < size; i++) {
        var row = upward ? size - 1 - i : i;
        for (var c = 0; c < 2; c++) {
          var col = right - c;
          if (!reserved[row][col]) out.push([row, col]);
        }
      }
      upward = !upward;
    }
    return out;
  }

  QR._dataPositions = dataPositions;

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
  ];

  QR._MASKS = MASKS;

  /* ---------------------------------------------------------
     Penalty rules, used to pick the mask. A scanner reads any
     mask, but a bad one puts finder-like runs in the data and
     makes the code harder to acquire.
     --------------------------------------------------------- */
  function penalty(m) {
    var size = m.length;
    var score = 0;
    var i, j, run, dark = 0;

    // Rule 1: runs of five or more same-colour modules in a line.
    for (i = 0; i < size; i++) {
      run = 1;
      for (j = 1; j < size; j++) {
        if (m[i][j] === m[i][j - 1]) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);

      run = 1;
      for (j = 1; j < size; j++) {
        if (m[j][i] === m[j - 1][i]) { run++; }
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }

    // Rule 2: 2x2 blocks of one colour.
    for (i = 0; i < size - 1; i++) {
      for (j = 0; j < size - 1; j++) {
        var v = m[i][j];
        if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) score += 3;
      }
    }

    // Rule 3: the 1:1:3:1:1 finder-like pattern with four light
    // modules either side.
    var p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(get, at, pattern) {
      for (var k = 0; k < pattern.length; k++) {
        if (get(at + k) !== pattern[k]) return false;
      }
      return true;
    }
    for (i = 0; i < size; i++) {
      for (j = 0; j <= size - 11; j++) {
        var rowGet = (function (r) { return function (x) { return m[r][x]; }; })(i);
        var colGet = (function (c) { return function (x) { return m[x][c]; }; })(i);
        if (matches(rowGet, j, p1) || matches(rowGet, j, p2)) score += 40;
        if (matches(colGet, j, p1) || matches(colGet, j, p2)) score += 40;
      }
    }

    // Rule 4: deviation from a 50/50 light-dark balance.
    for (i = 0; i < size; i++) {
      for (j = 0; j < size; j++) if (m[i][j]) dark++;
    }
    var percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  QR._penalty = penalty;

  /* ---------------------------------------------------------
     Build the matrix
     --------------------------------------------------------- */
  QR.matrix = function (text) {
    var bytes = toBytes(String(text == null ? '' : text));
    var version = pickVersion(bytes.length);
    if (!version) {
      throw new Error('Too much data for a version 10 QR code (' + bytes.length + ' bytes, max ' + capacity(10) + ').');
    }

    var size = version * 4 + 17;
    var base = blankMatrix(size);

    placeFinder(base, 0, 0);
    placeFinder(base, 0, size - 7);
    placeFinder(base, size - 7, 0);
    placeAlignment(base, version);
    placeTiming(base);
    reserveInfo(base, version);

    /* Everything set so far is function patterns; what is still
       null is where data goes. */
    var reserved = base.map(function (row) {
      return row.map(function (v) { return v !== null; });
    });

    var words = interleave(buildCodewords(bytes, version), version);
    var positions = dataPositions(size, reserved);

    var bitAt = function (index) {
      var byte = words[index >> 3];
      if (byte === undefined) return 0;     // remainder bits are 0
      return (byte >> (7 - (index & 7))) & 1;
    };

    /* Try every mask, keep the best-scoring one. */
    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var m = base.map(function (row) { return row.slice(); });
      positions.forEach(function (pos, index) {
        var bit = bitAt(index);
        if (MASKS[mask](pos[0], pos[1])) bit ^= 1;
        m[pos[0]][pos[1]] = bit;
      });
      writeFormat(m, mask);
      if (version >= 7) writeVersion(m, version);

      var score = penalty(m);
      if (!best || score < best.score) {
        best = { score: score, modules: m, mask: mask };
      }
    }

    return {
      version: version,
      size: size,
      mask: best.mask,
      modules: best.modules
    };
  };

  function writeFormat(m, mask) {
    var size = m.length;
    var bits = formatInfo(mask);

    /* The 15 bits go in two places, in the spec's order. */
    for (var i = 0; i < 15; i++) {
      var bit = (bits >> i) & 1;

      // Copy around the top-left finder.
      if (i < 6) m[8][i] = bit;
      else if (i === 6) m[8][7] = bit;
      else if (i === 7) m[8][8] = bit;
      else if (i === 8) m[7][8] = bit;
      else m[14 - i][8] = bit;

      // Second copy, split between top-right and bottom-left.
      if (i < 8) m[8][size - 1 - i] = bit;
      else m[size - 15 + i][8] = bit;
    }
  }

  function writeVersion(m, version) {
    var size = m.length;
    var bits = versionInfo(version);
    for (var i = 0; i < 18; i++) {
      var bit = (bits >> i) & 1;
      var r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = bit;
      m[r][size - 11 + c] = bit;
    }
  }

  /* ---------------------------------------------------------
     6. Rendering
     ---------------------------------------------------------
     One <path> of rectangles rather than a rect per module: a
     version 4 code is 1089 modules, and 1089 elements is enough
     DOM to be felt when the host page renders it.
     --------------------------------------------------------- */
  QR.svg = function (text, opts) {
    var o = opts || {};
    var quiet = o.quiet == null ? 4 : o.quiet;      // spec minimum is 4
    var dark = o.dark || '#07080B';
    var light = o.light || '#EFE6CE';
    var qr = QR.matrix(text);
    var total = qr.size + quiet * 2;

    var d = '';
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) {
          d += 'M' + (c + quiet) + ',' + (r + quiet) + 'h1v1h-1z';
        }
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" ' +
      'shape-rendering="crispEdges" role="img" aria-label="' +
      (o.label || 'QR code') + '">' +
      '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
      '<path d="' + d + '" fill="' + dark + '"/>' +
      '</svg>';
  };

  QR.dataUri = function (text, opts) {
    return 'data:image/svg+xml,' + encodeURIComponent(QR.svg(text, opts));
  };

  window.DetectiveQR = QR;
})(window);

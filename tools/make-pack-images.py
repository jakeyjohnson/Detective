#!/usr/bin/env python3
"""Draw the starter pack's evidence images.

These are SVGs generated here rather than photographs pulled off
the web, for three reasons: they work with no internet in the
venue, nothing can rot or change licence under you, and — most
of all — each one is drawn so the question is actually answerable
from what is on screen. A stock photo of a fingerprint does not
let a room pick which of four is a whorl.

Drawn on the show's cream plate so they read from the back of a
room: black ink, gold accents, thick strokes, big letter labels.

    python3 tools/make-pack-images.py
"""

import math
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'img', 'pack')

INK   = '#15120A'
CREAM = '#EFE6CE'
GOLD  = '#B5892A'
RED   = '#A8332F'

# SVG is XML: named HTML entities like &rsquo; are undefined and
# make the whole file fail to parse, which shows as a broken image
# with no error anywhere. Numeric character references are safe.
def svg(w, h, body, title):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        f'role="img" aria-label="{title}">\n'
        f'<rect width="{w}" height="{h}" fill="{CREAM}"/>\n'
        f'{body}\n</svg>\n'
    )

def write(name, content):
    path = os.path.join(OUT, name)
    with open(path, 'w') as f:
        f.write(content)
    print('wrote', os.path.relpath(path))

def label(x, y, text, size=44):
    return (f'<text x="{x}" y="{y}" font-family="Courier New, monospace" '
            f'font-size="{size}" font-weight="bold" fill="{INK}" '
            f'text-anchor="middle">{text}</text>')

def caption(x, y, text, size=22, fill=None, anchor='middle'):
    return (f'<text x="{x}" y="{y}" font-family="Helvetica, Arial, sans-serif" '
            f'font-size="{size}" fill="{fill or INK}" text-anchor="{anchor}">{text}</text>')


# ---------------------------------------------------------------
# 1 & 2. Fingerprint patterns: loop, whorl, arch, tented arch.
#    The four classes a question can genuinely ask about.
# ---------------------------------------------------------------
def ridge_arch(cx, cy):
    """Concentric round arches: a plain arch."""
    out = []
    for i in range(6):
        rx = 14 + i * 11
        ry = 12 + i * 9
        out.append(
            f'<path d="M{cx-rx},{cy+70} L{cx-rx},{cy} '
            f'A{rx},{ry} 0 0 1 {cx+rx},{cy} L{cx+rx},{cy+70}" '
            f'fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>'
        )
    return ''.join(out)

def ridge_tented(cx, cy):
    """A sharp apex, not a taller dome. Drawn as peaks so it is
    unmistakably different from the plain arch beside it."""
    out = []
    for i in range(6):
        w = 16 + i * 11
        h = 26 + i * 13
        out.append(
            f'<path d="M{cx-w},{cy+90} L{cx-w},{cy+40} L{cx},{cy+40-h} '
            f'L{cx+w},{cy+40} L{cx+w},{cy+90}" '
            f'fill="none" stroke="{INK}" stroke-width="5" stroke-linejoin="miter" '
            f'stroke-linecap="round"/>'
        )
    return ''.join(out)

def ridge_whorl(cx, cy):
    """Concentric closed circles — the defining whorl feature."""
    out = []
    for i in range(6):
        r = 12 + i * 11
        out.append(f'<circle cx="{cx}" cy="{cy+30}" r="{r}" fill="none" '
                   f'stroke="{INK}" stroke-width="5"/>')
    out.append(f'<path d="M{cx-72},{cy+100} L{cx-72},{cy+30}" fill="none" '
               f'stroke="{INK}" stroke-width="5"/>')
    out.append(f'<path d="M{cx+72},{cy+100} L{cx+72},{cy+30}" fill="none" '
               f'stroke="{INK}" stroke-width="5"/>')
    return ''.join(out)

def ridge_loop(cx, cy):
    """Ridges enter and leave from the same side, curving back."""
    out = []
    for i in range(6):
        rx = 14 + i * 11
        ry = 16 + i * 11
        out.append(
            f'<path d="M{cx-rx-10},{cy+100} '
            f'C{cx-rx},{cy+20} {cx-rx+6},{cy} {cx},{cy} '
            f'C{cx+rx},{cy} {cx+rx},{cy+40} {cx+rx*0.5},{cy+100}" '
            f'fill="none" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>'
        )
    return ''.join(out)

def fingerprint_sheet(order, name, title):
    """order: list of pattern keys, drawn A B C D left to right."""
    w, h = 1000, 400
    cells = []
    draw = {'arch': lambda cx: ridge_arch(cx, 130),
            'tented': lambda cx: ridge_tented(cx, 110),
            'whorl': lambda cx: ridge_whorl(cx, 100),
            'loop': lambda cx: ridge_loop(cx, 120)}
    for i, key in enumerate(order):
        cx = 125 + i * 250
        cells.append(f'<rect x="{cx-105}" y="40" width="210" height="270" '
                     f'fill="none" stroke="{GOLD}" stroke-width="3" rx="4"/>')
        cells.append(draw[key](cx))
        cells.append(label(cx, 365, 'ABCD'[i], 52))
    return svg(w, h, ''.join(cells), title)

write('fingerprints-1.svg',
      fingerprint_sheet(['loop', 'whorl', 'arch', 'tented'],
                        'fingerprints-1', 'Four fingerprint patterns labelled A to D'))
write('fingerprints-2.svg',
      fingerprint_sheet(['tented', 'arch', 'loop', 'whorl'],
                        'fingerprints-2', 'Four fingerprint patterns labelled A to D'))


# ---------------------------------------------------------------
# 3. Blood spatter: mist, drip, cast-off, transfer.
# ---------------------------------------------------------------
def spatter_panel(cx, kind):
    out = [f'<rect x="{cx-105}" y="40" width="210" height="210" fill="none" '
           f'stroke="{GOLD}" stroke-width="3" rx="4"/>']
    rnd = [0.13, 0.71, 0.29, 0.88, 0.44, 0.61, 0.07, 0.95, 0.52, 0.36,
           0.78, 0.22, 0.66, 0.41, 0.84, 0.18, 0.59, 0.33, 0.92, 0.48]
    if kind == 'mist':
        # Very many very fine droplets: high-velocity impact.
        for i in range(120):
            x = cx - 90 + (rnd[i % 20] * 180 + i * 7) % 180
            y = 55 + (rnd[(i + 5) % 20] * 180 + i * 11) % 180
            out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="1.6" fill="{RED}"/>')
    elif kind == 'drip':
        # A few large round drops: passive dripping.
        for i in range(7):
            x = cx - 60 + i * 20
            y = 90 + (i % 3) * 45
            out.append(f'<circle cx="{x}" cy="{y}" r="13" fill="{RED}"/>')
    elif kind == 'castoff':
        # A line of elongated drops flung from a swung object.
        for i in range(9):
            x = cx - 85 + i * 21
            y = 90 + i * 12
            out.append(f'<ellipse cx="{x}" cy="{y}" rx="5" ry="11" '
                       f'transform="rotate(-35 {x} {y})" fill="{RED}"/>')
    else:  # transfer
        # A smear: contact, then movement.
        out.append(f'<path d="M{cx-70},110 Q{cx},80 {cx+70},135 L{cx+70},175 '
                   f'Q{cx},130 {cx-70},160 Z" fill="{RED}" opacity="0.85"/>')
    return ''.join(out)

panels = []
for i, kind in enumerate(['drip', 'mist', 'castoff', 'transfer']):
    cx = 125 + i * 250
    panels.append(spatter_panel(cx, kind))
    panels.append(label(cx, 300, 'ABCD'[i], 52))
write('spatter.svg', svg(1000, 340, ''.join(panels),
                         'Four blood spatter patterns labelled A to D'))


# ---------------------------------------------------------------
# 4. Shoe treads: one matches the suspect's sole.
# ---------------------------------------------------------------
def tread(cx, cy, kind, scale=1.0):
    out = [f'<rect x="{cx-70}" y="{cy-110}" width="140" height="230" rx="60" '
           f'fill="none" stroke="{INK}" stroke-width="4"/>']
    if kind == 'bars':
        for i in range(7):
            y = cy - 85 + i * 30
            out.append(f'<rect x="{cx-48}" y="{y}" width="96" height="14" fill="{INK}"/>')
    elif kind == 'chevron':
        for i in range(6):
            y = cy - 80 + i * 34
            out.append(f'<path d="M{cx-45},{y+20} L{cx},{y} L{cx+45},{y+20}" '
                       f'fill="none" stroke="{INK}" stroke-width="11"/>')
    elif kind == 'waffle':
        for i in range(5):
            for j in range(4):
                out.append(f'<rect x="{cx-52+j*28}" y="{cy-82+i*40}" width="20" '
                           f'height="26" fill="{INK}"/>')
    elif kind == 'circles':
        for i in range(5):
            for j in range(3):
                out.append(f'<circle cx="{cx-36+j*36}" cy="{cy-70+i*38}" r="11" fill="{INK}"/>')
    return ''.join(out)

body = [caption(500, 34, 'THE PRINT AT THE SCENE', 24, GOLD)]
body.append(f'<g>{tread(500, 170, "chevron")}</g>')
body.append(f'<line x1="60" y1="310" x2="940" y2="310" stroke="{GOLD}" stroke-width="3"/>')
body.append(caption(500, 348, 'THE FOUR SUSPECTS&#8217; SOLES', 24, GOLD))
for i, kind in enumerate(['bars', 'waffle', 'chevron', 'circles']):
    cx = 160 + i * 227
    body.append(tread(cx, 500, kind))
    body.append(label(cx, 660, 'ABCD'[i], 46))
write('treads.svg', svg(1000, 700, ''.join(body),
                        'A shoe print from the scene above four suspects’ soles'))


# ---------------------------------------------------------------
# 5. A Caesar-shifted note.
# ---------------------------------------------------------------
def caesar(text, shift):
    out = []
    for ch in text.upper():
        if 'A' <= ch <= 'Z':
            out.append(chr((ord(ch) - 65 + shift) % 26 + 65))
        else:
            out.append(ch)
    return ''.join(out)

PLAIN = 'MEET AT MIDNIGHT'
CIPHER = caesar(PLAIN, 3)
body = [
    f'<rect x="60" y="50" width="880" height="300" fill="none" stroke="{INK}" stroke-width="4"/>',
    caption(500, 110, 'FOUND IN THE VICTIM&#8217;S COAT POCKET', 24, GOLD),
    f'<text x="500" y="220" font-family="Courier New, monospace" font-size="76" '
    f'font-weight="bold" fill="{INK}" text-anchor="middle" letter-spacing="8">{CIPHER}</text>',
    caption(500, 300, 'Each letter has been moved three places forward in the alphabet.', 24),
]
write('cipher.svg', svg(1000, 400, ''.join(body), 'An enciphered note'))
print('   cipher plaintext:', PLAIN, '| ciphertext:', CIPHER)


# ---------------------------------------------------------------
# 6. Morse.
# ---------------------------------------------------------------
MORSE = {
    'A': '.-', 'B': '-...', 'C': '-.-.', 'D': '-..', 'E': '.', 'F': '..-.',
    'G': '--.', 'H': '....', 'I': '..', 'J': '.---', 'K': '-.-', 'L': '.-..',
    'M': '--', 'N': '-.', 'O': '---', 'P': '.--.', 'Q': '--.-', 'R': '.-.',
    'S': '...', 'T': '-', 'U': '..-', 'V': '...-', 'W': '.--', 'X': '-..-',
    'Y': '-.--', 'Z': '--..'
}
MORSE_WORD = 'POISON'
code = ' / '.join(MORSE[c] for c in MORSE_WORD)
body = [
    caption(500, 70, 'TAPPED ON THE PIPE BY THE PRISONER', 24, GOLD),
    f'<text x="500" y="190" font-family="Courier New, monospace" font-size="52" '
    f'font-weight="bold" fill="{INK}" text-anchor="middle">{code}</text>',
    caption(500, 270, 'Six letters, separated by slashes.', 24),
]
write('morse.svg', svg(1000, 330, ''.join(body), 'A word in Morse code'))
print('   morse word:', MORSE_WORD, '| code:', code)


# ---------------------------------------------------------------
# 7. A floor plan. The question asks which exit is nearest the
#    body, so the distances must be unambiguous by eye.
# ---------------------------------------------------------------
body = [
    # Outer walls
    f'<rect x="80" y="60" width="840" height="480" fill="none" stroke="{INK}" stroke-width="6"/>',
    # Dividing wall
    f'<line x1="520" y1="60" x2="520" y2="330" stroke="{INK}" stroke-width="6"/>',
    f'<line x1="520" y1="430" x2="520" y2="540" stroke="{INK}" stroke-width="6"/>',
    caption(300, 100, 'THE LIBRARY', 24, GOLD),
    caption(720, 100, 'THE STUDY', 24, GOLD),
    # Desk and bookcase
    f'<rect x="640" y="150" width="200" height="70" fill="none" stroke="{INK}" stroke-width="4"/>',
    caption(740, 195, 'desk', 20),
    f'<rect x="120" y="120" width="70" height="200" fill="none" stroke="{INK}" stroke-width="4"/>',
    caption(155, 340, 'shelves', 18),
    # The body: close to exit B, with nothing in the way, and a
    # long way from every other exit.
    f'<circle cx="250" cy="460" r="26" fill="{RED}"/>',
    caption(250, 512, 'THE BODY', 22, RED),
    # Exits, lettered
    f'<rect x="250" y="52" width="100" height="16" fill="{GOLD}"/>', label(300, 40, 'A', 40),
    f'<rect x="72" y="430" width="16" height="70" fill="{GOLD}"/>',  label(45, 475, 'B', 40),
    f'<rect x="860" y="532" width="100" height="16" fill="{GOLD}"/>',
    f'<rect x="820" y="532" width="100" height="16" fill="{GOLD}"/>', label(870, 585, 'C', 40),
    f'<rect x="912" y="230" width="16" height="60" fill="{GOLD}"/>',  label(955, 270, 'D', 40),
]
write('floorplan.svg', svg(1000, 620, ''.join(body),
                           'A floor plan of two rooms with the body and four lettered exits'))


# ---------------------------------------------------------------
# 8. A witness line-up. Heights differ measurably; one figure
#    matches "tall, hat, long coat".
# ---------------------------------------------------------------
def figure(cx, base, height, hat, longcoat):
    head_r = 22
    top = base - height
    out = [f'<circle cx="{cx}" cy="{top + head_r}" r="{head_r}" fill="{INK}"/>']
    if hat:
        out.append(f'<rect x="{cx-34}" y="{top-14}" width="68" height="12" fill="{INK}"/>')
        out.append(f'<rect x="{cx-20}" y="{top-40}" width="40" height="28" fill="{INK}"/>')
    coat_bottom = base - (20 if longcoat else 90)
    out.append(f'<path d="M{cx-30},{top + head_r*2 + 6} L{cx+30},{top + head_r*2 + 6} '
               f'L{cx+36},{coat_bottom} L{cx-36},{coat_bottom} Z" fill="{INK}"/>')
    out.append(f'<rect x="{cx-14}" y="{coat_bottom}" width="10" height="{base-coat_bottom}" fill="{INK}"/>')
    out.append(f'<rect x="{cx+4}" y="{coat_bottom}" width="10" height="{base-coat_bottom}" fill="{INK}"/>')
    return ''.join(out)

# The tallest figure's hat reached the heading, so the baseline
# drops and the canvas grows rather than letting them collide.
base = 530
body = [caption(500, 40, 'THE WITNESS SAW A TALL FIGURE IN A HAT AND A LONG COAT', 24, GOLD)]
# (height, hat, long coat) — only C has all three of tall, hat
# and long coat; each of the others fails exactly one.
specs = [(300, False, True), (345, True, False), (405, True, True), (296, True, True)]
for i, (h, hat, coat) in enumerate(specs):
    cx = 150 + i * 235
    body.append(figure(cx, base, h, hat, coat))
    body.append(label(cx, 592, 'ABCD'[i], 46))
body.append(f'<line x1="60" y1="{base}" x2="940" y2="{base}" stroke="{INK}" stroke-width="5"/>')
write('lineup.svg', svg(1000, 630, ''.join(body),
                        'Four silhouettes in a line-up labelled A to D'))


# ---------------------------------------------------------------
# 9. Signatures: one is a forgery, shown by pen lifts and tremor.
# ---------------------------------------------------------------
def signature(x, y, shaky, lifts):
    """A looping scrawl. A forgery is drawn, not written: slower,
    so it wobbles and the pen stops and restarts."""
    pts = []
    for i in range(70):
        t = i / 69
        px = x + t * 300
        py = y + math.sin(t * 9) * 26 + (math.sin(t * 61) * 5 if shaky else 0)
        pts.append((px, py))
    if not lifts:
        d = 'M' + ' L'.join(f'{px:.1f},{py:.1f}' for px, py in pts)
        segs = [d]
    else:
        segs = []
        for chunk in (pts[:22], pts[26:46], pts[50:]):
            segs.append('M' + ' L'.join(f'{px:.1f},{py:.1f}' for px, py in chunk))
    return ''.join(f'<path d="{d}" fill="none" stroke="{INK}" stroke-width="5" '
                   f'stroke-linecap="round"/>' for d in segs)

body = [caption(360, 40, 'ONE OF THESE WAS NOT WRITTEN BY THE SAME HAND', 21, GOLD)]
for i, (shaky, lifts) in enumerate([(False, False), (False, False), (True, True), (False, False)]):
    y = 110 + i * 110
    body.append(f'<line x1="90" y1="{y+55}" x2="410" y2="{y+55}" stroke="{GOLD}" stroke-width="2"/>')
    body.append(signature(100, y + 20, shaky, lifts))
    body.append(label(60, y + 42, 'ABCD'[i], 44))
write('signatures.svg', svg(720, 560, ''.join(body),
                            'Four signatures labelled A to D'))


# ---------------------------------------------------------------
# 10. An alibi timeline. One suspect has a gap at 9pm.
# ---------------------------------------------------------------
NAMES = ['A  BUTLER', 'B  COOK', 'C  NEPHEW', 'D  DOCTOR']
# (start hour, end hour) covered, on a 7pm-11pm axis
BARS = [
    [(19, 23)],
    [(19, 23)],
    [(19, 20.5), (21.5, 23)],     # the only gap, and it covers 9pm
    [(19, 23)],
]
x0, x1 = 240, 940
def hx(h):
    return x0 + (h - 19) / 4 * (x1 - x0)

body = [caption(500, 38, 'WHO CANNOT ACCOUNT FOR 9PM?', 26, GOLD)]
for h in range(19, 24):
    x = hx(h)
    body.append(f'<line x1="{x:.0f}" y1="70" x2="{x:.0f}" y2="360" stroke="{GOLD}" '
                f'stroke-width="2" stroke-dasharray="4 6"/>')
    hh = h if h <= 12 else h - 12
    body.append(caption(x, 60, f'{hh}pm', 22, GOLD))
for i, (name, bars) in enumerate(zip(NAMES, BARS)):
    y = 110 + i * 62
    body.append(caption(210, y + 22, name, 24, INK, anchor='end'))
    for (s, e) in bars:
        body.append(f'<rect x="{hx(s):.0f}" y="{y}" width="{hx(e)-hx(s):.0f}" height="32" '
                    f'fill="{INK}" rx="3"/>')
write('timeline.svg', svg(1000, 390, ''.join(body),
                          'Alibi timeline for four suspects from 7pm to 11pm'))

print('\ndone')

#!/usr/bin/env python3
"""Build content/starter-pack.json — 50 placeholder questions.

Placeholder in the sense that you will swap them for your own
material, not in the sense of being filler: every one has a
checkable answer, and the ten image questions are answerable from
the picture on screen rather than needing outside knowledge.

Deliberately no audio or video questions. Those need media files
this repository cannot ship, and a question with an empty URL is
a dead question that the builder would flag. Adding one is a URL
in the builder.

    python3 tools/make-pack.py
"""

import json
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'content', 'starter-pack.json')
IMG = 'assets/img/pack/'

_ids = {'q': 0, 'o': 0, 'i': 0, 'r': 0}

def uid(kind):
    _ids[kind] += 1
    return f'pack_{kind}{_ids[kind]:03d}'

def opts(*pairs):
    """pairs: (text, is_correct)"""
    return [{'id': uid('o'), 'text': t, 'correct': bool(c)} for t, c in pairs]

def base(qtype, prompt, points, seconds):
    return {
        'id': uid('q'),
        'type': qtype,
        'prompt': prompt,
        'points': points,
        'timeLimit': seconds,
        'explanation': '',
        'media': {'kind': 'none', 'url': '', 'startAt': None, 'endAt': None,
                  'autoplay': True, 'loop': False},
        'options': [],
        'multiCorrect': False,
        'answers': [],
        'acceptClose': True,
        'items': [],
        'numeric': {'value': 0, 'tolerance': None},
        'wager': {'min': 0, 'max': None},
        'input': None,
    }

def mc(prompt, options, why='', points=10, seconds=25, image=None):
    q = base('image' if image else 'multiple-choice', prompt, points, seconds)
    q['options'] = opts(*options)
    q['explanation'] = why
    q['input'] = 'choice'
    if image:
        q['media'] = {'kind': 'image', 'url': IMG + image, 'startAt': None,
                      'endAt': None, 'autoplay': True, 'loop': False}
        q['timeLimit'] = max(seconds, 35)
    return q

def tf(prompt, answer_true, why='', points=10, seconds=15):
    q = base('true-false', prompt, points, seconds)
    q['options'] = opts(('True', answer_true), ('False', not answer_true))
    q['explanation'] = why
    q['input'] = 'choice'
    return q

def text(prompt, answers, why='', points=10, seconds=30, image=None):
    q = base('image' if image else 'standard', prompt, points, seconds)
    q['answers'] = list(answers)
    q['explanation'] = why
    q['input'] = 'text'
    if image:
        q['media'] = {'kind': 'image', 'url': IMG + image, 'startAt': None,
                      'endAt': None, 'autoplay': True, 'loop': False}
        q['timeLimit'] = max(seconds, 45)
    return q

def num(prompt, value, tolerance=None, why='', points=10, seconds=25):
    q = base('numeric', prompt, points, seconds)
    q['numeric'] = {'value': value, 'tolerance': tolerance}
    q['explanation'] = why
    q['input'] = 'number'
    return q

def order(prompt, items, why='', points=15, seconds=60):
    q = base('ordering', prompt, points, seconds)
    q['items'] = [{'id': uid('i'), 'text': t} for t in items]
    q['explanation'] = why
    q['input'] = 'order'
    return q

def wager(prompt, answer, why='', seconds=90):
    q = base('wager', prompt, 0, seconds)
    q['answers'] = [answer]
    q['explanation'] = why
    q['input'] = 'judged'
    return q

def rnd(title, description, questions):
    return {'id': uid('r'), 'title': title, 'description': description,
            'questions': questions}


# =================================================================
# ROUND 1 — Opening Statements
# =================================================================
round1 = rnd('Opening Statements', 'Ten to warm the room up. Nobody is out yet.', [
    mc('Who created Sherlock Holmes?',
       [('Arthur Conan Doyle', 1), ('Wilkie Collins', 0),
        ('Edgar Allan Poe', 0), ('G. K. Chesterton', 0)],
       'A Study in Scarlet, 1887.'),

    mc('What is Sherlock Holmes’s address?',
       [('221B Baker Street', 1), ('21B Baker Street', 0),
        ('221B Marylebone Road', 0), ('12 Baker Street', 0)]),

    tf('Sherlock Holmes never says “Elementary, my dear Watson” in any of '
       'Conan Doyle’s stories.', True,
       'He says “Elementary” and he says “my dear Watson”, '
       'but never the two together. The line came later, from the stage and screen.'),

    mc('Which detective did Agatha Christie make Belgian?',
       [('Hercule Poirot', 1), ('Inspector Japp', 0),
        ('Tommy Beresford', 0), ('Superintendent Battle', 0)]),

    mc('Which of Christie’s detectives is an elderly spinster living in a village?',
       [('Miss Marple', 1), ('Ariadne Oliver', 0),
        ('Miss Lemon', 0), ('Mrs McGinty', 0)]),

    mc('Which of these is NOT a room on the classic British Cluedo board?',
       [('The Cellar', 1), ('The Conservatory', 0),
        ('The Billiard Room', 0), ('The Ballroom', 0)]),

    tf('Agatha Christie is the best-selling novelist of all time.', True,
       'Somewhere around two billion copies, in more than a hundred languages.'),

    mc('Who wrote The Big Sleep?',
       [('Raymond Chandler', 1), ('Dashiell Hammett', 0),
        ('James M. Cain', 0), ('Ross Macdonald', 0)]),

    mc('Which private detective did Raymond Chandler create?',
       [('Philip Marlowe', 1), ('Sam Spade', 0),
        ('Lew Archer', 0), ('Mike Hammer', 0)],
       'Sam Spade is Hammett’s. It is the single most common mix-up in crime fiction.'),

    mc('In Murder on the Orient Express, where is the train travelling from and to?',
       [('Istanbul to Calais', 1), ('Paris to Istanbul', 0),
        ('Vienna to Venice', 0), ('Belgrade to London', 0)]),
])


# =================================================================
# ROUND 2 — The Evidence (every question is on the screen)
# =================================================================
round2 = rnd('The Evidence', 'Everything you need is on the screen. Look properly.', [
    mc('Which of these four fingerprints is a WHORL?',
       [('A', 0), ('B', 1), ('C', 0), ('D', 0)],
       'A whorl has ridges that form complete circles. A is a loop, C is a plain '
       'arch, D is a tented arch.',
       points=15, image='fingerprints-1.svg'),

    mc('Which of these four fingerprints is a TENTED ARCH?',
       [('A', 1), ('B', 0), ('C', 0), ('D', 0)],
       'A tented arch comes to a sharp point. B is a plain arch, C is a loop, '
       'D is a whorl.',
       points=15, image='fingerprints-2.svg'),

    mc('One of these patterns was made by high-velocity impact spatter — a fine '
       'mist of tiny droplets. Which?',
       [('A', 0), ('B', 1), ('C', 0), ('D', 0)],
       'B. A is passive dripping, C is cast-off from a swung object, D is a '
       'transfer smear from contact.',
       points=15, image='spatter.svg'),

    mc('Which pattern is CAST-OFF — blood flung from a moving object?',
       [('A', 0), ('B', 0), ('C', 1), ('D', 0)],
       'C. The drops are elongated and in a line, thrown along the arc of a swing.',
       points=15, image='spatter.svg'),

    mc('Whose sole made the print found at the scene?',
       [('A', 0), ('B', 0), ('C', 1), ('D', 0)],
       'C. The chevrons match, pointing the same way and the same width apart.',
       points=15, image='treads.svg'),

    text('Decipher the note. Each letter has been shifted three places forward '
         'in the alphabet.',
         ['MEET AT MIDNIGHT', 'meet at midnight'],
         'P becomes M, H becomes E, and so on back three: MEET AT MIDNIGHT.',
         points=20, seconds=75, image='cipher.svg'),

    text('What word was tapped out in Morse code?',
         ['POISON'],
         '.--. / --- / .. / ... / --- / -. spells POISON.',
         points=20, seconds=75, image='morse.svg'),

    mc('Looking at the floor plan, which exit is nearest the body?',
       [('A', 0), ('B', 1), ('C', 0), ('D', 0)],
       'B, on the library’s west wall, with nothing between it and the body.',
       points=15, image='floorplan.svg'),

    mc('The witness saw a TALL figure, in a HAT, wearing a LONG COAT. '
       'Which one is it?',
       [('A', 0), ('B', 0), ('C', 1), ('D', 0)],
       'C is the only one with all three. A has no hat, B’s coat is short, '
       'D is not tall.',
       points=15, image='lineup.svg'),

    mc('Three of these signatures were written by the same hand. Which is the forgery?',
       [('A', 0), ('B', 0), ('C', 1), ('D', 0)],
       'C. A forgery is drawn rather than written, so the line shakes and the pen '
       'stops and starts. The others are one confident stroke.',
       points=15, image='signatures.svg'),
])


# =================================================================
# ROUND 3 — Method
# =================================================================
round3 = rnd('Method', 'How it is actually done. Typed answers — spelling is forgiven.', [
    text('What does DNA stand for?',
         ['Deoxyribonucleic acid', 'deoxyribonucleic'],
         'Deoxyribonucleic acid.'),

    text('In which London district did the 1888 murders attributed to Jack the '
         'Ripper take place?',
         ['Whitechapel'],
         'Whitechapel, in the East End.'),

    text('What is the study of insects used to help establish a time of death called?',
         ['Forensic entomology', 'entomology'],
         'Forensic entomology. Which insects arrive, and when, puts a clock on a body.'),

    text('Luminol is sprayed at a scene to reveal traces of what?',
         ['Blood'],
         'Blood. It glows blue where haemoglobin remains, even after cleaning.'),

    text('By what name is the headquarters of London’s Metropolitan Police known?',
         ['Scotland Yard', 'New Scotland Yard'],
         'Scotland Yard — after Great Scotland Yard, its first address.'),

    text('Rigor mortis is the stiffening of what, after death?',
         ['Muscles', 'the muscles'],
         'The muscles. It sets in over a few hours and passes off over a day or so.'),

    text('Which poison was known in Victorian times as “inheritance powder”?',
         ['Arsenic'],
         'Arsenic. Cheap, tasteless, and undetectable until the Marsh test.'),

    text('What word means evidence that you were somewhere else when the crime '
         'was committed?',
         ['Alibi', 'An alibi'],
         'An alibi — Latin for “elsewhere”.'),

    text('A ballistics examiner matches marks on a fired bullet to what?',
         ['The barrel', 'The gun', 'The rifling', 'The barrel of the gun', 'The weapon'],
         'The barrel. Rifling scratches the bullet in a pattern unique to that gun.'),

    text('What is the medical examination of a body after death called?',
         ['Post-mortem', 'Autopsy', 'Post mortem', 'A post-mortem', 'An autopsy'],
         'A post-mortem, or an autopsy.'),
])


# =================================================================
# ROUND 4 — Motive and Opportunity
# =================================================================
round4 = rnd('Motive and Opportunity', 'Orders, numbers, and one look at a timeline.', [
    mc('Studying the alibi timeline, who cannot account for 9pm?',
       [('The butler', 0), ('The cook', 0), ('The nephew', 1), ('The doctor', 0)],
       'The nephew. Everyone else is covered from 7pm straight through to 11pm.',
       points=15, image='timeline.svg'),

    order('Put these four Sherlock Holmes novels in the order they were published, '
          'earliest first.',
          ['A Study in Scarlet', 'The Sign of the Four',
           'The Hound of the Baskervilles', 'The Valley of Fear'],
          '1887, 1890, 1902 and 1915.'),

    num('How many Sherlock Holmes SHORT STORIES did Conan Doyle write?',
        56, tolerance=2,
        why='Fifty-six short stories and four novels — the sixty works of the canon.'),

    num('In what year was the first Sherlock Holmes story published?',
        1887, tolerance=2,
        why='A Study in Scarlet, in Beeton’s Christmas Annual, 1887.'),

    num('How many rooms are there on the classic British Cluedo board?',
        9, tolerance=0,
        why='Nine: kitchen, ballroom, conservatory, dining room, billiard room, '
            'library, lounge, hall and study.'),

    mc('Which of these is NOT one of the six weapons in classic British Cluedo?',
       [('The crossbow', 1), ('The candlestick', 0),
        ('The lead pipe', 0), ('The spanner', 0)]),

    mc('In which village does Miss Marple live?',
       [('St Mary Mead', 1), ('Chipping Cleghorn', 0),
        ('Market Basing', 0), ('Wychwood-under-Ashe', 0)]),

    text('Which Agatha Christie novel caused an outcry over who its narrator '
         'turned out to be?',
         ['The Murder of Roger Ackroyd', 'Roger Ackroyd'],
         'The Murder of Roger Ackroyd, 1926.',
         seconds=35),

    num('How many suspects are there in classic British Cluedo?',
        6, tolerance=0,
        why='Six: Scarlett, Mustard, White, Green, Peacock and Plum.'),

    order('Put these detectives in the order their first book appeared, '
          'earliest first.',
          ['Sherlock Holmes', 'Hercule Poirot', 'Miss Marple', 'Philip Marlowe'],
          'Holmes 1887, Poirot 1920, Marple 1930, Marlowe 1939.'),
])


# =================================================================
# ROUND 5 — The Verdict
# =================================================================
round5 = rnd('The Verdict', 'Harder, worth more, and it ends on a wager.', [
    mc('On which moor is The Hound of the Baskervilles set?',
       [('Dartmoor', 1), ('Exmoor', 0), ('Bodmin Moor', 0), ('Ilkley Moor', 0)],
       points=15),

    mc('Which city is Inspector Morse’s beat?',
       [('Oxford', 1), ('Cambridge', 0), ('Bath', 0), ('York', 0)],
       points=15),

    mc('Which city does Ian Rankin’s Inspector Rebus work in?',
       [('Edinburgh', 1), ('Glasgow', 0), ('Aberdeen', 0), ('Dundee', 0)],
       points=15),

    mc('Who wrote Gone Girl?',
       [('Gillian Flynn', 1), ('Paula Hawkins', 0),
        ('Tana French', 0), ('Megan Abbott', 0)],
       points=15),

    mc('Who wrote The Girl with the Dragon Tattoo?',
       [('Stieg Larsson', 1), ('Jo Nesbø', 0),
        ('Henning Mankell', 0), ('Camilla Läckberg', 0)],
       points=15),

    text('Poirot credits his solutions to his little grey what?',
         ['Cells', 'Little grey cells', 'Grey cells'],
         'His little grey cells.',
         points=15, seconds=20),

    tf('Columbo’s first name is never revealed in the series.', True,
       'Never spoken on screen. It is glimpsed as “Frank” on his police '
       'ID in one episode, which fans still argue about.',
       points=15),

    mc('In which country is Henning Mankell’s Kurt Wallander a detective?',
       [('Sweden', 1), ('Norway', 0), ('Denmark', 0), ('Finland', 0)],
       'Ystad, in the far south of Sweden.',
       points=15),

    mc('Which English county was the television series Broadchurch filmed in?',
       [('Dorset', 1), ('Cornwall', 0), ('Devon', 0), ('Kent', 0)],
       'Mostly around West Bay in Dorset.',
       points=15),

    wager('Name the Belgian author who created Inspector Maigret.',
          'Georges Simenon',
          'Georges Simenon, who wrote seventy-five Maigret novels.'),
])


pack = {
    'id': 'pack_starter_01',
    'title': 'Play Detective — Starter Case',
    'subtitle': 'Fifty questions across five rounds. Swap them for your own.',
    'createdAt': '2026-09-22T00:00:00.000Z',
    'updatedAt': '2026-09-22T00:00:00.000Z',
    'settings': {
        'liveVotes': True,
        'speedBonus': False,
        'showBoardAfterEach': False,
        'showBoardAfterRound': True,
        'shuffleOptions': False,
        'allowLateJoin': True,
    },
    'rounds': [round1, round2, round3, round4, round5],
}

total = sum(len(r['questions']) for r in pack['rounds'])
assert total == 50, f'expected 50 questions, built {total}'

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as f:
    json.dump(pack, f, indent=2, ensure_ascii=False)
    f.write('\n')

print(f'wrote {os.path.relpath(OUT)}: {total} questions in {len(pack["rounds"])} rounds')
for r in pack['rounds']:
    kinds = {}
    for q in r['questions']:
        kinds[q['type']] = kinds.get(q['type'], 0) + 1
    print(f'  {r["title"]}: {len(r["questions"])} — ' +
          ', '.join(f'{v} {k}' for k, v in sorted(kinds.items())))

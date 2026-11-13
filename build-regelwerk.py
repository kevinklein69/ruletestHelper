"""Zerlegt das Regelbuch-PDF in Abschnitte (z. B. "63.7. Zugesprochenes Tor") → regelwerk.json.
Ein BEV-Regel-Update-PDF ("REGEL-UPDATE 2026/27") wird erkannt; dessen Einträge bekommen
`update` + `refs` (betroffene Regeln) und werden in der Extension bei diesen Regeln angezeigt.

Aufruf:  python3 build-regelwerk.py "<Regelbuch>.pdf" ["<Regel-Update>.pdf" ...]
Braucht pypdf (pip install pypdf).
"""
import collections, json, re, sys
from pypdf import PdfReader

HEAD = re.compile(r'^\s*(\d{1,3}\.\d{1,2})\.\s+(\S.*?)\s*$')          # 63.7. ZUGESPROCHENES TOR
RULE = re.compile(r'^\s*REGEL\s+(\d{1,3})\s+(\S.*?)\s*$')              # REGEL 63 SPIELVERZÖGERUNG
NOISE = re.compile(r'OFFIZIELLES REGELBUCH|^\s*\d\d SEKTION|^\s*INHALTSVERZEICHNIS\s*$')

UPD_HEAD = re.compile(r'^\s*([A-ZÄÖÜ][A-ZÄÖÜ0-9 ,&/\-]+?)\s+·\s+(.+?)\s*$')   # HOHER STOCK · REGEL 60.1
UPD_NOISE = re.compile(r'SCHIEDSRICHTERWESEN|^\s*Kurzüberblick|EISSPORT-VERBAND')

def update_sections(text, season):
    out, cur = [], None
    for line in text.splitlines():
        if UPD_NOISE.search(line):
            continue
        m = UPD_HEAD.match(line)
        if m:
            refs = re.findall(r'\d{1,3}(?:\.\d{1,2})?', m.group(2)) if 'REGEL' in m.group(2) else []
            cur = {'id': '🆕 ' + season, 'title': m.group(1).title(), 'rule': m.group(2).title(),
                   'refs': refs, 'update': True, 'text': ''}
            out.append(cur)
        elif cur and not (line.isupper() and '·' not in line):     # Gruppenüberschriften weg
            cur['text'] += ' ' + line.strip()
    for s in out:
        s['text'] = re.sub(r'\s+', ' ', s['text']).strip()
    return out

NOT_FRAGMENT = re.compile(r'(Team|Mannschaft|Anhang|Kategorie|Regel|Tabelle|Typ)$')

def lone_letters(words, vocab):
    """Einzelne Buchstaben ("V erlassen", "Linie n", "zu s pielen", "b edrohliche") an den Nachbarn
    hängen, mit dem ein häufigeres Wort entsteht; kommt keins heil vor ("ungebührlic h"), an den
    selteneren Nachbarn – der ist eher selbst ein Bruchstück.
    Nicht: Einheiten nach Zahlen ("3 m"), "Team A", "Anhang V", "Kategorie I"."""
    out, i = [], 0
    while i < len(words):
        w, prev = words[i], out[-1] if out else ''
        nxt = words[i + 1] if i + 1 < len(words) else ''
        m = re.fullmatch(r'(\W*)([a-zäöüA-ZÄÖÜ])(\W*)', w)
        if m and not prev[-1:].isdigit() and not (m.group(2).isupper() and NOT_FRAGMENT.search(prev)):
            pre, x, punct = m.groups()
            pw = re.search(r'\w+$', prev) if x.islower() and not pre and prev[-1:].islower() else None
            nw = re.match(r'\w+', nxt) if not punct and (x.isupper() or nxt[:1].islower()) else None
            L = vocab[(pw.group() + x).lower()] if pw else 0
            R = vocab[(x + nw.group()).lower()] if nw else 0
            if not (L or R) and x.islower() and not punct:       # nichts heil → seltenerer Nachbar
                L, R = (1, 0) if pw and (not nw or vocab[pw.group().lower()] <= vocab[nw.group().lower()]) \
                    else (0, 1) if nw else (0, 0)
            if not (L or R) and nw and x.isupper() and nxt[:1].islower():   # "E ntstehung"
                R = 1
            if L and L >= R:
                out[-1] += w; i += 1; continue
            if R:
                out.append(w + nxt); i += 2; continue
        out.append(w); i += 1
    return out

def sections(path):
    pages = [p.extract_text() or '' for p in PdfReader(path).pages]
    m = re.search(r'REGEL-UPDATE\s+(\S+)', pages[0])
    if m:
        return update_sections('\n'.join(pages), 'Regel-Update ' + m.group(1))
    out, rule, cur = [], '', None
    for text in pages:
        for line in text.splitlines():
            if NOISE.search(line) or '.....' in line:      # Kopf-/Fußzeilen, Inhaltsverzeichnis
                continue
            # Gesperrt gesetzte Überschriften "R E G E L  3  B Ä N K E" → "REGEL 3 BÄNKE"
            if all(len(c) <= 1 for part in line.strip().split('  ') for c in part.split(' ')):
                line = ' '.join(p.replace(' ', '') for p in line.strip().split('  ') if p.strip())
            m = RULE.match(line)
            if m and m.group(2).isupper():
                rule = f'Regel {m.group(1)} – {m.group(2).title()}'
                continue
            m = HEAD.match(line)
            if m and m.group(2).upper() == m.group(2) and any(c.isalpha() for c in m.group(2)):
                cur = {'id': m.group(1), 'title': m.group(2).title(), 'rule': rule, 'text': ''}
                out.append(cur)
                continue
            # Zeilen ohne Kleinbuchstaben sind Seitenköpfe ("06 SE K TI ON · KÖ R P …", "ANDERE
            # VERGEHEN"), Tabellenköpfe, Seitenzahlen oder "(I)" – im Fließtext landen sie mitten im Satz.
            if cur and re.search(r'[a-zäöüß]', line):
                cur['text'] += ' ' + line.strip()
    for s in out:   # Silbentrennung "Regel- werk" → "Regelwerk" (nicht "Spieler- oder"), Leerraum glätten
        t = re.sub(r'(\w) ?- (?!(?:und|oder|bzw|sowie)\b)(\w)', r'\1\2', s['text'])
        t = re.sub(r'(?<!\bund)(?<!\boder)(\w) -(\w)', r'\1-\2', t)            # "Break -Aways"
        s['text'] = re.sub(r'\s+', ' ', t).strip()
    # Blocksatz im PDF zerreißt Wörter ("Torlin ie", "wir d", "Tor hüter"): zusammenfügen, wenn
    # das ganze Wort häufiger vorkommt als der seltenere Teil – Bruchstücke sind selten, echte
    # Wortpaare nicht ("bei der": beider 24× < bei 138×; "Tor hüter": Torhüter 233× > hüter 3×).
    exact = collections.Counter(w for s in out for w in re.findall(r'\w+', s['text']))
    vocab = collections.Counter()
    for w, n in exact.items():
        vocab[w.lower()] += n
    for s in out:
        words, fixed = s['text'].split(' '), []
        for w in words:
            # head = Wortanfang ohne Satzzeichen ("n," → "n")
            head, tail = re.match(r'\w*', w).group(), re.search(r'\w+$', fixed[-1]) if fixed else None
            if head and tail and not (tail.group()[-1].isdigit() and w != head):   # "3 1/2", "15 ft)"
                tail = tail.group()
                joined = (tail + head).lower()
                # einzelne Buchstaben ("V erlassen", "Linie n") erledigt lone_letters()
                # kleingeschriebenes Substantiv steht nie allein: "Tor linie", "Gegen spieler"
                noun = head.islower() and exact[head] < exact[head.capitalize()]
                if vocab[joined] and ((tail + head).isdigit() or len(tail) > 1 and len(head) > 1 and   # "Regel 6 2"
                        (noun or vocab[joined] >= min(vocab[tail.lower()], vocab[head.lower()]))):
                    fixed[-1] += w
                    continue
            fixed.append(w)
        t = ' '.join(lone_letters(fixed, vocab))
        s['text'] = t if len(t) <= 8000 else t[:8000].rsplit(' ', 1)[0]   # Anhang/Adressseiten hängen sonst am letzten Abschnitt
    return [s for s in out if len(s['text']) > 40]

if __name__ == '__main__':
    result = [s for p in sys.argv[1:] for s in sections(p)]
    json.dump(result, open('regelwerk.json', 'w', encoding='utf-8'), ensure_ascii=False)
    print(len(result), 'Abschnitte → regelwerk.json')

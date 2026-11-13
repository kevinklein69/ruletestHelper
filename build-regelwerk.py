"""Zerlegt das Regelbuch-PDF in Abschnitte (z. B. "63.7. Zugesprochenes Tor") → regelwerk.json.
Ein BEV-Regel-Update-PDF ("REGEL-UPDATE 2026/27") wird erkannt; dessen Einträge bekommen
`update` + `refs` (betroffene Regeln) und werden in der Extension bei diesen Regeln angezeigt.

Aufruf:  python3 build-regelwerk.py "<Regelbuch>.pdf" ["<Regel-Update>.pdf" ...]
Braucht pypdf (pip install pypdf). regelwerk.json ist urheberrechtlich geschützter Text
→ steht in .gitignore und bleibt lokal.
"""
import json, re, sys
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
            m = RULE.match(line)
            if m and m.group(2).isupper():
                rule = f'Regel {m.group(1)} – {m.group(2).title()}'
                continue
            m = HEAD.match(line)
            if m and m.group(2).upper() == m.group(2) and any(c.isalpha() for c in m.group(2)):
                cur = {'id': m.group(1), 'title': m.group(2).title(), 'rule': rule, 'text': ''}
                out.append(cur)
                continue
            if cur:
                cur['text'] += ' ' + line.strip()
    for s in out:   # Silbentrennung "Regel -werk" → "Regelwerk", Leerraum glätten
        s['text'] = re.sub(r'\s+', ' ', re.sub(r'(\w) ?- (\w)', r'\1\2', s['text'])).strip()
    # Blocksatz im PDF zerreißt Wörter ("Torlin ie", "wir d"): zusammenfügen, wenn das
    # zusammengesetzte Wort sonst im Text vorkommt und mind. ein Teil kein eigenes Wort ist.
    vocab = {w.lower() for s in out for w in re.findall(r'\w+', s['text'])}
    for s in out:
        words, fixed = s['text'].split(' '), []
        for w in words:
            if fixed and re.fullmatch(r'\w+', w) and re.search(r'\w+$', fixed[-1]):
                tail = re.search(r'\w+$', fixed[-1]).group()
                joined = (tail + w).lower()
                if joined in vocab and (tail.lower() not in vocab or w.lower() not in vocab or len(w) <= 2):
                    fixed[-1] += w
                    continue
            fixed.append(w)
        s['text'] = ' '.join(fixed)[:8000]   # Anhang/Adressseiten hängen sonst am letzten Abschnitt
    return [s for s in out if len(s['text']) > 40]

if __name__ == '__main__':
    result = [s for p in sys.argv[1:] for s in sections(p)]
    json.dump(result, open('regelwerk.json', 'w', encoding='utf-8'), ensure_ascii=False)
    print(len(result), 'Abschnitte → regelwerk.json')

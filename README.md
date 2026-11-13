# 🏒 ClassMarker Eishockey Regeltest Helper

Eine Chrome Extension für [classmarker.com](https://classmarker.com), die beim Eishockey-Regeltest automatisch die richtigen Antworten lernt und beim nächsten Durchlauf automatisch ausfüllt.

---

## ✨ Features

- **Automatisches Lernen** — liest die richtigen Antworten von der Ergebnisseite (grüner Haken = richtig)
- **Auto-Fill** — füllt beim nächsten Testdurchlauf alle bekannten Antworten automatisch aus
- **Quiz-Tracking** — speichert auch richtig beantwortete Fragen die nicht auf der Ergebnisseite erscheinen
- **Export / Import** — Antworten als JSON teilen, damit Freunde den Test nicht selbst durchgehen müssen
- **HTML-Export** — durchsuchbare Antwortliste fürs Handy
- **Dark-Mode Overlay** — kleines Widget direkt auf der Seite

---

## 🚀 Installation

1. Dieses Repository herunterladen (grüner **Code**-Button → **Download ZIP**)
2. ZIP entpacken
   - **Windows:** Rechtsklick auf die ZIP-Datei → **Alle extrahieren**
   - **Mac:** Doppelklick auf die ZIP-Datei
3. Chrome öffnen → `chrome://extensions`
4. **Entwicklermodus** oben rechts aktivieren
5. **Entpackte Erweiterung laden** → den entpackten Ordner auswählen

---

## 📦 Antworten direkt mitbenutzen

Im Repository liegt bereits eine fertige Antwortdatei für den IIHF Eishockey Regeltest:

**`eishockey-antworten-2026-06-02.json`**

So importierst du sie:

1. Extension installieren (siehe oben)
2. Auf classmarker.com gehen
3. Im Overlay auf **📥 Antworten importieren** klicken
4. Die JSON-Datei aus dem Ordner auswählen
5. Fertig — alle Fragen sind sofort gespeichert

---

### BEV-Fragenkatalog (eishockey-management.de)

Die Extension läuft auch im BEV-Fragenkatalog — mit einem **eigenen, getrennten Speicher**. ClassMarker- und BEV-Antworten vermischen sich nicht.

- Fertige Antwortdatei: **`bev-fragenkatalog-antworten.json`** (alle 8 Pools, 433 Fragen) — auf eishockey-management.de über das Overlay importieren
- **Üben-Modus:** Lösungen werden nach „Antwort prüfen“ automatisch gelernt
- **🤖 Pool automatisch durchlernen** (im Üben-Modus) bzw. **🤖 Alle Pools durchlernen** (Übersicht) — ca. 12–20 s pro Frage
- **F** füllt bekannte Antworten aus
- **Shift + F** öffnet bzw. schließt Vergleichsleiste + Widget (ähnliche Fragen, Lösungen, Regelstellen) – ohne etwas anzuklicken
- **Gegenseitige Rückfallebene:** Findet eine Seite eine Frage nicht im eigenen Speicher, nimmt sie den Speicher der anderen Seite (z. B. BEV-Antworten im ClassMarker-Test). Dafür beide Dateien je einmal auf ihrer Seite importieren.
- **Abgewandelte Fragen:** Tippfehler, Satzzeichen und Artikel werden toleriert. Nur *ähnliche* Fragen (andere Wörter → oft Fallen) werden nicht angeklickt; stattdessen zeigt ein Vergleichsfenster die ähnlichsten gespeicherten Fragen mit Lösungen und markierten Unterschieden. Prüfen: `node test-fuzzy.js`

---

### 📖 Regelstellen im Vergleichsfenster (optional, lokal)

Bei nicht exakt bekannten Fragen zeigt das Vergleichsfenster die passendsten Abschnitte aus dem Regelbuch (aufklappbar mit vollem Text). Das Regelbuch ist urheberrechtlich geschützt und liegt deshalb **nicht** im Repo — einmal lokal bauen:

```bash
pip install pypdf
python3 build-regelwerk.py "2025-2026 IIHF Regelbuch DE V1.0.pdf" "BEV_Regelupdate_2026-27_Kompakt.pdf"
```

Einträge aus dem Regel-Update erscheinen als **🆕** direkt bei der betroffenen Regel (das Regelbuch selbst ist dort noch die alte Fassung). Danach die Extension unter `chrome://extensions` neu laden. Ohne `regelwerk.json` ist die Funktion einfach aus.

---

## 🔧 Benutzung

| Seite | Was passiert |
|---|---|
| Quiz-Seite | Bekannte Antworten werden automatisch ausgefüllt |
| Ergebnisseite | Richtige Antworten werden automatisch gelernt |
| Überall | Overlay zeigt Anzahl gespeicherter Fragen |

### Overlay-Buttons

| Button | Funktion |
|---|---|
| ▶ Aktuelle Frage ausfüllen | Manuell ausfüllen |
| 📖 Antworten lernen | Ergebnisseite manuell scannen |
| 📤 Antworten exportieren (JSON) | Zum Teilen mit Freunden |
| 📋 Als HTML exportieren | Lesbare Ansicht fürs Handy |
| 📥 Antworten importieren | JSON-Datei importieren |
| 🗑 Löschen | Alle gespeicherten Antworten löschen |

---

## 🛠 Technisches

- Chrome Extension Manifest V3
- Ionic Framework Web Components (Shadow DOM, `ion-item`, `ion-checkbox`, `ion-radio`)
- Eindeutige Fragen-Identifikation über ClassMarkers interne Answer-Hashes (`aux-input`)
- Speicherung via `chrome.storage.local`

// ClassMarker Eishockey Regeltest Helper - Content Script

const STORAGE_KEY  = 'cm_eishockey_answers';
const PENDING_KEY  = 'cm_pending_answers';

let knownAnswers   = {};
let pendingAnswers = {};   // selected answers during current quiz run
let overlayEl      = null;
let overlayStatus  = null;
let overlayCount   = null;
let learnedThisSession = false;
let lastFilledQuestion = '';
let watchDebounce  = null;

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadAnswers() {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY, PENDING_KEY], result => {
      knownAnswers   = result[STORAGE_KEY]  || {};
      pendingAnswers = result[PENDING_KEY]  || {};
      resolve();
    });
  });
}

function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function saveAnswers() {
  if (!isContextValid()) return;
  try { chrome.storage.local.set({ [STORAGE_KEY]: knownAnswers }); } catch {}
}

function savePending() {
  if (!isContextValid()) return;
  try { chrome.storage.local.set({ [PENDING_KEY]: pendingAnswers }); } catch {}
}

function clearPending() {
  pendingAnswers = {};
  if (!isContextValid()) return;
  try { chrome.storage.local.remove(PENDING_KEY); } catch {}
}

// ─── Page detection (URL-based, reliable) ────────────────────────────────────

function isOnResultPage() {
  return location.pathname.includes('/results/');
}

function isOnQuizPage() {
  return location.pathname.includes('/test/') && !isOnResultPage();
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

function normalizeText(text) {
  return (text || '')
    .replace(/ /g, ' ')   // non-breaking space → regular space
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getAnswerText(itemEl) {
  // Most specific: data-cy attribute set by ClassMarker
  const specific = itemEl.querySelector('[data-cy="question-option-text"]');
  if (specific) return normalizeText(specific.textContent);

  // Clone and strip icons/index letters before reading text
  const clone = itemEl.cloneNode(true);
  clone.querySelectorAll('ion-icon, .question-index').forEach(e => e.remove());

  const label = clone.querySelector('ion-label, .question-option, .question-content');
  if (label) return normalizeText(label.textContent).replace(/^[a-z]\.\s*/, '');
  return normalizeText(clone.textContent).replace(/^[a-z]\.\s*/, '');
}

// Strict answer matching — avoids "große strafe" matching "große strafe mit..."
function answerMatches(itemText, savedAnswer) {
  if (!itemText || !savedAnswer) return false;
  if (itemText === savedAnswer) return true;
  // Only allow substring match if lengths are within 15% of each other
  const ratio = Math.min(itemText.length, savedAnswer.length) /
                Math.max(itemText.length, savedAnswer.length);
  if (ratio < 0.85) return false;
  return itemText.includes(savedAnswer) || savedAnswer.includes(itemText);
}

// Returns all answer option elements.
// Both radio and checkbox questions use ion-item as the answer container.
// .checkbox-options-area is a class INSIDE each ion-item (not a wrapper around them).
function getAnswerItems(list) {
  return Array.from(list.querySelectorAll('ion-item'));
}

function getQuestionText(listEl) {
  const el = listEl.querySelector('.question-text .bbcode, .question-text, ion-list-header .bbcode, ion-list-header');
  return el ? normalizeText(el.textContent) : '';
}

// All ion-lists on the page that actually contain a question (have a question text).
// This is intentionally class-agnostic so that any question type is captured,
// regardless of what CSS class ClassMarker puts on the ion-list.
function getQuestionLists() {
  return Array.from(document.querySelectorAll('ion-list')).filter(l => getQuestionText(l) !== '');
}

// Unique storage key for a question.
// ClassMarker reuses identical question text for different questions (same stem, different options).
// We disambiguate by appending the sorted, normalized text of ALL answer options shown for
// this render.
//
// NOTE: we intentionally do NOT use ClassMarker's `input.aux-input` hidden fields for this
// anymore. Their `.value` is only populated once an option has actually been checked — so a
// key built from them changes with every click on a multi-select question (1 hash after the
// first click, 2 hashes after the second, ...) instead of staying stable for the whole
// question. That produced a separate, partial storage entry per click instead of one entry
// with all selected answers, which caused only some of the correct checkboxes to be learned
// / auto-filled for multi-select questions. The answer-text fingerprint below is present from
// the initial render regardless of click state, so it stays constant while the user selects
// answers.
function getQuestionKey(listEl) {
  const qText = getQuestionText(listEl);
  if (!qText) return '';

  const answerFp = getAnswerItems(listEl)
    .map(item => getAnswerText(item)).filter(Boolean).sort().join('\x00');
  return answerFp ? `${qText}\x01${answerFp}` : qText;
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

function createOverlay() {
  if (overlayEl) return;

  overlayEl = document.createElement('div');
  overlayEl.id = 'cm-helper-overlay';
  overlayEl.innerHTML = `
    <div id="cm-header">
      <span id="cm-title">🏒 Regeltest Helper</span>
      <button id="cm-toggle">▴</button>
    </div>
    <div id="cm-body">
      <div id="cm-status">Initialisiere…</div>
      <div id="cm-count"></div>
      <div id="cm-pending"></div>
      <button id="cm-autofill-btn" style="display:none">▶ Aktuelle Frage ausfüllen</button>
      <button id="cm-learn-btn" style="display:none">📖 Antworten lernen</button>
      <button id="cm-export-btn">📤 Antworten exportieren (JSON)</button>
      <button id="cm-export-html-btn">📋 Als HTML exportieren</button>
      <button id="cm-export-pdf-btn">📄 Als PDF exportieren (fürs Handy)</button>
      <button id="cm-import-btn">📥 Antworten importieren</button>
      <input id="cm-import-input" type="file" accept=".json" style="display:none">
      <button id="cm-debug-btn">🔍 DOM analysieren</button>
      <button id="cm-clear-btn">🗑 Gespeicherte Antworten löschen</button>
    </div>
  `;
  document.body.appendChild(overlayEl);

  overlayStatus = document.getElementById('cm-status');
  overlayCount  = document.getElementById('cm-count');

  let collapsed = true;
  overlayEl.classList.add('cm-collapsed');
  document.getElementById('cm-body').style.display = 'none';

  document.getElementById('cm-toggle').addEventListener('click', () => {
    collapsed = !collapsed;
    overlayEl.classList.toggle('cm-collapsed', collapsed);
    document.getElementById('cm-body').style.display = collapsed ? 'none' : 'block';
    document.getElementById('cm-toggle').textContent  = collapsed ? '▴' : '▾';
  });

  document.getElementById('cm-autofill-btn').addEventListener('click', fillCurrentQuestion);
  document.getElementById('cm-learn-btn').addEventListener('click', scrollAndLearn);
  document.getElementById('cm-export-btn').addEventListener('click', exportAnswers);
  document.getElementById('cm-export-html-btn').addEventListener('click', exportAnswersHTML);
  document.getElementById('cm-export-pdf-btn').addEventListener('click', exportAnswersPDF);
  document.getElementById('cm-import-btn').addEventListener('click', () => {
    document.getElementById('cm-import-input').click();
  });
  document.getElementById('cm-import-input').addEventListener('change', e => {
    importAnswers(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('cm-debug-btn').addEventListener('click', debugDOM);
  document.getElementById('cm-clear-btn').addEventListener('click', () => {
    if (confirm('Wirklich alle gespeicherten Antworten löschen?')) {
      knownAnswers = {};
      saveAnswers();
      clearPending();
      updateOverlay();
      setStatus('🗑 Gelöscht.');
    }
  });

  updateOverlay();
}

function setStatus(msg) {
  if (overlayStatus) overlayStatus.textContent = msg;
}

function updateOverlay() {
  const total   = Object.keys(knownAnswers).length;
  const pending = Object.keys(pendingAnswers).length;

  if (overlayCount) overlayCount.textContent = `Gespeichert: ${total} Frage${total !== 1 ? 'n' : ''}`;

  const pendingEl = document.getElementById('cm-pending');
  if (pendingEl) {
    pendingEl.textContent = pending > 0 ? `📝 Ausstehend: ${pending} Antwort${pending !== 1 ? 'en' : ''}` : '';
    pendingEl.style.color = '#a0cfff';
    pendingEl.style.fontSize = '11px';
  }

  const autofillBtn = document.getElementById('cm-autofill-btn');
  const learnBtn    = document.getElementById('cm-learn-btn');
  if (autofillBtn) autofillBtn.style.display = (isOnQuizPage() && total > 0) ? 'block' : 'none';
  if (learnBtn)    learnBtn.style.display    = isOnResultPage() ? 'block' : 'none';
}

// ─── Learning from results page ───────────────────────────────────────────────

async function scrollAndLearn() {
  setStatus('⏬ Scrolle durch alle Fragen…');

  const scrollEl = document.querySelector('ion-content') || document.scrollingElement || document.body;
  let lastCount = 0;
  let stableRounds = 0;

  while (stableRounds < 3) {
    scrollEl.scrollBy ? scrollEl.scrollBy(0, 600) : (scrollEl.scrollTop += 600);
    window.scrollBy(0, 600);
    await new Promise(r => setTimeout(r, 350));

    const count = getQuestionLists().length;

    stableRounds = count === lastCount ? stableRounds + 1 : 0;
    lastCount = count;
    setStatus(`⏬ Lade Fragen… (${lastCount} gefunden)`);
  }

  scrollEl.scrollTo ? scrollEl.scrollTo(0, 0) : (scrollEl.scrollTop = 0);
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 300));

  const fromResults = learnFromResults();
  const fromPending = mergePending();
  updateOverlay();
  const total = Object.keys(knownAnswers).length;
  setStatus(`✅ ${total} gespeichert — ${fromResults} von Ergebnisseite, ${fromPending} aus Quiz-Tracking.`);
}

function learnFromResults() {
  let learned = 0;

  getQuestionLists().forEach(list => {
    const qText = getQuestionText(list);
    const correctAnswers = [];

    getAnswerItems(list).forEach(item => {
      const hasTick    = item.querySelector('.circular-tick, .circular-tick-holo');
      const hasX       = item.querySelector('.circular-x');
      const isSelected = item.classList.contains('item-radio-checked') ||
                         item.classList.contains('item-checkbox-checked') ||
                         item.classList.contains('checkbox-checked');

      // Tick without X = definitively correct answer
      if (hasTick && !hasX) {
        const t = getAnswerText(item);
        if (t && !correctAnswers.includes(t)) correctAnswers.push(t);
      }
      // Selected with no markers = user answered this correctly
      else if (isSelected && !hasX && !hasTick) {
        const t = getAnswerText(item);
        if (t && !correctAnswers.includes(t)) correctAnswers.push(t);
      }
    });

    if (correctAnswers.length > 0) {
      const qKey = getQuestionKey(list);
      if (qKey !== qText) delete knownAnswers[qText]; // remove old ambiguous entry
      knownAnswers[qKey] = correctAnswers;
      learned++;
      console.log('[CM Helper] Gelernt:', qKey.substring(0, 60), '→', correctAnswers);
    }
  });

  learnedThisSession = true;
  saveAnswers();
  return learned;
}

// Merge pending (quiz-time selections) into knownAnswers for questions
// correctly answered (not shown on results page, so no tick icon available).
function mergePending() {
  const pendingKeys   = Object.keys(pendingAnswers);
  const knownKeys     = Object.keys(knownAnswers);
  let merged = 0;

  console.log('[CM Helper] Pending keys:', pendingKeys.length, '| Known keys:', knownKeys.length);

  pendingKeys.forEach(pKey => {
    const answers = pendingAnswers[pKey];
    if (!answers || answers.length === 0) return;

    // Already stored under the exact key (learnFromResults already handled it)
    if (knownAnswers[pKey]) {
      console.log('[CM Helper] Merge skip (exact key exists):', pKey.substring(0, 50));
      return;
    }

    const hasFingerprint = pKey.includes('|') || pKey.includes('\x01');
    const qOnly = hasFingerprint ? pKey.split(/[|\x01]/)[0] : pKey;

    if (hasFingerprint) {
      // Fingerprinted key is authoritative — save it and remove old text-only entry
      if (knownAnswers[qOnly]) delete knownAnswers[qOnly];
      knownAnswers[pKey] = answers;
      merged++;
      console.log('[CM Helper] Merge OK (ersetzt alt):', qOnly.substring(0, 50), '→', answers);
    } else if (!knownAnswers[qOnly]) {
      // Text-only key: only save if nothing exists at all
      knownAnswers[pKey] = answers;
      merged++;
      console.log('[CM Helper] Merge OK:', pKey.substring(0, 50), '→', answers);
    } else {
      console.log('[CM Helper] Merge skip (text-only collision):', pKey.substring(0, 50));
    }
  });

  if (merged > 0) saveAnswers();
  clearPending();
  return merged;
}

// ─── Auto-fill on quiz page ───────────────────────────────────────────────────

function findBestMatch(listEl) {
  const fullKey = getQuestionKey(listEl);
  const qText   = getQuestionText(listEl);

  // Exact full-key match (unambiguous — includes answer fingerprint)
  if (knownAnswers[fullKey]) return knownAnswers[fullKey];

  // Exact text-only match (backward compat with pre-fingerprint stored data)
  if (knownAnswers[qText]) return knownAnswers[qText];

  // Near-text fallback — strips fingerprint (either legacy "|" or "\x01" format) from stored
  // keys before comparing. This only fires when we have NO exact match for the answer options
  // actually shown right now, i.e. this specific question render was never learned before.
  //
  // ClassMarker reuses identical question text for genuinely different questions (different
  // correct answers depending on which option pool is shown — see getQuestionKey). If several
  // stored entries share this question's text but disagree on the answer set, we cannot tell
  // which one belongs to the variant currently on screen. Guessing one of them risks ticking
  // wrong/incomplete boxes, which is worse than leaving the question unanswered. So: only
  // auto-fill from this fallback when every matching stored entry agrees on the same answer
  // set (harmless — same question, just a legacy/slightly different key format) or there is
  // exactly one candidate. If they disagree, return null and let the user answer manually.
  const candidates = [];
  for (const [key, val] of Object.entries(knownAnswers)) {
    const keyText = key.split(/[|\x01]/)[0];
    const ratio = Math.min(qText.length, keyText.length) / Math.max(qText.length, keyText.length);
    if (ratio < 0.90) continue;
    if (!(qText.includes(keyText) || keyText.includes(qText))) continue;
    candidates.push(val);
  }
  if (candidates.length === 0) return null;

  const distinctSets = new Set(candidates.map(v => JSON.stringify([...v].sort())));
  if (distinctSets.size > 1) {
    console.log('[CM Helper] Mehrdeutig — mehrere unterschiedliche Antwort-Sets für "' +
      qText.substring(0, 60) + '" gefunden, kein Auto-Fill:', candidates);
    return null;
  }
  // All candidates agree — return the most complete-looking one (longest array).
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

function ionClick(el) {
  // Use native .click() — it generates a trusted event that Ionic accepts.
  // Target the specific interactive element inside the ion-item.
  const target =
    el.querySelector('ion-checkbox') ||
    el.querySelector('ion-radio') ||
    el;
  target.click();
}

function fillQuestionList(list) {
  const qText = getQuestionText(list);
  if (!qText) return false;

  const saved = findBestMatch(list);
  if (!saved) return false;

  let applied = false;
  getAnswerItems(list).forEach(item => {
    const t = getAnswerText(item);
    if (!t) return;
    if (saved.some(a => answerMatches(t, a))) {
      ionClick(item);
      applied = true;
      console.log('[CM Helper] Clicked:', t.substring(0, 50));
    }
  });
  return applied;
}

function fillCurrentQuestion() {
  if (Object.keys(knownAnswers).length === 0) {
    setStatus('⚠️ Keine gespeicherten Antworten vorhanden.');
    return;
  }
  const lists = getQuestionLists();

  if (lists.length === 0) {
    setStatus('⚠️ Keine Frage im DOM gefunden.');
    console.log('[CM Helper] fillCurrentQuestion: keine ion-list gefunden');
    return;
  }

  let filled = 0;
  lists.forEach(list => {
    const qText = getQuestionText(list);
    const match = findBestMatch(list);
    console.log('[CM Helper] Frage:', qText.substring(0, 60));
    console.log('[CM Helper] Key:', getQuestionKey(list).substring(0, 80));
    console.log('[CM Helper] Match:', match);
    if (match) {
      if (fillQuestionList(list)) filled++;
    } else {
      console.log('[CM Helper] Kein Match für diese Frage.');
    }
  });

  setStatus(filled > 0 ? `✅ ${filled} Frage(n) ausgefüllt` : '⚠️ Kein Match — Details in Konsole (F12).');
}

// ─── Single observer: tracks selections + auto-fills new questions ────────────

function startMainObserver() {
  const observer = new MutationObserver(mutations => {
    // ── 1. Track ion-item selections (class attribute changes) ──────────────
    if (isOnQuizPage()) {
      for (const mutation of mutations) {
        if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') continue;
        const item = mutation.target;
        if (!item.tagName || item.tagName.toLowerCase() !== 'ion-item') continue;

        const isChecked = item.classList.contains('item-radio-checked') ||
                          item.classList.contains('item-checkbox-checked');
        if (!isChecked) continue;

        const list = item.closest('ion-list');
        if (!list) continue;

        const qText = getQuestionText(list);
        if (!qText) continue;
        const answerText = getAnswerText(item);
        if (!answerText) continue;

        const qKey = getQuestionKey(list);
        const isCheckbox = !!list.querySelector('ion-checkbox');
        if (!pendingAnswers[qKey]) pendingAnswers[qKey] = [];
        if (isCheckbox) {
          if (!pendingAnswers[qKey].includes(answerText))
            pendingAnswers[qKey].push(answerText);
        } else {
          pendingAnswers[qKey] = [answerText];
        }
        savePending();
        updateOverlay();
        console.log('[CM Helper] Pending:', qText.substring(0, 40), '→', answerText.substring(0, 40));
      }
    }

    // Stop if extension was reloaded — prevents "context invalidated" errors
    if (!isContextValid()) { observer.disconnect(); return; }

    // ── 2. Auto-fill new questions + detect result page ─────────────────────
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      if (isOnResultPage()) {
        if (!learnedThisSession) scrollAndLearn();
        return;
      }
      if (!isOnQuizPage()) return;
      if (Object.keys(knownAnswers).length === 0) return;

      getQuestionLists().forEach(list => {
        const alreadyChecked = list.querySelector(
          '.radio-checked, ion-radio[aria-checked="true"], ion-checkbox[aria-checked="true"], .item-checkbox-checked, .item-radio-checked'
        );
        if (alreadyChecked) return;
        const qText = getQuestionText(list);
        if (!qText || qText === lastFilledQuestion) return;
        if (fillQuestionList(list)) {
          lastFilledQuestion = qText;
          setStatus('✅ Antwort eingetragen.');
        }
      });
    }, 400);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
}

// ─── Debug ────────────────────────────────────────────────────────────────────

function debugDOM() {
  const lines = [];
  lines.push('=== ClassMarker Debug ===');
  lines.push(`URL: ${location.href}`);
  lines.push(`isOnResultPage: ${isOnResultPage()}, isOnQuizPage: ${isOnQuizPage()}`);
  lines.push(`knownAnswers: ${Object.keys(knownAnswers).length}, pendingAnswers: ${Object.keys(pendingAnswers).length}`);

  const lists = getQuestionLists();
  lines.push(`\nFrage-Listen: ${lists.length}`);
  lists.forEach((list, i) => {
    const qText = getQuestionText(list);
    const qKey  = getQuestionKey(list);
    const items = list.querySelectorAll('ion-item');
    const ticks = list.querySelectorAll('.circular-tick, .circular-tick-holo');
    const xs    = list.querySelectorAll('.circular-x');
    const hasAux = list.querySelectorAll('input.aux-input').length;
    const inStorage = knownAnswers[qKey] ? '✅ gespeichert' : (knownAnswers[qText] ? '⚠️ alt-format' : '❌ unbekannt');
    lines.push(`  [${i}] ${inStorage} | aux-inputs:${hasAux} | items:${items.length} ticks:${ticks.length} x:${xs.length}`);
    lines.push(`       Text: "${qText.substring(0,70)}"`);
    lines.push(`       Key:  "${qKey.substring(0,80)}"`);
    items.forEach((item, j) => {
      const mark = item.querySelector('.circular-tick,.circular-tick-holo') ? '✅' :
                   item.querySelector('.circular-x') ? '❌' : '○';
      lines.push(`    (${j}) ${mark} "${getAnswerText(item).substring(0,60)}"`);
    });
  });

  // Show duplicate question texts — these are the ones that need disambiguation
  lines.push('\n=== Doppelte Fragetexte im Speicher ===');
  const textCount = {};
  Object.keys(knownAnswers).forEach(k => {
    const t = k.split('|')[0].split('\x01')[0];
    textCount[t] = (textCount[t] || 0) + 1;
  });
  const dupes = Object.entries(textCount).filter(([, n]) => n > 1);
  if (dupes.length === 0) {
    lines.push('  Keine — alle Fragetexte sind eindeutig gespeichert.');
  } else {
    dupes.forEach(([t, n]) => lines.push(`  ${n}x "${t.substring(0, 70)}"`));
  }

  if (lists.length > 0) {
    lines.push('\n--- HTML erste Liste ---');
    lines.push(lists[0].outerHTML.substring(0, 3000));
  }

  const out = lines.join('\n');
  console.log(out);
  setStatus('🔍 Ausgabe in Konsole (F12)');
  const win = window.open('', '_blank', 'width=700,height=600,scrollbars=yes');
  if (win) win.document.write(`<pre style="font-size:12px;padding:10px;white-space:pre-wrap">${out.replace(/</g,'&lt;')}</pre>`);
}

// ─── Export / Import ──────────────────────────────────────────────────────────

function exportAnswers() {
  const total = Object.keys(knownAnswers).length;
  if (total === 0) {
    setStatus('⚠️ Keine Antworten zum Exportieren.');
    return;
  }
  const data = JSON.stringify(knownAnswers, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `eishockey-antworten-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`📤 ${total} Antworten exportiert.`);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function exportAnswersHTML() {
  const total = Object.keys(knownAnswers).length;
  if (total === 0) {
    setStatus('⚠️ Keine Antworten zum Exportieren.');
    return;
  }

  const entries = Object.entries(knownAnswers);
  const questionsHtml = entries.map(([q, answers], i) => {
    const answersHtml = answers.map(a => `<li class="answer">${escapeHtml(a)}</li>`).join('');
    const searchData  = escapeHtml((q + ' ' + answers.join(' ')).toLowerCase());
    return `<div class="card" data-search="${searchData}">
        <div class="num">Frage ${i + 1} von ${total}</div>
        <div class="q">${escapeHtml(q)}</div>
        <ul class="answers">${answersHtml}</ul>
      </div>`;
  }).join('\n');

  const date = new Date().toLocaleDateString('de-DE');
  const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Eishockey Regeltest – Antworten</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;background:#1a1a2e;color:#e0e0e0;min-height:100vh;-webkit-text-size-adjust:100%}
    header{background:#0f3460;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0));padding-top:calc(12px + env(safe-area-inset-top,0));position:sticky;top:0;z-index:10;box-shadow:0 2px 10px rgba(0,0,0,.4)}
    h1{font-size:17px;margin-bottom:4px}
    .meta{font-size:12px;color:#7a9cc0;margin-bottom:8px}
    /* font-size:16px stops iOS Safari zooming in on focus */
    #search{width:100%;padding:12px 14px;border-radius:8px;border:1px solid #2d7bb5;background:#16213e;color:#e0e0e0;font-size:16px;outline:none}
    #search::placeholder{color:#7a9cc0}
    #search:focus{border-color:#a0cfff}
    #count{font-size:12px;color:#7a9cc0;margin-top:6px}
    main{padding:16px;max-width:700px;margin:0 auto;display:flex;flex-direction:column;gap:10px}
    .card{background:#16213e;border:1px solid #0f3460;border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
    .card.hidden{display:none}
    .num{font-size:11px;color:#7a9cc0}
    /* overflow-wrap breaks the long glued words (…unterbrechungoder) instead of scrolling sideways */
    .q{font-size:15px;line-height:1.5;overflow-wrap:anywhere}
    .answers{list-style:none;display:flex;flex-direction:column;gap:4px}
    .answer{background:#1a4b2e;border:1px solid #2d9b55;border-radius:6px;padding:8px 10px;font-size:14px;color:#7ddd9a;overflow-wrap:anywhere}
    mark{background:#ffd24a;color:#1a1a2e;border-radius:2px;padding:0 1px}
    #no-results{display:none;text-align:center;color:#7a9cc0;padding:40px 20px;font-size:14px}
  </style>
</head>
<body>
  <header>
    <h1>🏒 Eishockey Regeltest – Antworten</h1>
    <p class="meta">Exportiert am ${date} &middot; ${total} Fragen &middot; Suche v2 (Multi-Wort)</p>
    <input id="search" type="search" placeholder="Frage oder Antwort suchen…" autocomplete="off" autocapitalize="off" autocorrect="off">
    <div id="count">${total} Fragen angezeigt</div>
  </header>
  <main id="list">
    ${questionsHtml}
    <div id="no-results">Keine Fragen gefunden.</div>
  </main>
  <script>
    // Fold umlauts/diacritics so "muessen"/"mussen" both find "müssen".
    function fold(s){
      return s.toLowerCase()
        .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
        .normalize('NFD').replace(/[\\u0300-\\u036f]/g,'')
        .replace(/\\s+/g,' ').trim();
    }
    const search = document.getElementById('search');
    const cards  = document.querySelectorAll('.card');
    const countEl = document.getElementById('count');
    const noRes  = document.getElementById('no-results');
    // Precompute folded haystack per card once.
    cards.forEach(c => { c._hay = fold(c.dataset.search); });
    function runSearch() {
      // Split into words → every word must match (AND), order-independent.
      const tokens = fold(search.value).split(' ').filter(Boolean);
      let n = 0;
      cards.forEach(c => {
        const show = tokens.length === 0 || tokens.every(t => c._hay.includes(t));
        c.classList.toggle('hidden', !show);
        if (show) n++;
      });
      countEl.textContent = n + ' Frage' + (n !== 1 ? 'n' : '') + ' angezeigt';
      noRes.style.display = n === 0 ? 'block' : 'none';
    }
    // Mobile keyboards (predictive text / autocorrect) don't fire 'input'
    // reliably during composition — bind the extra events so it still runs.
    ['input','compositionend','change','search','keyup'].forEach(ev =>
      search.addEventListener(ev, runSearch));
    // Proof that JS actually runs here. If you DON'T see "✅ Suche aktiv"
    // on your phone, the file was opened in an in-app viewer without JS —
    // open it in a real browser (Chrome/Safari) instead.
    countEl.textContent = '✅ Suche aktiv · ' + countEl.textContent;
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `eishockey-antworten-${new Date().toISOString().slice(0,10)}.html`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`📋 ${total} Antworten als HTML exportiert.`);
}

function exportAnswersPDF() {
  const total = Object.keys(knownAnswers).length;
  if (total === 0) {
    setStatus('⚠️ Keine Antworten zum Exportieren.');
    return;
  }

  const entries = Object.entries(knownAnswers);
  const cardsHtml = entries.map(([q, answers], i) => {
    const answersHtml = answers.map(a => `<li>${escapeHtml(a)}</li>`).join('');
    return `<div class="card">
        <div class="num">Frage ${i + 1} von ${total}</div>
        <div class="q">${escapeHtml(q)}</div>
        <ul>${answersHtml}</ul>
      </div>`;
  }).join('\n');

  const date = new Date().toLocaleDateString('de-DE');
  // Light theme + print CSS: readable on paper/PDF, cards don't break across pages.
  const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>Eishockey Regeltest – Antworten</title>
  <style>
    @page { margin: 14mm; }
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',Arial,sans-serif;color:#111;line-height:1.5}
    h1{font-size:18px;margin-bottom:2px}
    .meta{font-size:11px;color:#555;margin-bottom:14px}
    .card{border:1px solid #bbb;border-radius:6px;padding:10px 12px;margin-bottom:8px;page-break-inside:avoid}
    .num{font-size:10px;color:#777;margin-bottom:3px}
    .q{font-size:13px;font-weight:600;margin-bottom:6px;overflow-wrap:anywhere}
    ul{list-style:none}
    li{font-size:12px;background:#eaf7ee;border:1px solid #bfe3c8;border-radius:4px;padding:5px 8px;margin-top:3px;overflow-wrap:anywhere}
  </style>
</head>
<body onload="window.print()">
  <h1>🏒 Eishockey Regeltest – Antworten</h1>
  <p class="meta">Exportiert am ${date} · ${total} Fragen · im PDF-Viewer mit der 🔍-Lupe suchen</p>
  ${cardsHtml}
</body>
</html>`;

  // Open in a new tab; onload triggers the print dialog → "Als PDF speichern".
  const w = window.open('', '_blank');
  if (!w) {
    setStatus('⚠️ Pop-up blockiert – bitte Pop-ups für diese Seite erlauben.');
    return;
  }
  w.document.write(html);
  w.document.close();
  setStatus(`📄 ${total} Antworten – im Druckdialog "Als PDF speichern" wählen.`);
}

function importAnswers(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (typeof imported !== 'object' || Array.isArray(imported)) throw new Error();
      let added = 0;
      Object.entries(imported).forEach(([q, a]) => {
        if (!knownAnswers[q]) added++;
        knownAnswers[q] = a; // imported data always wins
      });
      saveAnswers();
      updateOverlay();
      setStatus(`📥 ${Object.keys(imported).length} Antworten importiert (+${added} neu).`);
    } catch {
      setStatus('⚠️ Import fehlgeschlagen – ungültige Datei.');
    }
  };
  reader.readAsText(file);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await loadAnswers();
  createOverlay();

  if (isOnResultPage()) {
    setStatus('📋 Ergebnisseite – scrolle und lerne…');
    setTimeout(scrollAndLearn, 1500);
  } else if (isOnQuizPage()) {
    const total = Object.keys(knownAnswers).length;
    if (total > 0) {
      setStatus(`💡 ${total} Antworten gespeichert – fülle aus…`);
      setTimeout(() => { fillCurrentQuestion(); updateOverlay(); }, 1200);
    } else {
      setStatus('📝 Quiz – beantworte die Fragen, Antworten werden gespeichert.');
    }
  } else {
    setStatus('⏳ Warte auf Quiz oder Ergebnisseite…');
  }

  updateOverlay();
  startMainObserver();
}

init();

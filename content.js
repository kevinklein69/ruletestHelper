// ClassMarker Eishockey Regeltest Helper - Content Script

// Runs on two sites: ClassMarker and the BEV-Fragenkatalog (eishockey-management.de).
// Question wording can differ between the two, so each site gets its OWN storage key —
// import/export/clear/auto-fill only ever touch the store of the site you're on.
const IS_BEV       = location.hostname.endsWith('eishockey-management.de');
const STORAGE_KEY  = IS_BEV ? 'bev_fragenkatalog_answers' : 'cm_eishockey_answers';
const OTHER_KEY    = IS_BEV ? 'cm_eishockey_answers' : 'bev_fragenkatalog_answers';
const PENDING_KEY  = 'cm_pending_answers';
const EXPORT_NAME  = IS_BEV ? 'bev-fragenkatalog-antworten' : 'eishockey-antworten';
const EXPORT_TITLE = IS_BEV ? 'BEV-Fragenkatalog – Antworten' : 'Eishockey Regeltest – Antworten';

let knownAnswers   = {};
let otherAnswers   = {};   // the OTHER site's store — read-only fallback for auto-fill/compare panel
let pendingAnswers = {};   // selected answers during current quiz run
let overlayEl      = null;
let overlayStatus  = null;
let overlayCount   = null;
let learnedThisSession = false;
let watchDebounce  = null;
let fuzzyFilled    = 0;    // fuzzy-matched questions filled in the last fillCurrentQuestion()

// ─── Storage ──────────────────────────────────────────────────────────────────

function loadAnswers() {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY, OTHER_KEY, PENDING_KEY], result => {
      knownAnswers   = result[STORAGE_KEY]  || {};
      otherAnswers   = result[OTHER_KEY]    || {};
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
  if (IS_BEV) return false; // BEV gives feedback per question, learned via learnFromVisibleFeedback
  return location.pathname.includes('/results/');
}

function isOnQuizPage() {
  if (IS_BEV) return !!document.getElementById('fkFrage');
  return location.pathname.includes('/test/') && !isOnResultPage();
}

// BEV page script declares `const UEBEN = true` in practice mode (solutions are shown).
function isBevPracticeMode() {
  return IS_BEV && [...document.scripts].some(s => /const UEBEN\s*=\s*true\b/.test(s.textContent));
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
  clone.querySelectorAll('ion-icon, .question-index, .fk-key').forEach(e => e.remove());

  const label = clone.querySelector('ion-label, .question-option, .question-content');
  if (label) return normalizeText(label.textContent).replace(/^[a-z]\.\s*/, '');
  return normalizeText(clone.textContent).replace(/^[a-z]\.\s*/, '');
}

// Strict answer matching — avoids "große strafe" matching "große strafe mit..."
// ClassMarker uses true/false where BEV uses ja/nein; texts sometimes lose a space ("denhelm").
const YES_NO = { ja: 'ja', true: 'ja', richtig: 'ja', wahr: 'ja', nein: 'nein', false: 'nein', falsch: 'nein' };
const canonAnswer = t => YES_NO[t] || t.replace(/\s+/g, '');

function answerMatches(itemText, savedAnswer) {
  if (!itemText || !savedAnswer) return false;
  if (canonAnswer(itemText) === canonAnswer(savedAnswer)) return true;
  // Only allow substring match if lengths are within 15% of each other
  const ratio = Math.min(itemText.length, savedAnswer.length) /
                Math.max(itemText.length, savedAnswer.length);
  if (ratio < 0.85) return false;
  return itemText.includes(savedAnswer) || savedAnswer.includes(itemText);
}

// Returns all answer option elements.
// Both radio and checkbox questions use ion-item as the answer container.
// .checkbox-options-area is a class INSIDE each ion-item (not a wrapper around them).
// BEV: <button class="fk-opt" data-key="A"> inside #fkOptionen.
function getAnswerItems(list) {
  return Array.from(list.querySelectorAll(IS_BEV ? 'button.fk-opt' : 'ion-item'));
}

function getQuestionEl(listEl) {
  return listEl.querySelector(IS_BEV ? '#fkFrage'
    : '.question-text .bbcode, .question-text, ion-list-header .bbcode, ion-list-header');
}

function getQuestionText(listEl) {
  const el = getQuestionEl(listEl);
  return el ? normalizeText(el.textContent) : '';
}

// All ion-lists on the page that actually contain a question (have a question text).
// This is intentionally class-agnostic so that any question type is captured,
// regardless of what CSS class ClassMarker puts on the ion-list.
// BEV shows exactly one question at a time inside .fk-card.
function getQuestionLists() {
  const lists = IS_BEV ? document.querySelectorAll('.fk-card') : document.querySelectorAll('ion-list');
  return Array.from(lists).filter(l => getQuestionText(l) !== '');
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

// Drag an overlay by its head (selector, so re-rendered heads keep working). Position is
// remembered per overlay in chrome.storage; double-click on the head resets to the default spot.
function makeDraggable(el, headSel) {
  const key = 'cmPos_' + el.id;
  const place = p => Object.assign(el.style, p
    ? { left: p.x + 'px', top: p.y + 'px', right: 'auto', width: p.w ? p.w + 'px' : '' }
    : { left: '', top: '', right: '', width: '' });
  try { chrome.storage.local.get([key], r => r[key] && place(r[key])); } catch {}
  el.addEventListener('dblclick', e => {
    if (!e.target.closest(headSel) || e.target.closest('button')) return;
    place(null);
    try { chrome.storage.local.remove(key); } catch {}
  });
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.target.closest(headSel) || e.target.closest('button')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const w = el.id === 'cm-compare' ? Math.round(r.width) : 0;   // bar is sized by left+right → freeze width
    let pos = null;
    const move = ev => {
      // keep the whole overlay on screen, same rule on every edge
      pos = { x: Math.round(Math.max(0, Math.min(ev.clientX - dx, innerWidth - r.width))),
              y: Math.round(Math.max(0, Math.min(ev.clientY - dy, innerHeight - r.height))), w };
      place(pos);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (pos) try { chrome.storage.local.set({ [key]: pos }); } catch {}
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

function createOverlay() {
  if (overlayEl) return;

  overlayEl = document.createElement('div');
  overlayEl.id = 'cm-helper-overlay';
  overlayEl.innerHTML = `
    <div id="cm-header">
      <span id="cm-title">🏒 ${IS_BEV ? 'BEV-Fragenkatalog' : 'Regeltest Helper'}</span>
      <button id="cm-toggle">▴</button>
    </div>
    <div id="cm-body">
      <div id="cm-status">Initialisiere…</div>
      <div id="cm-count"></div>
      <div id="cm-pending"></div>
      <button id="cm-autofill-btn" style="display:none">▶ Aktuelle Frage ausfüllen</button>
      <button id="cm-compare-btn">🔎 Vergleichen &amp; Regelstellen (Shift+F)</button>
      <button id="cm-learn-btn" style="display:none">📖 Antworten lernen</button>
      <button id="cm-harvest-btn" style="display:none">🤖 Pool automatisch durchlernen</button>
      <button id="cm-harvest-all-btn" style="display:none">🤖 Alle Pools durchlernen</button>
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
  makeDraggable(overlayEl, '#cm-header');

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
  document.getElementById('cm-compare-btn').addEventListener('click', () => {
    const lists = getQuestionLists();
    if (!lists.length) return setStatus('⚠️ Keine Frage auf der Seite gefunden.');
    renderCompare(lists);
  });

  document.addEventListener('keydown', e => {
    if (e.key?.toLowerCase() !== 'f' || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.shiftKey) {   // Shift+F toggles: compare bar + expanded widget ⇄ both closed
      const panel = document.getElementById('cm-compare');
      const collapsed = overlayEl.classList.contains('cm-collapsed');
      if (panel) {
        panel.remove();
        clearQuestionHighlights();
        if (!collapsed) document.getElementById('cm-toggle').click();
        return;
      }
      if (collapsed) document.getElementById('cm-toggle').click();
      return document.getElementById('cm-compare-btn').click();
    }
    fillCurrentQuestion();
  });
  document.getElementById('cm-learn-btn').addEventListener('click', scrollAndLearn);
  document.getElementById('cm-harvest-btn').addEventListener('click', harvestBevPool);
  document.getElementById('cm-harvest-all-btn').addEventListener('click', startHarvestAll);
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

  if (overlayCount) overlayCount.textContent = `Gespeichert: ${total} Frage${total !== 1 ? 'n' : ''} · v${chrome.runtime.getManifest().version}`;

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
  const harvestBtn = document.getElementById('cm-harvest-btn');
  if (harvestBtn)  harvestBtn.style.display  = isBevPracticeMode() ? 'block' : 'none';
  const harvestAllBtn = document.getElementById('cm-harvest-all-btn');
  if (harvestAllBtn) harvestAllBtn.style.display =
    (IS_BEV && document.querySelector('a[title^="Üben"]')) ? 'block' : 'none';
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

// Reads the tick/cross markers ClassMarker renders on an answered question and returns the
// texts of the answer options that are confirmed correct.
//
// `.circular-tick` = the option you selected, marked correct.
// `.circular-tick-holo` = a correct option you did NOT select (still counts!) — easy to miss,
// this is what made question 1 ("...große strafe zwingend...") look 2-answer when it's really
// 4-answer: two of the four correct options only show the "holo" (outline) tick because they
// weren't picked.
// `.circular-x` = selected but wrong.
//
// `trustSelectedFallback` controls whether a selected item with NEITHER icon should be assumed
// correct — only safe when the whole page never renders tick/cross markers at all (see callers).
function extractCorrectAnswers(list, trustSelectedFallback) {
  const correctAnswers = [];
  getAnswerItems(list).forEach(item => {
    // BEV marks the option button itself: .correct (right, selected or not) / .wrong
    const hasTick    = IS_BEV ? item.classList.contains('correct') : item.querySelector('.circular-tick, .circular-tick-holo');
    const hasX       = IS_BEV ? item.classList.contains('wrong')   : item.querySelector('.circular-x');
    const isSelected = item.classList.contains('item-radio-checked') ||
                       item.classList.contains('item-checkbox-checked') ||
                       item.classList.contains('checkbox-checked');

    // Tick (selected or holo/unselected) without X = definitively correct answer
    if (hasTick && !hasX) {
      const t = getAnswerText(item);
      if (t && !correctAnswers.includes(t)) correctAnswers.push(t);
    }
    // Selected with no markers at all = only trust this if the page never shows markers.
    // Otherwise a selected-but-actually-wrong answer (marker just not rendered/found) would get
    // silently learned as "correct" — this previously poisoned stored data.
    else if (isSelected && !hasX && !hasTick && trustSelectedFallback) {
      const t = getAnswerText(item);
      if (t && !correctAnswers.includes(t)) correctAnswers.push(t);
    }
  });
  return correctAnswers;
}

function learnFromResults() {
  let learned = 0;

  // Whether this results page renders explicit tick/cross markers at all. Computed once so we
  // don't have to guess per-question. If markers are used ANYWHERE on the page, a selected item
  // with no tick is untrustworthy — see extractCorrectAnswers.
  const pageUsesMarkers = !!document.querySelector('.circular-tick, .circular-tick-holo, .circular-x');

  getQuestionLists().forEach(list => {
    const qText = getQuestionText(list);
    const correctAnswers = extractCorrectAnswers(list, !pageUsesMarkers);

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

// Learn from ClassMarker's immediate per-question feedback ("Übungsmodus" — you answer one
// question, click "Weiter", and it shows tick/cross icons + a "Bewertung" box right there,
// still on the /test/ URL). isOnResultPage() only fires for the final /results/ page, so this
// richer, more-immediate feedback was previously never learned from at all — every answer
// captured during practice mode came only from the raw click-tracking in startMainObserver,
// which has no way to know if a selection was actually correct.
const learnedFeedbackKeys = new Set();

function learnFromVisibleFeedback() {
  let learned = 0;

  getQuestionLists().forEach(list => {
    const hasFeedback = list.querySelector(IS_BEV ? '.fk-opt.correct'
      : '.circular-tick, .circular-tick-holo, .circular-x');
    if (!hasFeedback) return;

    const qKey = getQuestionKey(list);
    if (!qKey || learnedFeedbackKeys.has(qKey)) return;

    // Feedback icons are present on this exact list, so trust them fully (no fallback needed).
    const correctAnswers = extractCorrectAnswers(list, false);
    if (correctAnswers.length === 0) return;

    const qText = getQuestionText(list);
    if (qKey !== qText) delete knownAnswers[qText];
    knownAnswers[qKey] = correctAnswers;
    learnedFeedbackKeys.add(qKey);
    learned++;
    console.log('[CM Helper] Sofort-Feedback gelernt:', qKey.substring(0, 60), '→', correctAnswers);
  });

  if (learned > 0) {
    saveAnswers();
    updateOverlay();
    setStatus(`✅ ${learned} Frage(n) aus Sofort-Feedback gelernt.`);
  }
}

// BEV "Üben" mode: walks through the whole pool — picks option A, "Antwort prüfen", learns the
// solution the server marks with .correct, "Weiter" — until the result screen shows up.
// Only allowed in practice mode: in a real test there's no solution shown, so it would just
// submit A for everything. It still stops if no solution appears within 5s.
// Note: this counts as answered questions in your BEV-Fragenkatalog statistics.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sleepRandom = (minMs, maxMs) => sleep(minMs + Math.random() * (maxMs - minMs));

// Pacing per question: "reading" pause before answering + pause after the solution shows.
// ~12–20s per question → a 47-question pool takes roughly 10–15 minutes.
const HARVEST_READ_MS  = [9000, 14000];
const HARVEST_AFTER_MS = [2500, 4500];

async function waitFor(fn, timeout = 5000) {
  for (let t = 0; t < timeout; t += 100) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
}

let harvesting  = false;
let harvestStop = false;

// "Alle Pools durchlernen": remaining Üben-URLs live in storage so the chain survives the
// page loads between pools. init() picks it up on every BEV page (see resumeHarvestQueue).
const QUEUE_KEY = 'bev_harvest_queue';

function getHarvestQueue() {
  return new Promise(resolve => chrome.storage.local.get([QUEUE_KEY], r => resolve(r[QUEUE_KEY] || [])));
}

function setHarvestQueue(queue) {
  if (!isContextValid()) return;
  try { chrome.storage.local.set({ [QUEUE_KEY]: queue }); } catch {}
}

function startHarvestAll() {
  const urls = [...new Set([...document.querySelectorAll('a[title^="Üben"]')].map(a => a.href))];
  if (urls.length === 0) return;
  setHarvestQueue(urls);
  setStatus(`🤖 ${urls.length} Pools in der Warteschlange – starte…`);
  location.href = urls[0];
}

async function continueHarvestQueue() {
  const queue = await getHarvestQueue();
  if (queue.length === 0) return;
  setStatus(`✅ Pool fertig – nächster Pool gleich (${queue.length} übrig)…`);
  await sleepRandom(3000, 6000);
  location.href = queue[0];
}

// Practice page that's next in the queue → take it off and start. Any other BEV page (e.g.
// the stats page the site redirects to after a pool) → go to the next queued pool.
async function resumeHarvestQueue() {
  const queue = await getHarvestQueue();
  if (queue.length === 0) return;
  if (isBevPracticeMode() && queue[0] === location.href) {
    setHarvestQueue(queue.slice(1));
    await sleepRandom(2000, 4000);
    harvestBevPool();
  } else if (!isBevPracticeMode()) {
    await sleepRandom(2000, 4000);
    location.href = queue[0];
  }
}

async function harvestBevPool() {
  if (harvesting) {
    harvestStop = true;
    setHarvestQueue([]);
    setStatus('⏹ Stoppe nach dieser Frage…');
    return;
  }
  if (!isBevPracticeMode()) return;
  harvesting  = true;
  harvestStop = false;
  document.getElementById('cm-harvest-btn').textContent = '⏹ Durchlauf stoppen';
  const before = Object.keys(knownAnswers).length;
  let done = 0;
  const resultShown = () => {
    const r = document.getElementById('fkResult');
    return r && getComputedStyle(r).display !== 'none';
  };

  try {
    while (!resultShown() && !harvestStop) {
      const card = document.querySelector('.fk-card');
      if (!card || !getQuestionText(card)) break;

      if (!card.querySelector('.fk-opt.locked')) {
        await sleepRandom(...HARVEST_READ_MS);
        if (harvestStop) break;
        card.querySelector('.fk-opt')?.click();
        await sleepRandom(400, 1200);
        document.getElementById('fkAnswer')?.click();
        if (!await waitFor(() => document.querySelector('.fk-opt.correct'))) {
          setStatus('⚠️ Keine Lösung angezeigt – abgebrochen.');
          setHarvestQueue([]);
          return;
        }
      }
      learnFromVisibleFeedback();
      done++;
      setStatus(`🤖 ${done} Fragen durchgelernt…`);
      await sleepRandom(...HARVEST_AFTER_MS);
      if (harvestStop) break;

      document.getElementById('fkNext')?.click();
      // Next question is rendered unlocked; wait for that (not text change — stems can repeat).
      if (!await waitFor(() => resultShown() || !document.querySelector('.fk-opt.locked'))) break;
      await sleep(300);
    }
    const added = Object.keys(knownAnswers).length - before;
    setStatus(`${harvestStop ? '⏹ Gestoppt' : '✅ Pool fertig'}: ${done} Fragen, ${added} neu gespeichert.`);
    if (!harvestStop) await continueHarvestQueue();
  } finally {
    harvesting = false;
    document.getElementById('cm-harvest-btn').textContent = '🤖 Pool automatisch durchlernen';
    updateOverlay();
  }
}

// Merge pending (quiz-time selections) into knownAnswers for questions not covered by
// learnFromResults (no tick/cross markers found for them).
//
// Only trusted when the results page shows NO grading markers ANYWHERE — same guard as
// extractCorrectAnswers' trustSelectedFallback. If markers ARE used on this page but just
// weren't found for one specific question (missed by scroll, render timing, etc.), a raw
// click is not proof of correctness — silently trusting it previously poisoned stored data
// with wrong/incomplete answers (e.g. a selected-but-wrong multi-select option).
function mergePending() {
  const pageUsesMarkers = !!document.querySelector('.circular-tick, .circular-tick-holo, .circular-x');
  const pendingKeys   = Object.keys(pendingAnswers);
  const knownKeys     = Object.keys(knownAnswers);
  let merged = 0;

  console.log('[CM Helper] Pending keys:', pendingKeys.length, '| Known keys:', knownKeys.length, '| pageUsesMarkers:', pageUsesMarkers);

  pendingKeys.forEach(pKey => {
    const answers = pendingAnswers[pKey];
    if (!answers || answers.length === 0) return;

    // Already stored under the exact key (learnFromResults already handled it)
    if (knownAnswers[pKey]) {
      console.log('[CM Helper] Merge skip (exact key exists):', pKey.substring(0, 50));
      return;
    }

    if (pageUsesMarkers) {
      console.log('[CM Helper] Merge skip (marker page, unverified click):', pKey.substring(0, 50));
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

// ─── Fuzzy matching (abgewandelte Fragen) ─────────────────────────────────────
// The stored data is full of near-duplicate "trap" pairs that differ in ONE content word
// (AZ/NZ, innerhalb/außerhalb, team A/B, "+ Spieldauer", 2/5 Minuten, nicht, ...). So a
// "similar enough" score alone is unsafe. Rule: apart from punctuation, case, umlauts and
// filler words (articles, ...), the words must be the same in the same order — only typos allowed.
const FILLER_WORDS = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen',
  'einem', 'einer', 'eines', 'bzw', 'sowie', 'dabei', 'dann', 'hier', 'bitte', 'jeweils']);
const FUZZY_MIN = 0.8;

function tokenize(text) {
  return normalizeText(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss').split(/[^a-z0-9]+/).filter(Boolean);
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1]));
    prev = cur;
  }
  return prev[b.length];
}

// Typo tolerance: none for short words (az/nz, a/b, 2/5), 1 from 5 chars, 2 from 10.
const isTypo = (a, b) => editDistance(a, b) <= (Math.min(a.length, b.length) >= 10 ? 2 :
                                                Math.min(a.length, b.length) >= 5 ? 1 : 0);

// Word-by-word in order (word swaps can be traps too, e.g. "zuerst die kleine/große").
// Returns the share of identical words, or 0 if any word differs by more than a typo.
function similarity(a, b) {
  const ta = tokenize(a).filter(w => !FILLER_WORDS.has(w));
  const tb = tokenize(b).filter(w => !FILLER_WORDS.has(w));
  if (!ta.length || ta.length !== tb.length) return 0;
  let same = 0;
  for (let i = 0; i < ta.length; i++) {
    if (ta[i] === tb[i]) same++;
    else if (!isTypo(ta[i], tb[i])) return 0;
  }
  return same / ta.length;
}

// ponytail: O(n) scan over all stored keys per call, fine for a few thousand entries.
function fuzzyMatch(qText, sim = similarity, min = FUZZY_MIN, store = knownAnswers) {
  const hits = [];
  for (const [key, val] of Object.entries(store)) {
    const keyText = key.split(/[|\x01]/)[0];
    const score = sim(qText, keyText);
    if (score >= min) hits.push({ score, val, keyText });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];
  const sameSet = v => JSON.stringify([...v].sort()) === JSON.stringify([...best.val].sort());
  if (hits.some(h => h.score >= best.score - 0.05 && !sameSet(h.val))) {
    console.log('[CM Helper] Fuzzy mehrdeutig, kein Auto-Fill:', qText.substring(0, 60));
    return null;
  }
  console.log(`[CM Helper] Fuzzy-Match (${Math.round(best.score * 100)}%):`, qText.substring(0, 60));
  return Object.assign([...best.val], { fuzzy: best.score, keyText: best.keyText });
}

// Saved answer → option element. Exact/strict match first, else most similar option.
function findOption(items, savedAnswer, sim = similarity, min = FUZZY_MIN) {
  const strict = items.find(i => answerMatches(i.text, savedAnswer));
  if (strict) return strict;
  let best = null, bestScore = min;
  for (const i of items) {
    const s = sim(i.text, savedAnswer);
    if (s >= bestScore) { best = i; bestScore = s; }
  }
  return best;
}

// Dice coefficient on word sets — tolerant, so only ever used for the compare panel.
function looseSimilarity(a, b) {
  const A = new Set(tokenize(a)), B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let common = 0;
  A.forEach(w => { if (B.has(w)) common++; });
  return 2 * common / (A.size + B.size);
}

// ─── Rulebook search (regelwerk.json, built locally by build-regelwerk.py) ────
// BM25 over rule sections; query = question + options. Shows where to look, not an answer.
let rules = null;   // [{ id, title, rule, text, terms: Map, len }]
let ruleIdf = null;
let ruleWords = new Map();   // raw word → count, for splitting compounds in questions

// Crude German suffix stripping, applied until stable so "kapitän/kapitäne/kapitänen" agree.
const stem = w => {
  for (let prev = ''; w !== prev && w.length > 3;) { prev = w; w = w.replace(/(en|er|es|em|e|n|s)$/, ''); }
  return w;
};
// Questions use other words than the IIHF rulebook (question token → rulebook word, '' = ignore).
// Abbreviations/anglicisms are counted from the stored questions (th 327×, ref 251×, ...).
// "ja"/"nein" options are rare in the rulebook, so they'd count as strong evidence for random rules.
const SYNONYMS = {
  th: 'torhüter', ref: 'schiedsrichter', refs: 'schiedsrichter', sr: 'schiedsrichter',
  lp: 'linienrichter', linesman: 'linienrichter', ps: 'strafschuss', penaltyschuss: 'strafschuss',
  penalty: 'strafschuss', vz: 'verteidigungszone', az: 'angriffszone', nz: 'neutrale', ez: 'endzone',
  roughing: 'übertriebene', overtime: 'verlängerung', spd: 'spieldauer', ja: '', nein: '',
};
// Cut to 7 chars so inflections the suffix stripper misses still meet ("verschiebt"/"Verschiebens").
// Rulebook says "Time-out" in the text, questions say "Auszeit".
const ruleTerms = text => tokenize(text.replace(/time\s*-?\s*outs?/gi, ' auszeit '))
  .map(w => w in SYNONYMS ? tokenize(SYNONYMS[w])[0] : w).filter(Boolean).map(w => stem(w).slice(0, 7));

async function loadRules() {
  try {
    const res = await fetch(chrome.runtime.getURL('regelwerk.json'));
    if (!res.ok) return;
    rules = (await res.json()).map(r => {
      const terms = new Map();
      // rule name too: sections are often just "59.2 Kleine Strafe" under "Regel 59 – Check mit dem Stock"
      const all = r.title + ' ' + r.rule + ' ' + r.text;
      ruleTerms(all).forEach(t => terms.set(t, (terms.get(t) || 0) + 1));
      tokenize(all).forEach(w => ruleWords.set(w, (ruleWords.get(w) || 0) + 1));
      return { ...r, terms, len: [...terms.values()].reduce((a, b) => a + b, 0) };
    });
    const df = new Map();
    rules.forEach(r => r.terms.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1)));
    ruleIdf = t => Math.log(1 + (rules.length - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  } catch { /* no regelwerk.json → feature off */ }
}

// Questions glue words the rulebook keeps apart ("Stockcheck" vs. "Check mit dem Stock"):
// append the parts of a word if both parts are more common rulebook words than the word itself.
function splitCompounds(text) {
  const parts = [];
  for (const w of tokenize(text)) {
    const n = ruleWords.get(w) || 0;
    for (let i = 4; i <= w.length - 4; i++) {
      const a = w.slice(0, i), b = w.slice(i);
      if ((ruleWords.get(a) || 0) > n && (ruleWords.get(b) || 0) > n) { parts.push(a, b); break; }
    }
  }
  return parts.length ? text + ' ' + parts.join(' ') : text;
}

function searchRules(query, n = 5) {
  if (!rules) return [];
  const q = [...new Set(ruleTerms(query))];
  const avg = rules.reduce((a, r) => a + r.len, 0) / rules.length;
  return rules.map(r => ({
    r,
    score: q.reduce((sum, t) => {
      const tf = r.terms.get(t) || 0;
      return sum + (tf && ruleIdf(t) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * r.len / avg)));
    }, 0),
  })).sort((a, b) => b.score - a.score).slice(0, n).filter(h => h.score > 0);
}

// Sentence of the section that shares the rarest/most terms with the query (IDF-weighted, so
// "torhüter"/"strafe" count less than "angreifer") — as teaser.
function bestSentence(text, query) {
  const q = new Set(ruleTerms(query));
  return text.split(/(?<=[.!?])\s+/).map(s => ({ s, hits: [...new Set(ruleTerms(s))].filter(t => q.has(t))
    .reduce((sum, t) => sum + ruleIdf(t), 0) }))
    .sort((a, b) => b.hits - a.hits)[0].s;
}

// Season updates (from the BEV Regel-Update PDF) that change a given rulebook section.
const updatesFor = r => r.update ? [] : rules.filter(u => u.update &&
  u.refs.some(ref => r.id === ref || r.id.startsWith(ref + '.')));

// Key words of the answers (not already in the question, no filler like "der"/"und") in rule text.
function answerKeys(question, answers) {
  const q = new Set(ruleTerms(question));
  return new Set(ruleTerms(answers).filter(t => !q.has(t) && t.length > 3 && ruleIdf(t) > 2));
}
const markKeys = (text, keys) => text.split(/(\s+)/).map(w =>
  ruleTerms(w).some(t => keys.has(t)) ? `<mark class="cm-key">${escapeHtml(w)}</mark>` : escapeHtml(w)).join('');

function renderRules(question, answers) {
  const query = splitCompounds(question + ' ' + answers);
  const hits = searchRules(query);
  if (!hits.length) return '';
  const keys = answerKeys(question, answers), hl = t => markKeys(t, keys);
  const upd = u => `<div class="cm-cmp-update">🆕 <b>${escapeHtml(u.id.replace('🆕 ', ''))} – ` +
    `${escapeHtml(u.title)} (${escapeHtml(u.rule)}):</b> ${hl(u.text)}</div>`;
  return `<div class="cm-cmp-rules"><div class="cm-cmp-score">📖 Passende Regelstellen · <mark class="cm-key">markiert</mark> = Wörter aus den Antworten</div>` +
    hits.map(({ r }) => r.update ? upd(r) :
      `<details><summary><b>${escapeHtml(r.id)} ${escapeHtml(r.title)}</b>` +
      `<span class="cm-cmp-rule">${escapeHtml(r.rule)}</span><br>„${hl(bestSentence(r.text, query))}“</summary>` +
      `<div class="cm-cmp-ruletext">${hl(r.text)}</div></details>` +
      updatesFor(r).map(upd).join('')).join('') + '</div>';
}

// ─── Compare panel: "Frage zu 90% identisch zu …" ─────────────────────────────
// For questions that aren't known exactly, list the most similar stored questions (both
// stores) with their options/solutions, and highlight the words that differ.
const COMPARE_MIN = 0.6;
const RIVAL_MIN = 0.8;

function topSimilar(qText, n = 3) {
  const hits = [];
  [[knownAnswers, false], [otherAnswers, true]].forEach(([store, other]) => {
    for (const [key, val] of Object.entries(store)) {
      const [keyText, fp] = key.split(/[|\x01]/);
      const score = looseSimilarity(qText, keyText);
      if (score >= COMPARE_MIN) hits.push({ score, keyText, fp, val, other });
    }
  });
  // Same question from both stores (BEV + ClassMarker) → show once, preferring the one with options.
  const seen = new Set();
  return hits.sort((a, b) => b.score - a.score || !!b.fp - !!a.fp).filter(h => {
    const id = tokenize(h.keyText).join(' ') + '|' + h.val.map(canonAnswer).sort().join('|');
    return !seen.has(id) && seen.add(id);
  }).slice(0, n);
}

// Wraps words of `text` that don't occur in `otherText` in <mark>.
function markDiff(text, otherText) {
  const known = new Set(tokenize(otherText));
  return text.split(/(\s+)/).map(w =>
    tokenize(w).some(t => !known.has(t)) ? `<mark>${escapeHtml(w)}</mark>` : escapeHtml(w)).join('');
}

function renderCompare(lists) {
  if (!lists.length) return;
  let panel = document.getElementById('cm-compare');
  clearQuestionHighlights();
  const sections = lists.map((list, i) => {
    const qText = getQuestionText(list);
    const hits = topSimilar(qText);
    // Trap check: another stored question ≥ RIVAL_MIN similar with a DIFFERENT solution
    // (e.g. 87%: "der ref gibt das tor" → ja / "… erkennt das tor nicht an …" → nein).
    const differ = (x, y) => JSON.stringify([...x.val].map(canonAnswer).sort()) !==
                             JSON.stringify([...y.val].map(canonAnswer).sort());
    const rival = hits.slice(1).find(h => h.score >= RIVAL_MIN && differ(h, hits[0]));
    // Identical stored question → nothing differs from it; mark against the trap sibling instead.
    const ref = hits[0]?.score === 1 ? rival : hits[0];
    highlightQuestion(list, ref?.keyText);
    const body = hits.length ? hits.map(h => {
      const options = h.fp ? h.fp.split('\x00') : h.val;   // without fingerprint only solutions known
      const opts = options.map(o => {
        const ok = h.val.some(a => answerMatches(o, a));
        return `<li class="${ok ? 'cm-ok' : ''}">${ok ? '✅' : '▫️'} ${escapeHtml(o)}</li>`;
      }).join('');
      const src = h.other ? (IS_BEV ? 'ClassMarker' : 'BEV') : (IS_BEV ? 'BEV' : 'ClassMarker');
      return `<div class="cm-cmp-hit${h === ref ? ' cm-active' : ''}" data-key="${escapeHtml(h.keyText)}" title="Klicken: Frage oben gegen diese Frage markieren">
        <div class="cm-cmp-score">${Math.round(h.score * 100)}% identisch · ${src}</div>
        <div class="cm-cmp-q">${markDiff(h.keyText, qText)}</div>
        <ul>${opts}</ul></div>`;
    }).join('') : '<div class="cm-cmp-none">Keine ähnliche gespeicherte Frage gefunden.</div>';
    // Measured on the data: the % alone says little — what matters is the rival (see above).
    const verdict = !hits.length ? '' : rival
      ? `<div class="cm-cmp-warn">⚠️ Achtung Falle: ${Math.round(rival.score * 100)}% ähnliche Frage mit ANDERER Lösung – auf die markierten Wörter achten.</div>`
      : hits[0].score >= 0.95
        ? `<div class="cm-cmp-good">✔ Eindeutig: keine ähnlich nahe Variante mit anderer Lösung${hits[1] ? ` (nächste: ${Math.round(hits[1].score * 100)}%)` : ''}.</div>`
        : `<div class="cm-cmp-warn">⚠️ Keine Frage über 95% – eventuell neu oder stark umgebaut, selbst prüfen.</div>`;
    const answers = getAnswerItems(list).map(getAnswerText).join(' ');
    return `<div class="cm-cmp-section" data-i="${i}"><div class="cm-cmp-now"><b>Jetzt:</b> <span class="cm-cmp-nowtext">${markDiff(qText, ref?.keyText || qText)}</span></div>${verdict}<div class="cm-cmp-grid">${body}${renderRules(qText, answers)}</div></div>`;
  });
  if (!sections.length) return;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'cm-compare';
    document.body.appendChild(panel);
    makeDraggable(panel, '#cm-compare-head');
    panel.addEventListener('click', e => {
      if (e.target.id === 'cm-compare-close') { panel.remove(); clearQuestionHighlights(); return; }
      const hit = e.target.closest('.cm-cmp-hit');
      if (hit) selectCompareHit(hit);
    });
  }
  const questions = JSON.stringify(lists.map(getQuestionText));
  if (questions !== panel.dataset.questions) panel.scrollTop = 0;   // new question → back to the top
  panel.dataset.questions = questions;
  panel.innerHTML = `<div id="cm-compare-head"><span>🔎 Ähnliche Fragen – <mark>markiert</mark> = abweichende Wörter · Spalte anklicken = Frage oben dagegen markieren</span>
    <button id="cm-compare-close">✕</button></div>${sections.join('')}`;
}

// Click on a column → mark the question (page + "Jetzt" line) against that stored question.
function selectCompareHit(hit) {
  const section = hit.closest('.cm-cmp-section');
  const list = getQuestionLists()[+section.dataset.i];
  if (!list) return;
  const key = hit.dataset.key;
  clearQuestionHighlights(getQuestionEl(list));
  highlightQuestion(list, key);
  section.querySelector('.cm-cmp-nowtext').innerHTML = markDiff(getQuestionText(list), key);
  section.querySelectorAll('.cm-cmp-hit').forEach(h => h.classList.toggle('cm-active', h === hit));
}

// Marks the words of the question ON THE PAGE that don't occur in `otherText`.
// Only wraps text nodes in <mark>, so textContent (used for matching) stays the same.
function highlightQuestion(list, otherText) {
  const el = getQuestionEl(list);
  if (!el || !otherText) return;
  const known = new Set(tokenize(otherText));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => {
    const parts = node.textContent.split(/(\s+)/);
    if (!parts.some(w => tokenize(w).some(t => !known.has(t)))) return;
    const frag = document.createDocumentFragment();
    parts.forEach(w => {
      if (!tokenize(w).some(t => !known.has(t))) return frag.append(w);
      const m = document.createElement('mark');
      m.className = 'cm-diff';
      m.textContent = w;
      frag.append(m);
    });
    node.replaceWith(frag);
  });
}

function clearQuestionHighlights(root = document) {
  if (!root) return;
  root.querySelectorAll('mark.cm-diff').forEach(m => {
    const parent = m.parentNode;
    m.replaceWith(m.textContent);
    parent.normalize();
  });
}

// Panel stays open until the user closes it (✕); on a new question it switches to that one.
function refreshCompare() {
  const panel = document.getElementById('cm-compare');
  if (!panel) return;
  const lists = getQuestionLists();
  const now = JSON.stringify(lists.map(getQuestionText));
  if (lists.length && now !== panel.dataset.questions) renderCompare(lists);
}

// ─── Auto-fill on quiz page ───────────────────────────────────────────────────

// Own store first; the other site's store only if nothing (not even fuzzy) matched here.
function findBestMatch(listEl) {
  const own = matchIn(listEl, knownAnswers);
  if (own) return own;
  const other = matchIn(listEl, otherAnswers);
  return other && Object.assign([...other], { fuzzy: other.fuzzy, other: true });
}

function matchIn(listEl, store) {
  const fullKey = getQuestionKey(listEl);
  const qText   = getQuestionText(listEl);

  // Exact full-key match (unambiguous — includes answer fingerprint)
  if (store[fullKey]) return store[fullKey];

  // Exact text-only match (backward compat with pre-fingerprint stored data)
  if (store[qText]) return store[qText];

  // Exact-text fallback across fingerprinted keys — strips a stored key's fingerprint suffix
  // (either legacy "|" or "\x01" format) before comparing, but still requires the FULL question
  // text to match exactly. This only ever picks up a *different rendering* of the exact same
  // question (e.g. options shown in a different order), never a different-but-similarly-worded
  // one.
  //
  // Only if nothing matches exactly do we fall back to fuzzyMatch(). The exam includes
  // near-duplicate "trap" questions (a couple of words swapped, different answer), so the
  // fuzzy path only tolerates typos/punctuation/articles (see similarity()), bails out if
  // similar stored questions disagree, and fuzzy fills are flagged in the status line.
  const candidates = [];
  for (const [key, val] of Object.entries(store)) {
    const keyText = key.split(/[|\x01]/)[0];
    if (keyText === qText) candidates.push(val);
  }
  if (candidates.length === 0) return fuzzyMatch(qText, similarity, FUZZY_MIN, store);

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

  const items = getAnswerItems(list).map(el => ({ el, text: getAnswerText(el) })).filter(i => i.text);
  const picks = new Set(saved.map(a => findOption(items, a)).filter(Boolean));
  // Fuzzy or other-site match: all saved answers must map to an option, else leave it to the user.
  const unsure = saved.fuzzy || saved.other;
  if (unsure && picks.size !== saved.length) {
    console.log('[CM Helper] Unsicherer Match, Antworten passen nicht zu den Optionen — kein Auto-Fill.');
    return false;
  }
  picks.forEach(i => {
    ionClick(i.el);
    console.log('[CM Helper] Clicked:', i.text.substring(0, 50));
  });
  if (picks.size && unsure) fuzzyFilled++;
  return picks.size > 0;
}

function fillCurrentQuestion() {
  if (!Object.keys(knownAnswers).length && !Object.keys(otherAnswers).length) {
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
  const unsure = [];
  fuzzyFilled = 0;
  lists.forEach(list => {
    const qText = getQuestionText(list);
    const match = findBestMatch(list);
    console.log('[CM Helper] Frage:', qText.substring(0, 60));
    console.log('[CM Helper] Key:', getQuestionKey(list).substring(0, 80));
    console.log('[CM Helper] Match:', match);
    if (!match || match.fuzzy || match.other) unsure.push(list);
    if (match) {
      if (fillQuestionList(list)) filled++;
    } else {
      console.log('[CM Helper] Kein Match für diese Frage.');
    }
  });

  renderCompare(unsure);

  const fuzzyNote = fuzzyFilled ? ` (⚠️ ${fuzzyFilled} davon ähnlich oder aus dem anderen Katalog – bitte prüfen)` : '';
  const cmpNote = unsure.length ? ' · 🔎 Ähnliche Fragen im Vergleichsfenster oben.' : '';
  setStatus(filled > 0 ? `✅ ${filled} Frage(n) ausgefüllt${fuzzyNote}${cmpNote}`
    : unsure.length ? '🔎 Nicht exakt bekannt – ähnliche Fragen im Vergleichsfenster oben.'
    : '⚠️ Kein Match — Details in Konsole (F12).');
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
      refreshCompare();

      // Always check for immediate per-question feedback first, even with an empty store —
      // this is how we bootstrap answers from scratch in practice mode.
      learnFromVisibleFeedback();

      if (!Object.keys(knownAnswers).length && !Object.keys(otherAnswers).length) return;

      const hasUnfilled = getQuestionLists().some(list => {
        const alreadyChecked = list.querySelector(
          '.radio-checked, ion-radio[aria-checked="true"], ion-checkbox[aria-checked="true"], .item-checkbox-checked, .item-radio-checked, .fk-opt.sel, .fk-opt.locked'
        );
        return !alreadyChecked && findBestMatch(list);
      });
      if (hasUnfilled) setStatus('💡 Antwort bekannt – F drücken zum Ausfüllen.');
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
    const items = getAnswerItems(list);
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
  a.download = `${EXPORT_NAME}-${new Date().toISOString().slice(0,10)}.json`;
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
  <title>${EXPORT_TITLE}</title>
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
    <h1>🏒 ${EXPORT_TITLE}</h1>
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
  a.download = `${EXPORT_NAME}-${new Date().toISOString().slice(0,10)}.html`;
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
  <title>${EXPORT_TITLE}</title>
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
  <h1>🏒 ${EXPORT_TITLE}</h1>
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
  // Guard against mixing the two stores: export filenames tell the sites apart.
  const fileIsBev = file.name.startsWith('bev-');
  if (fileIsBev !== IS_BEV &&
      !confirm(`Die Datei "${file.name}" sieht nach ${fileIsBev ? 'BEV-Fragenkatalog' : 'ClassMarker'} aus, ` +
               `du bist aber auf ${IS_BEV ? 'BEV-Fragenkatalog' : 'ClassMarker'}. Trotzdem importieren?`)) {
    setStatus('⚠️ Import abgebrochen.');
    return;
  }
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
  loadRules();
  createOverlay();

  if (isOnResultPage()) {
    setStatus('📋 Ergebnisseite – scrolle und lerne…');
    setTimeout(scrollAndLearn, 1500);
  } else if (isOnQuizPage()) {
    const total = Object.keys(knownAnswers).length;
    if (total > 0) {
      setStatus(`💡 ${total} Antworten gespeichert – F drücken zum Ausfüllen.`);
    } else {
      setStatus('📝 Quiz – beantworte die Fragen, Antworten werden gespeichert.');
    }
  } else {
    setStatus('⏳ Warte auf Quiz oder Ergebnisseite…');
  }

  updateOverlay();
  startMainObserver();
  if (IS_BEV) resumeHarvestQueue();
}

init();

// Run: node test-fuzzy.js — loads content.js with stubs, then: for every stored question, hide it and fuzzy-match it
// against the rest. Reports matches with a DIFFERENT answer set (= would be wrong).
const fs = require('fs'), vm = require('vm');
const dir = __dirname + '/';
const ctx = { console: { log() {} }, location: { hostname: 'x', pathname: '/' },
  chrome: { storage: { local: { get() {} } } }, document: { scripts: [] }, setTimeout() {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(dir + 'content.js', 'utf8').replace(/\ninit\(\);\s*$/, ''), ctx);
for (const file of ['eishockey-antworten-merged.json', 'bev-fragenkatalog-antworten.json']) {
  const all = JSON.parse(fs.readFileSync(dir + file, 'utf8'));
  delete all.__regelangaben;   // rule references, not a question
  let hits = 0, wrong = 0;
  for (const [key, val] of Object.entries(all)) {
    const rest = { ...all }; delete rest[key];
    const [q, fp] = key.split(/[|\x01]/);
    // skip if an exact-text sibling exists (exact path would handle it)
    if (Object.keys(rest).some(k => k.split(/[|\x01]/)[0] === q)) continue;
    ctx.__ka = rest; vm.runInContext('knownAnswers = globalThis.__ka', ctx);
    const m = ctx.fuzzyMatch(q);
    if (!m) continue;
    hits++;
    const items = (fp || '').split('\x00').filter(Boolean).map(text => ({ text }));
    if (!items.length) continue;
    const picks = new Set(m.map(a => ctx.findOption(items, a)).filter(Boolean));
    if (picks.size !== m.length) { hits--; continue; }  // fill aborts
    const chosen = [...picks].map(i => i.text).sort();
    const truth = items.filter(i => val.some(v => ctx.answerMatches(i.text, v))).map(i => i.text).sort();
    if (JSON.stringify(chosen) !== JSON.stringify(truth)) {
      wrong++;
      const src = Object.keys(rest).find(k => JSON.stringify(rest[k]) === JSON.stringify([...m]) && ctx.similarity(k.split(/[|\x01]/)[0], q) === m.fuzzy) || '';
      const a = new Set(ctx.tokenize(q)), b = new Set(ctx.tokenize(src.split(/[|\x01]/)[0]));
      console.error('WRONG', m.fuzzy.toFixed(2), '| nur neu:', [...a].filter(w => !b.has(w)).join(','), '| nur alt:', [...b].filter(w => !a.has(w)).join(','));
    }
  }
  console.error(file, 'n=', Object.keys(all).length, 'fuzzy hits=', hits, 'wrong=', wrong);
  if (wrong) process.exitCode = 1;
}
// Cross-site: ClassMarker questions answered from the BEV store (other-store fallback).
// CM file has no option lists, so options = CM answers ∪ BEV answers (approximation).
{
  const cm = JSON.parse(fs.readFileSync(dir + 'eishockey-antworten-merged.json', 'utf8'));
  delete cm.__regelangaben;
  ctx.__ka = JSON.parse(fs.readFileSync(dir + 'bev-fragenkatalog-antworten.json', 'utf8'));
  delete ctx.__ka.__regelangaben;
  vm.runInContext('knownAnswers = globalThis.__ka', ctx);
  const txt = k => k.split(/[|\x01]/)[0];
  const byText = {}; for (const [k, v] of Object.entries(ctx.__ka)) (byText[txt(k)] ||= []).push(v);
  let right = 0, wrong = 0, skipped = 0, none = 0;
  for (const [k, v] of Object.entries(cm)) {
    const q = txt(k);
    const m = byText[q]?.length === 1 ? byText[q][0] : ctx.fuzzyMatch(q);
    if (!m) { none++; continue; }
    const items = [...new Set([...v, ...m])].map(text => ({ text }));
    const picks = new Set(m.map(a => ctx.findOption(items, a)).filter(Boolean));
    if (picks.size !== m.length) { skipped++; continue; }
    const chosen = [...picks].map(i => vm.runInContext('canonAnswer', ctx)(i.text)).sort();
    const truth = [...new Set(v.map(a => vm.runInContext('canonAnswer', ctx)(ctx.findOption(items, a).text)))].sort();
    if (JSON.stringify(chosen) === JSON.stringify(truth)) right++;
    else { wrong++; console.error('  CROSS-WRONG', q.slice(0, 80)); }
  }
  console.error('ClassMarker-Fragen aus BEV-Speicher: richtig=', right, 'falsch=', wrong,
                'abgebrochen=', skipped, 'kein Treffer=', none);
}

// Rewording check: typo/punctuation/article changes match, traps don't.
const store = { 'darf ein spieler ohne helm auf der spielerbank sitzen, wenn das spiel läuft?': ['nein'] };
const check = (q, expect) => {
  ctx.__ka = store; vm.runInContext('knownAnswers = globalThis.__ka', ctx);
  if (!!ctx.fuzzyMatch(q) !== expect) throw new Error('self-check failed: ' + q);
};
check('darf ein Spieler ohne Helm auf der Spielerbank sitzen wenn das Spiel laeuft ?', true);
check('darf der spieler ohne helm auf einer spielerbank sitzen, wenn das spiel lauft.', true);
check('darf ein spieler ohne helm auf der spilerbank sitzen, wenn das spiel läuft?', true);
check('darf ein spieler nicht ohne helm auf der spielerbank sitzen, wenn das spiel läuft?', false);
check('darf ein torhüter ohne helm auf der spielerbank sitzen, wenn das spiel läuft?', false);
check('darf ein spieler ohne helm auf der strafbank sitzen, wenn das spiel läuft?', false);
check('darf ein spieler ohne helm auf der spielerbank sitzen, wenn das spiel ruht?', false);
check('ein spieler darf ohne helm auf der spielerbank sitzen, wenn das spiel läuft?', false);
console.error('self-check ok');

const STORAGE_KEY     = 'cm_eishockey_answers';
const BEV_STORAGE_KEY = 'bev_fragenkatalog_answers';

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function updateCount() {
  chrome.storage.local.get([STORAGE_KEY, BEV_STORAGE_KEY], result => {
    document.getElementById('count').textContent     = Object.keys(result[STORAGE_KEY] || {}).length;
    document.getElementById('count-bev').textContent = Object.keys(result[BEV_STORAGE_KEY] || {}).length;
  });
}

// Clears ClassMarker only — BEV answers are cleared from the overlay on eishockey-management.de.
document.getElementById('clear-btn').addEventListener('click', () => {
  if (confirm('Wirklich alle gespeicherten ClassMarker-Antworten löschen? (BEV bleibt erhalten)')) {
    chrome.storage.local.remove([STORAGE_KEY], () => {
      updateCount();
      setStatus('✅ Gelöscht.');
    });
  }
});

updateCount();

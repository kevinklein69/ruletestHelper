const STORAGE_KEY = 'cm_eishockey_answers';

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function updateCount() {
  chrome.storage.local.get([STORAGE_KEY], result => {
    const data  = result[STORAGE_KEY] || {};
    const count = Object.keys(data).length;
    document.getElementById('count').textContent = count;
  });
}

document.getElementById('clear-btn').addEventListener('click', () => {
  if (confirm('Wirklich alle gespeicherten Antworten löschen?')) {
    chrome.storage.local.remove([STORAGE_KEY], () => {
      updateCount();
      setStatus('✅ Gelöscht.');
    });
  }
});

updateCount();

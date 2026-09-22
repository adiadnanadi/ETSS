// ─── PRESENCE HEARTBEAT ───────────────────────────────────────────────────────
// Šalje serveru da je korisnik aktivan (IP se bilježi na serveru).
// Uključi na stranicama gdje je korisnik prijavljen:
//   import { startPresence } from '/js/presence.js';
//   startPresence();   // ili startPresence('/student')

import { auth } from '/js/firebase-config.js';

const INTERVAL_MS = 45_000;
let timer = null;
let currentPage = (typeof location !== 'undefined')
  ? (location.pathname + location.search)
  : '/';

export function setPresencePage(page) {
  if (page) currentPage = String(page).slice(0, 120);
}

async function sendHeartbeat() {
  try {
    const user = auth.currentUser;
    if (!user) return;
    const token = await user.getIdToken();
    await fetch('/api/presence', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ page: currentPage }),
      keepalive: true
    });
  } catch (_) {
    // tiho — ne smeta UX-u
  }
}

export function startPresence(page) {
  if (page) setPresencePage(page);
  else if (typeof location !== 'undefined') {
    currentPage = location.pathname + location.search;
  }

  // Odmah + periodično
  sendHeartbeat();
  if (timer) clearInterval(timer);
  timer = setInterval(sendHeartbeat, INTERVAL_MS);

  // Kad se vrati na tab
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) sendHeartbeat();
    });
  }
}

export function stopPresence() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

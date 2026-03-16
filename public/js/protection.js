// ─── ZAŠTITA KVIZA ────────────────────────────────────────────────────────────

// 1. Onemogući desni klik
document.addEventListener('contextmenu', e => e.preventDefault());

// 2. Onemogući kopiranje teksta
document.addEventListener('copy',  e => e.preventDefault());
document.addEventListener('cut',   e => e.preventDefault());
document.addEventListener('paste', e => e.preventDefault());

// 3. Onemogući označavanje teksta CSS-om
document.body.style.userSelect    = 'none';
document.body.style.webkitUserSelect = 'none';

// 4. Onemogući keyboard shortcuts za kopiranje i DevTools
document.addEventListener('keydown', e => {
  // Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+A, Ctrl+S, Ctrl+P
  if (e.ctrlKey && ['c','x','v','a','s','p','u'].includes(e.key.toLowerCase())) {
    e.preventDefault();
  }
  // F12 - DevTools
  if (e.key === 'F12') e.preventDefault();
  // Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C - DevTools
  if (e.ctrlKey && e.shiftKey && ['i','j','c'].includes(e.key.toLowerCase())) {
    e.preventDefault();
  }
  // Ctrl+U - View source
  if (e.ctrlKey && e.key.toLowerCase() === 'u') e.preventDefault();
});

// 5. Screenshot detekcija — detektuje Print Screen
document.addEventListener('keyup', e => {
  if (e.key === 'PrintScreen') {
    // Privremeno sakrij sadržaj
    document.body.style.filter = 'blur(10px)';
    setTimeout(() => document.body.style.filter = '', 2000);
    showWarning('⚠️ Screenshot je onemogućen tokom kviza!');
  }
});

// 6. Detekcija kada učenik napusti tab/prozor
let warningCount = 0;
const MAX_WARNINGS = 3;

document.addEventListener('visibilitychange', () => {
  if (document.hidden && window._quizActive) {
    warningCount++;
    if (warningCount >= MAX_WARNINGS) {
      showWarning(`🚫 Napustili ste kviz ${MAX_WARNINGS} puta! Kviz će biti automatski predан.`);
      setTimeout(() => {
        if (window.autoSubmitQuiz) window.autoSubmitQuiz();
      }, 3000);
    } else {
      // Zapamti za log
      window._tabSwitches = (window._tabSwitches || 0) + 1;
    }
  } else if (!document.hidden && window._quizActive && warningCount < MAX_WARNINGS) {
    showWarning(`⚠️ Upozorenje ${warningCount}/${MAX_WARNINGS}: Ne napuštajte kviz tokom rješavanja!`);
  }
});

// 7. Detekcija fullscreen izlaska (opcionalno)
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && window._quizActive) {
    showWarning('⚠️ Preporučujemo rješavanje kviza u fullscreen modu.');
  }
});

// ─── Warning toast ────────────────────────────────────────────────────────────
function showWarning(msg) {
  // Ukloni postojeće upozorenje
  const old = document.getElementById('quiz-warning');
  if (old) old.remove();

  const el = document.createElement('div');
  el.id = 'quiz-warning';
  el.style.cssText = `
    position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
    background: rgba(232,104,90,.15); border: 1px solid rgba(232,104,90,.4);
    color: #e8685a; padding: 12px 20px; border-radius: 10px;
    font-size: 14px; font-weight: 500; z-index: 9999;
    backdrop-filter: blur(12px); text-align: center;
    animation: fadeUp .3s ease; max-width: 90vw;
    font-family: 'Inter', sans-serif;
  `;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el?.remove(), 4000);
}

// Eksportuj za korištenje u take-quiz.html
window._showQuizWarning = showWarning;

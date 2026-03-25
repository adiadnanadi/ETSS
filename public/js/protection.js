// ─── ZAŠTITA KVIZA ────────────────────────────────────────────────────────────

// 1. Onemogući desni klik
document.addEventListener('contextmenu', function(e) { e.preventDefault(); });
// 2. Onemogući kopiranje
document.addEventListener('copy', function(e) { e.preventDefault(); });
document.addEventListener('cut',  function(e) { e.preventDefault(); });
// 3. Onemogući označavanje teksta
document.body.style.userSelect       = 'none';
document.body.style.webkitUserSelect = 'none';
document.body.style.msUserSelect     = 'none';
// 4. Keyboard shortcuts — SVE unutar jednog listenera
document.addEventListener('keydown', function(e) {
  var key = e.key.toLowerCase();
  // Ctrl+C, Ctrl+X, Ctrl+A, Ctrl+S, Ctrl+P, Ctrl+U
  if (e.ctrlKey && (key === 'c' || key === 'x' || key === 'a' || key === 's' || key === 'p' || key === 'u')) {
    e.preventDefault();
  }
  // F12
  if (e.key === 'F12') {
    e.preventDefault();
  }
  // Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C
  if (e.ctrlKey && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) {
    e.preventDefault();
  }
});
// 5. Print Screen detekcija
document.addEventListener('keyup', function(e) {
  if (e.key === 'PrintScreen') {
    document.body.style.filter = 'blur(10px)';
    setTimeout(function() { document.body.style.filter = ''; }, 2000);
    showQuizWarning('Screenshot je onemogućen tokom kviza!');
  }
});

// 6. Tab switch detekcija
var warningCount = 0;
document.addEventListener('visibilitychange', function() {
  if (!window._quizActive) return;
  if (document.hidden) {
    warningCount++;
    window._tabSwitches = warningCount;
    if (warningCount >= 3) {
      showQuizWarning('Napustili ste kviz 3 puta! Kviz će biti automatski predan.');
      setTimeout(function() {
        if (typeof window.autoSubmitQuiz === 'function') {
          window.autoSubmitQuiz();
        }
      }, 3000);
    }
  } else {
    if (warningCount > 0 && warningCount < 3) {
      showQuizWarning('Upozorenje ' + warningCount + '/3 — Ne napuštajte kviz tokom rješavanja!');
    }
  }
});

// ─── NOVO: Blur detekcija (alt-tab, klik na drugu app) ───────────────────────
var blurTimeout = null;
window.addEventListener('blur', function() {
  if (!window._quizActive) return;
  // Kratki delay da izbjegnemo lažne alarme
  blurTimeout = setTimeout(function() {
    if (!document.hasFocus() && window._quizActive) {
      warningCount++;
      window._tabSwitches = warningCount;
      if (warningCount >= 3) {
        showQuizWarning('Napustili ste kviz 3 puta! Kviz će biti automatski predan.');
        setTimeout(function() {
          if (typeof window.autoSubmitQuiz === 'function') {
            window.autoSubmitQuiz();
          }
        }, 3000);
      } else {
        showQuizWarning('Upozorenje ' + warningCount + '/3 — Detektovano prebacivanje na drugu aplikaciju!');
      }
    }
  }, 500);
});

window.addEventListener('focus', function() {
  // Poništi blur timeout ako se korisnik brzo vrati
  if (blurTimeout) {
    clearTimeout(blurTimeout);
    blurTimeout = null;
  }
});

// ─── NOVO: Splitscreen detekcija (resize prozora) ────────────────────────────
var initialWidth  = window.innerWidth;
var initialHeight = window.innerHeight;
var splitWarned   = false;

window.addEventListener('resize', function() {
  if (!window._quizActive) return;

  var screenW  = window.screen.availWidth  || window.screen.width;
  var screenH  = window.screen.availHeight || window.screen.height;
  var wRatio   = window.innerWidth  / screenW;
  var hRatio   = window.innerHeight / screenH;

  // Ako je prozor manji od 65% širine ili 55% visine ekrana — splitscreen
  var isSplit = wRatio < 0.65 || hRatio < 0.55;

  // Samo jednom upozori dok ne vrate na full
  if (isSplit && !splitWarned) {
    splitWarned = true;
    warningCount++;
    window._tabSwitches = warningCount;
    if (warningCount >= 3) {
      showQuizWarning('Napustili ste kviz 3 puta! Kviz će biti automatski predan.');
      setTimeout(function() {
        if (typeof window.autoSubmitQuiz === 'function') {
          window.autoSubmitQuiz();
        }
      }, 3000);
    } else {
      showQuizWarning('Upozorenje ' + warningCount + '/3 — Detektovano dijeljenje ekrana! Koristite cijeli ekran.');
    }
  }

  // Resetuj kad vrate prozor na normalnu veličinu
  if (!isSplit && splitWarned) {
    splitWarned = false;
  }
});

// ─── Warning prikaz ───────────────────────────────────────────────────────────
function showQuizWarning(msg) {
  var old = document.getElementById('quiz-warning');
  if (old) old.remove();
  var el = document.createElement('div');
  el.id = 'quiz-warning';
  el.style.position       = 'fixed';
  el.style.top            = '70px';
  el.style.left           = '50%';
  el.style.transform      = 'translateX(-50%)';
  el.style.background     = 'rgba(232,104,90,.15)';
  el.style.border         = '1px solid rgba(232,104,90,.4)';
  el.style.color          = '#e8685a';
  el.style.padding        = '12px 20px';
  el.style.borderRadius   = '10px';
  el.style.fontSize       = '14px';
  el.style.fontWeight     = '500';
  el.style.zIndex         = '9999';
  el.style.backdropFilter = 'blur(12px)';
  el.style.textAlign      = 'center';
  el.style.maxWidth       = '90vw';
  el.style.fontFamily     = 'Inter, sans-serif';
  el.textContent = '⚠️ ' + msg;
  document.body.appendChild(el);
  setTimeout(function() {
    if (el && el.parentNode) el.remove();
  }, 4000);
}
window._showQuizWarning = showQuizWarning;

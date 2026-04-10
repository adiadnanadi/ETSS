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
    showQuizWarning('Screenshot je onemogućen tokom kviza!', 'screenshot');
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
      showQuizWarning('Napustili ste kviz 3 puta! Kviz će biti automatski predan.', 'final');
      setTimeout(function() {
        if (typeof window.autoSubmitQuiz === 'function') {
          window.autoSubmitQuiz();
        }
      }, 3000);
    }
  } else {
    if (warningCount > 0 && warningCount < 3) {
      showQuizWarning('Ne napuštajte kviz tokom rješavanja!', 'tab');
    }
  }
});

// ─── Blur detekcija (alt-tab, klik na drugu app) ───────────────────────
var blurTimeout = null;
window.addEventListener('blur', function() {
  if (!window._quizActive) return;
  // Kratki delay da izbjegnemo lažne alarme
  blurTimeout = setTimeout(function() {
    if (!document.hasFocus() && window._quizActive) {
      warningCount++;
      window._tabSwitches = warningCount;
      if (warningCount >= 3) {
        showQuizWarning('Napustili ste kviz 3 puta! Kviz će biti automatski predan.', 'final');
        setTimeout(function() {
          if (typeof window.autoSubmitQuiz === 'function') {
            window.autoSubmitQuiz();
          }
        }, 3000);
      } else {
        showQuizWarning('Detektovano prebacivanje na drugu aplikaciju!', 'blur');
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

// ─── Splitscreen detekcija (resize prozora) ────────────────────────────
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
      showQuizWarning('Napustili ste kviz 3 puta! Kviz će biti automatski predan.', 'final');
      setTimeout(function() {
        if (typeof window.autoSubmitQuiz === 'function') {
          window.autoSubmitQuiz();
        }
      }, 3000);
    } else {
      showQuizWarning('Detektovano dijeljenje ekrana! Koristite cijeli ekran.', 'split');
    }
  }

  // Resetuj kad vrate prozor na normalnu veličinu
  if (!isSplit && splitWarned) {
    splitWarned = false;
  }
});

// ─── Premium Warning prikaz ───────────────────────────────────────────────
function showQuizWarning(msg, type) {
  // Remove existing warnings
  var old = document.getElementById('quiz-warning');
  if (old) old.remove();

  // Determine warning level
  var level = warningCount >= 3 ? 3 : warningCount >= 2 ? 2 : 1;
  var icon = level >= 3 ? '🚨' : level >= 2 ? '⚠️' : '⚡';

  // Build warning dots (show 3 dots, fill based on count)
  var dotsHtml = '';
  for (var d = 0; d < 3; d++) {
    dotsHtml += '<div class="warning-dot' + (d < warningCount ? ' active' : '') + '"></div>';
  }

  var el = document.createElement('div');
  el.id = 'quiz-warning';
  el.className = 'quiz-warning-overlay';
  el.innerHTML =
    '<div class="quiz-warning-bar warn-level-' + level + '">' +
      '<div class="warning-icon">' + icon + '</div>' +
      '<span>Upozorenje ' + Math.min(warningCount, 3) + '/3 — ' + msg + '</span>' +
      '<div class="warning-counter">' + dotsHtml + '</div>' +
      '<div class="warning-progress"></div>' +
    '</div>';

  document.body.appendChild(el);

  // Auto-remove after 5 seconds (unless it's the final warning)
  if (level < 3) {
    setTimeout(function() {
      if (el && el.parentNode) {
        el.style.animation = 'none';
        el.style.transition = 'opacity .4s ease, transform .4s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateY(-100%)';
        setTimeout(function() {
          if (el && el.parentNode) el.remove();
        }, 400);
      }
    }, 5000);
  }
}
window._showQuizWarning = showQuizWarning;

// ─── TOAST ────────────────────────────────────────────────────────────────────
export function toast(msg, type = 'info', ms = 3500) {
  let box = document.getElementById('toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';
  el.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 300); }, ms);
}

// ─── LOADING ──────────────────────────────────────────────────────────────────
export function showLoading(msg = 'Učitavanje...') {
  let el = document.getElementById('loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading';
    el.innerHTML = `<div class="spinner"></div><p>${msg}</p>`;
    document.body.appendChild(el);
  } else {
    el.querySelector('p').textContent = msg;
    el.style.display = 'flex';
  }
}
export function hideLoading() {
  const el = document.getElementById('loading');
  if (el) el.style.display = 'none';
}

// ─── BTN LOADING ─────────────────────────────────────────────────────────────
export function btnLoad(btn, text = 'Molimo pričekajte...') {
  btn._orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${text}`;
}
export function btnReset(btn) {
  btn.disabled = false;
  btn.innerHTML = btn._orig || btn.innerHTML;
}

// ─── BADGE HELPERS ───────────────────────────────────────────────────────────
export function gradeBadge(grade, label) {
  const cls = grade >= 3 ? 'badge-green' : 'badge-red';
  return `<span class="badge ${cls}">${grade} — ${label}</span>`;
}
export function pctColor(pct) {
  return pct >= 75 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)';
}

// ─── DATE FORMAT ─────────────────────────────────────────────────────────────
export function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('bs-BA', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
export function fmtDateTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('bs-BA');
}

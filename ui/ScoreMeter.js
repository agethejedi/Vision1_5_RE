// vision/ui/ScoreMeter.js
// Compatibility Score Panel with an imperative API expected by app.js:
//   const sp = ScoreMeter('#score-panel');
//   sp.setScore(55, { blocked:false, reasons:[...] });
//   sp.setBlocked(true);
//   sp.setReasons(['OFAC / sanctions list match', ...]);
//   sp.setSummary(result); // preferred: pass the whole result

export function ScoreMeter(root) {
  const el = (typeof root === 'string') ? document.querySelector(root) : root;
  if (!el) {
    // return a no-op API to avoid crashes if panel is absent
    return {
      setScore(){}, setBlocked(){}, setReasons(){}, setSummary(){}, getScore(){ return 0; }
    };
  }

  // Locate sub-elements if present (all optional)
  const labelEl   = el.querySelector('.score-text') || el.querySelector('[data-role="score-text"]');
  const subEl     = el.querySelector('.score-sub')  || el.querySelector('[data-role="score-sub"]');
  const ringSvg   = el.querySelector('svg'); // optional SVG arc
  const ringArc   = ringSvg ? ringSvg.querySelector('.arc') : null;
  const reasonsEl = el.querySelector('.reasons') || el.querySelector('[data-role="reasons"]');

  let _score = 0;
  let _blocked = false;

  function clamp(n){ n = Number(n)||0; return n < 0 ? 0 : (n > 100 ? 100 : n); }
  function ringColor(score){
    if (_blocked || score >= 80) return '#ef4444'; // red
    if (score >= 60) return '#f59e0b';             // amber
    return '#10b981';                               // green
  }
  function bandLabel(score){
    if (_blocked || score >= 80) return 'High';
    if (score >= 60) return 'Elevated';
    return 'Moderate';
  }
  function apply(){
    // main label
    if (labelEl) labelEl.textContent = _blocked ? 'Blocked' : String(_score);
    // subtitle
    if (subEl)   subEl.textContent = _blocked ? 'Policy: Hard Block' : bandLabel(_score);
    // class + CSS var color (works with your styles.css from earlier)
    el.classList.add('score-meter');
    el.classList.toggle('blocked', _blocked);
    el.style.setProperty('--ring-color', ringColor(_score));
    // optional SVG arc update
    if (ringArc) {
      const pct = _score / 100;
      const dash = 283 * pct; // 2πr for ~45 radius ring
      ringArc.setAttribute('stroke', ringColor(_score));
      ringArc.setAttribute('stroke-dasharray', `${dash} 999`);
    }
  }

  function setScore(score, opts = {}) {
    _score = clamp(score);
    if (typeof opts.blocked === 'boolean') _blocked = opts.blocked;
    apply();
  }
  function setBlocked(flag) {
    _blocked = !!flag;
    if (_blocked && _score < 100) _score = 100; // force 100 on blocked, per policy
    apply();
  }
  function setReasons(list) {
    if (!reasonsEl) return;
    const items = Array.isArray(list) ? list.filter(Boolean) : [];
    reasonsEl.innerHTML = items.length
      ? items.map(t => `<div class="reason">${escapeHtml(t)}</div>`).join('')
      : `<div class="reason muted">No elevated factors detected</div>`;
  }
  function setSummary(result = {}) {
    // Trust server-side policy when provided
    const blocked = !!(result.block || result.risk_score === 100 || result.sanctionHits);
    const score = (typeof result.risk_score === 'number')
      ? result.risk_score
      : (typeof result.score === 'number' ? result.score : (blocked ? 100 : 0));
    setReasons(result.reasons || result.risk_factors || []);
    setScore(score, { blocked });
  }

  function getScore(){ return _score; }

  // Initial paint
  apply();

  return { setScore, setBlocked, setReasons, setSummary, getScore };
}

// Small escape helper for reasons text
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

// Default export and legacy global for maximum compatibility
const api = { ScoreMeter };
export default api;
try { if (typeof window !== 'undefined') window.ScoreMeter = ScoreMeter; } catch {}

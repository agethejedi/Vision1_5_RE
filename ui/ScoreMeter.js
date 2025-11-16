// ui/ScoreMeter.js — Vision 1_5_RE
// Compact gauge widget used by app.js via window.ScoreMeter('#scorePanel')

import { colorForScore, bandForScore } from '../lib/risk-colors.js';

(function () {
  function createMeter(root) {
    root.innerHTML = `
      <div class="score-panel score-meter">
        <div class="meter">
          <svg viewBox="0 0 100 100" class="ring">
            <circle class="track"
                    cx="50" cy="50" r="45"
                    fill="none" stroke-width="8"></circle>
            <circle class="arc"
                    cx="50" cy="50" r="45"
                    fill="none" stroke-width="8"
                    stroke-linecap="round"
                    stroke-dasharray="0 283"></circle>
          </svg>
          <div class="label">
            <div class="score-text">0</div>
            <div class="score-sub">Moderate</div>
          </div>
        </div>
        <div class="reasons"></div>
      </div>
    `;

    const arcEl      = root.querySelector('.arc');
    const scoreText  = root.querySelector('.score-text');
    const scoreSub   = root.querySelector('.score-sub');
    const reasonsEl  = root.querySelector('.reasons');
    const panelEl    = root.querySelector('.score-panel');
    const CIRC       = 2 * Math.PI * 45; // circle length for r=45

    function clamp(x, lo = 0, hi = 100) {
      x = Number(x) || 0;
      return Math.max(lo, Math.min(hi, x));
    }

    function setScore(val) {
      const s = clamp(val);
      const dash = (s / 100) * CIRC;
      arcEl.style.strokeDasharray = `${dash} ${CIRC}`;
      scoreText.textContent = String(Math.round(s));
    }

    function setBlocked(blocked) {
      if (blocked) panelEl.classList.add('blocked');
      else panelEl.classList.remove('blocked');
    }

    function setReasons(breakdown) {
      reasonsEl.innerHTML = '';
      if (!Array.isArray(breakdown) || !breakdown.length) {
        reasonsEl.textContent = 'No elevated factors detected';
        return;
      }
      breakdown.forEach(item => {
        const div = document.createElement('div');
        div.className = 'reason';
        const delta = typeof item.delta === 'number'
          ? (item.delta > 0 ? `+${item.delta}` : String(item.delta))
          : '0';
        div.innerHTML = `
          <span>${item.label}</span>
          <span class="val">${delta}</span>
        `;
        reasonsEl.appendChild(div);
      });
    }

    function setSummary(res = {}) {
      const score = (typeof res.score === 'number')
        ? res.score
        : (typeof res.risk_score === 'number' ? res.risk_score : 0);

      const blocked = !!(
        res.block ||
        res.blocked ||
        res.risk_score === 100 ||
        res.sanctionHits ||
        res.explain?.ofacHit ||
        res.ofac === true
      );

      // Single source: colors + bands
      const color = colorForScore(score, blocked);
      const band  = bandForScore(score, blocked);

      // Apply meter visuals
      setScore(score);
      scoreSub.textContent = band;
      setBlocked(blocked);
      setReasons(res.breakdown || res.reasons || res.risk_factors || []);

      // Sync ring color to the shared palette
      panelEl.style.setProperty('--ring-color', color);
      panelEl.dataset.rxlBand = band;
    }

    function getScore() {
      return Number(scoreText.textContent) || 0;
    }

    return { setScore, setBlocked, setReasons, setSummary, getScore };
  }

  // Public factory
  window.ScoreMeter = function (selector) {
    const el = (typeof selector === 'string')
      ? document.querySelector(selector)
      : selector;
    if (!el) {
      return {
        setScore() {}, setBlocked() {}, setReasons() {},
        setSummary() {}, getScore() { return 0; }
      };
    }
    return createMeter(el);
  };
})();

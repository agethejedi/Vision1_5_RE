// lib/risk-model.js
// Balanced Rule-Based + Gov ensemble v1 for Vision 1_5_RE

import { normalizeAddress, computeAgeDays, bandForScore } from './utils.js';

function buildIndexOfac(ofacJson) {
  const map = new Map();
  const entries = Array.isArray(ofacJson?.entries) ? ofacJson.entries : [];
  for (const e of entries) {
    const addr = normalizeAddress(e.address);
    if (!addr) continue;
    map.set(addr, {
      network: (e.network || 'ethereum').toLowerCase(),
      entity: e.entity || null,
      risk_score: e.risk_score || 100,
      tags: e.tags || []
    });
  }
  return map;
}

function buildIndexMixers(mixersJson) {
  const map = new Map();
  const mixers = Array.isArray(mixersJson?.mixers) ? mixersJson.mixers : [];
  for (const m of mixers) {
    const name = m.name || 'Mixer';
    const nets = (m.networks || []).map(x => String(x).toLowerCase());
    const level = m.risk_level || 'high';
    const addrs = m.addresses || [];
    for (const a of addrs) {
      const addr = normalizeAddress(a);
      if (!addr) continue;
      map.set(addr, { name, nets, level });
    }
  }
  return map;
}

function buildIndexCustodians(custJson) {
  const map = new Map();
  const list = Array.isArray(custJson?.custodians) ? custJson.custodians : [];
  for (const c of list) {
    const name = c.name || 'Custodian';
    const nets = (c.networks || []).map(x => String(x).toLowerCase());
    const risk = c.risk_level || 'low';
    const category = c.category || 'CEX';
    const notes = c.notes || '';
    const addrs = c.addresses || [];
    for (const a of addrs) {
      const addr = normalizeAddress(a);
      if (!addr) continue;
      map.set(addr, { name, nets, risk, category, notes });
    }
  }
  return map;
}

export function buildContext({ address, network, txs, data }) {
  const addr = normalizeAddress(address);
  const net = (network || 'eth').toLowerCase();

  const ofacIndex = buildIndexOfac(data.ofac || {});
  const mixerIndex = buildIndexMixers(data.mixers || {});
  const custIndex = buildIndexCustodians(data.custodians || {});
  const heur = data.heuristics || {};

  const ageDays = computeAgeDays(txs || []);

  const ctx = {
    address: addr,
    network: net,
    txs: txs || [],
    data: { ofacIndex, mixerIndex, custIndex, heur },
    feats: {
      ageDays,
      mixerTaint: 0,
      local: {
        riskyNeighborRatio: 0,
        neighborAvgTx: null,
        neighborAvgAgeDays: null,
        neighborCount: null
      }
    }
  };

  return ctx;
}

export function scoreAddress({ ctx }) {
  const { address, network, feats } = ctx;
  const heur = ctx.data.heur || {};
  const W = heur.weights || {};
  const bands = heur.bands || {};
  const thresholds = heur.thresholds || {};

  let score = 0;
  let block = false;
  const reasons = [];
  const factorImpacts = [];

  // --- OFAC direct ---
  const ofacHit = ctx.data.ofacIndex.get(address);
  if (ofacHit) {
    score = Math.max(score, W.ofac_direct ?? 100);
    block = true;
    reasons.push('OFAC/sanctions list match');
    factorImpacts.push({ key: 'ofac_direct', label: 'OFAC match', delta: W.ofac_direct ?? 100 });
  }

  // --- Mixer proximity (direct address-level heuristic) ---
  const mixerHit = ctx.data.mixerIndex.get(address);
  if (mixerHit && !block) {
    score += W.mixer_direct ?? 35;
    reasons.push('known Mixer Proximity');
    factorImpacts.push({ key: 'mixer_direct', label: 'Mixer direct', delta: W.mixer_direct ?? 35 });
    feats.mixerTaint = Math.min(1, (feats.mixerTaint || 0) + 0.6);
  }

  // --- Custodian dampener ---
  const custHit = ctx.data.custIndex.get(address);
  if (custHit && !block) {
    const damp = heur.custodian?.dampener ?? (W.custodian_dampener ?? -15);
    score += damp;
    reasons.push('Custodian (reduced risk)');
    factorImpacts.push({ key: 'custodian_dampener', label: 'Custodian', delta: damp });
  }

  // --- Wallet age (younger → riskier) ---
  if (!block && typeof feats.ageDays === 'number') {
    const d = feats.ageDays;
    let add = 0;
    if (d < 30) add = W.young_wallet_lt_30d ?? 15;
    else if (d < 90) add = W.young_wallet_30_90d ?? 10;
    else if (d < 180) add = W.young_wallet_90_180d ?? 6;
    if (add) {
      score += add;
      reasons.push('Young wallet');
      factorImpacts.push({ key: 'age_young', label: 'Young wallet', delta: add });
    }
  }

  // --- Neighbor stats: we let UI proxy this; here just mild bump if high inactive ratio ---
  if (!block && typeof feats.local?.riskyNeighborRatio === 'number') {
    const r = feats.local.riskyNeighborRatio;
    const step = W.neighbors_inactive_ratio_per_0_1 ?? 2;
    const add = Math.round(r / 0.1) * step;
    if (add > 0) {
      score += add;
      reasons.push('Dormant neighbors');
      factorImpacts.push({ key: 'neighbors_dormant', label: 'Dormant neighbors', delta: add });
    }
  }

  // Clamp & band
  if (!block) {
    const min = heur.score?.min ?? 0;
    const max = heur.score?.max ?? 100;
    score = Math.max(min, Math.min(max, score));
  } else {
    score = heur.score?.max ?? 100;
  }

  const scoreBand = bandForScore(score, bands);

  const res = {
    address,
    id: address,
    network,
    block,
    risk_score: score,
    reasons,
    risk_factors: reasons,
    feats,
    score_band: scoreBand,
    explain: {
      reasons,
      blocked: block,
      ofacHit: !!ofacHit,
      factorImpacts
    }
  };

  if (feats.local?.neighborCount != null && feats.local.neighborCount < (heur.narrative?.sparse_neighbor_threshold ?? 5)) {
    res.sparseNeighborhood = true;
  }

  return res;
}

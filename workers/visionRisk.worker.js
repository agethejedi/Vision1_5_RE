// workers/visionRisk.worker.js
// Scoring + dynamic breakdown + age + NEIGHBORS with real-onchain fallback via /txs.

let CFG = {
  apiBase: "",
  network: "eth",
  concurrency: 8,
  flags: { graphSignals: true, streamBatch: true, neighborStats: true },
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    if (type === 'INIT') {
      if (payload?.apiBase) CFG.apiBase = String(payload.apiBase).replace(/\/$/, '');
      if (payload?.network) CFG.network = payload.network;
      if (payload?.concurrency) CFG.concurrency = payload.concurrency;
      if (payload?.flags) CFG.flags = { ...CFG.flags, ...payload.flags };
      post({ id, type: 'INIT_OK' });
      return;
    }

    if (type === 'SCORE_ONE') {
      const item = payload?.item;
      const res = await scoreOne(item);
      post({ id, type: 'RESULT', data: res });
      return;
    }

    if (type === 'SCORE_BATCH') {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const it of items) {
        const r = await scoreOne(it);
        post({ type: 'RESULT_STREAM', data: r });
      }
      post({ id, type: 'DONE' });
      return;
    }

    if (type === 'NEIGHBORS') {
      const addr = (payload?.id || payload?.address || '').toLowerCase();
      const network = payload?.network || CFG.network || 'eth';
      const hop = Number(payload?.hop ?? 1) || 1;
      const limit = Number(payload?.limit ?? 250) || 250;

      let data = null;

      // 1) Try canonical /neighbors
      try {
        data = await fetchNeighbors(addr, network, { hop, limit });
      } catch {}

      // 2) If missing/empty, derive neighbors from /txs counterparties (real data)
      if (!data || !Array.isArray(data.nodes) || !data.nodes.length) {
        data = await deriveNeighborsFromTxs(addr, network, { limit });
      }

      // 3) As a last resort (no API at all), tiny stub so UI path still functions
      if (!data || !Array.isArray(data.nodes) || !data.nodes.length) {
        data = stubNeighbors(addr);
      }

      post({ id, type: 'RESULT', data });
      return;
    }

    throw new Error(`unknown type: ${type}`);
  } catch (err) {
    post({ id, type: 'ERROR', error: String(err?.message || err) });
  }
};

function post(msg){ self.postMessage(msg); }

/* ====================== SCORE CORE ======================= */

async function scoreOne(item) {
  const idRaw = item?.id || item?.address || '';
  const id = String(idRaw).toLowerCase();
  const network = item?.network || CFG.network || 'eth';
  if (!id) throw new Error('scoreOne: missing id');

  // 1) Policy / list check
  let policy = null;
  try {
    if (CFG.apiBase) {
      const url = `${CFG.apiBase}/check?address=${encodeURIComponent(id)}&network=${encodeURIComponent(network)}`;
      const r = await fetch(url, { headers: { 'accept':'application/json' }, cf:{ cacheTtl: 0 } }).catch(()=>null);
      if (r && r.ok) policy = await r.json();
    }
  } catch (_) {}

  // 2) Local baseline
  let localScore = 55;
  const blocked = !!(policy?.block || policy?.risk_score === 100);
  const mergedScore = blocked ? 100 :
    (typeof policy?.risk_score === 'number' ? policy.risk_score : localScore);

  // 3) Dynamic breakdown
  const breakdown = makeBreakdown(policy);

  // 4) Account age (days)
  const ageDays = await fetchAgeDays(id, network).catch(()=>0);

  // 5) Unified shape
  const reasons = policy?.reasons || policy?.risk_factors || [];
  return {
    type: 'address',
    id,
    address: id,
    network,
    label: id.slice(0,10)+'…',
    block: blocked,
    risk_score: mergedScore,
    score: mergedScore,
    reasons,
    risk_factors: reasons,
    breakdown,
    feats: {
      ageDays,
      mixerTaint: 0,
      local: { riskyNeighborRatio: 0 },
    },
    explain: {
      reasons,
      blocked,
      ofacHit: coerceOfacFromPolicy(policy, reasons),
    },
    parity: 'SafeSend parity',
  };
}

/* ====================== NEIGHBORS ======================== */

async function fetchNeighbors(address, network, { hop=1, limit=250 } = {}){
  if (!CFG.apiBase) return null;

  const url = `${CFG.apiBase}/neighbors?address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}&hop=${hop}&limit=${limit}`;
  const r = await fetch(url, { headers: { 'accept':'application/json' }, cf:{ cacheTtl: 0 } });
  if (!r.ok) return null;
  const raw = await r.json().catch(()=> ({}));

  const nodes = [];
  const links = [];

  const pushNode = (n) => {
    const id = String(n?.id || n?.address || n?.addr || '').toLowerCase();
    if (!id) return;
    nodes.push({ id, address:id, network, ...n });
  };
  const pushLink = (L) => {
    const a = String(L?.a ?? L?.source ?? L?.idA ?? L?.from ?? '').toLowerCase();
    const b = String(L?.b ?? L?.target ?? L?.idB ?? L?.to   ?? '').toLowerCase();
    if (!a || !b || a === b) return;
    links.push({ a, b, weight: Number(L?.weight ?? 1) || 1 });
  };

  if (Array.isArray(raw?.nodes)) raw.nodes.forEach(pushNode);
  if (Array.isArray(raw?.links)) raw.links.forEach(pushLink);

  if (!nodes.length && Array.isArray(raw)) {
    const set = new Set();
    for (const L of raw) {
      const a = String(L?.a ?? L?.source ?? L?.from ?? L?.idA ?? '').toLowerCase();
      const b = String(L?.b ?? L?.target ?? L?.to   ?? L?.idB ?? '').toLowerCase();
      if (a) set.add(a);
      if (b) set.add(b);
      pushLink(L);
    }
    set.forEach(id => nodes.push({ id, address:id, network }));
  }

  if (!nodes.length && !links.length) return null;
  return { nodes, links };
}

/** Fallback: derive 1-hop neighbors from /txs counterparties (real addresses). */
async function deriveNeighborsFromTxs(address, network, { limit=200 } = {}){
  if (!CFG.apiBase) return null;

  // Pull earliest N (or most recent) — use desc so we get active counterparties
  // Adjust to your proxy semantics if needed.
  const url = `${CFG.apiBase}/txs?address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}&limit=${limit}&sort=desc`;
  const r = await fetch(url, { headers:{ 'accept':'application/json' }, cf:{ cacheTtl: 0 } });
  if (!r.ok) return null;

  const data = await r.json().catch(()=> ({}));
  const arr = Array.isArray(data?.result) ? data.result : [];
  if (!arr.length) return null;

  const center = String(address).toLowerCase();
  const set = new Set();
  const nodes = [{ id:center, address:center, network }];
  const links = [];

  for (const t of arr) {
    const from = pickAddr(t, 'from');
    const to   = pickAddr(t, 'to');
    const other =
      (from && from !== center) ? from :
      (to   && to   !== center) ? to   : null;
    if (!other) continue;
    if (!set.has(other)) {
      set.add(other);
      nodes.push({ id:other, address:other, network });
      links.push({ a:center, b:other, weight:1 });
    }
  }

  if (nodes.length <= 1) return null;
  return { nodes, links };
}

function pickAddr(tx, side){
  // Support many shapes: t.from, t.to, t.raw.fromAddress, etc.
  const s = side === 'from' ? ['from','fromAddress'] : ['to','toAddress'];
  for (const k of s) {
    const v = tx?.[k] || tx?.raw?.[k] || tx?.metadata?.[k];
    if (v) return String(v).toLowerCase();
  }
  return null;
}

function stubNeighbors(center){
  // Last-resort demo so UI plumbing can be verified
  const centerId = String(center || '').toLowerCase() || '0xseed';
  const n = 10, nodes = [{ id:centerId, address:centerId, network: CFG.network }];
  const links = [];
  for (let i=0;i<n;i++){
    const id = `0x${Math.random().toString(16).slice(2).padStart(40,'0').slice(0,40)}`;
    nodes.push({ id, address:id, network: CFG.network });
    links.push({ a:centerId, b:id, weight:1 });
  }
  return { nodes, links };
}

/* ====================== HELPERS ======================== */

const WEIGHTS = {
  'OFAC': 40,
  'OFAC/sanctions list match': 40,
  'sanctioned Counterparty': 40,
  'fan In High': 9,
  'shortest Path To Sanctioned': 6,
  'burst Anomaly': 0,
  'known Mixer Proximity': 0,
};

function makeBreakdown(policy){
  const src = policy?.reasons || policy?.risk_factors || [];
  if (!Array.isArray(src) || src.length === 0) return [];
  const list = src.map(r => ({ label: String(r), delta: WEIGHTS[r] ?? 0 }));
  const hasSanctioned = list.some(x => /sanction|ofac/i.test(x.label));
  if ((policy?.block || policy?.risk_score === 100) && !hasSanctioned) {
    list.unshift({ label: 'sanctioned Counterparty', delta: 40 });
  }
  return list.sort((a,b) => (b.delta - a.delta));
}

async function fetchAgeDays(address, network){
  if (!CFG.apiBase) return 0;
  const url = `${CFG.apiBase}/txs?address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}&limit=1&sort=asc`;
  const r = await fetch(url, { headers:{ 'accept':'application/json' }, cf:{ cacheTtl: 0 } });
  if (!r.ok) return 0;
  const data = await r.json().catch(()=>({}));
  const arr  = Array.isArray(data?.result) ? data.result : [];
  if (arr.length === 0) return 0;

  const t = arr[0];
  const iso = t?.raw?.metadata?.blockTimestamp || t?.metadata?.blockTimestamp;
  const sec = t?.timeStamp || t?.timestamp || t?.blockTime;
  let ms = 0;
  if (iso) { const d = new Date(iso); if (!isNaN(d)) ms = d.getTime(); }
  if (!ms && sec) {
    const n = Number(sec);
    if (!isNaN(n) && n > 1000000000) ms = (n < 2000000000 ? n*1000 : n);
  }
  if (!ms) return 0;

  const days = (Date.now() - ms) / 86400000;
  return days > 0 ? Math.round(days) : 0;
}

function coerceOfacFromPolicy(policy, reasons){
  const txt = Array.isArray(reasons) ? reasons.join(' | ').toLowerCase() : String(reasons||'').toLowerCase();
  return !!(policy?.block || policy?.risk_score === 100 || /ofac|sanction/.test(txt));
}

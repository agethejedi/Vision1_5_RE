// workers/visionRisk.worker.js
// Server-policy aware scoring + dynamic breakdown + account age (years/months).

let CFG = {
  apiBase: "",
  network: "eth",
  concurrency: 8,
  flags: { graphSignals: true, streamBatch: true },
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

    throw new Error(`unknown type: ${type}`);
  } catch (err) {
    post({ id, type: 'ERROR', error: String(err?.message || err) });
  }
};

function post(msg){ self.postMessage(msg); }

// ---------------- core ----------------

async function scoreOne(item) {
  const id = item?.id || item?.address || '';
  const network = item?.network || CFG.network || 'eth';
  if (!id) throw new Error('scoreOne: missing id');

  // 1) Policy / list check
  let policy = null;
  try {
    const url = `${CFG.apiBase}/check?address=${encodeURIComponent(id)}&network=${encodeURIComponent(network)}`;
    const r = await fetch(url, { headers: { 'accept':'application/json' }, cf:{ cacheTtl: 0 } }).catch(()=>null);
    if (r && r.ok) policy = await r.json();
  } catch (_) {}

  // 2) Local baseline (keeps your mid 55 unless server says otherwise)
  let localScore = 55;
  const blocked = !!(policy?.block || policy?.risk_score === 100);
  const mergedScore = blocked ? 100 :
    (typeof policy?.risk_score === 'number' ? policy.risk_score : localScore);

  // 3) Dynamic breakdown (from reasons → weighted items)
  const breakdown = makeBreakdown(policy);

  // 4) Account age (days) via earliest tx from your /txs proxy
  const ageDays = await fetchAgeDays(id, network).catch(()=>0);

  // 5) Return unified shape
  const res = {
    type: 'address',
    id,
    address: id,
    network,
    label: id.slice(0,10)+'…',

    block: blocked,
    risk_score: mergedScore,
    score: mergedScore,                 // legacy
    reasons: policy?.reasons || policy?.risk_factors || [],
    risk_factors: policy?.risk_factors || policy?.reasons || [],

    breakdown,                          // <-- dynamic factor list
    feats: {
      ageDays,                          // <-- used by UI to render years/months
      mixerTaint: 0,
      local: { riskyNeighborRatio: 0 },
    },

    explain: { reasons: (policy?.reasons || []), blocked },
    parity: 'SafeSend parity',
  };

  return res;
}

// ---- helpers ----

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
  const list = src.map(r => ({
    label: String(r),
    delta: WEIGHTS[r] ?? 0,
  }));
  // If blocked and the explicit label wasn't present, add the standard label
  const hasSanctioned = list.some(x => /sanction/i.test(x.label));
  if ((policy?.block || policy?.risk_score === 100) && !hasSanctioned) {
    list.unshift({ label: 'sanctioned Counterparty', delta: 40 });
  }
  // sort by weight desc, keep stable for equal weights
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

  // pick earliest record and extract a timestamp robustly
  const t = arr[0];
  const iso = t?.raw?.metadata?.blockTimestamp || t?.metadata?.blockTimestamp;
  const sec = t?.timeStamp || t?.timestamp || t?.blockTime;
  let ms = 0;
  if (iso) { const d = new Date(iso); if (!isNaN(d)) ms = d.getTime(); }
  if (!ms && sec) {
    const n = Number(sec);
    if (!isNaN(n) && n > 1000000000) ms = (n < 2000000000 ? n*1000 : n); // handle seconds or ms
  }
  if (!ms) return 0;

  const days = (Date.now() - ms) / 86400000;
  return days > 0 ? Math.round(days) : 0;
}

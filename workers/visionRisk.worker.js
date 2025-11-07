// workers/visionRisk.worker.js — Vision 1_4_2
// Instrumented neighbors + NEIGHBOR_STATS + TTL cache + batched scoring

let CFG = {
  apiBase: "",
  network: "eth",
  concurrency: 8,
  flags: { graphSignals: true, streamBatch: true, neighborStats: true },
};

const TTL_MS = 10 * 60 * 1000; // 10 min
const neighborCache = new Map(); // key `${net}:${addr}:limit` -> { ts, payload }
const scoreCache = new Map();    // key `${net}:${addr}` -> last result (for stats)

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
      const addr = normalizeAddr(payload?.id || payload?.address);
      const network = payload?.network || CFG.network || 'eth';
      const hop = Number(payload?.hop ?? 1) || 1;
      const reqLimit = Number(payload?.limit ?? 250) || 250;
      const cap = Number(payload?.cap ?? 120) || 120;

      // 1) cached?
      const cacheKey = `${network}:${addr}:${reqLimit}`;
      const cached = neighborCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < TTL_MS) {
        post({ type:'RESULT', id, data: cached.payload.graph });        // nodes/links for UI
        post({ type:'NEIGHBOR_STATS', data: { ...cached.payload.stats, source:'cache' }});
        return;
      }

      // 2) fetch (instrument timings)
      const t0 = Date.now();
      const fetch1 = await fetchNeighbors(addr, network, { hop, limit: reqLimit }).catch(() => null);
      const msFetch = Date.now() - t0;

      let graph = fetch1 || { nodes:[], links:[] };
      let totalNeighbors = (graph.nodes?.length || 0) - 1;

      // Guard against partial graphs (<5). Retry ONCE.
      let retried = false;
      if (totalNeighbors < 5) {
        retried = true;
        const t1 = Date.now();
        const fetch2 = await fetchNeighbors(addr, network, { hop, limit: Math.max(50, reqLimit) }).catch(() => null);
        graph = fetch2 || graph;
        totalNeighbors = (graph.nodes?.length || 0) - 1;
        graph._msRetry = Date.now() - t1;
      }

      // Deterministic cap
      const limited = limitGraph(graph, cap);
      const overflow = Math.max(0, totalNeighbors - (limited.nodes.length - 1));

      // 3) send graph to UI
      post({ type:'RESULT', id, data: limited });

      // 4) score neighbors in batches (25 w/ 75ms gap) and compute stats
      const neighborIds = limited.nodes.map(n => n.id).filter(id2 => id2 !== addr);
      const stats = await scoreNeighborsAndSummarize(addr, network, neighborIds, {
        batchSize: 25, gapMs: 75
      });

      const sparseNeighborhood = totalNeighbors < 5;
      const outStats = {
        id: addr, network,
        n: neighborIds.length, totalNeighbors, overflow,
        avgDays: stats.avgDays, avgTx: stats.avgTx,
        inactiveRatio: stats.inactiveRatio,
        sparseNeighborhood,
        timings: { msFetch, msScore: stats.msScore || 0, msRetry: graph._msRetry || 0 },
        source: 'network'
      };

      // cache both graph + stats
      neighborCache.set(cacheKey, { ts: Date.now(), payload: { graph: limited, stats: outStats } });

      // 5) emit stats
      post({ type:'NEIGHBOR_STATS', data: outStats });
      return;
    }

    throw new Error(`unknown type: ${type}`);
  } catch (err) {
    post({ id, type: 'ERROR', error: String(err?.message || err) });
  }
};

function post(msg){ self.postMessage(msg); }
function normalizeAddr(x){ return String(x||'').toLowerCase(); }

/* ====================== SCORE CORE ======================= */

async function scoreOne(item) {
  const idRaw = item?.id || item?.address || '';
  const id = normalizeAddr(idRaw);
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

  // 5) Build result
  const reasons = policy?.reasons || policy?.risk_factors || [];
  const res = {
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
      txCount: null, // placeholder for future backend enrichment
    },
    parity: 'SafeSend parity',
  };

  // cache for stats aggregation
  scoreCache.set(`${network}:${id}`, res);
  return res;
}

/* ====================== NEIGHBORS ======================== */

async function fetchNeighbors(address, network, { hop=1, limit=250 } = {}){
  if (!CFG.apiBase) return stubNeighbors(address);

  const url = `${CFG.apiBase}/neighbors?address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}&hop=${hop}&limit=${limit}`;
  const r = await fetch(url, { headers: { 'accept':'application/json' }, cf:{ cacheTtl: 0 } });
  if (!r.ok) return stubNeighbors(address);
  const raw = await r.json().catch(()=> ({}));

  const nodes = [];
  const links = [];

  const pushNode = (n) => {
    const id = normalizeAddr(n?.id || n?.address || n?.addr || '');
    if (!id) return;
    nodes.push({ id, address:id, network, ...n });
  };
  const pushLink = (L) => {
    const a = normalizeAddr(L?.a ?? L?.source ?? L?.idA ?? L?.from ?? '');
    const b = normalizeAddr(L?.b ?? L?.target ?? L?.idB ?? L?.to   ?? '');
    if (!a || !b || a === b) return;
    links.push({ a, b, weight: Number(L?.weight ?? L?.amount ?? 1) || 1 });
  };

  if (Array.isArray(raw?.nodes)) raw.nodes.forEach(pushNode);
  if (Array.isArray(raw?.links)) raw.links.forEach(pushLink);

  if (!nodes.length && Array.isArray(raw)) {
    const set = new Set();
    for (const L of raw) {
      const a = normalizeAddr(L?.a ?? L?.source ?? L?.from ?? L?.idA ?? '');
      const b = normalizeAddr(L?.b ?? L?.target ?? L?.to   ?? L?.idB ?? '');
      if (a) set.add(a);
      if (b) set.add(b);
      pushLink(L);
    }
    set.forEach(id => nodes.push({ id, address:id, network }));
  }

  if (!nodes.length && !links.length) return stubNeighbors(address, network);
  return { nodes, links };
}

function stubNeighbors(center, network = CFG.network){
  const centerId = normalizeAddr(center || '0xseed');
  const n = 10, nodes = [{ id:centerId, address:centerId, network }];
  const links = [];
  for (let i=0;i<n;i++){
    const id = `0x${Math.random().toString(16).slice(2).padStart(40,'0').slice(0,40)}`;
    nodes.push({ id, address:id, network });
    links.push({ a:centerId, b:id, weight:1 });
  }
  return { nodes, links };
}

function limitGraph(graph, cap){
  const center = graph.nodes[0]?.id;
  const nodes = [];
  const links = [];
  const keep = new Set();

  // Keep center always
  if (center) { keep.add(center); nodes.push(graph.nodes.find(n => n.id === center)); }

  // Deterministically keep first `cap` neighbors in input order
  for (const n of graph.nodes) {
    if (n.id === center) continue;
    if (nodes.length - 1 >= cap) break;
    keep.add(n.id);
    nodes.push(n);
  }

  for (const L of graph.links) {
    if (keep.has(L.a) && keep.has(L.b)) links.push(L);
  }
  return { nodes, links };
}

/* ========== Batch scoring neighbors + stats aggregation ========== */

async function scoreNeighborsAndSummarize(centerId, network, neighborIds, { batchSize=25, gapMs=75 }={}){
  const key = (id)=> `${network}:${id}`;

  const todo = [];
  for (const id of neighborIds) {
    if (!scoreCache.has(key(id))) {
      todo.push({ type:'address', id, network });
    }
  }

  const t0 = Date.now();
  for (let i=0; i<todo.length; i += batchSize){
    const batch = todo.slice(i, i+batchSize);

    // Execute batch sequentially to respect rate limits
    for (const it of batch) {
      try {
        const r = await scoreOne(it);
        // stream neighbors too? optional; we skip to avoid UI spam
        // post({ type:'RESULT_STREAM', data:r });
      } catch (_) {}
    }

    // light backpressure
    if (i + batchSize < todo.length) {
      await sleep(gapMs);
    }
  }
  const msScore = Date.now() - t0;

  // Aggregate stats from cache
  let n = neighborIds.length;
  if (!n) return { n:0, avgDays:null, avgTx:null, inactiveRatio:0, msScore };

  let haveAge=0, sumAge=0;
  let haveTx=0, sumTx=0;
  let inactive=0;

  for (const id of neighborIds) {
    const s = scoreCache.get(key(id));
    const age = s?.feats?.ageDays;
    const tx  = s?.explain?.txCount ?? s?.txCount;
    if (typeof age === 'number') { sumAge += age; haveAge++; }
    if (typeof tx  === 'number') { sumTx  += tx;  haveTx++; }
    const isDormant = (typeof age === 'number' && age > 365) && !(tx > 0);
    if (isDormant) inactive++;
  }

  const avgDays = haveAge ? Math.round(sumAge / haveAge) : null;
  const avgTx   = haveTx ? (sumTx / haveTx) : null;
  const inactiveRatio = n ? (inactive / n) : 0;

  return { n, avgDays, avgTx, inactiveRatio, msScore };
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

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

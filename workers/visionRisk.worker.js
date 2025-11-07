// workers/visionRisk.worker.js — Vision 1_4_2a hot-fix
let CFG = { apiBase:"", network:"eth", concurrency:8, flags:{ graphSignals:true, streamBatch:true, neighborStats:true } };

const TTL_MS = 10*60*1000;
const neighborCache = new Map();
const scoreCache = new Map();

self.onmessage = async (e) => {
  const { id, type, payload } = e.data || {};
  try {
    if (type === 'INIT') {
      if (payload?.apiBase) CFG.apiBase = String(payload.apiBase).replace(/\/$/, '');
      if (payload?.network) CFG.network = payload.network;
      if (payload?.concurrency) CFG.concurrency = payload.concurrency;
      if (payload?.flags) CFG.flags = { ...CFG.flags, ...payload.flags };
      post({ id, type:'INIT_OK' });
      return;
    }

    if (type === 'SCORE_ONE') {
      const res = await scoreOne(payload?.item);
      post({ id, type:'RESULT', data: res });
      return;
    }

    if (type === 'SCORE_BATCH') {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const it of items) {
        const r = await scoreOne(it);
        post({ type:'RESULT_STREAM', data:r });
      }
      post({ id, type:'DONE' });
      return;
    }

    if (type === 'NEIGHBORS') {
      const addr = norm(payload?.id || payload?.address);
      const network = payload?.network || CFG.network || 'eth';
      const hop = Number(payload?.hop ?? 1) || 1;
      const reqLimit = Number(payload?.limit ?? 250) || 250;
      const cap = Number(payload?.cap ?? 120) || 120;

      const cacheKey = `${network}:${addr}:${reqLimit}`;
      const cached = neighborCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < TTL_MS) {
        console.info('[worker] neighbors(cache)', { addr, n:(cached.payload.graph.nodes?.length||1)-1 });
        post({ type:'RESULT', id, data: cached.payload.graph });
        post({ type:'NEIGHBOR_STATS', data:{ ...cached.payload.stats, source:'cache' } });
        return;
      }

      const t0 = Date.now();
      let graph = await fetchNeighbors(addr, network, { hop, limit:reqLimit }).catch(()=>null);
      let msFetch = Date.now() - t0;
      let totalNeighbors = (graph?.nodes?.length || 0) - 1;

      // Fallback: build neighbors from txs if neighbors API returns none
      if (!graph || totalNeighbors < 1) {
        console.warn('[worker] /neighbors empty → falling back to /txs neighborhood', { addr });
        const tTx = Date.now();
        graph = await fallbackNeighborsFromTxs(addr, network, reqLimit).catch(()=>null) || { nodes:[], links:[] };
        msFetch += (Date.now() - tTx);
        totalNeighbors = (graph.nodes.length || 0) - 1;
      }

      // Retry once if still very small
      let retried = false;
      if (totalNeighbors < 5) {
        retried = true;
        const t1 = Date.now();
        const g2 = await fetchNeighbors(addr, network, { hop, limit: Math.max(50, reqLimit) }).catch(()=>null);
        if (g2 && (g2.nodes?.length||0) > (graph.nodes?.length||0)) graph = g2;
        graph._msRetry = Date.now() - t1;
        totalNeighbors = (graph.nodes.length || 0) - 1;
      }

      // Cap & overflow
      const limited = limitGraph(graph, cap);
      const overflow = Math.max(0, totalNeighbors - (limited.nodes.length - 1));

      console.info('[worker] neighbors(final)', { addr, totalNeighbors, shown:(limited.nodes.length-1), overflow, msFetch, retried });

      // Emit graph immediately
      post({ type:'RESULT', id, data: limited });

      // Score neighbors in batches + summarize
      const ids = limited.nodes.map(n=>n.id).filter(x=>x!==addr);
      const stats = await scoreNeighborsAndSummarize(addr, network, ids, { batchSize:25, gapMs:75 });
      const outStats = {
        id: addr, network,
        n: ids.length, totalNeighbors, overflow,
        avgDays: stats.avgDays, avgTx: stats.avgTx,
        inactiveRatio: stats.inactiveRatio,
        sparseNeighborhood: totalNeighbors < 5,
        timings: { msFetch, msScore: stats.msScore || 0, msRetry: graph._msRetry || 0 },
        source: 'network'
      };

      neighborCache.set(cacheKey, { ts: Date.now(), payload: { graph: limited, stats: outStats } });
      post({ type:'NEIGHBOR_STATS', data: outStats });
      return;
    }

    throw new Error(`unknown type: ${type}`);
  } catch (err) {
    console.error('[worker] ERROR', err);
    post({ id, type:'ERROR', error: String(err?.message || err) });
  }
};

function post(m){ self.postMessage(m); }
function norm(x){ return String(x||'').toLowerCase(); }

/* ---- scoring (unchanged core) ---------------------------------- */
async function scoreOne(item){
  const id = norm(item?.id || item?.address || '');
  const network = item?.network || CFG.network || 'eth';
  if (!id) throw new Error('scoreOne: missing id');

  let policy = null;
  try {
    if (CFG.apiBase) {
      const url = `${CFG.apiBase}/check?address=${encodeURIComponent(id)}&network=${encodeURIComponent(network)}`;
      const r = await fetch(url, { headers:{ accept:'application/json' }, cf:{ cacheTtl:0 } }).catch(()=>null);
      if (r && r.ok) policy = await r.json();
    }
  } catch {}

  const blocked = !!(policy?.block || policy?.risk_score === 100);
  const score = blocked ? 100 : (typeof policy?.risk_score === 'number' ? policy.risk_score : 55);
  const reasons = policy?.reasons || policy?.risk_factors || [];
  const breakdown = makeBreakdown(policy);
  const ageDays = await fetchAgeDays(id, network).catch(()=>0);

  const res = {
    type:'address', id, address:id, network, label: id.slice(0,10)+'…',
    block: blocked, risk_score: score, score,
    reasons, risk_factors: reasons, breakdown,
    feats: { ageDays, mixerTaint:0, local:{ riskyNeighborRatio:0 } },
    explain: { reasons, blocked, ofacHit: coerceOfacFromPolicy(policy, reasons), txCount: null },
    parity: 'SafeSend parity',
  };
  scoreCache.set(`${network}:${id}`, res);
  return res;
}

/* ---- neighbors helpers ----------------------------------------- */
async function fetchNeighbors(address, network, { hop=1, limit=250 }={}){
  if (!CFG.apiBase) return { nodes:[{ id:address, address, network }], links:[] };
  const url = `${CFG.apiBase}/neighbors?address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}&hop=${hop}&limit=${limit}`;
  const r = await fetch(url, { headers:{ accept:'application/json' }, cf:{ cacheTtl:0 } });
  if (!r.ok) return { nodes:[{ id:address, address, network }], links:[] };
  const raw = await r.json().catch(()=> ({}));

  const nodes=[]; const links=[];
  const N = (n)=>{ const id = norm(n?.id || n?.address || n?.addr || ''); if(!id) return; nodes.push({ id, address:id, network, ...n }); };
  const L = (e)=>{ const a=norm(e?.a ?? e?.source ?? e?.from ?? e?.idA ?? ''); const b=norm(e?.b ?? e?.target ?? e?.to ?? e?.idB ?? ''); if(!a||!b||a===b) return; links.push({ a,b,weight:Number(e?.weight ?? e?.amount ?? 1)||1 }); };

  if (Array.isArray(raw?.nodes)) raw.nodes.forEach(N);
  if (Array.isArray(raw?.links)) raw.links.forEach(L);

  // edge-list fallback
  if (!nodes.length && Array.isArray(raw)) {
    const set=new Set();
    for(const e of raw){ const a=norm(e?.a ?? e?.source ?? e?.from ?? e?.idA ?? ''); const b=norm(e?.b ?? e?.target ?? e?.to ?? e?.idB ?? ''); if(a) set.add(a); if(b) set.add(b); L(e); }
    set.forEach(id=>nodes.push({ id, address:id, network }));
  }
  return { nodes: nodes.length?nodes:[{ id:address, address, network }], links };
}

// Build neighbors by sampling earliest/latest tx counterparties if neighbors API is missing
async function fallbackNeighborsFromTxs(address, network, limit=120){
  if (!CFG.apiBase) return { nodes:[{ id:address, address, network }], links:[] };
  const q = (params) => Object.entries(params).map(([k,v])=> `${k}=${encodeURIComponent(v)}`).join('&');
  const doFetch = async (sort) => {
    const url = `${CFG.apiBase}/txs?${q({ address, network, limit: Math.min(200, limit), sort })}`;
    const r = await fetch(url, { headers:{ accept:'application/json' }, cf:{ cacheTtl:0 } });
    if (!r.ok) return [];
    const js = await r.json().catch(()=>({}));
    return Array.isArray(js?.result) ? js.result : [];
  };

  const early = await doFetch('asc');
  const late  = await doFetch('desc');
  const sample = [...early, ...late].slice(0, Math.min(200, limit*2));

  const nodes = [{ id:address, address, network }];
  const links = [];
  const seen = new Set([address]);
  for (const t of sample) {
    const a = norm(t?.from || t?.fromAddress || t?.src || '');
    const b = norm(t?.to   || t?.toAddress   || t?.dst || '');
    const other = a === address ? b : (b === address ? a : '');
    if (other && !seen.has(other)) {
      seen.add(other);
      nodes.push({ id: other, address: other, network });
      links.push({ a: address, b: other, weight: 1 });
      if (nodes.length - 1 >= limit) break;
    }
  }
  return { nodes, links };
}

function limitGraph(graph, cap){
  const center = graph.nodes[0]?.id;
  const nodes=[graph.nodes[0]]; const links=[]; const keep=new Set([center]);
  for (const n of graph.nodes) { if (n.id===center) continue; if (nodes.length-1 >= cap) break; keep.add(n.id); nodes.push(n); }
  for (const e of graph.links) if (keep.has(e.a) && keep.has(e.b)) links.push(e);
  return { nodes, links };
}

/* ---- stats aggregation ------------------------------------------ */
async function scoreNeighborsAndSummarize(centerId, network, neighborIds, { batchSize=25, gapMs=75 }={}){
  const key = (id)=> `${network}:${id}`;
  const todo = neighborIds.filter(id => !scoreCache.has(key(id))).map(id => ({ type:'address', id, network }));

  const t0 = Date.now();
  for (let i=0; i<todo.length; i+=batchSize){
    for (const it of todo.slice(i, i+batchSize)) {
      try { await scoreOne(it); } catch {}
    }
    if (i + batchSize < todo.length) await sleep(gapMs);
  }
  const msScore = Date.now() - t0;

  let n = neighborIds.length, haveAge=0, sumAge=0, haveTx=0, sumTx=0, inactive=0;
  for (const id of neighborIds) {
    const s = scoreCache.get(key(id));
    const age = s?.feats?.ageDays;
    const tx  = s?.explain?.txCount ?? s?.txCount;
    if (typeof age==='number') { sumAge+=age; haveAge++; }
    if (typeof tx==='number')  { sumTx +=tx;  haveTx++; }
    const isDormant = (typeof age==='number' && age > 365) && !(tx > 0);
    if (isDormant) inactive++;
  }
  return {
    n, avgDays: haveAge ? Math.round(sumAge/haveAge) : null,
    avgTx: haveTx ? (sumTx/haveTx) : null,
    inactiveRatio: n ? (inactive/n) : 0,
    msScore
  };
}

/* ---- misc ------------------------------------------------------- */
const WEIGHTS = { 'OFAC':40, 'OFAC/sanctions list match':40, 'sanctioned Counterparty':40, 'fan In High':9, 'shortest Path To Sanctioned':6, 'burst Anomaly':0, 'known Mixer Proximity':0 };
function makeBreakdown(p){ const src=p?.reasons||p?.risk_factors||[]; if(!Array.isArray(src)||!src.length) return []; const list=src.map(r=>({label:String(r),delta:WEIGHTS[r]??0})); const has=list.some(x=>/sanction|ofac/i.test(x.label)); if((p?.block||p?.risk_score===100)&&!has) list.unshift({label:'sanctioned Counterparty',delta:40}); return list.sort((a,b)=>(b.delta-a.delta)); }
async function fetchAgeDays(address, network){
  if (!CFG.apiBase) return 0;
  const url = `${CFG.apiBase}/txs?address=${encodeURIComponent(address)}&network=${encodeURIComponent(network)}&limit=1&sort=asc`;
  const r = await fetch(url, { headers:{ accept:'application/json' }, cf:{ cacheTtl:0 } });
  if (!r.ok) return 0;
  const js = await r.json().catch(()=>({}));
  const arr = Array.isArray(js?.result) ? js.result : [];
  if (!arr.length) return 0;
  const t = arr[0];
  const iso = t?.raw?.metadata?.blockTimestamp || t?.metadata?.blockTimestamp;
  const sec = t?.timeStamp || t?.timestamp || t?.blockTime;
  let ms=0; if (iso){ const d=new Date(iso); if(!isNaN(d)) ms=d.getTime(); }
  if (!ms && sec){ const n=Number(sec); if(!isNaN(n) && n>1e9) ms=(n<2e9 ? n*1000 : n); }
  const days = (Date.now()-ms)/86400000;
  return days > 0 ? Math.round(days) : 0;
}
function coerceOfacFromPolicy(p, reasons){ const txt=Array.isArray(reasons)?reasons.join(' | ').toLowerCase():String(reasons||'').toLowerCase(); return !!(p?.block||p?.risk_score===100||/ofac|sanction/.test(txt)); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

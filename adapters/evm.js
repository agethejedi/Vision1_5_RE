const rootScope =
  typeof self !== "undefined" ? self :
  typeof window !== "undefined" ? window : {};

const API = () =>
  ((rootScope.VisionConfig?.API_BASE) ??
   "https://xwalletv1dot2.agedotcom.workers.dev").replace(/\/$/, "");

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}\n${t.slice(0,180)}…`);
  try { return JSON.parse(t); } catch { throw new Error(`Invalid JSON from ${url}\n${t.slice(0,180)}…`); }
}

async function ofacCheck(addr, network) {
  const url = `${API()}/ofac?address=${encodeURIComponent(addr)}&network=${network}`;
  return await fetchJSON(url);
}

async function getTxs(addr, network, order) {
  const qs = new URLSearchParams({ address: addr, network, limit: '100' });
  const url = `${API()}/txs?${qs.toString()}`;
  const res = await fetchJSON(url);
  const txs = Array.isArray(res.result) ? res.result : [];
  return order === 'desc' ? txs.slice().reverse() : txs;
}

export const RiskAdapters = {
  evm: {
    async getAddressSummary(addr, { network } = {}) {
      network = network || "eth";
      const txs = await getTxs(addr, network, 'asc');

      let ageDays = null, fanInZ = 0, fanOutZ = 0, mixerTaint = 0, category = "wallet";
      if (txs.length) {
        const firstTs = Number(txs[0].timeStamp || 0) * 1000;
        if (firstTs) ageDays = Math.max(0, (Date.now() - firstTs) / (1000*60*60*24));
        const latest = txs.slice(-50);
        const senders = new Set(), receivers = new Set();
        for (const t of latest) {
          if (t.from) senders.add(t.from.toLowerCase());
          if (t.to) receivers.add(String(t.to || '').toLowerCase());
        }
        fanInZ = (senders.size - 5) / 3;
        fanOutZ = (receivers.size - 5) / 3;
      }

      const s = await ofacCheck(addr, network);
      const sanctionHits = !!s?.hit;

      if (txs.length) {
        const heuristic = txs.slice(-100).some(t =>
          /binance|kraken|coinbase|exchange/i.test(`${t.toTag||''}${t.fromTag||''}`)
        );
        if (heuristic) category = 'exchange_unverified';
      }
      return { ageDays, category, sanctionHits, mixerTaint, fanInZ, fanOutZ };
    },

    async getLocalGraphStats(addr, { network } = {}) {
      network = network || "eth";
      const txs = await getTxs(addr, network, 'desc');
      const neigh = new Set();
      for (const t of txs) {
        if (t.from) neigh.add(t.from.toLowerCase());
        if (t.to)   neigh.add(String(t.to || '').toLowerCase());
      }
      neigh.delete(addr.toLowerCase());
      const neighbors = Array.from(neigh);

      let riskyCount = 0;
      for (const n of neighbors) {
        const s = await ofacCheck(n, network);
        if (s?.hit) riskyCount++;
      }
      const riskyNeighborRatio = neighbors.length ? riskyCount / neighbors.length : 0;
      const degree = neighbors.length;
      const centralityZ = (degree - 8) / 4;
      const riskyFlowRatio = riskyNeighborRatio * 0.7;

      return { riskyNeighborRatio, shortestPathToSanctioned: 3, centralityZ, riskyFlowRatio };
    },

    async getAnomalySeries(addr, { network } = {}) {
      network = network || "eth";
      const txs = await getTxs(addr, network, 'desc');
      const byDay = new Map();
      for (const t of txs) {
        const ts = new Date((Number(t.timeStamp || 0)) * 1000);
        const day = ts.toISOString().slice(0,10);
        byDay.set(day, (byDay.get(day) || 0) + 1);
      }
      const counts = Array.from(byDay.values());
      const mean = counts.reduce((a,b)=>a+b,0) / (counts.length || 1);
      const last = counts[counts.length - 1] || 0;
      const burstZ = (last - mean) / Math.max(1, Math.sqrt(mean || 1));
      return { burstZ };
    },
  }
};

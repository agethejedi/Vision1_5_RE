// graph.js — Vision 1_5_RE
// Radial wallet graph with focused-node hexagon + pulse halo.
// Exposes window.graph: { setData, getData, on, setHalo, centerOn, zoomFit }

const NS = 'http://www.w3.org/2000/svg';

(function () {
  const state = {
    nodes: [],
    links: [],
    halos: {},        // id -> { color, blocked, intensity }
    focusedId: null,
    listeners: {},    // event -> [fn]
  };

  let container = null;
  let svg = null;
  let edgesLayer = null;
  let nodesLayer = null;

  /* ========= event bus ========= */

  function on(event, fn) {
    if (!state.listeners[event]) state.listeners[event] = [];
    state.listeners[event].push(fn);
  }

  function emit(event, payload) {
    (state.listeners[event] || []).forEach(fn => {
      try { fn(payload); } catch (_) {}
    });
  }

  /* ========= init / ensure SVG ========= */

  function ensureSvg() {
    if (svg) return;
    container = document.getElementById('graph');
    if (!container) return;

    container.innerHTML = '';
    container.style.position = 'relative';

    svg = document.createElementNS(NS, 'svg');
    svg.classList.add('vision-graph');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    container.appendChild(svg);

    edgesLayer = document.createElementNS(NS, 'g');
    edgesLayer.classList.add('edges');
    svg.appendChild(edgesLayer);

    nodesLayer = document.createElementNS(NS, 'g');
    nodesLayer.classList.add('nodes');
    svg.appendChild(nodesLayer);

    // UI controls (back/forward handled by app history; we just emit events)
    buildControls();
  }

  function buildControls() {
    const wrap = document.createElement('div');
    wrap.style.position = 'absolute';
    wrap.style.top = '12px';
    wrap.style.right = '18px';
    wrap.style.display = 'flex';
    wrap.style.gap = '6px';
    wrap.style.zIndex = '3';

    function ctl(label, title, handler) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = title;
      btn.className = 'graph-ctl-btn';
      btn.style.padding = '4px 8px';
      btn.style.borderRadius = '999px';
      btn.style.border = '1px solid rgba(148,163,184,.4)';
      btn.style.background = 'rgba(15,23,42,.9)';
      btn.style.color = '#e5e7eb';
      btn.style.fontSize = '11px';
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', handler);
      wrap.appendChild(btn);
    }

    ctl('←', 'Back (delegated to app via custom event)', () => emit('navBack'));
    ctl('→', 'Forward (delegated to app via custom event)', () => emit('navForward'));
    ctl('Reset', 'Reset layout', () => zoomFit());
    ctl('Fit', 'Zoom to fit', () => zoomFit());

    container.appendChild(wrap);
  }

  /* ========= layout ========= */

  function layoutRadial() {
    if (!svg) return;
    const bbox = container.getBoundingClientRect();
    const W = bbox.width || 800;
    const H = bbox.height || 480;
    const cx = W / 2;
    const cy = H / 2;

    if (!state.nodes.length) return;

    // Center node: focused if present, else first node.
    const centerId = state.focusedId || state.nodes[0].id;
    state.focusedId = centerId;

    const center = state.nodes.find(n => n.id === centerId) || state.nodes[0];
    center.x = cx;
    center.y = cy;

    const others = state.nodes.filter(n => n !== center);
    const r = Math.min(W, H) * 0.3;
    const step = (2 * Math.PI) / Math.max(others.length, 1);

    others.forEach((n, i) => {
      const angle = -Math.PI / 2 + i * step;
      n.x = cx + r * Math.cos(angle);
      n.y = cy + r * Math.sin(angle);
    });
  }

  /* ========= render ========= */

  function clearLayer(layer) {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }

  function renderEdges() {
    clearLayer(edgesLayer);
    const links = state.links || [];
    links.forEach(L => {
      const src = state.nodes.find(n => n.id === (L.a || L.source));
      const dst = state.nodes.find(n => n.id === (L.b || L.target));
      if (!src || !dst) return;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', src.x);
      line.setAttribute('y1', src.y);
      line.setAttribute('x2', dst.x);
      line.setAttribute('y2', dst.y);
      line.classList.add('edge');
      edgesLayer.appendChild(line);
    });
  }

  function hexPoints(r) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + i * (Math.PI / 3); // flat-top hex
      pts.push(`${Math.cos(a) * r},${Math.sin(a) * r}`);
    }
    return pts.join(' ');
  }

  function renderNodes() {
    clearLayer(nodesLayer);
    const nodes = state.nodes || [];

    nodes.forEach(n => {
      const g = document.createElementNS(NS, 'g');
      g.classList.add('node');
      if (n.id === state.focusedId) g.classList.add('focused');
      g.dataset.id = n.id;
      g.setAttribute('transform', `translate(${n.x},${n.y})`);

      // outer circle
      const outer = document.createElementNS(NS, 'circle');
      outer.classList.add('node-outer');
      outer.setAttribute('r', 11);

      // inner circle
      const inner = document.createElementNS(NS, 'circle');
      inner.classList.add('node-inner');
      inner.setAttribute('r', 6);

      // hex overlay (centered at 0,0, hidden via CSS until focused)
      const hex = document.createElementNS(NS, 'polygon');
      hex.classList.add('node-hex');
      hex.setAttribute('points', hexPoints(8));

      // small label
      const label = document.createElementNS(NS, 'text');
      label.textContent = shorten(n.id);
      label.setAttribute('x', 0);
      label.setAttribute('y', -18);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'node-label');

      g.appendChild(outer);
      g.appendChild(inner);
      g.appendChild(hex);
      g.appendChild(label);

      // interaction
      g.addEventListener('click', () => {
        focusNode(n.id, { emitSelect: true });
      });

      g.addEventListener('mouseenter', () => {
        emit('hoverNode', n);
      });
      g.addEventListener('mouseleave', () => {
        emit('hoverNode', null);
      });

      nodesLayer.appendChild(g);

      // Apply halo (color / blocked) if known
      applyHaloToDom(n.id);
    });
  }

  function shorten(id) {
    if (!id) return '';
    const s = String(id);
    if (s.length <= 10) return s;
    return `${s.slice(0, 6)}…${s.slice(-4)}`;
  }

  function applyHaloToDom(id) {
    if (!svg) return;
    const cfg = state.halos[id];
    const g = nodesLayer.querySelector(`g.node[data-id="${CSS.escape(id)}"]`);
    if (!g) return;
    const outer = g.querySelector('.node-outer');
    const inner = g.querySelector('.node-inner');

    if (cfg && cfg.color && outer) {
      outer.style.stroke = cfg.color;
      inner.style.fill = cfg.color;
    } else if (outer && inner) {
      outer.style.stroke = 'rgba(148,163,184,0.6)';
      inner.style.fill = 'rgba(45,212,191,1)';
    }

    if (cfg && cfg.blocked) g.classList.add('blocked');
    else g.classList.remove('blocked');
  }

  /* ========= public ops ========= */

  function setData({ nodes, links }) {
    ensureSvg();
    state.nodes = (nodes || []).map(n => ({
      ...n,
      id: String(n.id || n.address || '').toLowerCase()
    }));
    state.links = (links || []).map(L => ({
      ...L,
      a: String(L.a || L.source || '').toLowerCase(),
      b: String(L.b || L.target || '').toLowerCase()
    }));

    if (!state.nodes.length) {
      clearLayer(edgesLayer);
      clearLayer(nodesLayer);
      emit('dataChanged', { nodes: [], links: [] });
      return;
    }

    // default focus: first node if focusedId no longer exists
    if (!state.focusedId || !state.nodes.find(n => n.id === state.focusedId)) {
      state.focusedId = state.nodes[0].id;
    }

    layoutRadial();
    renderEdges();
    renderNodes();

    emit('dataChanged', { nodes: state.nodes, links: state.links });
    emit('viewportChanged');
  }

  function getData() {
    return {
      nodes: state.nodes.slice(),
      links: state.links.slice()
    };
  }

  // Called by app.js with result object or { id, color, blocked, intensity, pulse, focused }
  function setHalo(obj) {
    if (!obj) return;
    const cfg = typeof obj === 'object' ? obj : { id: obj };
    const id = String(cfg.id || '').toLowerCase();
    if (!id) return;

    const prev = state.halos[id] || {};
    state.halos[id] = {
      ...prev,
      color: cfg.color || prev.color || '#22d3ee',
      blocked: !!(cfg.blocked || cfg.block),
      intensity: cfg.intensity != null ? cfg.intensity : (prev.intensity || 0.7)
    };

    if (cfg.focused) {
      state.focusedId = id;
      // refresh focus classes
      nodesLayer.querySelectorAll('g.node').forEach(g => {
        g.classList.toggle('focused', g.dataset.id === id);
      });
    }

    applyHaloToDom(id);
  }

  function focusNode(id, { emitSelect = false } = {}) {
    state.focusedId = String(id || '').toLowerCase();
    // update classes
    nodesLayer.querySelectorAll('g.node').forEach(g => {
      g.classList.toggle('focused', g.dataset.id === state.focusedId);
    });
    // ensure halo applied for focused node
    applyHaloToDom(state.focusedId);

    const node = state.nodes.find(n => n.id === state.focusedId);
    if (emitSelect && node) emit('selectNode', node);
  }

  function centerOn(id) {
    // For radial layout, centering is just "focused node becomes center",
    // app takes care of regenerating neighborhood.
    focusNode(id, { emitSelect: true });
  }

  function zoomFit() {
    // For now, radial layout already fills the card; we simply emit viewportChanged
    emit('viewportChanged');
  }

  /* ========= export global ========= */

  window.graph = {
    setData,
    getData,
    on,
    setHalo,
    centerOn,
    zoomFit
  };
})();

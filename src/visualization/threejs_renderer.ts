/**
 * 3D force-directed graph renderer.
 *
 * Ported from `src/visualization/threejs_renderer.ts` in /root/hybrid-graph-memory
 * (Eyal Nof, MIT). See PROVENANCE.md. Changes made in and after the port:
 *
 *   1. The CDN reference is pinned to a major version. The original loaded
 *      `unpkg.com/3d-force-graph` unpinned, so a rendered file's behaviour
 *      changed whenever upstream published.
 *   2. `val` is carried into the render payload. The exporter computes degree
 *      centrality into `val`, but the gData mapping dropped it, so node sizing
 *      never actually reached the graph. It is now bound via `.nodeVal()`.
 *   3. **The palette is the memory domain's own.** The donor's palette listed ITS
 *      node types (`claude_api_feature`, `atomic_capability`, `api_route`, ...)
 *      and none of this package's, so every memory node fell through to a hash of
 *      its type name. A hash has no contrast guarantee, and the two most common
 *      types landed near-black on a near-black page: `evidence` resolved to
 *      #1f2024 and `lesson:proposed` to #162d2f against a #0a0e27 background.
 *      They were invisible unless you happened to tap one. The fix is both
 *      halves: a semantic palette for the types this package actually emits, and
 *      a hash that varies only HUE while holding saturation and lightness fixed,
 *      so a type nobody has thought of yet is still guaranteed to be legible.
 *   4. Labels are DOM, not 3D sprites. The obvious route, `three-spritetext`, is
 *      a UMD bundle that assigns `globalThis.SpriteText = factory(globalThis.THREE)`
 *      -- and `3d-force-graph` bundles its own three privately without exposing a
 *      global, so the factory received `undefined` and `SpriteText` was never
 *      defined. Observed: the Labels button rendered disabled and no label ever
 *      appeared. Loading a second, global copy of three would fix it at the cost
 *      of a third CDN dependency and two three instances in one page. Projecting
 *      node positions with `graph2ScreenCoords` into absolutely-positioned divs
 *      needs no extra dependency at all, and gives crisper text on a phone.
 *
 * `generateLiveHtml` was not ported: it polls a server endpoint this package
 * does not have. The output here is a single self-contained file.
 *
 * This module writes files, so it lives outside `src/core/` by construction --
 * `tooling/check-boundaries.mjs` fails the build if the core reaches it.
 */
import fs from "node:fs";
import path from "node:path";

export interface VisNode {
  id: string;
  name: string;
  type: string;
  description?: string;
  degree?: number;
  val?: number;
  /** Connected-component index, assigned by the exporter. */
  cluster?: number;
}

export interface VisEdge {
  source: string;
  target: string;
  type: string;
}

export interface GraphData {
  nodes: VisNode[];
  edges: VisEdge[];
}

/** The page background. Every colour decision below is judged against it. */
export const BACKGROUND = "#0a0e27";

/** Pinned, and the only external code the page loads. */
export const EXTERNAL_SCRIPTS = ["https://unpkg.com/3d-force-graph@1"] as const;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/**
 * A colour for a type nobody predicted.
 *
 * Only the HUE comes from the hash. Saturation and lightness are fixed, which is
 * the entire point: the previous version hashed straight into 24 bits of RGB and
 * could -- and did -- produce colours indistinguishable from the background.
 */
export function deterministicColor(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hslToHex((hash >>> 0) % 360, 62, 62);
}

export class ThreeJSGraphRenderer {
  /**
   * The memory domain's node types, coloured by meaning rather than by hash:
   * green reads as passed, red as failed, grey as withdrawn, and a lesson warms
   * as it climbs the ladder from proposed to approved.
   */
  public generateColorPalette(nodeTypes: Set<string>): Record<string, string> {
    const predefined: Record<string, string> = {
      "episode:verified": "#4ade80",
      "episode:failed": "#f87171",
      "episode:abandoned": "#94a3b8",
      "episode:open": "#fbbf24",
      "lesson:proposed": "#7dd3fc",
      "lesson:qualified": "#22d3ee",
      "lesson:approved": "#e879f9",
      "lesson:contradicted": "#fb7185",
      "lesson:revoked": "#8b93a7",
      evidence: "#cbd5e1",
      unknown: "#9aa4b8",
    };

    const colors: Record<string, string> = {};
    for (const nodeType of nodeTypes) {
      colors[nodeType] = predefined[nodeType] ?? deterministicColor(nodeType);
    }
    return colors;
  }

  /** Edge colours follow the governance meaning, not the node an edge starts from. */
  public edgePalette(): Record<string, string> {
    return {
      produced: "#7c8698",
      applied: "#38bdf8",
      /** The ratchet: the one edge whose presence promotes a lesson. */
      "reused-in": "#4ade80",
      cites: "#5a6274",
      contradicts: "#fb7185",
    };
  }

  public generateLegendHtml(colors: Record<string, string>): string {
    return Object.entries(colors)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([nodeType, color]) => `<button class="legend-item" data-type="${escapeHtml(nodeType)}">
        <span class="legend-color" style="background-color: ${color};"></span>
        <span class="legend-label">${escapeHtml(nodeType)}</span>
      </button>`,
      )
      .join("");
  }

  public generateHtml(graphData: GraphData, outputPath: string, title: string = "Knowledge Graph 3D"): string {
    const nodeTypes = new Set(graphData.nodes.map((n) => n.type || "unknown"));
    const colors = this.generateColorPalette(nodeTypes);
    const edgeColors = this.edgePalette();
    const safeTitle = escapeHtml(title);
    const clusterCount = new Set(graphData.nodes.map((n) => n.cluster ?? 0)).size;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>${safeTitle}</title>
    <style>
        :root {
            --bg: ${BACKGROUND};
            --panel: rgba(14, 19, 48, 0.88);
            --edge: rgba(120, 160, 255, 0.22);
            --ink: #e8edf9;
            --ink-dim: #8b96b4;
            --accent: #5eb2f0;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0; overflow: hidden; background: var(--bg); color: var(--ink);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
            touch-action: none; -webkit-font-smoothing: antialiased;
        }
        #graph-container { width: 100vw; height: 100dvh; }
        .panel {
            background: var(--panel); border: 1px solid var(--edge); border-radius: 14px;
            backdrop-filter: blur(10px); box-shadow: 0 8px 28px rgba(0,0,0,0.45);
            pointer-events: auto;
        }
        #top {
            position: absolute; top: max(10px, env(safe-area-inset-top)); left: 10px; right: 10px;
            display: flex; gap: 10px; align-items: flex-start; justify-content: space-between;
            pointer-events: none; z-index: 5;
        }
        #title-card { padding: 10px 14px; max-width: 60%; }
        #title-card h1 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: 0.2px; }
        #stats { font-size: 11px; color: var(--ink-dim); margin-top: 3px; font-variant-numeric: tabular-nums; }
        #tools { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
        .btn {
            background: var(--panel); color: var(--ink); border: 1px solid var(--edge);
            border-radius: 999px; padding: 9px 15px; font-size: 13px; font-weight: 600;
            cursor: pointer; pointer-events: auto; white-space: nowrap; backdrop-filter: blur(10px);
            font-family: inherit;
        }
        .btn:active { background: rgba(94,178,240,0.25); }
        .btn.on { background: var(--accent); color: #06213a; border-color: var(--accent); }
        #search {
            padding: 9px 14px; font-size: 13px; width: 180px; font-family: inherit;
            background: var(--panel); color: var(--ink);
            border: 1px solid var(--edge); border-radius: 999px; outline: none; pointer-events: auto;
        }
        #search::placeholder { color: var(--ink-dim); }
        #search:focus { border-color: var(--accent); }
        #legend {
            position: absolute; left: 10px; bottom: max(10px, env(safe-area-inset-bottom));
            display: flex; flex-wrap: wrap; gap: 6px; max-width: min(430px, calc(100vw - 20px));
            z-index: 5; pointer-events: none;
        }
        .legend-item {
            display: inline-flex; align-items: center; gap: 6px;
            background: var(--panel); border: 1px solid var(--edge); border-radius: 999px;
            padding: 6px 11px 6px 8px; font-size: 11px; color: var(--ink);
            cursor: pointer; pointer-events: auto; font-family: inherit; backdrop-filter: blur(10px);
        }
        .legend-item.off { opacity: 0.34; }
        .legend-item.off .legend-label { text-decoration: line-through; }
        .legend-color { width: 9px; height: 9px; border-radius: 50%; flex: none; }
        #sheet {
            position: absolute; left: 0; right: 0; bottom: 0; transform: translateY(105%);
            transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
            background: #0e1330; border-top: 1px solid var(--edge);
            border-radius: 18px 18px 0 0; padding: 18px 18px max(18px, env(safe-area-inset-bottom));
            max-height: 52dvh; overflow-y: auto; z-index: 10;
            box-shadow: 0 -14px 34px rgba(0,0,0,0.55);
        }
        #sheet.open { transform: translateY(0); }
        #sheet-grip { width: 38px; height: 4px; border-radius: 2px; background: #33406b; margin: -6px auto 12px; }
        #sheet-close {
            position: absolute; top: 12px; right: 16px; width: 32px; height: 32px;
            display: grid; place-items: center; border-radius: 50%; border: none;
            background: rgba(255,255,255,0.06); color: var(--ink-dim); font-size: 20px; cursor: pointer;
        }
        #sheet-kind {
            display: inline-flex; font-size: 10px; font-weight: 700; letter-spacing: 1.1px;
            text-transform: uppercase; padding: 4px 10px; border-radius: 999px; margin-bottom: 10px;
            background: rgba(255,255,255,0.07);
        }
        #sheet-title { margin: 0 40px 12px 0; font-size: 16px; line-height: 1.35; font-weight: 620; }
        #sheet-body {
            color: #c3cce4; font-size: 12.5px; line-height: 1.62; white-space: pre-wrap;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            background: #080c22; padding: 12px; border-radius: 10px; border: 1px solid #1b234a;
        }
        #sheet-links { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; }
        .rel {
            font-size: 11px; padding: 5px 10px; border-radius: 999px; cursor: pointer;
            background: rgba(255,255,255,0.05); border: 1px solid var(--edge);
            color: var(--ink); font-family: inherit;
        }
        .rel-kind { color: var(--ink-dim); }
        /* Labels are DOM, projected onto the canvas each frame. */
        #labels { position: absolute; inset: 0; pointer-events: none; z-index: 3; overflow: hidden; }
        .node-label {
            position: absolute; top: 0; left: 0; white-space: nowrap;
            font-size: 11px; font-weight: 500; color: #dbe4f7;
            text-shadow: 0 1px 3px rgba(0,0,0,0.95), 0 0 8px rgba(4,8,25,0.9);
            transition: opacity 0.15s linear; will-change: transform;
        }
        #empty {
            position: absolute; inset: 0; display: none; place-items: center; text-align: center;
            color: var(--ink-dim); font-size: 14px; padding: 30px; z-index: 2;
        }
    </style>
${EXTERNAL_SCRIPTS.map((src) => `    <script src="${src}"></script>`).join("\n")}
</head>
<body>
    <div id="graph-container"></div>
    <div id="labels"></div>
    <div id="empty">Nothing to show.<br><span style="font-size:12px">Every node type is filtered out.</span></div>

    <div id="top">
        <div id="title-card" class="panel">
            <h1>${safeTitle}</h1>
            <div id="stats">${graphData.nodes.length} nodes &middot; ${graphData.edges.length} edges &middot; ${clusterCount} cluster${clusterCount === 1 ? "" : "s"}</div>
        </div>
        <div id="tools">
            <input id="search" type="search" placeholder="Find..." autocomplete="off" spellcheck="false">
            <button class="btn" id="btn-labels">Labels</button>
            <button class="btn" id="btn-clusters">Clusters</button>
            <button class="btn" id="btn-reset">Reset</button>
        </div>
    </div>

    <div id="legend">${this.generateLegendHtml(colors)}</div>

    <div id="sheet">
        <div id="sheet-grip"></div>
        <button id="sheet-close" aria-label="Close">&times;</button>
        <div id="sheet-kind">TYPE</div>
        <h2 id="sheet-title">Node</h2>
        <div id="sheet-body"></div>
        <div id="sheet-links"></div>
    </div>

    <script>
        const graphData = ${safeJson(graphData)};
        const colors = ${safeJson(colors)};
        const edgeColors = ${safeJson(edgeColors)};
        const DIM_NODE = 'rgba(120,132,168,0.16)';
        const DIM_EDGE = 'rgba(120,132,168,0.05)';

        const byId = new Map(graphData.nodes.map(n => [n.id, n]));
        const neighbours = new Map(graphData.nodes.map(n => [n.id, new Set()]));
        const incident = new Map(graphData.nodes.map(n => [n.id, []]));
        for (const e of graphData.edges) {
            if (!neighbours.has(e.source) || !neighbours.has(e.target)) continue;
            neighbours.get(e.source).add(e.target);
            neighbours.get(e.target).add(e.source);
            incident.get(e.source).push(e);
            incident.get(e.target).push(e);
        }

        const keyOf = (source, target, type) => source + '>' + target + '>' + type;

        /** Distinct hues for cluster mode. Fixed lightness, so every one stays legible. */
        const clusterColor = (index) => 'hsl(' + ((index * 47) % 360) + ', 60%, 64%)';

        const hidden = new Set();
        let showLabels = true;
        let clusterMode = false;
        let focus = null;
        let selectedId = null;

        const elem = document.getElementById('graph-container');
        const sheet = document.getElementById('sheet');
        const labelLayer = document.getElementById('labels');

        /** Above this many nodes, labels are noise and the per-frame cost stops being free. */
        const LABEL_LIMIT = 150;
        let labelEls = new Map();

        function visibleData() {
            const nodes = graphData.nodes.filter(n => !hidden.has(n.type));
            const ids = new Set(nodes.map(n => n.id));
            const links = graphData.edges
                .filter(e => ids.has(e.source) && ids.has(e.target))
                .map(e => ({ source: e.source, target: e.target, type: e.type }));
            return { nodes: nodes.map(n => Object.assign({}, n)), links };
        }

        const baseColor = (node) => clusterMode
            ? clusterColor(node.cluster || 0)
            : (colors[node.type] || '#9aa4b8');

        const nodeColor = (node) =>
            (focus && !focus.nodes.has(node.id)) ? DIM_NODE : baseColor(node);

        function edgeKey(link) {
            const s = typeof link.source === 'object' ? link.source.id : link.source;
            const t = typeof link.target === 'object' ? link.target.id : link.target;
            return keyOf(s, t, link.type);
        }

        const linkColor = (link) => (focus && !focus.edges.has(edgeKey(link)))
            ? DIM_EDGE
            : (edgeColors[link.type] || 'rgba(200,215,255,0.30)');

        const linkWidth = (link) => (focus && !focus.edges.has(edgeKey(link)))
            ? 0.4
            // The ratchet and a contradiction are the two edges worth noticing.
            : ((link.type === 'reused-in' || link.type === 'contradicts') ? 2.4 : 1.1);

        let Graph;

        function rebuildLabels() {
            labelLayer.textContent = '';
            labelEls = new Map();
            if (!showLabels) return;
            const nodes = Graph.graphData().nodes;
            if (nodes.length > LABEL_LIMIT) return;
            for (const node of nodes) {
                const el = document.createElement('div');
                el.className = 'node-label';
                el.textContent = node.name.length > 26 ? node.name.slice(0, 25) + '…' : node.name;
                el.style.opacity = '0';
                labelLayer.appendChild(el);
                labelEls.set(node.id, el);
            }
        }

        /** Runs every frame: the camera can move at any time, including under inertia. */
        function positionLabels() {
            if (labelEls.size === 0) return;
            const w = window.innerWidth;
            const h = window.innerHeight;
            for (const node of Graph.graphData().nodes) {
                const el = labelEls.get(node.id);
                if (!el) continue;
                if (node.x === undefined) { el.style.opacity = '0'; continue; }
                const at = Graph.graph2ScreenCoords(node.x, node.y, node.z || 0);
                // Behind the camera or off-screen: projection still returns a point.
                if (!at || !Number.isFinite(at.x) || at.x < -100 || at.y < -60 || at.x > w + 100 || at.y > h + 60) {
                    el.style.opacity = '0';
                    continue;
                }
                const drop = Math.cbrt(node.val || 1) * 3 + 12;
                el.style.transform = 'translate(-50%, 0) translate(' + Math.round(at.x) + 'px, ' + Math.round(at.y + drop) + 'px)';
                el.style.opacity = (focus && !focus.nodes.has(node.id)) ? '0.15' : '0.95';
            }
        }

        function refresh() {
            Graph.nodeColor(nodeColor).linkColor(linkColor).linkWidth(linkWidth);
        }

        /** Everything reachable from a node: the whole causal story it belongs to. */
        function componentOf(startId) {
            const nodes = new Set([startId]);
            const stack = [startId];
            while (stack.length) {
                const current = stack.pop();
                for (const next of (neighbours.get(current) || [])) {
                    const node = byId.get(next);
                    if (!nodes.has(next) && node && !hidden.has(node.type)) {
                        nodes.add(next);
                        stack.push(next);
                    }
                }
            }
            const edges = new Set();
            for (const e of graphData.edges) {
                if (nodes.has(e.source) && nodes.has(e.target)) edges.add(keyOf(e.source, e.target, e.type));
            }
            return { nodes, edges };
        }

        /** Just the node and what it touches directly. */
        function neighbourhoodOf(startId) {
            const nodes = new Set([startId]);
            for (const next of (neighbours.get(startId) || [])) nodes.add(next);
            const edges = new Set();
            for (const e of (incident.get(startId) || [])) edges.add(keyOf(e.source, e.target, e.type));
            return { nodes, edges };
        }

        function clearFocus() {
            focus = null;
            selectedId = null;
            sheet.classList.remove('open');
            refresh();
        }

        function describeRelations(nodeId) {
            const box = document.getElementById('sheet-links');
            box.textContent = '';
            for (const e of (incident.get(nodeId) || [])) {
                const otherId = e.source === nodeId ? e.target : e.source;
                const other = byId.get(otherId);
                if (!other) continue;
                const chip = document.createElement('button');
                chip.className = 'rel';
                const kind = document.createElement('span');
                kind.className = 'rel-kind';
                kind.textContent = (e.source === nodeId ? '→ ' : '← ') + e.type + ' ';
                chip.appendChild(kind);
                chip.appendChild(document.createTextNode(
                    other.name.length > 24 ? other.name.slice(0, 23) + '…' : other.name));
                chip.onclick = () => select(otherId, true);
                box.appendChild(chip);
            }
        }

        function select(nodeId, fly) {
            const node = byId.get(nodeId);
            if (!node) return;
            selectedId = nodeId;
            focus = neighbourhoodOf(nodeId);
            refresh();

            const kind = document.getElementById('sheet-kind');
            kind.textContent = node.type;
            kind.style.color = baseColor(node);
            document.getElementById('sheet-title').textContent = node.name;
            document.getElementById('sheet-body').textContent = node.description || 'No metadata recorded.';
            describeRelations(nodeId);
            sheet.classList.add('open');

            if (fly) {
                const live = Graph.graphData().nodes.find(n => n.id === nodeId);
                if (live && live.x !== undefined) {
                    const ratio = 1 + 110 / Math.hypot(live.x, live.y, live.z || 1);
                    Graph.cameraPosition(
                        { x: live.x * ratio, y: live.y * ratio, z: (live.z || 0) * ratio }, live, 900);
                }
            }
        }

        function applyFilters() {
            Graph.graphData(visibleData());
            const shown = graphData.nodes.filter(n => !hidden.has(n.type)).length;
            document.getElementById('empty').style.display = shown === 0 ? 'grid' : 'none';
        }

        try {
            Graph = ForceGraph3D()(elem)
                .graphData(visibleData())
                .backgroundColor(${JSON.stringify(BACKGROUND)})
                .nodeVal(node => node.val || 1)
                .nodeColor(nodeColor)
                .nodeLabel(node => node.name)
                .nodeOpacity(0.92)
                .nodeResolution(12)
                .linkColor(linkColor)
                .linkWidth(linkWidth)
                .linkOpacity(0.55)
                .linkDirectionalArrowLength(3.5)
                .linkDirectionalArrowRelPos(1)
                .linkDirectionalParticles(link => link.type === 'reused-in' ? 3 : 0)
                .linkDirectionalParticleWidth(1.8)
                .linkDirectionalParticleSpeed(0.006)
                .onBackgroundClick(clearFocus);

            Graph.onEngineStop(() => Graph.zoomToFit(500, 60));

            rebuildLabels();
            (function paint() {
                positionLabels();
                requestAnimationFrame(paint);
            })();

            // Tap selects the node and its immediate neighbours. Tapping the SAME
            // node again widens the focus to its whole connected component -- the
            // full story rather than one step of it.
            Graph.onNodeClick(node => {
                if (selectedId === node.id) {
                    focus = componentOf(node.id);
                    refresh();
                } else {
                    select(node.id, true);
                }
            });

            document.getElementById('btn-reset').onclick = () => {
                clearFocus();
                Graph.zoomToFit(700, 60);
            };

            const labelsBtn = document.getElementById('btn-labels');
            labelsBtn.classList.toggle('on', showLabels);
            labelsBtn.onclick = () => {
                showLabels = !showLabels;
                labelsBtn.classList.toggle('on', showLabels);
                rebuildLabels();
            };

            const clusterBtn = document.getElementById('btn-clusters');
            clusterBtn.onclick = () => {
                clusterMode = !clusterMode;
                clusterBtn.classList.toggle('on', clusterMode);
                refresh();
            };

            // Legend chips double as type filters.
            for (const chip of document.querySelectorAll('.legend-item')) {
                chip.onclick = () => {
                    const type = chip.dataset.type;
                    if (hidden.has(type)) hidden.delete(type); else hidden.add(type);
                    chip.classList.toggle('off', hidden.has(type));
                    focus = null;
                    selectedId = null;
                    applyFilters();
                    rebuildLabels();
                    refresh();
                };
            }

            const search = document.getElementById('search');
            search.oninput = () => {
                const term = search.value.trim().toLowerCase();
                if (!term) { focus = null; refresh(); return; }
                const matches = graphData.nodes.filter(n =>
                    n.name.toLowerCase().includes(term) ||
                    n.type.toLowerCase().includes(term) ||
                    (n.description || '').toLowerCase().includes(term));
                const nodes = new Set(matches.map(n => n.id));
                const edges = new Set();
                for (const e of graphData.edges) {
                    if (nodes.has(e.source) && nodes.has(e.target)) edges.add(keyOf(e.source, e.target, e.type));
                }
                focus = { nodes, edges };
                refresh();
            };

            document.getElementById('sheet-close').onclick = clearFocus;
        } catch (err) {
            elem.innerHTML = '<div style="padding:24px;color:#f87171;font-family:sans-serif">' +
                'WebGL failed to initialise.</div>';
        }
    </script>
</body>
</html>`;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html, "utf8");
    return outputPath;
  }
}

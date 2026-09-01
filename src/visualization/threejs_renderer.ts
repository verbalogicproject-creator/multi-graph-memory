/**
 * 3D force-directed graph renderer.
 *
 * Ported from `src/visualization/threejs_renderer.ts` in /root/hybrid-graph-memory
 * (Eyal Nof, MIT). See PROVENANCE.md. Two changes were made in the port:
 *
 *   1. The CDN reference is pinned to a major version. The original loaded
 *      `unpkg.com/3d-force-graph` unpinned, so a rendered file's behaviour
 *      changed whenever upstream published.
 *   2. `val` is carried into the render payload. The exporter computes degree
 *      centrality into `val`, but the gData mapping dropped it, so node sizing
 *      never actually reached the graph. It is now bound via `.nodeVal()`.
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

function deterministicColor(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `#${(hash >>> 0 & 0xffffff).toString(16).padStart(6, "0")}`;
}

export class ThreeJSGraphRenderer {
  public generateColorPalette(nodeTypes: Set<string>): Record<string, string> {
    const predefined: Record<string, string> = {
      claude_api_feature: "#2a9fd6",
      category: "#9b59b6",
      atomic_capability: "#e74c3c",
      pattern: "#f39c12",
      meta: "#1abc9c",
      gemini_pattern: "#3498db",
      component: "#4CAF50",
      module: "#2196F3",
      store: "#9C27B0",
      api_route: "#FF9800",
      class: "#E91E63",
      interface: "#00BCD4",
      memory: "#ffeb3b",
      chunk: "#795548",
      file: "#607d8b",
      unknown: "#888888",
    };

    const colors: Record<string, string> = {};
    for (const nodeType of nodeTypes) {
      if (predefined[nodeType]) {
        colors[nodeType] = predefined[nodeType];
      } else {
        colors[nodeType] = deterministicColor(nodeType);
      }
    }
    return colors;
  }

  public generateLegendHtml(colors: Record<string, string>): string {
    const items = Object.entries(colors).sort((a, b) => a[0].localeCompare(b[0])).map(([nodeType, color]) => {
      return `<div class="legend-item">
        <div class="legend-color" style="background-color: ${color};"></div>
        <span>${escapeHtml(nodeType)}</span>
      </div>`;
    });
    return items.join("");
  }

  public generateHtml(graphData: GraphData, outputPath: string, title: string = "Knowledge Graph 3D"): string {
    const nodeTypes = new Set(graphData.nodes.map((n) => n.type || "unknown"));
    const colors = this.generateColorPalette(nodeTypes);
    const safeTitle = escapeHtml(title);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${safeTitle}</title>
    <style>
        body { margin: 0; overflow: hidden; font-family: sans-serif; background: #0a0e27; color: white; touch-action: none; }
        #graph-container { width: 100vw; height: 100vh; }
        
        /* Floating Top Bar (Mobile Optimized) */
        #top-bar {
            position: absolute; top: 10px; left: 10px; right: 10px;
            display: flex; justify-content: space-between; align-items: flex-start;
            pointer-events: none;
        }
        .panel {
            background: rgba(10, 14, 39, 0.9);
            padding: 12px; border-radius: 8px; border: 1px solid #2a9fd6;
            backdrop-filter: blur(4px); pointer-events: auto;
        }
        
        /* Legend */
        #legend { font-size: 11px; max-height: 150px; overflow-y: auto; pointer-events: auto; }
        .legend-item { display: flex; align-items: center; margin: 4px 0; }
        .legend-color { width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }

        /* Action Buttons */
        .btn {
            background: #2a9fd6; color: white; border: none; border-radius: 20px;
            padding: 10px 16px; font-weight: bold; font-size: 14px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            pointer-events: auto; cursor: pointer;
        }

        /* Bottom Sheet for Rich Metadata */
        #bottom-sheet {
            position: absolute; bottom: -400px; left: 0; right: 0;
            background: #111536; border-top: 2px solid #2a9fd6;
            border-top-left-radius: 16px; border-top-right-radius: 16px;
            padding: 20px; transition: bottom 0.3s cubic-bezier(0.1, 0.8, 0.2, 1);
            box-shadow: 0 -10px 20px rgba(0,0,0,0.5);
            max-height: 40vh; overflow-y: auto;
            pointer-events: auto;
        }
        #bottom-sheet.open { bottom: 0; }
        #bs-close {
            position: absolute; top: 15px; right: 20px;
            font-size: 24px; color: #888; cursor: pointer; font-weight: bold;
        }
        #bs-title { color: #fff; font-size: 18px; margin: 0 0 5px 0; padding-right: 30px; word-break: break-all; }
        #bs-type { color: #2a9fd6; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 15px; }
        #bs-desc { color: #ccc; font-size: 13px; line-height: 1.5; white-space: pre-wrap; font-family: monospace; background: #0a0e27; padding: 10px; border-radius: 6px;}
    </style>
    <script src="https://unpkg.com/3d-force-graph@1"></script>
</head>
<body>
    <div id="graph-container"></div>
    
    <div id="top-bar">
        <div class="panel">
            <h2 style="margin: 0 0 5px 0; font-size: 14px; color: #2a9fd6;">${safeTitle}</h2>
            <div style="font-size: 11px; color: #aaa;">N: ${graphData.nodes.length} | E: ${graphData.edges.length}</div>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 10px;">
            <button class="btn" onclick="resetCamera()">Reset View</button>
            <div id="legend" class="panel">
                ${this.generateLegendHtml(colors)}
            </div>
        </div>
    </div>

    <!-- Bottom Sheet -->
    <div id="bottom-sheet">
        <div id="bs-close" onclick="closeSheet()">×</div>
        <h3 id="bs-title">Node Name</h3>
        <div id="bs-type">TYPE</div>
        <div id="bs-desc">Description...</div>
    </div>

    <script>
        const graphData = ${safeJson(graphData)};
        const colors = ${safeJson(colors)};
        
        const gData = {
            nodes: graphData.nodes.map(n => ({ id: n.id, name: n.name, type: n.type, description: n.description, val: n.val })),
            links: graphData.edges.map(e => ({ source: e.source, target: e.target, type: e.type }))
        };

        let Graph;
        const elem = document.getElementById('graph-container');
        const sheet = document.getElementById('bottom-sheet');
        
        function closeSheet() {
            sheet.classList.remove('open');
        }

        function resetCamera() {
            if (Graph) Graph.zoomToFit(800, 50);
        }

        try {
            Graph = ForceGraph3D()(elem)
                .graphData(gData)
                .nodeAutoColorBy('type')
                .nodeColor(node => colors[node.type] || '#888888')
                .nodeVal(node => node.val || 1)
                .nodeLabel(() => '') // Disable hover tooltips for mobile
                .linkColor(link => link.type.includes('inferred') ? '#ff0055' : 'rgba(255,255,255,0.2)')
                .linkWidth(link => link.type.includes('inferred') ? 2 : 0.5)
                .linkDirectionalParticles(link => link.type.includes('inferred') ? 2 : 0)
                .linkDirectionalParticleWidth(link => link.type.includes('inferred') ? 4 : 0)
                .backgroundColor('#0a0e27')
                .onNodeClick(node => {
                    // Center camera on node
                    const distance = 100;
                    const distRatio = 1 + distance/Math.hypot(node.x, node.y, node.z);
                    Graph.cameraPosition(
                        { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
                        node, 
                        1000
                    );

                    // Open bottom sheet with rich metadata
                    document.getElementById('bs-title').innerText = node.name;
                    document.getElementById('bs-type').innerText = node.type;
                    document.getElementById('bs-desc').innerText = node.description || "No metadata available.";
                    sheet.classList.add('open');
                })
                .onBackgroundClick(closeSheet);

            Graph.onEngineStop(() => {
                Graph.zoomToFit(400);
            });
        } catch (err) {
            elem.innerHTML = '<div style="padding: 20px; color: #ff5555;">WebGL failed to initialize.</div>';
        }
    </script>
</body>
</html>`;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html, "utf8");
    return outputPath;
  }
}

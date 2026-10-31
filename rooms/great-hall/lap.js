// lap.js: Live Acoustic Parameters (LAP) for the VR27 viewer.
//
// Reads <scene>/params/index.json and the per-IR energy bins written by `vr27irprep params`,
// and returns T20, T30, EDT, C50, C80, D50, D80 per octave band for:
//   case A  - one receiver (baked values, straight lookup), or
//   case B  - several grid receivers with weights (the bilinear weights of the walking engine):
//             the energy bins are blended and the parameters refitted, so the values follow the
//             listener continuously between grid points.
// computeFromBins() mirrors params_from_bins() in vr27irprep/params.py line for line; the test
// suite checks that both give the same numbers.
//
// No dependencies. The panel helper takes THREE as an argument so this file does not import it.

import { loadBins } from "../../shared/irpack.js";
export const PARAMS = ["T20", "T30", "EDT", "C50", "C80", "D50", "D80"];
const FITS = { EDT: [-0.1, -10.1], T20: [-5, -25], T30: [-5, -35] };

// ---------------------------------------------------------------- core maths (mirror of Python)
function slope(t, y, i0, i1) {
  const n = i1 - i0;
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = i0; i < i1; i++) { st += t[i]; sy += y[i]; stt += t[i] * t[i]; sty += t[i] * y[i]; }
  return (n * sty - st * sy) / (n * stt - st * st);
}

function firstAtOrBelow(a, v) {
  for (let i = 0; i < a.length; i++) if (a[i] <= v) return i;
  return 0; // same as numpy argmax on an all-false mask
}

/** bins: Float32Array/Float64Array of energy per bin from the band onset; tail: missing energy. */
export function computeFromBins(bins, tail, binMs) {
  const n = bins.length;
  const out = Object.fromEntries(PARAMS.map((p) => [p, null]));
  const edc = new Float64Array(n);
  let acc = tail;
  for (let i = n - 1; i >= 0; i--) { acc += bins[i]; edc[i] = acc; }
  if (!(edc[0] > 0)) return out;
  const db = new Float64Array(n), t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    db[i] = 10 * Math.log10(Math.max(edc[i] / edc[0], 1e-300));
    t[i] = (i * binMs) / 1000;
  }
  for (const [name, [up, lo]] of Object.entries(FITS)) {
    const iu = firstAtOrBelow(db, up), il = firstAtOrBelow(db, lo);
    if (db[n - 1] > lo || il - iu < 3) continue;
    const k = slope(t, db, iu, il);
    out[name] = k < 0 ? -60 / k : null;
  }
  const total = edc[0];
  for (const [ms, c, d] of [[50, "C50", "D50"], [80, "C80", "D80"]]) {
    const nb = Math.round(ms / binMs);
    let early = 0;
    for (let i = 0; i < Math.min(nb, n); i++) early += bins[i];
    const late = total - early;
    if (early > 0 && late > 0) {
      out[c] = 10 * Math.log10(early / late);
      out[d] = (100 * early) / total;
    }
  }
  return out;
}

export function midValues(values, midBands) {
  const out = {};
  for (const p of PARAMS) {
    const v = midBands.map((f) => values[String(f)]?.[p]);
    out[p] = v.some((x) => x == null) ? null : v.reduce((a, b) => a + b, 0) / v.length;
  }
  return out;
}

// ---------------------------------------------------------------- scene data
export class LapData {
  /** base: URL of the scene folder (the one holding manifest.json and params/). */
  constructor(base, { cacheSize = 64, suffix = "" } = {}) {
    this.base = base.endsWith("/") ? base : base + "/";
    this.sfx = suffix;   // cache-busting query, e.g. "?v=<build version>"
    this.index = null;
    this.cache = new Map(); // LRU of Float32Array bins
    this.cacheSize = cacheSize;
  }

  async load() {
    const r = await fetch(this.base + "params/index.json" + this.sfx);
    if (!r.ok) throw new Error(`LAP: params/index.json not found (${r.status}). Run "vr27irprep params".`);
    this.index = await r.json();
    return this;
  }

  entry(scenario, receiver, source) {
    return this.index?.scenarios?.[scenario]?.irs?.[receiver]?.[source] ?? null;
  }

  async bins(scenario, receiver, source) {
    const e = this.entry(scenario, receiver, source);
    if (!e) return null;
    const key = e.bins_file;
    if (this.cache.has(key)) {
      const v = this.cache.get(key); this.cache.delete(key); this.cache.set(key, v); return v;
    }
    const v = await loadBins(this.base + key, this.sfx);
    if (!v) return null;
    this.cache.set(key, v);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return v;
  }

  /**
   * Parameters at the listener.
   *   scenario: scenario id
   *   sources:  array of source ids (energies of several sources are summed, as for sources
   *             playing together; pass one id for the usual per-source values)
   *   nodes:    [{receiver, weight}] - one node for case A or "nearest seat" mode, the 4 cell
   *             corners with their bilinear weights for case B. Weights are used as energy weights.
   * Returns {bands, values: {band: {T20..D80}}, mid: {...}, kind, flags, blended}.
   */
  async valuesAt({ scenario, sources, nodes }) {
    const ix = this.index;
    const bands = ix.bands, binMs = ix.bin_ms;
    const live = nodes.filter((n) => n.weight > 1e-6);
    const pairs = [];
    for (const n of live) for (const s of sources) {
      const e = this.entry(scenario, n.receiver, s);
      if (e) pairs.push({ e, w: n.weight, r: n.receiver, s });
    }
    if (!pairs.length) return null;
    const kinds = new Set(pairs.map((p) => p.e.kind));
    const flags = {};
    for (const p of pairs) for (const [b, f] of Object.entries(p.e.flags || {}))
      (flags[b] ??= new Set()), f.forEach((x) => flags[b].add(x));
    const flagObj = Object.fromEntries(Object.entries(flags).map(([b, s]) => [b, [...s]]));

    // single IR: baked values, no fetch of the bins needed
    if (pairs.length === 1) {
      const e = pairs[0].e;
      return { bands, values: e.values, mid: e.mid, kind: e.kind, flags: flagObj, blended: false };
    }
    // several IRs: weighted energy sum per band, then refit
    const data = await Promise.all(pairs.map((p) => this.bins(scenario, p.r, p.s)));
    const values = {};
    bands.forEach((f, bi) => {
      let len = 0;
      pairs.forEach((p) => (len = Math.max(len, p.e.n_bins_band[bi])));
      const acc = new Float64Array(len);
      let tail = 0;
      pairs.forEach((p, k) => {
        const d = data[k]; if (!d) return;
        const nb = p.e.n_bins, nbb = p.e.n_bins_band[bi], off = bi * nb;
        for (let i = 0; i < nbb; i++) acc[i] += p.w * d[off + i];
        tail += p.w * p.e.tail[bi];
      });
      const v = computeFromBins(acc, tail, binMs);
      // a corner without a usable decay fit in this band (measured IRs): no values for the band
      if (pairs.some((p) => p.e.t_ok && p.e.t_ok[bi] === false)) for (const k of PARAMS) v[k] = null;
      values[String(f)] = v;
    });
    return {
      bands, values, mid: midValues(values, ix.mid_bands),
      kind: [...kinds].join("+"), flags: flagObj, blended: true,
    };
  }
}

// ---------------------------------------------------------------- display
const UNITS = { T20: "s", T30: "s", EDT: "s", C50: "dB", C80: "dB", D50: "%", D80: "%" };
const DIGITS = { T20: 2, T30: 2, EDT: 2, C50: 1, C80: 1, D50: 0, D80: 0 };
export const fmt = (p, v) => (v == null ? "-" : v.toFixed(DIGITS[p]));
const bandLabel = (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

/** Plain-text table (desktop overlay <pre>, console, logging). */
export function formatText(res, { full = false, showBands = [125, 250, 500, 1000, 2000, 4000] } = {}) {
  if (!res) return "LAP: no data for this position";
  const L = [`LAP  ${res.kind}${res.blended ? "  (blended)" : ""}`];
  if (!full) {
    for (const p of PARAMS) L.push(`${p.padEnd(4)} ${fmt(p, res.mid[p]).padStart(6)} ${UNITS[p]}`);
    return L.join("\n");
  }
  const bands = showBands.filter((b) => res.values[String(b)]);
  L.push("     " + bands.map((b) => bandLabel(b).padStart(6)).join("") + "    mid");
  for (const p of PARAMS)
    L.push(p.padEnd(5) + bands.map((b) => fmt(p, res.values[String(b)][p]).padStart(6)).join("") +
      fmt(p, res.mid[p]).padStart(7) + " " + UNITS[p]);
  return L.join("\n");
}

/**
 * In-headset panel: WebXR does not show HTML overlays, so the table is drawn on a canvas and shown
 * as a textured plane. Attach panel.mesh to the camera (fixed in view) or to a controller (wrist).
 *   const panel = makeLapPanel(THREE); camera.add(panel.mesh); panel.mesh.position.set(0, -0.25, -0.8);
 *   panel.update(res, {full: false});
 */
export function makeLapPanel(THREE, { width = 0.42, px = 1024 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = px; canvas.height = px / 2;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  if ("colorSpace" in tex) tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 2), mat);
  mesh.renderOrder = 999;
  let last = "";
  function update(res, opts = {}) {
    const text = formatText(res, opts);
    if (text === last) return; // redraw only when a displayed digit changes
    last = text;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(10,14,20,0.78)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const lines = text.split("\n");
    const size = Math.floor(canvas.height / (lines.length + 1.5));
    ctx.font = `${size}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textBaseline = "top";
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? "#8fd3ff" : "#f2f2f2";
      ctx.fillText(l, size * 0.6, size * 0.6 + i * size);
    });
    tex.needsUpdate = true;
  }
  return { mesh, canvas, update, set visible(v) { mesh.visible = v; }, get visible() { return mesh.visible; } };
}

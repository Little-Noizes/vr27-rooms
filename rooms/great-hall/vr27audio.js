// VR27 audio engine: first-order ambisonic room IRs on a measured grid, convolved in the browser and
// decoded binaurally. Used by the 3D viewer; the 2D seat player carries an older inline copy (case A).
//
// Modes ("blend"):
//   nearest - case A: the IR of the nearest measured seat.
//   paper   - case B as published (Castro et al., VolAR): the 4 IRs at the corners of the grid cell you stand
//             in, mixed with bilinear amplitude weights w_i.
//   aligned - case B improved, for A/B listening: each corner is delayed so its direct sound lands at the time
//             expected at your position (no comb filtering between corners), and the diffuse tail is mixed by
//             energy (constant reverberant level across the cell).
//
// v2 structure (17 Oct 2026), built to keep the browser's audio thread well inside its budget:
//   EARLY  - direct sound + first 50 ms of each corner IR: one short ConvolverNode per channel per corner
//            (16 for 4 corners), gains follow your position continuously (weights, and alignment delays).
//   LATE   - the IR after 50 ms is diffuse and changes slowly across the room, so the 4 corner tails of the
//            current cell are pre-mixed into ONE 4-channel IR (paper: 0.25 each = amplitude sum at the cell
//            centre, aligned: 0.5 each = energy sum). Two banks of 4 long convolvers alternate: on a cell change
//            the idle bank gets the new tail, runs silent for 0.5 s to build up its reverb history, then
//            crossfades in over 0.5 s. That is 4 long convolvers in steady state (8 during a change) instead
//            of 16 to 32, which is what caused the crackling (audio thread overruns) in v1.
//
// Signal flow: dry -> [per-corner DelayNode -> 4 early convolvers -> weights] + [late DelayNode -> bank A/B
// (4 convolvers each) -> bank gains] -> room gate -> ambisonic bus (ACN W,Y,Z,X) -> SN3D sampling decode,
// max-rE, 8 virtual loudspeakers at the cube corners -> browser HRTF (PannerNode) -> headphones.
//
// Frames: the acoustic frame (x, y, z-up) maps to three.js / Web Audio as (x, z, -y), so a three.js
// camera's world direction can be handed straight to setOrientation().

import { loadIR } from "../../shared/irpack.js";
const N_SPK = 8, MAXRE = 0.577, C = 343;
const D0 = 0.006;               // base delay (s) so alignment can move each corner either way
const EARLY = 0.050, XF = 0.005;   // early/late split after the direct sound, raised-cosine crossfade
const LATE_PAD = 0.003;         // room inside the late buffer for alignment shifts
const PRE = 0.5, FADE = 0.5;    // late bank change: silent pre-roll, then equal-power crossfade (s)
const HYST = 0.05;              // stay in the current grid cell until 5 cm past its edge
const CACHE = 48;               // decoded IRs kept in memory

function b64ToBuf(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

const CURVE_IN = new Float32Array(33).map((_, i) => Math.sin((i / 32) * Math.PI / 2));
const CURVE_OUT = new Float32Array(33).map((_, i) => Math.cos((i / 32) * Math.PI / 2));

export class SeatAudio {
  /**
   * @param {object} opts
   *   manifest: vr27irprep manifest (sources, receivers, scenarios[0].irs)
   *   irBase:   URL prefix for manifest IR files
   *   dryUrl:   URL of the anechoic recording
   *   irScale:  gain the stored IRs were multiplied by (16-bit packages); playback divides by it
   *   urlSuffix: appended to every fetched URL (cache-busting, e.g. "?v=abc123")
   */
  constructor({ manifest, irBase, dryUrl, irScale = 1, urlSuffix = "" }) {
    this.M = manifest; this.irBase = irBase; this.dryUrl = dryUrl; this.irScale = irScale; this.sfx = urlSuffix;
    const rec = new Map(manifest.receivers.map((r) => [r.id, r]));
    this.seats = manifest.scenarios[0].irs.map((e) => ({ id: e.receiver, file: e.file, position: rec.get(e.receiver).position,
      offset: (rec.get(e.receiver).time_offset_ms?.[manifest.scenarios[0].id] ?? 0) / 1000, checks: e.checks }));
    this.byId = new Map(this.seats.map((s) => [s.id, s]));
    this.source = manifest.sources[0];
    this.grid = this._grid();
    this.ctx = null; this.mode = "room"; this.blend = "nearest"; this.vol = 0;
    this.pos = null; this.seat = null; this.cell = null; this.weights = new Map();
    this.cache = new Map(); this.pending = new Map(); this.slots = new Map();
    this.late = { active: 0, key: null, busy: false };
    this.playing = false; this.onstatus = () => {}; this.onweights = () => {};
  }

  // ---------------------------------------------------------------- geometry
  _grid() {   // regular grid from receiver ids xNNyNN, or null when the receivers are not a full grid
    const cells = new Map(); let nx = 0, ny = 0;
    for (const s of this.seats) {
      const m = /^x(\d+)y(\d+)$/.exec(s.id); if (!m) return null;
      const i = +m[1], j = +m[2]; cells.set(`${i},${j}`, s.id); nx = Math.max(nx, i + 1); ny = Math.max(ny, j + 1);
    }
    if (cells.size !== nx * ny || nx < 2 || ny < 2) return null;
    const p00 = this.byId.get(cells.get("0,0")).position, p10 = this.byId.get(cells.get("1,0")).position, p01 = this.byId.get(cells.get("0,1")).position;
    return { nx, ny, ox: p00[0], oy: p00[1], dx: p10[0] - p00[0], dy: p01[1] - p00[1], id: (i, j) => cells.get(`${i},${j}`) };
  }

  nearestSeat(x, y) {   // acoustic-frame position -> nearest measured seat and its distance (m)
    let best = null, bd = Infinity;
    for (const s of this.seats) { const d = Math.hypot(s.position[0] - x, s.position[1] - y); if (d < bd) { bd = d; best = s; } }
    return { seat: best, dist: bd };
  }

  cornerWeights(x, y, keep = null) {   // bilinear weights of the 4 corners of the cell holding (x, y), clamped to the grid
    const g = this.grid; if (!g) return { cell: null, corners: [{ id: this.nearestSeat(x, y).seat.id, w: 1 }] };
    const fx = Math.min(Math.max((x - g.ox) / g.dx, 0), g.nx - 1), fy = Math.min(Math.max((y - g.oy) / g.dy, 0), g.ny - 1);
    let i = Math.min(Math.floor(fx), g.nx - 2), j = Math.min(Math.floor(fy), g.ny - 2);
    if (keep) {   // hysteresis: keep the current cell until the listener is clearly out of it
      const hx = HYST / Math.abs(g.dx), hy = HYST / Math.abs(g.dy);
      if (fx >= keep[0] - hx && fx <= keep[0] + 1 + hx && fy >= keep[1] - hy && fy <= keep[1] + 1 + hy) [i, j] = keep;
    }
    const tx = Math.min(Math.max(fx - i, 0), 1), ty = Math.min(Math.max(fy - j, 0), 1);
    return { cell: [i, j], corners: [{ id: g.id(i, j), w: (1 - tx) * (1 - ty) }, { id: g.id(i + 1, j), w: tx * (1 - ty) },
      { id: g.id(i, j + 1), w: (1 - tx) * ty }, { id: g.id(i + 1, j + 1), w: tx * ty }] };
  }

  _geoT(x, y, z) {   // geometric direct-sound time from the loudspeaker (s)
    const p = this.source.position; return Math.hypot(p[0] - x, p[1] - y, p[2] - z) / C;
  }

  // ---------------------------------------------------------------- transport
  async start() {   // call from a user gesture
    if (!this.ctx) {
      // the device's own rate: forcing 48 kHz on a 44.1 kHz output adds a resampler to the audio thread
      this.ctx = new AudioContext({ latencyHint: "balanced" });
      this._build();
      this.onstatus("Loading the dry recording…");
      const r = await fetch(this.dryUrl + this.sfx); if (!r.ok) throw new Error(`dry recording (${r.status})`);
      this.dry = await this.ctx.decodeAudioData(await r.arrayBuffer());
      if (this.pos) this._update(true);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (!this.src) {
      this.src = new AudioBufferSourceNode(this.ctx, { buffer: this.dry, loop: true });
      this.src.connect(this.dryIn); this.src.start();
    }
    this.playing = true;
  }

  stop() {
    if (this.src) { try { this.src.stop(); } catch (e) {} this.src.disconnect(); this.src = null; }
    this.playing = false;
  }

  _build() {
    const ac = this.ctx, mono = { channelCount: 1, channelCountMode: "explicit", channelInterpretation: "discrete" };
    this.master = new GainNode(ac, { gain: Math.pow(10, this.vol / 20) * 2 }); this.master.connect(ac.destination);
    this.bus = [0, 1, 2, 3].map(() => new GainNode(ac, mono));
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const u = [sx, sy, sz].map((v) => v / Math.sqrt(3));
      const w = [1, 3 * MAXRE * u[1], 3 * MAXRE * u[2], 3 * MAXRE * u[0]];   // ACN W, Y, Z, X
      const sum = new GainNode(ac, mono);
      this.bus.forEach((b, c) => { const n = new GainNode(ac, { gain: w[c] / N_SPK }); b.connect(n); n.connect(sum); });
      const p = new PannerNode(ac, { panningModel: "HRTF", distanceModel: "linear", refDistance: 1, maxDistance: 10000,
        rolloffFactor: 0, positionX: u[0], positionY: u[2], positionZ: -u[1] });
      sum.connect(p); p.connect(this.master);
    }
    // room gate: all IR paths go through here, so Room/Dry is one gain per channel
    this.roomIn = [0, 1, 2, 3].map((c) => { const g = new GainNode(ac, { ...mono, gain: this.mode === "room" ? 1 / this.irScale : 0 }); g.connect(this.bus[c]); return g; });
    this.dryIn = new GainNode(ac, mono);
    this.dryDelay = new DelayNode(ac, { delayTime: D0, maxDelayTime: 0.05 });
    this.dryIn.connect(this.dryDelay);
    this.dryEnc = [0, 1, 2, 3].map((c) => { const n = new GainNode(ac, { gain: 0 }); this.dryDelay.connect(n); n.connect(this.bus[c]); return n; });
    // late banks
    this.lateDelay = new DelayNode(ac, { delayTime: D0 - LATE_PAD, maxDelayTime: 0.05 });
    this.dryIn.connect(this.lateDelay);
    this.banks = [0, 1].map(() => [0, 1, 2, 3].map((c) => {
      const cv = new ConvolverNode(ac, { disableNormalization: true, ...mono });
      const g = new GainNode(ac, { gain: 0 });
      cv.connect(g); g.connect(this.roomIn[c]);
      return { cv, g, connected: false };
    }));
  }

  // ---------------------------------------------------------------- IR loading: decode, find the direct sound, split
  async _ir(id) {
    if (this.cache.has(id)) { const v = this.cache.get(id); this.cache.delete(id); this.cache.set(id, v); return v; }
    if (this.pending.has(id)) return this.pending.get(id);
    const job = (async () => {
      const buf = await loadIR(this.ctx, this.irBase + this.byId.get(id).file, this.sfx);
      if (buf.numberOfChannels < 4) throw new Error(`IR ${id} has ${buf.numberOfChannels} channels, expected 4`);
      const ir = this._prep(id, buf);
      this.cache.set(id, ir); this.pending.delete(id);
      while (this.cache.size > CACHE) {   // evict least recently used, never one in use
        const k = [...this.cache.keys()].find((k) => !this.slots.has(k)); if (!k) break; this.cache.delete(k);
      }
      return ir;
    })();
    this.pending.set(id, job);
    job.catch(() => this.pending.delete(id));
    return job;
  }

  _prep(id, buf) {
    const fs = buf.sampleRate, W = buf.getChannelData(0), s = this.byId.get(id), p = s.position;
    // direct sound: first sample within 6 dB of the W peak inside geometric time (+ measured system offset)
    // +/- 1.5 ms; falls back to the geometric time if nothing qualifies
    const tg = this._geoT(...p) + s.offset, lo = Math.max(0, Math.floor((tg - 0.0015) * fs)), hi = Math.min(W.length, Math.ceil((tg + 0.0015) * fs));
    let pk = 0; for (let n = lo; n < hi; n++) pk = Math.max(pk, Math.abs(W[n]));
    let on = -1; for (let n = lo; n < hi && pk > 0; n++) if (Math.abs(W[n]) >= 0.5 * pk) { on = n; break; }
    const T = on >= 0 ? on / fs : tg;
    const f = Math.round(XF * fs), a = Math.min(Math.round((T + EARLY) * fs) - (f >> 1), buf.length - f);
    const early = this.ctx.createBuffer(4, a + f, fs), late = [];
    for (let c = 0; c < 4; c++) {
      const x = buf.getChannelData(c), e = early.getChannelData(c), l = new Float32Array(x.length - a);
      for (let n = 0; n < a; n++) e[n] = x[n];
      for (let k = 0; k < f; k++) { const r = 0.5 - 0.5 * Math.cos(Math.PI * k / f); e[a + k] = x[a + k] * (1 - r); l[k] = x[a + k] * r; }
      for (let n = a + f; n < x.length; n++) l[n - a] = x[n];
      late.push(l);
    }
    return { id, T, early, late, lateStart: a, fs };
  }

  // ---------------------------------------------------------------- early part: one slot per corner
  _slot(ir) {
    const ac = this.ctx, delay = new DelayNode(ac, { delayTime: D0, maxDelayTime: 0.05 });
    this.dryIn.connect(delay);
    const ch = [0, 1, 2, 3].map((c) => {
      const mono = ac.createBuffer(1, ir.early.length, ir.fs); mono.copyToChannel(ir.early.getChannelData(c), 0);
      const cv = new ConvolverNode(ac, { disableNormalization: true, channelCount: 1, channelCountMode: "explicit" });
      cv.buffer = mono;
      const g = new GainNode(ac, { gain: 0 });
      delay.connect(cv); cv.connect(g); g.connect(this.roomIn[c]);
      return { cv, g };
    });
    return { ir, delay, ch, dropAt: null };
  }

  _dropSlot(id) {
    const s = this.slots.get(id); if (!s) return;
    try { this.dryIn.disconnect(s.delay); } catch (e) {}
    for (const n of s.ch) { try { n.cv.disconnect(); } catch (e) {} try { n.g.disconnect(); } catch (e) {} }
    try { s.delay.disconnect(); } catch (e) {}
    this.slots.delete(id);
  }

  // ---------------------------------------------------------------- late part: pre-mixed tail, two banks
  _lateSpec() {   // which tails make up the late part right now, and how they are mixed
    if (this.blend === "nearest") return { key: `n:${this.seat}`, ids: [this.seat], coef: 1, align: false };
    const ids = this.cellIds;
    return { key: `${this.blend}:${ids.join(",")}`, ids, coef: this.blend === "aligned" ? 0.5 : 0.25, align: this.blend === "aligned" };
  }

  async _wantLate() {
    const L = this.late; if (!this.ctx || L.busy) return;
    const spec = this._lateSpec(); if (!spec.ids.length || spec.ids.some((x) => !x) || spec.key === L.key) return;
    L.busy = true;
    let irs;
    try { irs = await Promise.all(spec.ids.map((id) => this._ir(id))); } catch (err) { this.onstatus(err.message); L.busy = false; return; }
    if (this._lateSpec().key !== spec.key) { L.busy = false; this._wantLate(); return; }   // moved on while loading
    const buf = this._mixLate(irs, spec);
    const t = this.ctx.currentTime, first = L.key === null, idle = first ? L.active : 1 - L.active, old = L.active;
    for (const n of this.banks[idle]) {
      if (n.connected) { try { this.lateDelay.disconnect(n.cv); } catch (e) {} }
      const b = this.ctx.createBuffer(1, buf[0].length, this.ctx.sampleRate);
      b.copyToChannel(buf[this.banks[idle].indexOf(n)], 0);
      n.cv.buffer = b;   // the idle bank is silent, so replacing its buffer cannot be heard
      this.lateDelay.connect(n.cv); n.connected = true;
    }
    if (first) {
      this.banks[idle].forEach((n) => n.g.gain.setValueAtTime(1, t));
      L.key = spec.key; L.busy = false; return;
    }
    // pre-roll (new bank builds reverb history at gain 0), then equal-power crossfade
    for (const n of this.banks[idle]) { n.g.gain.cancelScheduledValues(t); n.g.gain.setValueAtTime(0, t); n.g.gain.setValueCurveAtTime(CURVE_IN, t + PRE, FADE); }
    for (const n of this.banks[old]) { n.g.gain.cancelScheduledValues(t); n.g.gain.setValueAtTime(1, t); n.g.gain.setValueCurveAtTime(CURVE_OUT, t + PRE, FADE); }
    L.key = spec.key;
    setTimeout(() => { L.active = idle; L.busy = false; this._wantLate(); }, (PRE + FADE) * 1000 + 60);
  }

  _mixLate(irs, spec) {
    const fs = this.ctx.sampleRate, pad = Math.round(LATE_PAD * fs);
    // aligned: line the tails up on the cell's mean direct-sound time; otherwise keep them as measured
    const Tc = irs.reduce((a, ir) => a + ir.T, 0) / irs.length;
    const sh = irs.map((ir) => ir.lateStart + (spec.align ? Math.round((Tc - ir.T) * fs) : 0) + pad);
    const len = Math.max(...irs.map((ir, k) => sh[k] + ir.late[0].length));
    const out = [0, 1, 2, 3].map(() => new Float32Array(len));
    irs.forEach((ir, k) => {
      const s = Math.max(0, sh[k]);
      for (let c = 0; c < 4; c++) { const src = ir.late[c], dst = out[c]; for (let n = 0; n < src.length; n++) dst[s + n] += spec.coef * src[n]; }
    });
    return out;
  }

  // ---------------------------------------------------------------- public controls
  setPosition(x, y, z = null) {   // listener position, acoustic frame (m); call every frame or on change
    this.pos = [x, y, z ?? (this.seats[0]?.position[2] ?? 1.5)];
    this._update(false);
  }

  setSeat(id) {   // jump to a measured seat (click a marker)
    const p = this.byId.get(id).position; this.seat = null; this.cell = null; this.setPosition(p[0], p[1], p[2]);
  }

  setBlend(blend) {   // "nearest" | "paper" | "aligned"
    this.blend = blend; this.seat = null; this._update(true);
  }

  setMode(mode) {
    this.mode = mode;
    if (this.ctx) {
      const t = this.ctx.currentTime;
      this.roomIn.forEach((g) => g.gain.setTargetAtTime(mode === "room" ? 1 / this.irScale : 0, t, 0.03));
      this._applyDry(t, this.weights);
    }
  }

  setVolume(db) {
    this.vol = db;
    if (this.ctx) this.master.gain.setTargetAtTime(Math.pow(10, db / 20) * 2, this.ctx.currentTime, 0.03);
  }

  // forward/up in three.js / Web Audio coordinates (unit vectors)
  setOrientation(f, u) {
    if (!this.ctx) return;
    const L = this.ctx.listener, t = this.ctx.currentTime;
    if (L.forwardX) {
      L.forwardX.setTargetAtTime(f.x, t, 0.01); L.forwardY.setTargetAtTime(f.y, t, 0.01); L.forwardZ.setTargetAtTime(f.z, t, 0.01);
      L.upX.setTargetAtTime(u.x, t, 0.01); L.upY.setTargetAtTime(u.y, t, 0.01); L.upZ.setTargetAtTime(u.z, t, 0.01);
    } else L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
  }

  // ---------------------------------------------------------------- core
  _targets() {
    const [x, y] = this.pos;
    if (this.blend === "nearest") {
      const { seat, dist } = this.nearestSeat(x, y);
      if (this.seat && this.seat !== seat.id) {   // 6 cm hysteresis so standing on a boundary does not flicker
        const c = this.byId.get(this.seat).position;
        if (Math.hypot(c[0] - x, c[1] - y) - dist < 0.06) return [{ id: this.seat, w: 1 }];
      }
      this.seat = seat.id; return [{ id: seat.id, w: 1 }];
    }
    const r = this.cornerWeights(x, y, this.cell);
    this.cell = r.cell; this.cellIds = r.corners.map((c) => c.id);
    return r.corners;
  }

  _update(force) {
    if (!this.pos) return;
    const tgt = this._targets();
    this.weights = new Map(tgt.map((c) => [c.id, c.w]));
    this.onweights({ blend: this.blend, corners: tgt, pos: this.pos });
    if (!this.ctx) return;
    for (const c of tgt) if (!this.slots.has(c.id) && c.w > 0 && !this.pending.has(`slot:${c.id}`)) {
      this.pending.set(`slot:${c.id}`, true);
      this._ir(c.id).then((ir) => {
        this.pending.delete(`slot:${c.id}`);
        if (!this.slots.has(c.id) && this.weights.get(c.id) > 0) { this.slots.set(c.id, this._slot(ir)); this._apply(); }
      }).catch((err) => { this.pending.delete(`slot:${c.id}`); this.onstatus(err.message); });
    }
    if (this.blend !== "nearest" && this.grid) this._prefetch();
    this._wantLate();
    this._apply();
  }

  _prefetch() {
    const g = this.grid, [i, j] = this.cell;
    for (let a = i - 1; a <= i + 2; a++) for (let b = j - 1; b <= j + 2; b++)
      if (a >= 0 && b >= 0 && a < g.nx && b < g.ny) { const id = g.id(a, b); if (!this.cache.has(id)) this._ir(id).catch(() => {}); }
  }

  _apply() {
    const t = this.ctx.currentTime;
    const live = [...this.weights].filter(([id, w]) => w > 0 && this.slots.has(id));
    if (!live.length && this.slots.size) return;   // nothing of the new set loaded yet: hold the current sound
    const sum = live.reduce((a, [, w]) => a + w, 0) || 1;
    const W = new Map(live.map(([id, w]) => [id, w / sum]));
    const aligned = this.blend === "aligned";
    let Tt = 0;   // aligned: direct-sound time expected at the listener = geometric + the corners' measured offsets
    if (aligned) {
      for (const [id, w] of W) { const s = this.slots.get(id), p = this.byId.get(id).position; Tt += w * (s.ir.T - this._geoT(...p)); }
      Tt += this._geoT(...this.pos);
    }
    const tau = this.blend === "nearest" ? 0.05 : 0.03;
    for (const [id, s] of this.slots) {
      const w = W.get(id) ?? 0;
      if (Math.abs((s.lastW ?? -1) - w) > 1e-4) { for (const n of s.ch) n.g.gain.setTargetAtTime(w, t, tau); s.lastW = w; }
      const d = aligned && w > 0 ? Math.min(Math.max(D0 + Tt - s.ir.T, 0), 0.049) : D0;
      if (Math.abs((s.lastD ?? -1) - d) > 2e-6) { s.delay.delayTime.setTargetAtTime(d, t, 0.05); s.lastD = d; }
      if (w > 0) s.dropAt = null;
      else if (s.dropAt === null) s.dropAt = t + 0.4;   // dropped once faded out
    }
    for (const [id, s] of [...this.slots]) if (s.dropAt !== null && t > s.dropAt && !this.weights.get(id)) this._dropSlot(id);
    this._applyDry(t, W);
  }

  _applyDry(t, W) {   // dry signal as a plane wave from the loudspeaker at the interpolated direct-sound level
    let g = [0, 0, 0, 0];
    if (this.mode === "dry" && this.pos) {
      const [x, y, z] = this.pos, s = this.source.position;
      const v = [s[0] - x, s[1] - y, s[2] - z], d = Math.hypot(...v), u = v.map((q) => q / d);
      let a = 0, ws = 0;
      for (const [id, w] of (W.size ? W : this.weights)) { a += w * Math.pow(10, (this.byId.get(id).checks.direct_level_db ?? -20) / 20); ws += w; }
      a = ws ? a / ws : 0.1;
      g = [a, a * u[1], a * u[2], a * u[0]];
    }
    this.dryEnc.forEach((n, c) => n.gain.setTargetAtTime(g[c], t, 0.03));
  }
}

export { b64ToBuf };

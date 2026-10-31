// VR27 audio engine, multi-source build (31 Oct 2026). Based on vr27audio.js v3 (18 Oct 2026).
// Changes from vr27audio.js:
//   - SeatAudio takes a shared AudioContext (opts.ctx) so several sources run on one clock.
//   - start() is split into prepare() (graph + binaural decoder) and play(buffer, when, offset, gain), so a
//     rig can start every source on the same sample and switch what each source plays.
//   - Each source keeps its own binaural decoder into the shared destination (fine for 2 sources).
// Everything else (early/late split, two late banks, nearest / paper / aligned blends, static decoder) is as
// in vr27audio.js. Frames: acoustic (x front, y left, z up) -> three.js (x, z, -y).

import { loadIR } from "../../shared/irpack.js";
const N_SPK = 8, MAXRE = 0.577, C = 343;
const D0 = 0.006, EARLY = 0.050, XF = 0.005, LATE_PAD = 0.003;
const PRE = 0.5, FADE = 0.5, HYST = 0.05, CACHE = 48;
const CURVE_IN = new Float32Array(33).map((_, i) => Math.sin((i / 32) * Math.PI / 2));
const CURVE_OUT = new Float32Array(33).map((_, i) => Math.cos((i / 32) * Math.PI / 2));

export class SeatAudio {
  constructor({ manifest, irBase, ctx, irScale = 1, urlSuffix = "" }) {
    this.M = manifest; this.irBase = irBase; this.irScale = irScale; this.sfx = urlSuffix; this.ctx = ctx;
    const rec = new Map(manifest.receivers.map((r) => [r.id, r]));
    this.scenarios = manifest.scenarios.map((sc) => ({ id: sc.id, label: sc.label ?? sc.id, irScale: sc.ir_scale ?? irScale,
      byId: new Map(sc.irs.map((e) => [e.receiver, { file: e.file, checks: e.checks,
        offset: (rec.get(e.receiver).time_offset_ms?.[sc.id] ?? 0) / 1000 }])) }));
    this.scn = 0; this.switchAt = 0;
    this.seats = manifest.scenarios[0].irs.map((e) => ({ id: e.receiver, label: rec.get(e.receiver).label ?? e.receiver,
      position: rec.get(e.receiver).position, ...this.scenarios[0].byId.get(e.receiver) }));
    this.byId = new Map(this.seats.map((s) => [s.id, s]));
    this.source = manifest.sources[0];
    this.grid = this._grid();
    this.mode = "room"; this.blend = "nearest"; this.vol = 0;
    this.pos = null; this.seat = null; this.cell = null; this.weights = new Map();
    this.cache = new Map(); this.pending = new Map(); this.slots = new Map();
    this.late = { active: 0, key: null, busy: false };
    this.ready = false; this.onstatus = () => {}; this.onweights = () => {};
  }

  _grid() {
    const cells = new Map(); let nx = 0, ny = 0;
    for (const s of this.seats) {
      const m = /^x(\d+)y(\d+)$/.exec(s.id); if (!m) return null;
      const i = +m[1], j = +m[2]; cells.set(`${i},${j}`, s.id); nx = Math.max(nx, i + 1); ny = Math.max(ny, j + 1);
    }
    if (cells.size !== nx * ny || nx < 2 || ny < 2) return null;
    const p00 = this.byId.get(cells.get("0,0")).position, p10 = this.byId.get(cells.get("1,0")).position, p01 = this.byId.get(cells.get("0,1")).position;
    return { nx, ny, ox: p00[0], oy: p00[1], dx: p10[0] - p00[0], dy: p01[1] - p00[1], id: (i, j) => cells.get(`${i},${j}`) };
  }

  nearestSeat(x, y) {
    let best = null, bd = Infinity;
    for (const s of this.seats) { const d = Math.hypot(s.position[0] - x, s.position[1] - y); if (d < bd) { bd = d; best = s; } }
    return { seat: best, dist: bd };
  }

  cornerWeights(x, y, keep = null) {
    const g = this.grid; if (!g) return { cell: null, corners: [{ id: this.nearestSeat(x, y).seat.id, w: 1 }] };
    const fx = Math.min(Math.max((x - g.ox) / g.dx, 0), g.nx - 1), fy = Math.min(Math.max((y - g.oy) / g.dy, 0), g.ny - 1);
    let i = Math.min(Math.floor(fx), g.nx - 2), j = Math.min(Math.floor(fy), g.ny - 2);
    if (keep) {
      const hx = HYST / Math.abs(g.dx), hy = HYST / Math.abs(g.dy);
      if (fx >= keep[0] - hx && fx <= keep[0] + 1 + hx && fy >= keep[1] - hy && fy <= keep[1] + 1 + hy) [i, j] = keep;
    }
    const tx = Math.min(Math.max(fx - i, 0), 1), ty = Math.min(Math.max(fy - j, 0), 1);
    return { cell: [i, j], corners: [{ id: g.id(i, j), w: (1 - tx) * (1 - ty) }, { id: g.id(i + 1, j), w: tx * (1 - ty) },
      { id: g.id(i, j + 1), w: (1 - tx) * ty }, { id: g.id(i + 1, j + 1), w: tx * ty }] };
  }

  _geoT(x, y, z) { const p = this.source.position; return Math.hypot(p[0] - x, p[1] - y, p[2] - z) / C; }

  // ---------------------------------------------------------------- transport (shared clock)
  async prepare() {
    if (this.ready) return;
    this._build();
    await this._binaural();
    this.ready = true;
    if (this.pos) this._update(true);
  }

  play(buffer, when, offset = 0, gain = 1) {   // start this source's dry signal on the shared clock
    this.stop(when);
    if (!buffer) return;
    this.src = new AudioBufferSourceNode(this.ctx, { buffer, loop: true });
    this.feed = new GainNode(this.ctx, { gain });
    this.src.connect(this.feed); this.feed.connect(this.dryIn);
    this.src.start(when, offset % buffer.duration);
  }

  stop(when = 0) {
    if (this.src) { const s = this.src, f = this.feed; try { s.stop(when); } catch (e) {} s.onended = () => { s.disconnect(); f.disconnect(); }; this.src = null; }
  }

  _build() {
    const ac = this.ctx, mono = { channelCount: 1, channelCountMode: "explicit", channelInterpretation: "discrete" };
    this.master = new GainNode(ac, { gain: Math.pow(10, this.vol / 20) * 2 }); this.master.connect(ac.destination);
    this.bus = [0, 1, 2, 3].map(() => new GainNode(ac, mono));
    this.rotOut = [0, 1, 2].map(() => new GainNode(ac, mono));
    this.rotG = [0, 1, 2].map((i) => [0, 1, 2].map((j) => {
      const g = new GainNode(ac, { gain: i === j ? 1 : 0 }); this.bus[j + 1].connect(g); g.connect(this.rotOut[i]); return g; }));
    this.decIn = [this.bus[0], ...this.rotOut];
    this.R = null;
    this.roomIn = [0, 1, 2, 3].map((c) => { const g = new GainNode(ac, { ...mono, gain: this.mode === "room" ? 1 : 0 }); g.connect(this.bus[c]); return g; });
    this.dryIn = new GainNode(ac, mono);
    this.dryDelay = new DelayNode(ac, { delayTime: D0, maxDelayTime: 0.05 });
    this.dryIn.connect(this.dryDelay);
    this.dryEnc = [0, 1, 2, 3].map((c) => { const n = new GainNode(ac, { gain: 0 }); this.dryDelay.connect(n); n.connect(this.bus[c]); return n; });
    this.lateDelay = new DelayNode(ac, { delayTime: D0 - LATE_PAD, maxDelayTime: 0.05 });
    this.dryIn.connect(this.lateDelay);
    this.banks = [0, 1].map(() => [0, 1, 2, 3].map((c) => {
      const cv = new ConvolverNode(ac, { disableNormalization: true, ...mono });
      const g = new GainNode(ac, { gain: 0 });
      cv.connect(g); g.connect(this.roomIn[c]);
      return { cv, g, connected: false };
    }));
  }

  _speakers() {
    const out = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const u = [sx, sy, sz].map((v) => v / Math.sqrt(3));
      out.push({ u, w: [1, 3 * MAXRE * u[1], 3 * MAXRE * u[2], 3 * MAXRE * u[0]].map((v) => v / N_SPK) });
    }
    return out;
  }

  async _binaural() {
    const fs = this.ctx.sampleRate, PRE_N = 4096, LEN = 1024, spk = this._speakers();
    const off = new OfflineAudioContext(2 * spk.length, PRE_N + LEN, fs);
    const LS = off.listener;
    if (LS.forwardX) { LS.forwardX.value = 1; LS.forwardY.value = 0; LS.forwardZ.value = 0; LS.upX.value = 0; LS.upY.value = 1; LS.upZ.value = 0; }
    else LS.setOrientation(1, 0, 0, 0, 1, 0);
    const imp = off.createBuffer(1, PRE_N + LEN, fs); imp.getChannelData(0)[PRE_N] = 1;
    const src = new AudioBufferSourceNode(off, { buffer: imp });
    const merge = new ChannelMergerNode(off, { numberOfInputs: 2 * spk.length });
    spk.forEach((s, k) => {
      const p = new PannerNode(off, { panningModel: "HRTF", distanceModel: "linear", refDistance: 1, maxDistance: 10000,
        rolloffFactor: 0, positionX: s.u[0], positionY: s.u[2], positionZ: -s.u[1] });
      const sp = new ChannelSplitterNode(off, { numberOfOutputs: 2 });
      src.connect(p); p.connect(sp); sp.connect(merge, 0, 2 * k); sp.connect(merge, 1, 2 * k + 1);
    });
    merge.connect(off.destination); src.start();
    const r = await off.startRendering();
    this.decoder = [0, 1, 2, 3].map((c) => {
      const h = this.ctx.createBuffer(2, LEN, fs);
      for (let e = 0; e < 2; e++) {
        const out = h.getChannelData(e);
        spk.forEach((s, k) => { const d = r.getChannelData(2 * k + e); for (let n = 0; n < LEN; n++) out[n] += s.w[c] * d[PRE_N + n]; });
      }
      const cv = new ConvolverNode(this.ctx, { disableNormalization: true, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "discrete" });
      cv.buffer = h; this.decIn[c].connect(cv); cv.connect(this.master);
      return cv;
    });
  }

  // ---------------------------------------------------------------- IR loading
  _key(id, scn = this.scn) { return `${scn}|${id}`; }

  async _ir(id, scn = this.scn) {
    const key = this._key(id, scn);
    if (this.cache.has(key)) { const v = this.cache.get(key); this.cache.delete(key); this.cache.set(key, v); return v; }
    if (this.pending.has(key)) return this.pending.get(key);
    const job = (async () => {
      const e = this.scenarios[scn].byId.get(id); if (!e) throw new Error(`No IR for ${id}`);
      const buf = await loadIR(this.ctx, this.irBase + e.file, this.sfx);
      if (buf.numberOfChannels < 4) throw new Error(`IR ${id} has ${buf.numberOfChannels} channels, expected 4`);
      const ir = this._prep(id, buf, scn);
      this.cache.set(key, ir); this.pending.delete(key);
      while (this.cache.size > CACHE) { const k = [...this.cache.keys()].find((k) => !this.slots.has(k)); if (!k) break; this.cache.delete(k); }
      return ir;
    })();
    this.pending.set(key, job);
    job.catch(() => this.pending.delete(key));
    return job;
  }

  _prep(id, buf, scn) {
    const sc = this.scenarios[scn], g = 1 / sc.irScale;
    for (let c = 0; c < buf.numberOfChannels; c++) { const x = buf.getChannelData(c); for (let n = 0; n < x.length; n++) x[n] *= g; }
    const fs = buf.sampleRate, W = buf.getChannelData(0), s = sc.byId.get(id), p = this.byId.get(id).position;
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
    // direct-sound level (dB re full scale of the unpacked IR) for the Dry mode
    let dpk = 0; for (let n = lo; n < hi; n++) dpk = Math.max(dpk, Math.abs(W[n]));
    s.direct = dpk || 0.1;
    return { id, scn, key: this._key(id, scn), T, early, late, lateStart: a, fs };
  }

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

  _lateSpec() {
    if (this.blend === "nearest") return { key: `${this.scn}:n:${this.seat}`, ids: [this.seat], coef: 1, align: false };
    const ids = this.cellIds ?? [];
    return { key: `${this.scn}:${this.blend}:${ids.join(",")}`, ids, coef: this.blend === "aligned" ? 0.5 : 0.25, align: this.blend === "aligned" };
  }

  async _wantLate() {
    const L = this.late; if (!this.ready || L.busy) return;
    const spec = this._lateSpec(); if (!spec.ids.length || spec.ids.some((x) => !x) || spec.key === L.key) return;
    L.busy = true;
    let irs; const scn = this.scn;
    try { irs = await Promise.all(spec.ids.map((id) => this._ir(id, scn))); } catch (err) { this.onstatus(err.message); L.busy = false; return; }
    if (this._lateSpec().key !== spec.key) { L.busy = false; this._wantLate(); return; }
    const buf = this._mixLate(irs, spec);
    const t = this.ctx.currentTime, first = L.key === null, idle = first ? L.active : 1 - L.active, old = L.active;
    this.banks[idle].forEach((n, c) => {
      if (n.connected) { try { this.lateDelay.disconnect(n.cv); } catch (e) {} }
      const b = this.ctx.createBuffer(1, buf[0].length, this.ctx.sampleRate);
      b.copyToChannel(buf[c], 0);
      n.cv.buffer = b;
      this.lateDelay.connect(n.cv); n.connected = true;
    });
    if (first) { this.banks[idle].forEach((n) => n.g.gain.setValueAtTime(1, t)); L.key = spec.key; L.busy = false; return; }
    for (const n of this.banks[idle]) { n.g.gain.cancelScheduledValues(t); n.g.gain.setValueAtTime(0, t); n.g.gain.setValueCurveAtTime(CURVE_IN, t + PRE, FADE); }
    for (const n of this.banks[old]) { n.g.gain.cancelScheduledValues(t); n.g.gain.setValueAtTime(1, t); n.g.gain.setValueCurveAtTime(CURVE_OUT, t + PRE, FADE); }
    L.key = spec.key;
    setTimeout(() => { L.active = idle; L.busy = false; this._wantLate(); }, (PRE + FADE) * 1000 + 60);
  }

  _mixLate(irs, spec) {
    const fs = this.ctx.sampleRate, pad = Math.round(LATE_PAD * fs);
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
  setPosition(x, y, z = null) { this.pos = [x, y, z ?? (this.seats[0]?.position[2] ?? 1.5)]; this._update(false); }
  setSeat(id) { const p = this.byId.get(id).position; this.seat = null; this.cell = null; this.setPosition(p[0], p[1], p[2]); }
  setBlend(blend) { this.blend = blend; this.seat = null; this._update(true); }

  setMode(mode) {
    this.mode = mode;
    if (this.ready) {
      const t = this.ctx.currentTime;
      this.roomIn.forEach((g) => g.gain.setTargetAtTime(mode === "room" ? 1 : 0, t, 0.03));
      this._applyDry(t, this.weights);
    }
  }

  setVolume(db) { this.vol = db; if (this.ready) this.master.gain.setTargetAtTime(Math.pow(10, db / 20) * 2, this.ctx.currentTime, 0.03); }

  setOrientation(f, u) {   // three.js forward / up unit vectors
    if (!this.ready) return;
    const F = [f.x, -f.z, f.y], U = [u.x, -u.z, u.y];
    const L = [U[1] * F[2] - U[2] * F[1], U[2] * F[0] - U[0] * F[2], U[0] * F[1] - U[1] * F[0]];
    const R = [L, U, F].map((a) => [a[1], a[2], a[0]]);
    const prev = this.R; let moved = !prev;
    if (prev) for (let i = 0; i < 3 && !moved; i++) for (let j = 0; j < 3; j++) if (Math.abs(prev[i][j] - R[i][j]) > 2e-3) { moved = true; break; }
    if (!moved) return;
    this.R = R; const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) this.rotG[i][j].gain.setTargetAtTime(R[i][j], t, 0.015);
  }

  _targets() {
    const [x, y] = this.pos;
    if (this.blend === "nearest") {
      const { seat, dist } = this.nearestSeat(x, y);
      if (this.seat && this.seat !== seat.id) {
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
    if (!this.ready) return;
    const scn = this.scn;
    for (const c of tgt) {
      const k = this._key(c.id, scn);
      if (this.slots.has(k) || !(c.w > 0) || this.pending.has(`slot:${k}`)) continue;
      this.pending.set(`slot:${k}`, true);
      this._ir(c.id, scn).then((ir) => {
        this.pending.delete(`slot:${k}`);
        if (!this.slots.has(k) && this.scn === scn && this.weights.get(c.id) > 0) { this.slots.set(k, this._slot(ir)); this._apply(); }
      }).catch((err) => { this.pending.delete(`slot:${k}`); this.onstatus(err.message); });
    }
    if (this.blend !== "nearest" && this.grid) this._prefetch();
    this._wantLate();
    this._apply();
  }

  _prefetch() {
    const g = this.grid, [i, j] = this.cell;
    for (let a = i - 1; a <= i + 2; a++) for (let b = j - 1; b <= j + 2; b++)
      if (a >= 0 && b >= 0 && a < g.nx && b < g.ny) { const id = g.id(a, b); if (!this.cache.has(this._key(id))) this._ir(id).catch(() => {}); }
  }

  _apply() {
    const t = this.ctx.currentTime;
    const live = [...this.weights].filter(([id, w]) => w > 0 && this.slots.has(this._key(id)));
    if (!live.length && this.slots.size) return;
    const sum = live.reduce((a, [, w]) => a + w, 0) || 1;
    const W = new Map(live.map(([id, w]) => [this._key(id), w / sum]));
    const aligned = this.blend === "aligned";
    let Tt = 0;
    if (aligned) {
      for (const [k, w] of W) { const s = this.slots.get(k), p = this.byId.get(s.ir.id).position; Tt += w * (s.ir.T - this._geoT(...p)); }
      Tt += this._geoT(...this.pos);
    }
    const tau = this.blend === "nearest" ? 0.05 : 0.03;
    for (const [k, s] of this.slots) {
      const w = W.get(k) ?? 0;
      if (Math.abs((s.lastW ?? -1) - w) > 1e-4) { for (const n of s.ch) n.g.gain.setTargetAtTime(w, t, tau); s.lastW = w; }
      const d = aligned && w > 0 ? Math.min(Math.max(D0 + Tt - s.ir.T, 0), 0.049) : D0;
      if (Math.abs((s.lastD ?? -1) - d) > 2e-6) { s.delay.delayTime.setTargetAtTime(d, t, 0.05); s.lastD = d; }
      if (w > 0) s.dropAt = null; else if (s.dropAt === null) s.dropAt = t + 0.4;
    }
    for (const [k, s] of [...this.slots]) if (s.dropAt !== null && t > s.dropAt && !W.has(k)) this._dropSlot(k);
    this._applyDry(t, W);
  }

  _applyDry(t, W) {   // dry: plane wave from the loudspeaker at the interpolated direct-sound level
    let g = [0, 0, 0, 0];
    if (this.mode === "dry" && this.pos) {
      const [x, y, z] = this.pos, s = this.source.position;
      const v = [s[0] - x, s[1] - y, s[2] - z], d = Math.hypot(...v), u = v.map((q) => q / d);
      let a = 0, ws = 0;
      const sc = this.scenarios[this.scn];
      for (const [k, w] of (W.size ? W : this.weights)) {
        const id = k.includes("|") ? k.split("|")[1] : k;
        a += w * (sc.byId.get(id)?.direct ?? 0.1); ws += w;
      }
      a = ws ? a / ws : 0.1;
      g = [a, a * u[1], a * u[2], a * u[0]];
    }
    this.dryEnc.forEach((n, c) => n.gain.setTargetAtTime(g[c], t, 0.03));
  }
}

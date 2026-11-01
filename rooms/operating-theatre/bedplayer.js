// VR27 baked bed player (1 Nov 2026). Case A "baked mode" from claude/VR27_multisource.md.
// A bed is several steady sources pre-convolved offline into one first-order ambisonic loop per receiver and
// scenario (beds/<bed>/<scenario>/<receiver>.opus, 4 ch ACN/SN3D). The browser only plays the loop of the
// nearest IR point, then rotates and decodes it with the ambisonic bus and binaural decoder of a SeatAudio
// engine (eng.bus, eng.setOrientation, eng.setVolume), so beds and live sources share one decoder design.
// All loops of a bed have the same length and start on one clock (t0), so a change of IR point or scenario is
// an equal-power crossfade between two loops at the same loop phase. No silent pre-roll is needed: each baked
// loop already carries its full reverberant tail.

const FADE = 0.4, CACHE = 4;
const CURVE_IN = new Float32Array(33).map((_, i) => Math.sin((i / 32) * Math.PI / 2));
const CURVE_OUT = new Float32Array(33).map((_, i) => Math.cos((i / 32) * Math.PI / 2));

export class BedPlayer {
  constructor({ ctx, eng, info, bed, base = "audio/" }) {
    this.ctx = ctx; this.eng = eng; this.info = info; this.bed = bed; this.base = base;
    this.L = info.loop_s; this.cache = new Map(); this.cur = null; this.want = null; this.playing = false;
    this.onstatus = () => {};
    // undo the global bake gain, split the 4-channel loop onto the engine's ambisonic bus (W, Y, Z, X)
    this.inGain = new GainNode(ctx, { gain: 1 / info.scale, channelCount: 4, channelCountMode: "explicit", channelInterpretation: "discrete" });
    this.split = new ChannelSplitterNode(ctx, { numberOfOutputs: 4 });
    this.inGain.connect(this.split);
    for (let c = 0; c < 4; c++) this.split.connect(eng.bus[c], c);
  }

  _url(scn, rid) { return this.base + this.info.path.replace("{bed}", this.bed).replace("{scenario}", scn).replace("{receiver}", rid); }

  async _buf(scn, rid) {
    const key = `${scn}|${rid}`;
    if (this.cache.has(key)) { const v = this.cache.get(key); this.cache.delete(key); this.cache.set(key, v); return v; }
    const job = fetch(this._url(scn, rid)).then((r) => {
      if (!r.ok) throw new Error(`${this.bed} loop ${rid} did not load (${r.status})`);
      return r.arrayBuffer();
    }).then((a) => this.ctx.decodeAudioData(a)).then((b) => {
      if (b.numberOfChannels !== 4) throw new Error(`${this.bed} loop ${rid}: ${b.numberOfChannels} channels, expected 4`);
      return b;
    });
    this.cache.set(key, job);
    job.catch(() => this.cache.delete(key));
    while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value);
    return job;
  }

  set(scn, rid) { this.want = { scn, rid, key: `${scn}|${rid}` }; this._switch(); }

  start(t0) { this.t0 = t0; this.playing = true; this._switch(); }

  stop() {
    this.playing = false;
    if (this.cur) { try { this.cur.src.stop(); } catch (e) {} this.cur.g.disconnect(); this.cur = null; }
  }

  async _switch() {
    if (!this.playing || !this.want || this.cur?.key === this.want.key) return;
    const w = this.want;
    let buf;
    try { buf = await this._buf(w.scn, w.rid); } catch (err) { this.onstatus(err.message); return; }
    if (!this.playing || this.want.key !== w.key || this.cur?.key === w.key) return;
    const ctx = this.ctx, when = Math.max(ctx.currentTime + 0.03, this.t0);
    const off = (((when - this.t0) % this.L) + this.L) % this.L;
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
    const g = new GainNode(ctx, { gain: 0, channelCount: 4, channelCountMode: "explicit", channelInterpretation: "discrete" });
    src.connect(g); g.connect(this.inGain);
    src.start(when, off);
    if (this.cur) {
      const old = this.cur;
      g.gain.setValueCurveAtTime(CURVE_IN, when, FADE);
      old.g.gain.cancelScheduledValues(when); old.g.gain.setValueCurveAtTime(CURVE_OUT, when, FADE);
      try { old.src.stop(when + FADE + 0.05); } catch (e) {}
      old.src.onended = () => old.g.disconnect();
    } else g.gain.setValueAtTime(1, when);
    this.cur = { key: w.key, src, g };
  }
}

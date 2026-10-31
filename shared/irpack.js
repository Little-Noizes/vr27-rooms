// VR27 IR loader shared by all room engines (1 Nov 2026).
// A manifest "file" is either a plain WAV path or a slice of a pack written by tools/pack_room.py:
//   packs/<name>.wav#<start>,<length>,<fs>     (start and length in samples at the pack's own rate)
// A pack is fetched and decoded once per AudioContext; each IR is then cut out of it. The browser
// resamples the pack to the context rate, so start and length are scaled by contextRate / fs.

const packCache = new WeakMap();   // AudioContext -> Map(url -> Promise<AudioBuffer>)

async function decode(ctx, url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url.split("/").pop()} (${r.status})`);
  return ctx.decodeAudioData(await r.arrayBuffer());
}

export async function loadIR(ctx, url, suffix = "") {
  const hash = url.indexOf("#");
  if (hash < 0) return decode(ctx, url + suffix);
  const base = url.slice(0, hash);
  const [start, length, fs] = url.slice(hash + 1).split(",").map(Number);
  let m = packCache.get(ctx);
  if (!m) packCache.set(ctx, (m = new Map()));
  if (!m.has(base)) m.set(base, decode(ctx, base + suffix));
  let pack;
  try { pack = await m.get(base); } catch (e) { m.delete(base); throw e; }
  const ratio = pack.sampleRate / fs;
  const s0 = Math.round(start * ratio);
  const n = Math.max(1, Math.min(Math.round(length * ratio), pack.length - s0));
  const out = new AudioBuffer({ numberOfChannels: pack.numberOfChannels, length: n, sampleRate: pack.sampleRate });
  for (let c = 0; c < pack.numberOfChannels; c++) out.copyToChannel(pack.getChannelData(c).subarray(s0, s0 + n), c);
  return out;
}

// LAP parameter bins: "params/<scenario>.f32#<offset>,<count>" (float32 values) or a plain .f32 path.
const binCache = new Map();
export async function loadBins(url, suffix = "") {
  const hash = url.indexOf("#");
  if (hash < 0) {
    const r = await fetch(url + suffix);
    return r.ok ? new Float32Array(await r.arrayBuffer()) : null;
  }
  const base = url.slice(0, hash);
  const [off, count] = url.slice(hash + 1).split(",").map(Number);
  if (!binCache.has(base)) binCache.set(base, fetch(base + suffix).then((r) => (r.ok ? r.arrayBuffer() : null)));
  const buf = await binCache.get(base);
  return buf ? new Float32Array(buf, off * 4, count) : null;
}

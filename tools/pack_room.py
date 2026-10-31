"""Pack a room's IRs (and LAP parameter bins) into a few larger files for static web hosting.

Why: GitHub Pages (and any static host) serves hundreds of small IR files fine, but every one is a
separate request and a separate file to version. Packing groups neighbouring receivers, so a page
loads a block of the grid in one request and the repo holds tens of files instead of hundreds.

IR packs
  For each scenario and source, the IRs are taken in manifest order (grid order, so neighbours sit
  together) and written back to back into packs/<scenario>_<source>_<k>.wav, 16-bit PCM, with
  PAD zero samples after each IR so resampling in the browser cannot smear one IR into the next.
  A pack closes once it passes --target-mb. Each manifest entry's "file" becomes
      packs/<name>.wav#<start>,<length>,<fs>
  (start and length in samples at the pack's own rate). shared/irpack.js reads that form; a plain
  file name still works, so packed and unpacked manifests share one engine.

LAP bins (optional, --params)
  params/<scenario>/<receiver>/<source>.f32 files are concatenated per scenario into
  params/<scenario>.f32 and index.json "bins_file" becomes params/<scenario>.f32#<offset>,<count>
  (in float32 values). lap.js reads that form.

Usage
  python tools/pack_room.py <audio dir> [--manifest manifest.json] [--target-mb 4] [--params]
  The audio dir holds the manifest and the IR files it references; packed output is written in place
  (packs/, updated manifest and params/index.json); the loose IR and .f32 files are removed.
"""
import argparse, json, shutil
from pathlib import Path
import numpy as np
import soundfile as sf

PAD = 256


def pack_irs(audio: Path, manifest: str, target_mb: float, peak_scale: float | None, base: str = "") -> dict:
    man_path = audio / manifest
    audio = audio / base   # IR files and packs/ live under <audio>/<base> (the page's irBase)
    man = json.loads(man_path.read_text())
    out = audio / "packs"
    out.mkdir(exist_ok=True)
    used, stats = set(), {"packs": 0, "irs": 0, "bytes": 0}
    # one common scale for float sources so 16-bit cannot clip (recorded in the manifest)
    scale = 1.0
    if peak_scale is None:
        peak = 0.0
        for scn in man["scenarios"]:
            for e in scn["irs"]:
                info = sf.info(str(audio / e["file"]))
                if info.subtype.startswith("FLOAT") or info.subtype == "DOUBLE":
                    peak = max(peak, float(np.abs(sf.read(str(audio / e["file"]))[0]).max()))
        if peak > 0.999:
            scale = 0.999 / peak
    for scn in man["scenarios"]:
        groups = {}
        for e in scn["irs"]:
            groups.setdefault(e.get("source") or man["sources"][0]["id"], []).append(e)
        for src, entries in groups.items():
            k, buf, fs0, size = 0, [], None, 0

            def flush():
                nonlocal k, buf, size
                if not buf:
                    return
                name = f"{scn['id']}_{src}_{k}.wav"
                data = np.concatenate([b for b, _ in buf], axis=0)
                sf.write(str(out / name), np.clip(data * scale, -1, 1), fs0, subtype="PCM_16")
                for (b, e), start in zip(buf, np.cumsum([0] + [len(b) for b, _ in buf[:-1]])):
                    e["file"] = f"packs/{name}#{int(start)},{len(b) - PAD},{fs0}"
                stats["packs"] += 1
                stats["bytes"] += (out / name).stat().st_size
                k, buf, size = k + 1, [], 0

            for e in entries:
                src_file = audio / e["file"]
                x, fs = sf.read(str(src_file), always_2d=True)
                if fs0 is not None and fs != fs0:
                    flush()
                fs0 = fs
                buf.append((np.vstack([x, np.zeros((PAD, x.shape[1]))]), e))
                used.add(src_file)
                size += (len(x) + PAD) * x.shape[1] * 2
                stats["irs"] += 1
                if size >= target_mb * 1e6:
                    flush()
            flush()
    if scale != 1.0:
        man["pack_scale"] = scale
        for scn in man["scenarios"]:
            scn["ir_scale"] = scn.get("ir_scale", 1.0) / scale
    man_path.write_text(json.dumps(man))
    for f in used:
        f.unlink()
    for d in sorted({f.parent for f in used}, key=lambda p: -len(p.parts)):
        while d != audio and d.exists() and not any(d.iterdir()):
            d.rmdir()
            d = d.parent
    stats["scale"] = scale
    return stats


def pack_params(audio: Path) -> int:
    ix_path = audio / "params" / "index.json"
    ix = json.loads(ix_path.read_text())
    n = 0
    for scn_id, scn in ix["scenarios"].items():
        chunks, off = [], 0
        for rec in scn["irs"].values():
            for e in rec.values():
                f = audio / e["bins_file"]
                v = np.fromfile(f, dtype="<f4")
                chunks.append(v)
                e["bins_file"] = f"params/{scn_id}.f32#{off},{len(v)}"
                off += len(v)
                n += 1
        np.concatenate(chunks).astype("<f4").tofile(audio / "params" / f"{scn_id}.f32")
        shutil.rmtree(audio / "params" / scn_id)
    ix_path.write_text(json.dumps(ix))
    return n


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--manifest", default="manifest.json")
    ap.add_argument("--target-mb", type=float, default=4.0)
    ap.add_argument("--params", action="store_true")
    ap.add_argument("--base", default="", help="IR folder relative to the audio dir, if the page's irBase is a subfolder")
    a = ap.parse_args()
    s = pack_irs(Path(a.audio), a.manifest, a.target_mb, None, a.base)
    print(f"{a.audio}/{a.manifest}: {s['irs']} IRs -> {s['packs']} packs, {s['bytes'] / 1e6:.1f} MB, scale {s['scale']:.4f}")
    if a.params:
        print(f"params: {pack_params(Path(a.audio))} bins packed")

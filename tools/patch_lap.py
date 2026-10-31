"""Make lap.js read packed parameter bins through shared/irpack.js. Idempotent."""
import sys
from pathlib import Path
for p in map(Path, sys.argv[1:]):
    s = p.read_text()
    if "loadBins(" in s:
        print(p, "already patched"); continue
    old = """    const r = await fetch(this.base + key + this.sfx);
    if (!r.ok) return null;
    const v = new Float32Array(await r.arrayBuffer());"""
    assert old in s, p
    s = s.replace(old, """    const v = await loadBins(this.base + key, this.sfx);
    if (!v) return null;""")
    lines = s.split("\n"); i = 0
    while i < len(lines) and (lines[i].startswith("//") or not lines[i].strip()): i += 1
    lines.insert(i, 'import { loadBins } from "../../shared/irpack.js";')
    p.write_text("\n".join(lines)); print(p, "patched")

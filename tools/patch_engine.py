"""Make a room engine load IRs through shared/irpack.js (packed or plain files). Idempotent."""
import re, sys
from pathlib import Path
IMPORT = 'import { loadIR } from "../../shared/irpack.js";\n'
for p in map(Path, sys.argv[1:]):
    s = p.read_text()
    if "loadIR(" in s:
        print(p, "already patched"); continue
    pat = re.compile(r'const r = await fetch\((this\.irBase \+ (.+?)) \+ this\.sfx\); if \(!r\.ok\) throw new Error\(.+?\);\n(\s*)const buf = await this\.ctx\.decodeAudioData\(await r\.arrayBuffer\(\)\);')
    s, n = pat.subn(lambda m: f'const buf = await loadIR(this.ctx, {m.group(1)}, this.sfx);', s)
    assert n == 1, (p, n)
    # imports must come first in a module: put ours after the leading comment block
    lines = s.split("\n"); i = 0
    while i < len(lines) and (lines[i].startswith("//") or not lines[i].strip()): i += 1
    lines.insert(i, IMPORT.rstrip())
    p.write_text("\n".join(lines)); print(p, "patched")

"""Regenerate the MIT common-source oracle from identical transient.cir bytes.

Run: python3 packages/core/src/devices/bsim4/__fixtures__/rgatemod2/generate-transient.py
Requires ngspice-47; no circuit or solver options are modified.
"""
import bisect
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

base = pathlib.Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
assert 'ngspice-47 ' in version, version
deck = base / 'transient.cir'
with tempfile.TemporaryDirectory() as tmp:
    raw = pathlib.Path(tmp) / 'transient.raw'
    run = subprocess.run(['ngspice', '-b', '-r', str(raw), str(deck)],
                         env={**os.environ, 'SPICE_ASCIIRAWFILE': '1'},
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr
    header, data = raw.read_text().split('Values:\n')
    variables = [line.split()[1] for line in header.split('Variables:\n')[1].splitlines()]
    count = len(variables)
    lines = data.splitlines()
    rows = [[float(lines[i + j].split()[-1]) for j in range(count)]
            for i in range(0, len(lines), count)]
    times = [row[0] for row in rows]
    grid = [n * 1e-9 for n in range(201)]
    signals = {}
    for name in ['v(out)', 'i(vdd)']:
        col = variables.index(name)
        values = []
        for t in grid:
            j = max(0, min(len(rows) - 2, bisect.bisect_right(times, t) - 1))
            weight = (t - times[j]) / (times[j + 1] - times[j])
            values.append(rows[j][col] + weight * (rows[j + 1][col] - rows[j][col]))
        signals[name] = values
    result = dict(version=version.splitlines()[1], sha256=hashlib.sha256(deck.read_bytes()).hexdigest(),
                  nativePoints=len(rows), grid=grid, signals=signals)
    (base / 'transient-ngspice-47.json').write_text(json.dumps(result, indent=2) + '\n')
print(f'Generated {len(grid)} common-source samples from {len(rows)} native points')

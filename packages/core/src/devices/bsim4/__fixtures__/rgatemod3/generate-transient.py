"""Generate four authored MIT transient decks and identical-byte ngspice-47 oracles.

Run through spice-heavy; requires ngspice-47. No solver/tolerance overrides.
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
for polarity, kind in [(1, 'nmos'), (-1, 'pmos')]:
    for reverse in [False, True]:
        name = f'transient-{kind}-{"reverse" if reverse else "forward"}'
        terminals = '0 in out 0' if reverse else 'out in 0 0'
        deck = base / f'{name}.cir'
        deck.write_text(f'''Authored BSIM4 RGATEMOD=3 {kind} {"reverse" if reverse else "forward"} transient (MIT)
.model DUT {kind.upper()} LEVEL=54 VERSION=4.8.3 RGATEMOD=3 RSHG=1000 CGBO=2e-10 CGSL=1e-10 CGDL=3e-10
Vdd vdd 0 {polarity * 1.8}
Rd vdd out 10k
Vin in 0 PULSE(0 {polarity * 1.2} 10n 10n 10n 80n 200n)
M1 {terminals} DUT L=1u W=10u
Cl out 0 100f
.tran 1n 200n
.end
''')
        with tempfile.TemporaryDirectory() as tmp:
            raw = pathlib.Path(tmp) / 'transient.raw'
            run = subprocess.run(['ngspice', '-b', '-r', str(raw), str(deck)],
                                 env={**os.environ, 'SPICE_ASCIIRAWFILE': '1'}, capture_output=True, text=True)
            assert run.returncode == 0, run.stdout + run.stderr
            header, data = raw.read_text().split('Values:\n')
            variables = [line.split()[1] for line in header.split('Variables:\n')[1].splitlines()]
            count = len(variables)
            lines = data.splitlines()
            rows = [[float(lines[i + j].split()[-1]) for j in range(count)] for i in range(0, len(lines), count)]
            times = [row[0] for row in rows]
            grid = [n * 1e-9 for n in range(201)]
            signals = {}
            for signal in ['v(out)', 'i(vdd)']:
                col = variables.index(signal)
                values = []
                for t in grid:
                    j = max(0, min(len(rows) - 2, bisect.bisect_right(times, t) - 1))
                    weight = (t - times[j]) / (times[j + 1] - times[j])
                    values.append(rows[j][col] + weight * (rows[j + 1][col] - rows[j][col]))
                signals[signal] = values
            result = dict(version=version.splitlines()[1], sha256=hashlib.sha256(deck.read_bytes()).hexdigest(),
                          nativePoints=len(rows), grid=grid, signals=signals)
            (base / f'{name}-ngspice-47.json').write_text(json.dumps(result, indent=2) + '\n')
        print(f'{name}: {result["sha256"]}, {len(rows)} native points')

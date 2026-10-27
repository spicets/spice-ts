"""MIT original fixtures. Run via spice-heavy; unchanged committed deck bytes."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

base = Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
assert 'ngspice-47 ' in version
cases = []
for name in ['ac', 'tran']:
    deck = base / f'{name}.cir'
    with tempfile.TemporaryDirectory() as directory:
        raw = Path(directory) / 'native.raw'
        run = subprocess.run(['ngspice', '-b', '-r', str(raw), str(deck)],
                             env={**os.environ, 'SPICE_ASCIIRAWFILE': '1'}, capture_output=True, text=True)
        assert run.returncode == 0, run.stdout + run.stderr
        plot = raw.read_text().split('Title:')[1]
        count_match = re.search(r'No. Variables: (\d+)', plot)
        assert count_match is not None
        count = int(count_match[1])
        names = [line.split()[1] for line in plot.split('Variables:\n')[1].split('Values:\n')[0].splitlines()]
        values = plot.split('Values:\n')[1].split()
        rows = []
        for offset in range(0, len(values), count + 1):
            row = values[offset + 1:offset + count + 1]
            if name == 'ac':
                point = [float(row[0].split(',')[0]), *map(float, row[names.index('v(out)')].split(','))]
            else:
                point = [float(row[0]), float(row[names.index('v(out)')])]
            rows.append(point)
        cases.append(dict(deck=deck.name, sha256=hashlib.sha256(deck.read_bytes()).hexdigest(), points=rows))
(base / 'dynamic-ngspice-47.json').write_text(json.dumps(dict(version=version.splitlines()[1], cases=cases), indent=2) + '\n')
print({c['deck']: len(c['points']) for c in cases})

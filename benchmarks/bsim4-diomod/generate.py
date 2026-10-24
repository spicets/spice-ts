#!/usr/bin/env python3
"""Regenerate identical-byte OP/DC references with spice-heavy python3 generate.py."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

BASE = Path(__file__).resolve().parent
assert 'ngspice-47 ' in subprocess.check_output(['ngspice', '--version'], text=True)
cases = []
with tempfile.TemporaryDirectory(prefix='diomod-', dir=os.environ.get('TMPDIR')) as tmp:
    for deck in sorted(BASE.glob('*.cir')):
        raw = Path(tmp) / 'reference.raw'
        subprocess.run(['ngspice', '-b', '-r', str(raw), str(deck)],
                       env={**os.environ, 'SPICE_ASCIIRAWFILE': '1'},
                       capture_output=True, text=True, check=True)
        plots = []
        for plot in raw.read_text().split('Title:')[1:]:
            match = re.search(r'No. Points:\s*(\d+)', plot)
            assert match is not None
            count = int(match[1])
            variables = [line.split()[1] for line in plot.split('Variables:\n')[1].split('Values:\n')[0].splitlines()]
            values = plot.split('Values:\n')[1].splitlines()
            points = [[float(values[i * len(variables) + j].split()[-1]) for j in range(len(variables))] for i in range(count)]
            plots.append({'analysis': 'dc' if 'DC transfer' in plot else 'op', 'variables': variables, 'points': points})
        assert sorted(p['analysis'] for p in plots) == ['dc', 'op']
        cases.append({'deck': deck.name, 'sha256': hashlib.sha256(deck.read_bytes()).hexdigest(), 'plots': plots})
        print(deck.name, [(p['analysis'], len(p['points'])) for p in plots])
(BASE / 'ngspice-47.json').write_text(json.dumps({'version': 'ngspice-47', 'cases': cases}, indent=2) + '\n')

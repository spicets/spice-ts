#!/usr/bin/env python3
"""Freeze ngspice-47 DC branch currents from the unchanged self-authored decks.
Run under spice-heavy: spice-heavy python3 benchmarks/bsim4-igc/generate.py
The JSON is read by gate-current.test.ts; raw files/logs are temporary only.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

BASE = Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
assert 'ngspice-47 ' in version, 'Reference requires ngspice-47'
cases = []
with tempfile.TemporaryDirectory(prefix='bsim4-igc-', dir=os.environ.get('TMPDIR')) as tmp:
    for deck in sorted(BASE.glob('*.cir')):
        raw = Path(tmp) / 'dc.raw'
        subprocess.run(['ngspice', '-b', '-r', str(raw), str(deck)],
                                env={**os.environ, 'SPICE_ASCIIRAWFILE': '1'},
                                capture_output=True, text=True, check=True)
        text = raw.read_text()
        assert 'ngspice-47' in text
        match = re.search(r'No. Points:\s*(\d+)', text)
        assert match is not None
        count = int(match[1])
        variables = [line.split()[1] for line in text.split('Variables:\n')[1].split('Values:\n')[0].splitlines()]
        values = text.split('Values:\n')[1].splitlines()
        assert len(values) == count * len(variables)
        points = []
        for index in range(count):
            row = [float(values[index * len(variables) + column].split()[-1]) for column in range(len(variables))]
            points.append({'vgs': row[0], 'ig': row[variables.index('i(vg)')], 'id': row[variables.index('i(vd)')]})
        cases.append({'deck': deck.name, 'sha256': hashlib.sha256(deck.read_bytes()).hexdigest(), 'points': points})
        print(f'{deck.name}: {count} native points')
(BASE / 'ngspice-47.json').write_text(json.dumps({'version': 'ngspice-47', 'cases': cases}, indent=2) + '\n')

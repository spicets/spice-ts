"""Regenerate MIT project-authored identical-deck ngspice-47 AC oracles.

Run: python3 packages/core/src/devices/__fixtures__/diode-self-heating-ac/generate.py
Only output control is added; electrical deck bytes and analysis are unchanged.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
version = subprocess.run(['ngspice', '--version'], capture_output=True, text=True, check=True).stdout
if 'ngspice-47' not in version:
    raise RuntimeError('Reference regeneration requires ngspice-47')
for deck in sorted(HERE.glob('*.cir')):
    data = deck.read_bytes()
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as scratch:
        work = Path(scratch)
        control = '''.control
set numdgt=15
set wr_singlescale
set wr_vecnames
run
wrdata reference.txt real(v(tj)) imag(v(tj)) real(v(anode)) imag(v(anode)) real(i(vsrc)) imag(i(vsrc))
quit
.endc
.end
'''
        (work / 'reference.cir').write_text(data.decode().replace('.end\n', control))
        run = subprocess.run(['ngspice', '-b', 'reference.cir'], cwd=work, capture_output=True, text=True)
        if run.returncode:
            raise RuntimeError(run.stdout + run.stderr)
        rows = [[float(value) for value in line.split()]
                for line in (work / 'reference.txt').read_text().splitlines()[1:]]
        assert len(rows) == 61 and all(len(row) == 7 for row in rows)
    deck.with_suffix('.json').write_text(json.dumps({
        'source': 'ngspice-47; project-authored MIT fixture; see generate.py',
        'sha256': hashlib.sha256(data).hexdigest(),
        'columns': ['frequency', 'tj.real', 'tj.imag', 'anode.real', 'anode.imag', 'vsrc.real', 'vsrc.imag'],
        'rows': rows,
    }, indent=2) + '\n')
    print(f'{deck.name}: {len(rows)} reference points')

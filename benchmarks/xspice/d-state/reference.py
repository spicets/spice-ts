"""Self-authored MIT oracle generator, run from repo root:
spice-heavy python3 benchmarks/xspice/d-state/reference.py
Runs the committed deck and state-file bytes unchanged with ngspice-47.
"""
import hashlib
import json
from pathlib import Path
import struct
import subprocess

base = Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
if 'ngspice-47 ' not in version:
    raise RuntimeError('Requires ngspice-47')
result = {}
for case in ['counter', 'reset']:
    raw = base / f'{case}.raw'
    try:
        subprocess.run(['ngspice', '-b', '-r', str(raw), f'{case}.cir'],
                       cwd=base, check=True, capture_output=True)
        header, payload = raw.read_bytes().split(b'Binary:\n', 1)
        if b'\t0\ttime\ttime\n\t1\tv(out0)\tvoltage\n\t2\tv(out1)\tvoltage\n' not in header:
            raise RuntimeError('Unexpected reference vectors')
        samples = list(struct.iter_unpack('ddd', payload))
        result[case] = {
            'deckSha256': hashlib.sha256((base / f'{case}.cir').read_bytes()).hexdigest(),
            'stateSha256': hashlib.sha256((base / 'state.txt').read_bytes()).hexdigest(),
            'samples': samples,
        }
        print(f'{case}: {len(samples)} samples')
    finally:
        raw.unlink(missing_ok=True)
(base / 'ngspice47.json').write_text(json.dumps(result, separators=(',', ':')) + '\n')

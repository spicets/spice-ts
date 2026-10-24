"""Regenerate the test-consumed ngspice-47 oracle from unchanged corpus-f bytes.

Run from the repository root: spice-heavy python3 benchmarks/xspice/digital-models-reference.py
Deck provenance/licence: benchmarks/corpus/corpus-f/SOURCES.md (BSD-3-Clause).
"""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile

DECK = Path('benchmarks/corpus/corpus-f/fixtures/examples/xspice/original-examples/digital_models.deck')
OUTPUT = Path('packages/core/src/devices/xspice/digital-models-ngspice47.json')
version = subprocess.check_output(['ngspice', '--version'], text=True)
if 'ngspice-47 ' not in version:
    raise RuntimeError('This reference requires ngspice-47')
with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
    raw = Path(directory) / 'reference.raw'
    subprocess.run(['ngspice', '-b', '-r', str(raw), str(DECK.resolve())],
                   env={**os.environ, 'HOME': directory}, check=True, capture_output=True)
    header, payload = raw.read_bytes().split(b'Binary:\n', 1)
    if b'\t0\ttime\ttime\n\t1\tv(1)\tvoltage\n\t2\ti(v1)\tcurrent\n' not in header:
        raise RuntimeError('Unexpected reference vectors')
    samples = list(struct.iter_unpack('ddd', payload))
OUTPUT.write_text(json.dumps({
    'source': 'ngspice-47 -b -r reference.raw ' + str(DECK),
    'sha256': hashlib.sha256(DECK.read_bytes()).hexdigest(),
    'columns': ['time', 'v(1)', 'i(v1)'],
    'samples': samples,
}, indent=2) + '\n')
print(f'{OUTPUT}: {len(samples)} points')

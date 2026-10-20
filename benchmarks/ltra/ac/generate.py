"""Regenerate identical-deck AC references with ngspice-47.
Run from the repository root: spice-heavy python3 benchmarks/ltra/ac/generate.py
"""
import json
from pathlib import Path
import subprocess
import tempfile
import os
import struct

HERE = Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
if 'ngspice-47' not in version:
    raise RuntimeError('References require ngspice-47')
for case, resistance, inductance in [('rlc', '0.1', '250n'), ('rc', '10', '0'), ('lc', '0', '250n')]:
    deck = f'''LTRA {case.upper()} AC parity, issue 1604
V1 1 0 DC 0 AC 1
R1 1 2 50
O1 2 0 3 0 lm
R2 3 0 50
.model lm ltra r={resistance} l={inductance} c=100p len=1
.ac dec 10 1k 1g
.end
'''
    (HERE / f'{case}.cir').write_text(deck)
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as temp:
        raw = Path(temp) / 'reference.raw'
        subprocess.run(['ngspice', '-n', '-b', '-r', str(raw), str(HERE / f'{case}.cir')],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        header, data = raw.read_bytes().split(b'Binary:\n', 1)
        text = header.decode()
        variables = text.split('Variables:\n')[1].strip().splitlines()
        names = [line.split()[1] for line in variables]
        points = []
        width = len(names)
        values = struct.unpack(f'{len(data) // 8}d', data)
        for offset in range(0, len(values), 2 * width):
            frequency = values[offset]
            position = offset + 2 * names.index('v(3)')
            real, imaginary = values[position:position + 2]
            points.append([frequency, real, imaginary])
        (HERE / f'{case}.json').write_text(json.dumps(points, indent=2) + '\n')
        print(f'{case}: {len(points)} ngspice-47 AC points')

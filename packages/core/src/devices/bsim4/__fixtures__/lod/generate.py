"""Original MIT BSIM4 LOD fixtures. Both engines read identical deck bytes.
Run: spice-heavy python3 packages/core/src/devices/bsim4/__fixtures__/lod/generate.py
Requires ngspice-47; SPICE_ASCIIRAWFILE=1 ngspice -b -r <raw> <deck>.
"""
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
for name, instance, extra, temp in [
    ('nf2', 'SA=0.5u SB=0.5u SD=0.2u NF=2', '', 27),
    ('nf1', 'SA=0.3u SB=0.8u NF=1', '', 27),
    ('scaled-hot', 'SA=0.5u SB=0.7u SD=0.2u NF=3 MULU0=1.2 DELVTO=0.03',
     'WLOD=0.1u LLODKU0=1 WLODKU0=1 LKU0=0.2u WKU0=0.1u PKU0=0.01p '
     'LLODVTH=1 WLODVTH=1 LKVTH0=0.1u WKVTH0=0.2u PKVTH0=0.02p TKU0=0.2 LODK2=1.2 LODETA0=0.8', 75),
    ('inactive-sd', 'SA=0.5u SB=0.5u SD=0 NF=2', '', 27),
    ('inactive-sa', 'SA=0 SB=0.5u SD=0.2u NF=2', '', 27),
    ('neutral', 'SA=0 SB=0 NF=2', '', 27),
]:
    deck = f'''Original MIT BSIM4 LOD OP/DC regression
.model DUT NMOS LEVEL=54 VERSION=4.8 KU0=1e-7 KVTH0=2e-8 KVSAT=0.4 STK2=1e-8 STETA0=2e-8 {extra}
Vd d 0 0.8
Vg g 0 1.2
Vs s 0 0
Vb b 0 -0.2
M1 d g s b DUT L=1u W=10u {instance}
.temp {temp}
.options abstol=1e-15 reltol=1e-10 vntol=1e-12
.save v(d) v(g) v(s) v(b) i(Vd)
.op
.dc Vg 0.4 1.4 0.2
.end
'''
    path = base / f'{name}.cir'
    path.write_text(deck)
    with tempfile.TemporaryDirectory() as directory:
        raw = Path(directory) / 'native.raw'
        run = subprocess.run(['ngspice', '-b', '-r', str(raw), str(path)],
                             env={**os.environ, 'SPICE_ASCIIRAWFILE': '1'}, capture_output=True, text=True)
        assert run.returncode == 0, run.stdout + run.stderr
        plots = {}
        for plot in raw.read_text().split('Title:')[1:]:
            kind_match = re.search(r'Plotname: (.+)', plot)
            count_match = re.search(r'No. Variables: (\d+)', plot)
            assert kind_match is not None and count_match is not None
            kind = kind_match[1]
            count = int(count_match[1])
            names = [line.split()[1] for line in plot.split('Variables:\n')[1].split('Values:\n')[0].splitlines()]
            values = plot.split('Values:\n')[1].split()
            rows = []
            for offset in range(0, len(values), count + 1):
                row = list(map(float, values[offset + 1:offset + count + 1]))
                rows.append([row[names.index(n)] for n in ['v(d)', 'v(g)', 'v(s)', 'v(b)', 'i(vd)']])
            plots[kind] = rows
        cases.append(dict(deck=path.name, sha256=hashlib.sha256(deck.encode()).hexdigest(),
                          op=plots['Operating Point'][0], points=plots['DC transfer characteristic']))
(base / 'ngspice-47.json').write_text(json.dumps(dict(version=version.splitlines()[1], cases=cases), indent=2) + '\n')
print(f'Generated {len(cases)} OP cases, {sum(len(c["points"]) for c in cases)} DC points')

"""Regenerate identical-deck MOS6 oracles with ngspice-47.

Run: spice-heavy python3 benchmarks/fixtures/issue-1847/generate.py
Original project-authored decks, MIT. No third-party fixture bytes.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
if '** ngspice-47 :' not in version:
    raise RuntimeError('Requires ngspice-47')
references = []
for polarity, sign in [('n', 1), ('p', -1)]:
    for case, parameters in [('temp', 'TEMP=75'), ('dtemp', 'DTEMP=30'),
                             ('both', 'TEMP=75 DTEMP=30')]:
        name = f'{polarity}-{case}'
        deck = f'''MOS6 instance temperature {name}
Vd supply 0 {sign * 3}
Vg g 0 {sign * 2}
Vb b 0 {-sign * 0.4}
Rd supply d 1k
Rs s 0 100
M1 d g s b MOD L=2u W=10u AD=2p AS=3p {parameters}
.model MOD {polarity.upper()}MOS LEVEL=6 VTO={sign * 0.7} KV=1.2 NV=0.9 KC=50u NC=1.3 GAMMA=0.4 GAMMA1=0.05 SIGMA=0.02 LAMBDA0=0.02 LAMBDA1=0.004 PHI=0.6 IS=1e-14 JS=1e-8 TNOM=27
.options TEMP=40 RELTOL=1e-10 ABSTOL=1e-15 VNTOL=1e-12
.op
.dc Vg 0 {sign * 3} {sign * 0.05}
.control
set filetype=ascii
.endc
.end
'''
        path = HERE / f'{name}.cir'
        path.write_text(deck)
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
            raw = pathlib.Path(tmp) / 'reference.raw'
            subprocess.run(['ngspice', '-b', '-r', str(raw), str(path)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            text = raw.read_text()
        plots = {}
        for plot in text.split('Title:')[1:]:
            header, values = plot.split('Values:\n')
            variables = [line.split()[1] for line in header.split('Variables:\n')[1].splitlines()]
            numbers = [float(line.split()[-1]) for line in values.splitlines() if line.strip()]
            plots['op' if 'Operating Point' in header else 'dc'] = [
                dict(zip(variables, numbers[i:i+len(variables)]))
                for i in range(0, len(numbers), len(variables))]
        references.append({'id': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), **plots})
(HERE / 'reference.json').write_text(json.dumps({'ngspice': 47, 'references': references}, indent=2) + '\n')
print(f'Generated {len(references)} identical-deck OP/DC references with ngspice-47')

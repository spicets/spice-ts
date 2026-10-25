"""Authored MIT BSIM4 RSH/NRD/NRS OP/DC oracle, identical .cir inputs.
Run from repository root:
  spice-heavy python3 packages/core/src/devices/bsim4/__fixtures__/series-resistance/generate.py
Requires ngspice-47. Source provenance and equations: ../../SETUP.md.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

base = pathlib.Path(__file__).resolve().parent
ngspice = os.environ.get('NGSPICE', 'ngspice')
version = subprocess.check_output([ngspice, '--version'], text=True)
assert 'ngspice-47 ' in version, version
cases = []
for name, polarity, vd, model, instance, internal in [
    ('symmetric', 1, 0.7, 'RSH=10', 'NRD=2 NRS=2', ['drain', 'source']),
    ('pmos-asymmetric', -1, 0.7, 'RSH=10', 'NRD=3 NRS=1', ['drain', 'source']),
    ('reverse', 1, -0.7, 'RSH=10', 'NRD=1 NRS=3', ['drain', 'source']),
    ('drain-only', 1, 0.7, 'RSH=10', 'NRD=2', ['drain']),
    ('source-only', 1, 0.7, 'RSH=10', 'NRS=2 NRD=0', ['source']),
    ('omitted', 1, 0.7, 'RSH=10', '', []),
    ('zero-rsh', 1, 0.7, 'RSH=0', 'NRD=2 NRS=2', []),
    ('multipliers', 1, 0.7, 'RSH=10', 'NRD=2 NRS=2 M=3 MULT_I=2 NF=2', ['drain', 'source']),
    ('gate-body', 1, 0.7, 'RSH=10 RGATEMOD=3 RSHG=100 RBODYMOD=1', 'NRD=2 NRS=2 M=2',
     ['gate', 'midgate', 'dbody', 'body', 'sbody', 'drain', 'source']),
]:
    deck = f'''Authored BSIM4 series resistance OP/DC regression (MIT)
.model DUT {'NMOS' if polarity == 1 else 'PMOS'} LEVEL=54 VERSION=4.8.3 {model}
Vd d 0 {polarity * vd}
Vg g 0 {polarity * 1.4}
Vs s 0 0
Vb b 0 {polarity * (-0.9 if vd < 0 else -0.2)}
M1 d g s b DUT L=1u W=10u {instance}
.options abstol=1e-15 reltol=1e-10 vntol=1e-12
.op
.dc Vd {polarity * (1 if vd > 0 else -1) * 0.2} {polarity * (1 if vd > 0 else -1) * 1.0} {polarity * (1 if vd > 0 else -1) * 0.2}
.end
'''
    path = base / f'{name}.cir'
    path.write_text(deck)
    quantities = ['d', 'g', 's', 'b'] + ['M1.' + n for n in internal] + ['Vd', 'Vg', 'Vs', 'Vb']
    native_names = {'drain': 'drain', 'source': 'source', 'gate': 'gate', 'midgate': 'midgate',
                    'dbody': 'dbody', 'body': 'body', 'sbody': 'sbody'}
    vectors = ['v(d)', 'v(g)', 'v(s)', 'v(b)'] + [f'v(m1#{native_names[n]})' for n in internal] + ['i(Vd)', 'i(Vg)', 'i(Vs)', 'i(Vb)']
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        control = f'''.control
set wr_vecnames
set wr_singlescale
set numdgt=17
* Explicit vectors (no 'all'): outitf.c otherwise suppresses #drain/#source.
save {' '.join(vectors)}
op
wrdata {tmp / 'op.dat'} {' '.join(vectors)}
dc Vd {polarity * (1 if vd > 0 else -1) * 0.2} {polarity * (1 if vd > 0 else -1) * 1.0} {polarity * (1 if vd > 0 else -1) * 0.2}
wrdata {tmp / 'dc.dat'} {' '.join(vectors)}
quit
.endc
.end
'''
        native = tmp / 'native.cir'
        native.write_text(deck.replace('.end\n', control))
        run = subprocess.run([ngspice, '-b', str(native)], cwd=tmp, capture_output=True, text=True)
        assert run.returncode == 0 and (tmp / 'op.dat').exists(), name + '\n' + run.stdout + run.stderr
        def points(filename):
            return [list(map(float, line.split()[1:])) for line in (tmp / filename).read_text().splitlines()[1:]]
        cases.append(dict(deck=path.name, sha256=hashlib.sha256(deck.encode()).hexdigest(), quantities=quantities,
                          op=points('op.dat')[0], points=points('dc.dat')))
(base / 'ngspice-47.json').write_text(json.dumps(dict(version=version.splitlines()[1], cases=cases), indent=2) + '\n')
print(f'Generated {len(cases)} cases, {sum(len(c["points"]) for c in cases)} DC points')

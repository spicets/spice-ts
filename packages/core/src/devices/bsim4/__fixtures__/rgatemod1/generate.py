"""Regenerate authored (MIT, like spice-ts) single-device RGATEMOD=1 references.
Run: python3 packages/core/src/devices/bsim4/__fixtures__/rgatemod1/generate.py
Requires ngspice-47 on PATH. Identical .cir inputs are consumed by both engines.
"""
import hashlib
import json
import pathlib
import subprocess
import tempfile

base = pathlib.Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
assert 'ngspice-47 ' in version, version
cases = []
# model selector, instance override, geometry defaults, both polarities, and zero-R fallback.
for name, polarity, model, instance in [
    ('model', 1, 'RGATEMOD=1 RSHG=1meg XGW=20n XGL=10n NGCON=2', 'NF=2 M=3'),
    ('instance', -1, 'RGATEMOD=0 RSHG=1meg XGW=20n XGL=10n NGCON=2', 'RGATEMOD=1 XGW=40n NGCON=1 M=2'),
    ('defaults', 1, 'RGATEMOD=1', ''),
    ('zero-rshg', 1, 'RGATEMOD=1 RSHG=0', ''),
]:
    deck = f'''Authored BSIM4 RGATEMOD=1 OP/DC regression (MIT)
.model DUT {'NMOS' if polarity == 1 else 'PMOS'} LEVEL=54 VERSION=4.8.3 IGCMOD=1 IGBMOD=1 TOXE=1n {model}
Vd d 0 {polarity * 0.7}
Vg g 0 {polarity * 1.4}
Vb b 0 {polarity * -0.2}
Vs s 0 0
M1 d g s b DUT L=1u W=10u {instance}
.options abstol=1e-15 reltol=1e-10 vntol=1e-12
.op
.dc Vg {polarity * 0.8} {polarity * 1.6} {polarity * 0.2}
.end
'''
    path = base / f'{name}.cir'
    path.write_text(deck)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        control = f'''.control
set wr_vecnames
set wr_singlescale
set numdgt=17
op
wrdata {tmp / 'op.dat'} v(g) v(d) v(b) v(m1#gate) i(Vg) i(Vd) i(Vb) i(Vs)
dc Vg {polarity * 0.8} {polarity * 1.6} {polarity * 0.2}
wrdata {tmp / 'dc.dat'} v(g) v(d) v(b) v(m1#gate) i(Vg) i(Vd) i(Vb) i(Vs)
quit
.endc
.end
'''
        native = tmp / 'native.cir'
        native.write_text(deck.replace('.end\n', control))
        run = subprocess.run(['ngspice', '-b', str(native)], cwd=tmp, capture_output=True, text=True)
        assert run.returncode == 0, run.stdout + run.stderr
        def points(filename):
            lines = (tmp / filename).read_text().splitlines()[1:]
            return [dict(zip(['vg', 'vd', 'vb', 'gate', 'ig', 'id', 'ib', 'is'], map(float, line.split()[1:]))) for line in lines]
        cases.append(dict(deck=path.name, sha256=hashlib.sha256(deck.encode()).hexdigest(), op=points('op.dat')[0], points=points('dc.dat')))
(base / 'ngspice-47.json').write_text(json.dumps(dict(version=version.splitlines()[1], cases=cases), indent=2) + '\n')
print(f'Generated {len(cases)} cases, {sum(len(c["points"]) for c in cases)} DC points')

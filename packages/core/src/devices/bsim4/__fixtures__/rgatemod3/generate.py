"""Authored MIT RGATEMOD=3 OP/DC/AC oracle. Requires ngspice-47.
Run with spice-heavy python3 packages/core/src/devices/bsim4/__fixtures__/rgatemod3/generate.py
Both engines consume the same netlists; only oracle export controls differ.
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
for name, polarity, reverse, selector, instance in [
    ('nmos', 1, False, 'RGATEMOD=3 RSHG=1meg XGW=20n XGL=10n NGCON=2 CGBO=30p CGSL=100p CGDL=80p', 'NF=2 M=3'),
    ('pmos-instance', -1, False, 'RGATEMOD=0 RSHG=1meg', 'RGATEMOD=3 M=2'),
    ('nmos-reverse', 1, True, 'RGATEMOD=3 RSHG=1meg', ''),
    ('zero-rshg', 1, False, 'RGATEMOD=3 RSHG=0', ''),
    ('body', 1, False, 'RGATEMOD=3 RSHG=1meg RBODYMOD=1', ''),
]:
    deck = f'''Authored MIT BSIM4 RGATEMOD=3 common-source regression
.model DUT {'NMOS' if polarity == 1 else 'PMOS'} LEVEL=54 VERSION=4.8.3 IGCMOD=1 IGBMOD=1 TOXE=1n {selector}
Vdd supply 0 {polarity * 1.8}
Rd supply d 1k
Vg g 0 {polarity * 1.4} AC 1
Vb b 0 {polarity * -0.2}
Vs s 0 0
M1 {'s g d b' if reverse else 'd g s b'} DUT L=1u W=10u {instance}
.options abstol=1e-15 reltol=1e-10 vntol=1e-12
.op
.dc Vg {polarity * 1.0} {polarity * 1.6} {polarity * 0.2}
.ac dec 3 1k 1g
.end
'''
    path = base / f'{name}.cir'
    path.write_text(deck)
    quantities = 'v(d) v(g) v(s) v(b) v(m1#gate) v(m1#midgate) i(Vdd) i(Vg) i(Vs) i(Vb)'
    with tempfile.TemporaryDirectory() as directory:
        tmp = pathlib.Path(directory)
        control = f'''.control
set wr_vecnames
set wr_singlescale
set numdgt=17
op
wrdata {tmp / 'op.dat'} {quantities}
dc Vg {polarity * 1.0} {polarity * 1.6} {polarity * 0.2}
wrdata {tmp / 'dc.dat'} {quantities}
ac dec 3 1k 1g
wrdata {tmp / 'ac.dat'} {quantities}
quit
.endc
.end
'''
        native = tmp / 'native.cir'
        native.write_text(deck.replace('.end\n', control))
        run = subprocess.run(['ngspice', '-b', str(native)], cwd=tmp, capture_output=True, text=True)
        assert run.returncode == 0, run.stdout + run.stderr
        def rows(file):
            return [list(map(float, line.split())) for line in (tmp / file).read_text().splitlines()[1:]]
        cases.append(dict(deck=path.name, sha256=hashlib.sha256(deck.encode()).hexdigest(),
                          op=rows('op.dat')[0][1:], dc=rows('dc.dat'), ac=rows('ac.dat')))
(base / 'ngspice-47.json').write_text(json.dumps(dict(version=version.splitlines()[1], cases=cases), indent=2) + '\n')
print(f'Generated {len(cases)} OP cases, {sum(len(c["dc"]) for c in cases)} DC points, {sum(len(c["ac"]) for c in cases)} AC points')

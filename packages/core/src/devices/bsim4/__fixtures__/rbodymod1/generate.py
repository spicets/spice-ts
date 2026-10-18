"""Authored MIT BSIM4 body-network fixtures. Same decks in both engines.
Run with ngspice-47: python3 packages/core/src/devices/bsim4/__fixtures__/rbodymod1/generate.py
"""
import hashlib
import json
import pathlib
import subprocess
import tempfile

base = pathlib.Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
assert 'ngspice-47 ' in version
cases = []
for name, polarity, selector, instance in [
    ('model', 1, 'rbodymod=1', ''),
    ('instance-pmos-gate', -1, 'rbodymod=0 rgatemod=1 rshg=1000', 'rbodymod=1 rbpb=30000'),
]:
    deck = f'''Authored MIT BSIM4 body-network OP/AC regression
.model DUT {'NMOS' if polarity == 1 else 'PMOS'} level=54 version=4.8.3 {selector} rbpb=50000 rbpd=60000 rbps=70000 rbdb=80000 rbsb=90000
M1 d g s b DUT l=1u w=10u ad=1p as=2p {instance}
Vd d 0 {polarity} ac 0.1
Vg g 0 {polarity} ac 0.3
Vb b 0 {-0.1 * polarity} ac 1
Vs s 0 0
.options abstol=1e-15 reltol=1e-10 vntol=1e-12
.op
.ac dec 2 1k 1meg
.end
'''
    path = base / f'{name}.cir'
    path.write_text(deck)
    quantities = ['v(d)', 'v(g)', 'v(s)', 'v(b)', 'v(m1#dbody)', 'v(m1#body)', 'v(m1#sbody)', 'i(Vd)', 'i(Vg)', 'i(Vs)', 'i(Vb)']
    with tempfile.TemporaryDirectory() as directory:
        tmp = pathlib.Path(directory)
        control = f'''.control
set wr_vecnames
set wr_singlescale
set numdgt=17
op
wrdata {tmp / 'op.dat'} {' '.join(quantities)}
ac dec 2 1k 1meg
wrdata {tmp / 'ac.dat'} {' '.join(quantities)}
quit
.endc
.end
'''
        native = tmp / 'native.cir'
        native.write_text(deck.replace('.end\n', control))
        run = subprocess.run(['ngspice', '-b', str(native)], capture_output=True, text=True)
        assert run.returncode == 0, run.stdout + run.stderr
        def rows(file):
            return [list(map(float, line.split())) for line in (tmp / file).read_text().splitlines()[1:]]
        cases.append(dict(deck=path.name, sha256=hashlib.sha256(deck.encode()).hexdigest(), op=rows('op.dat')[0][1:], ac=rows('ac.dat')))
(base / 'ngspice-47.json').write_text(json.dumps(dict(version=version.splitlines()[1], cases=cases), indent=2) + '\n')
print(f'Generated {len(cases)} OP cases and {sum(len(c["ac"]) for c in cases)} AC points')

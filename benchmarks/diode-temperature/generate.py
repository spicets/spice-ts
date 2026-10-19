"""Regenerate #1533 diode references using ngspice-47 (project-authored MIT).

From the repository root: spice-heavy python benchmarks/diode-temperature/generate.py
Only Python's standard library is needed. No upstream netlists are copied.
"""
import json
import math
import re
import subprocess
import tempfile
from pathlib import Path

BASE = dict(CJ0=1e-11, CJSW=3e-12, VJ=.8, VJSW=.9, M=.4, MJSW=.33, TT=2e-9, TNOM=27)
LINEAR = dict(CTA=.001, CTP=.002, TPB=.0003, TPHP=.0004)
POLYNOMIAL = dict(TM1=.001, TM2=.00001, TTT1=.002, TTT2=.00002)
COMBINED = dict(TLEVC=1, **LINEAR, **POLYNOMIAL)
CASES = [{}, {'TLEVC': 1}]
CASES += [dict(TLEVC=1, **{k: v}) for k, v in LINEAR.items()]
CASES += [{k: v} for k, v in POLYNOMIAL.items()]
CASES += [COMBINED]
# Coefficients of the linear law must be inactive with TLEVC=0.
CASES += [{k: v} for k, v in LINEAR.items()]


def run(directory, params, temperature, bias, kind):
    model = BASE | params
    if kind == 'bottom':
        model.update(CJSW=0, TT=0)
    if kind == 'sidewall':
        model.update(CJ0=0, TT=0)
    if kind == 'transit':
        model.update(CJ0=0, CJSW=0)
    fields = ' '.join(f'{k}={v}' for k, v in model.items())
    source = (f'V1 in 0 {bias} AC 1\nR1 in out 1k' if kind == 'all'
              else f'V1 out 0 {bias} AC 1')
    deck = f'''Diode temperature parameter oracle #1533
{source}
D1 out 0 DM PJ=1
.model DM D ({fields})
.options temp={temperature} reltol=1e-12 abstol=1e-20 vntol=1e-14
.control
set numdgt=17
op
print @d1[cd] @d1[gd]
ac lin 1 100Meg 100Meg
print vm(out) vp(out)
.endc
.end
'''
    path = directory / 'oracle.cir'
    path.write_text(deck)
    result = subprocess.run(['ngspice', '-b', str(path)], capture_output=True, text=True)
    text = result.stdout + result.stderr
    found = {k: float(v) for k, v in re.findall(
        r'(@d1\[\w+\]|vm\(out\)|vp\(out\))\s*=\s*([-+\d.eE]+)', text)}
    if len(found) != 4:
        raise RuntimeError(text)
    return found


def extract(directory, params, temperature, kind):
    # Ideal voltage source avoids series-resistor/GMIN voltage error in this fit.
    c = [run(directory, params, temperature, v, kind)['@d1[cd]'] for v in [0, -1, -2]]
    ratio = math.log(c[1] / c[0]) / math.log(c[2] / c[0])
    lo, hi = .001, 100.
    for _ in range(150):
        mid = (lo + hi) / 2
        if math.log1p(1 / mid) / math.log1p(2 / mid) > ratio:
            lo = mid
        else:
            hi = mid
    potential = (lo + hi) / 2
    grading = -math.log(c[1] / c[0]) / math.log1p(1 / potential)
    return c[0], potential, grading


version = subprocess.check_output(['ngspice', '--version'], text=True)
if 'ngspice-47 ' not in version:
    raise RuntimeError('This fixture is pinned to ngspice-47')
rows = []
with tempfile.TemporaryDirectory(prefix='diode-1533-') as directory:
    directory = Path(directory)
    groups = [(27, [100, -20], CASES), (50, [50, 100, -20], [COMBINED, POLYNOMIAL])]
    for nominal, temperatures, cases in groups:
        for temperature in temperatures:
            for params in cases:
                params = params | {'TNOM': nominal}
                cj, vj, m = extract(directory, params, temperature, 'bottom')
                cs, vs, _ = extract(directory, params, temperature, 'sidewall')
                # ngspice dioload.c:585: diffusion capacitance = TT(T)*gd.
                transit = run(directory, params, temperature, .5, 'transit')
                tt = transit['@d1[cd]'] / transit['@d1[gd]']
                ac = run(directory, params, temperature, -1, 'all')
                rows.append(dict(temperature=temperature, model=params,
                                 expected=dict(CJ0=cj, CJSW=cs, VJ=vj, VJSW=vs, M=m, TT=tt),
                                 magnitude=ac['vm(out)'], phase=ac['vp(out)']))
output = Path(__file__).resolve().parents[2] / 'packages/core/src/devices/fixtures/diode-temperature-1533.json'
output.write_text(json.dumps(rows, indent=2) + '\n')
print(f'Wrote {len(rows)} ngspice-47 references to {output}')

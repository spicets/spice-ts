"""Regenerate: spice-heavy python3 benchmarks/fixtures/issue-1845/generate.py

Original project-authored decks (MIT), identical inputs for both simulators.
Requires ngspice-47. Reference equations: ngspice-47 vdmostemp.c.
"""
import json
import os
import pathlib
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
assert 'ngspice-47' in version, version
references = []
configs = [('repro', '''t
.options TEMP=75
Vd d 0 10
Vg g 0 5
M1 d g 0 vd
.model vd VDMOS(VTO=2 KP=1)
.op
.end
''')]
for polarity, sign in [('n', 1), ('p', -1)]:
    for temp in [-20, 75]:
        for mode, drain, resistance in [('channel', 10, 'TEXP0=1.8'), ('diode', -0.8, 'TRD1=0.004 TRD2=0.00001')]:
            name = f'{polarity}-{mode}-temp{temp}'
            configs.append((name, f'''VDMOS circuit temperature {name}
.options TEMP={temp} RELTOL=1e-10 ABSTOL=1e-15 VNTOL=1e-12
Vd d 0 {sign * drain}
Vg g 0 {sign * 5}
M1 d g 0 vd
.model vd VDMOS({'pchan' if sign < 0 else ''} VTO={sign * 2} KP=1 TNOM=40 TCVTH=-0.003 MU=-1.2
+ RD=0.2 RS=0.1 RG=0.3 {resistance} TRS1=0.003 TRS2=0.000002 TRG1=0.002
+ RQ=0.1 VQ=3 TEXP1=0.5 IS=2e-12 N=1.1 EG=1.08 XTI=2.5 RB=0.15 TRB1=0.002 TRB2=0.000003
+ CJO=1n VJ=0.7 M=0.4 TT=10n)
.op
.dc Vg 0 {sign * 6} {sign * 0.1}
.end
'''))
for name, deck in configs:
    deck = deck.replace('.end\n', '.control\nset filetype=ascii\n.endc\n.end\n')
    (HERE / f'{name}.cir').write_text(deck)
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
        path = pathlib.Path(tmp)
        subprocess.run(['ngspice', '-b', '-r', str(path / 'reference.raw'), str(HERE / f'{name}.cir')],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        text = (path / 'reference.raw').read_text()
    plots = {}
    for plot in text.split('Title:')[1:]:
        header, values = plot.split('Values:\n')
        variables = [line.split()[1] for line in header.split('Variables:\n')[1].splitlines()]
        numbers = [float(line.split()[-1]) for line in values.splitlines() if line.strip()]
        plots['op' if 'Operating Point' in header else 'dc'] = [
            dict(zip(variables, numbers[i:i+len(variables)])) for i in range(0, len(numbers), len(variables))]
    references.append({'id': name, **plots})
(HERE / 'reference.json').write_text(json.dumps({'ngspice': 47, 'references': references}, separators=(',', ':')) + '\n')
print(f'Generated {len(references)} identical-deck ngspice-47 references')

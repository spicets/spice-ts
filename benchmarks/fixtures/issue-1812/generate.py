"""Regenerate: spice-heavy python3 benchmarks/fixtures/issue-1812/generate.py

Original project-authored decks, MIT. Each identical deck is run with:
ngspice -b -r <temporary-reference.raw> benchmarks/fixtures/issue-1812/<id>.cir
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
for polarity, sign in [('n', 1), ('p', -1)]:
    for tnom in [27, 50]:
        for temp in [27, 50, 100]:
            name = f'{polarity}-tnom{tnom}-temp{temp}'
            deck = f'''MOS9 circuit temperature {name}
VD supply 0 {sign * 3}
VG g 0 {sign * 2}
VB b 0 {-sign * 0.4}
RD supply d 1k
RS s 0 100
M1 d g s b MOD L=2u W=10u AD=2p AS=3p
.model MOD {polarity.upper()}MOS LEVEL=9 VTO={sign * 0.7} KP=50u GAMMA=0.4 PHI=0.6 THETA=0.1 ETA=0.02 KAPPA=0.2 VMAX=1e5 TOX=20n IS=1e-14 JS=1e-8 TNOM={tnom}
.options TEMP={temp} RELTOL=1e-10 ABSTOL=1e-15 VNTOL=1e-12
.op
.dc VG {sign * 0.8} {sign * 2.4} {sign * 0.4}
.control
set filetype=ascii
.endc
.end
'''
            (HERE / f'{name}.cir').write_text(deck)
            with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
                raw = pathlib.Path(tmp) / 'reference.raw'
                subprocess.run(['ngspice', '-b', '-r', str(raw), str(HERE / f'{name}.cir')],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                text = raw.read_text()
            plots = {}
            for plot in text.split('Title:')[1:]:
                header, values = plot.split('Values:\n')
                variables = [line.split()[1] for line in header.split('Variables:\n')[1].splitlines()]
                nvars = len(variables)
                numbers = [float(line.split()[-1]) for line in values.splitlines() if line.strip()]
                plots['op' if 'Operating Point' in header else 'dc'] = [
                    dict(zip(variables, numbers[i:i+nvars])) for i in range(0, len(numbers), nvars)]
            references.append({'id': name, **plots})
(HERE / 'reference.json').write_text(json.dumps({'ngspice': 47, 'references': references}, indent=2) + '\n')
print(f'Generated {len(references)} identical-deck OP/DC references with ngspice-47')

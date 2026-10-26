"""Regenerate: spice-heavy python3 benchmarks/fixtures/issue-1821/generate.py

Requires ngspice-47. Original project-authored decks and generator, MIT.
The exact committed deck bytes are passed to both ngspice and spice-ts.
"""
import json
import os
import pathlib
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
if 'ngspice-47 ' not in version:
    raise RuntimeError('This oracle requires ngspice-47')
references = []
for level in [4, 5]:
    for polarity, sign in [('n', 1), ('p', -1)]:
        for model_temp in [27, 75]:
            for temp in [27, 75, -20]:
                name = f'b{level-3}-{polarity}-model{model_temp}-temp{temp}'
                mobility = 'MUZ=600 MUS=600 U0=0.05 N0=1.4' if level == 4 else 'MU0=600 MUS0=600 N0=1.4'
                deck = f'''BSIM circuit temperature {name}
VD supply 0 {sign * 3}
VG g 0 {sign * 2}
VB b 0 {-sign * 0.4}
RD supply d 1k
RS s 0 100
M1 d g s b MOD L=5u W=20u AD=2p AS=3p PD=6u PS=8u
.model MOD {polarity.upper()}MOS LEVEL={level} TOX=0.03 VFB=-1 PHI=0.8 K1=1.3 {mobility} JS=1e-4 PB=0.8 PBSW=0.7 CJ=1e-4 CJSW=1e-10 TEMP={model_temp}
.options TEMP={temp} RELTOL=1e-10 ABSTOL=1e-15 VNTOL=1e-12
.op
.dc VG {sign * 0.4} {sign * 2.4} {sign * 0.4}
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
                    nvars = len(variables)
                    numbers = [float(line.split()[-1]) for line in values.splitlines() if line.strip()]
                    plots['op' if 'Operating Point' in header else 'dc'] = [
                        dict(zip(variables, numbers[i:i+nvars])) for i in range(0, len(numbers), nvars)]
                references.append({'id': name, 'temperature': temp, **plots})
(HERE / 'reference.json').write_text(json.dumps({
    'ngspice': 47,
    'command': 'spice-heavy python3 benchmarks/fixtures/issue-1821/generate.py',
    'referenceCommand': 'ngspice -b -r reference.raw <id>.cir',
    'references': references,
}, indent=2) + '\n')
print(f'Generated {len(references)} identical-deck OP/DC references with ngspice-47')

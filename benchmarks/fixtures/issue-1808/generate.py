"""Regenerate: spice-heavy python3 benchmarks/fixtures/issue-1808/generate.py

Requires ngspice-47. Original project-authored decks and data, MIT.
Each committed deck is passed unchanged to both simulators.
"""
import json
import os
import pathlib
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
if 'ngspice-47 ' not in version:
    raise RuntimeError('References require ngspice-47')
references = []
for directive in ['options', 'temp']:
    for temperature in [27, 50]:
        name = f'{directive}-{temperature}'
        setting = f'.options TEMP={temperature}' if directive == 'options' else f'.temp {temperature}'
        deck = f'''Resistor instance temperature {name}
V1 in 0 5
R1 in delta 1k TC1=0.01 TC2=0.0001 DTEMP=10
R2 delta 0 2k
R3 in absolute 1k TC1=0.01 TC2=0.0001 TEMP=80
R4 absolute 0 2k
R5 in both 1k TC1=0.01 TC2=0.0001 TEMP=80 DTEMP=10
R6 both 0 2k
R7 in ambient 1k TC1=0.01 TC2=0.0001
R8 ambient 0 2k
{setting}
.op
.dc TEMP 27 73 23
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
        references.append({'id': name, **plots})
(HERE / 'reference.json').write_text(json.dumps({'ngspice': 47, 'references': references}, indent=2) + '\n')
print(f'Generated {len(references)} identical-deck OP/DC references with ngspice-47')

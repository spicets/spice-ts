#!/usr/bin/env python3
"""Check static channel against unmodified pinned b4ld C statements.
Not full-circuit/ngspice parity. Fixed shared relative limit 2e-12.
"""
from pathlib import Path
import argparse
import importlib.util
import json
import math
import os
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
args = parser.parse_args()
BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[4]
SOURCE = args.source.resolve()
spec = importlib.util.spec_from_file_location('generator', BASE / 'generate-load.py')
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert (BASE / 'load-kernel.ts').read_text() == module.generate(SOURCE)
D = SOURCE / 'src/spicelib/devices/bsim4'
source = (D / 'b4ld.c').read_text()
lines = source.splitlines(keepends=True)
body = ''.join(''.join(lines[first-1:last]) for first, last in module.RANGES)
uncommented = re.sub(r'/\*.*?\*/|//[^\n]*', '', body, flags=re.S)
model_fields = sorted(set(re.findall(r'model->BSIM4(\w+)', uncommented)))
size_fields = sorted(set(re.findall(r'pParam->BSIM4(\w+)', uncommented)))
here_fields = sorted(set(re.findall(r'here->BSIM4(\w+)', uncommented)))
table = re.sub(r'/\*.*?\*/', '', (D / 'b4.c').read_text(), flags=re.S)
setter = re.sub(r'/\*.*?\*/', '', (D / 'b4mpar.c').read_text(), flags=re.S)
entries = {}
for name, identifier in re.findall(r'\b(?:IOP\w*|IP\w*)\(\s*"([^"]+)"\s*,\s*(BSIM4_MOD_\w+)', table):
    entries.setdefault(identifier, name)
mapping = {'type': 'type', 'v48intVersion': 'v48intversion'}
setters = list(re.finditer(r'\bcase\s+(BSIM4_MOD_\w+)\s*:', setter))
for index, case in enumerate(setters):
    block = setter[case.end():setters[index+1].start() if index+1 < len(setters) else len(setter)]
    fields = [f for f in re.findall(r'mod->BSIM4(\w+)\s*=(?!=)', block) if not f.endswith('Given')]
    if fields[0] != 'type':
        mapping[fields[0]] = entries[case[1]]
with tempfile.TemporaryDirectory(prefix='bsim4-load-oracle-', dir=os.environ.get('TMPDIR', str(ROOT))) as temporary:
    tmp = Path(temporary)
    js = f'''import {{setupBsim4Model,setupBsim4Instance}} from {json.dumps(str(BASE / 'setup.ts'))};
import {{preprocessBsim4}} from {json.dumps(str(BASE / 'temp.ts'))};
import {{evaluateBsim4}} from {json.dumps(str(BASE / 'load.ts'))};
const cases=[];
for(const type of [1,-1]) for(const temperature of [300.15,360.15]) for(const nf of [1,3])
for(const extra of [{{}},{{igbmod:1,toxe:1e-9,toxref:1.2e-9,ntox:1.3}},{{igbmod:1,igcmod:1,toxe:1e-9,ngate:1e20,nigbacc:1.2,nigbinv:2.5}},{{lambda:2e-10,vtl:2e5,xn:4}},{{alpha0:0.1,alpha1:1e4,beta0:0.1,pdits:0.1,pditsd:0.2,pditsl:1e4,fprout:0.2,dvtp0:1e-8,dvtp1:0.2,dvtp2:0.01,dvtp3:0.1,dvtp4:0.2,dvtp5:0.001}}])
for(const bias of [{{vgs:-2,vds:0.7,vbs:-0.2}},{{vgs:-2,vds:-0.7,vbs:-0.9}},{{vgs:0,vds:0,vbs:0}},{{vgs:0.4,vds:0.05,vbs:-0.3}},{{vgs:1.4,vds:0.7,vbs:0.1}},{{vgs:1.8,vds:2,vbs:-0.2}},{{vgs:1,vds:-0.7,vbs:-0.5}}]) {{
 const model=setupBsim4Model({{type,...extra}});
 const instance=setupBsim4Instance(model,{{l:0.35e-6,w:2e-6*nf,nf}},{{d:1,g:2,s:0,b:3}});
 const processed=preprocessBsim4(model,instance,temperature);
 cases.push({{processed,given:[...model.given],bias,output:evaluateBsim4(processed,model.given,bias)}});
}}
console.log(JSON.stringify(cases));
'''
    (tmp / 'run.ts').write_text(js)
    data = json.loads(subprocess.check_output(['pnpm', 'exec', 'tsx', str(tmp / 'run.ts')], cwd=ROOT, text=True))
    def structure(name, fields):
        return 'typedef struct {\n' + ''.join(f'double BSIM4{f};\n' for f in fields) + '} ' + name + ';\n'
    c = source[:source.index('#include')] + '\n#include <stdio.h>\n#include <math.h>\n'
    c += ''.join(lines[33:60]) + '\n#define CHARGE 1.6021766208e-19\n'
    c += structure('Model', model_fields) + structure('Size', size_fields) + structure('Instance', here_fields)
    c += 'typedef struct { double CKTtemp; } Circuit;\n'
    c += ''.join(lines[5401:5433])
    c += 'void run(Model *model, Instance *here, Size *pParam, Circuit *ckt, double inputVgs, double inputVds, double inputVbs) {\n'
    c += '\n'.join('double ' + group + ';' for group in re.findall(r'\bdouble\s+([^;]+);', ''.join(lines[100:238])))
    c += '\nvgs=inputVgs; vds=inputVds; vbs=inputVbs; vgd=vgs-vds; vbd=vbs-vds;\n' + body
    targets = [('ids', 'cdrain'), ('gm', 'here->BSIM4gm'), ('gds', 'here->BSIM4gds'), ('gmbs', 'here->BSIM4gmbs'),
               ('isub', 'here->BSIM4csub'), ('gbgs', 'here->BSIM4gbgs'), ('gbds', 'here->BSIM4gbds'), ('gbbs', 'here->BSIM4gbbs'),
               ('igb', 'here->BSIM4Igb'), ('gigbg', 'here->BSIM4gIgbg'), ('gigbd', 'here->BSIM4gIgbd'), ('gigbb', 'here->BSIM4gIgbb')]
    c += '\nprintf("RESULT");\n'
    for _, expression in targets:
        c += f'printf("\\t%.17g", ({expression}) * here->BSIM4nf);\n'
    c += 'printf("\\n"); }\nint main(void) {\n'
    for case in data:
        c += '{ Model m={0}; Instance h={0}; Size p={0}; Circuit c={' + str(case['processed']['temperatureK']) + '};\n'
        for field in model_fields:
            if field.endswith('Given'):
                value = int(mapping[field[:-5]] in case['given'])
            else:
                value = case['processed']['model'][mapping.get(field, field)]
            c += f'm.BSIM4{field}={float(value)!r};\n'
        for obj, fields, name in [('h', here_fields, 'instance'), ('p', size_fields, 'size')]:
            for field in fields:
                # Unused dynamic output fields initialize as in native zeroed structures.
                value = case['processed'][name].get(field, 0)
                c += f'{obj}.BSIM4{field}={float(value)!r};\n'
        bias = case['bias']
        c += f'run(&m,&h,&p,&c,{bias["vgs"]},{bias["vds"]},{bias["vbs"]}); }}\n'
    c += 'return 0;}\n'
    (tmp / 'oracle.c').write_text(c)
    subprocess.run(['cc', '-O0', str(tmp / 'oracle.c'), '-o', str(tmp / 'oracle')], check=True)
    output = subprocess.check_output([str(tmp / 'oracle')], text=True)
    expected = [list(map(float, line.split('\t')[1:])) for line in output.splitlines() if line.startswith('RESULT')]
    assert len(expected) == len(data)
    maximum = 0
    checks = 0
    for index, (want, case) in enumerate(zip(expected, data)):
        for (key, _), value in zip(targets, want):
            got = case['output'][key]
            assert math.isfinite(value) and math.isfinite(got), (index, key, value, got)
            error = abs(value-got) / max(abs(value), 1e-30)
            assert error <= 2e-12, (index, key, value, got, error)
            maximum = max(maximum, error)
            checks += 1
    print(f'PASS: {len(data)} original-C cases; {checks} numeric comparisons; maximum relative error {maximum:.17g}; shared limit 2e-12')

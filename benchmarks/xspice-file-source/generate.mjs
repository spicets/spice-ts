// Self-authored MIT fixtures. Run: node benchmarks/xspice-file-source/generate.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const version = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout;
if (!version.includes('ngspice-47')) throw new Error('ngspice-47 required');
writeFileSync(join(directory, 'table.txt'), '* Time and output voltage (MIT, self-authored)\n0 1\n200u 3\n400u -1\n2m 2\n');
for (const [name, params] of [['defaults', 'amploffset=[0] amplscale=[1]'], ['scaled', 'amplscale=[2] amploffset=[-0.5] timeoffset=-50u timescale=1.5'], ['step', 'amploffset=[0] amplscale=[1] amplstep=true']]) {
  const netlist = `filesource ${name} (self-authored MIT)\na1 %v([out]) src\n.model src filesource(file="table.txt" ${params})\nr1 out 0 1k\n.tran 10u 800u\n.end\n`;
  writeFileSync(join(directory, `${name}.cir`), netlist);
  const temp = mkdtempSync(join(tmpdir(), 'file-source-'));
  try {
    writeFileSync(join(temp, 'input.cir'), netlist);
    writeFileSync(join(temp, 'table.txt'), readFileSync(join(directory, 'table.txt')));
    const control = 'oracle\n.control\nset numdgt=17\nsource input.cir\nrun\nwrdata reference.txt v(out)\nquit\n.endc\n.end\n';
    writeFileSync(join(temp, 'oracle.cir'), control);
    const result = spawnSync('ngspice', ['-b', 'oracle.cir'], { cwd: temp, encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0 || /MIF-ERROR|Error:/i.test(result.stdout + result.stderr)) throw new Error(result.stdout + result.stderr);
    writeFileSync(join(directory, `${name}.txt`), readFileSync(join(temp, 'reference.txt')));
    writeFileSync(join(directory, 'oracle.cir'), control);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
writeFileSync(join(directory, 'reference.json'), JSON.stringify({ version: version.trim(), command: 'ngspice -b oracle.cir', regenerate: 'node benchmarks/xspice-file-source/generate.mjs', machine: `${platform()} ${arch()}`, description: 'oracle.cir sources an identical copy of each committed deck as input.cir, alongside table.txt; wrdata records all ngspice transient timepoints. ngspice canonical name is filesource, not file_source.' }, null, 2) + '\n');

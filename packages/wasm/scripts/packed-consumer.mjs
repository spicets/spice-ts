import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const coreRoot = resolve(packageRoot, '../core');

const consumerRoot = mkdtempSync(join(tmpdir(), 'spice-ts-wasm-consumer-'));
const packsRoot = join(consumerRoot, 'packs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

try {
  mkdirSync(packsRoot);
  for (const root of [coreRoot, packageRoot]) {
    run('pnpm', ['pack', '--pack-destination', packsRoot], root);
  }
  const tarballs = readdirSync(packsRoot)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => join(packsRoot, name));
  if (tarballs.length !== 2) throw new Error(`Expected two package tarballs, found ${tarballs.length}`);
  const coreTarball = tarballs.find(path => basename(path).startsWith('spice-ts-core-'));

  const wasmTarball = tarballs.find(path => basename(path).startsWith('spice-ts-wasm-'));
  if (!coreTarball || !wasmTarball) throw new Error('Packed dependency set is incomplete');

  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@spice-ts/core': `file:${coreTarball}`,
      '@spice-ts/wasm': `file:${wasmTarball}`,
      ajv: '8.20.0',
    },
    pnpm: {
      overrides: {
        '@spice-ts/core': `file:${coreTarball}`,
      },
    },
  }, null, 2)}\n`);
  run('pnpm', ['install', '--ignore-workspace', '--prefer-offline'], consumerRoot);
  writeFileSync(join(consumerRoot, 'consume.mjs'), `
    import { createSpiceEngine } from '@spice-ts/wasm';
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    if (engine.capabilities.numericWasm?.kernel !== 'dense-gaussian-complex-f64-v2'
      || !engine.capabilities.analyses.includes('ac')
      || !engine.capabilities.analyses.includes('dc')) throw new Error('missing packed numeric capabilities');
    const result = await engine.simulate({
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 AC 1\\nR1 in out 1k\\nC1 out 0 1u\\n.ac lin 1 100 100' },
    }, { requestId: 'packed-wasm' });
    const analysis = result.ok ? result.data.analyses[0] : undefined;
    const output = analysis?.type === 'ac' ? analysis.voltagePhasors.out?.[0] : undefined;
    if (!result.ok || result.metadata.backend !== 'spice-ts-wasm'
      || analysis?.type !== 'ac' || !output
      || Math.abs(output.magnitude - 0.8467330159648304) > 1e-12
      || Math.abs(output.phaseDegrees - -32.141907635342065) > 1e-10) {
      throw new Error(JSON.stringify(result));
    }
    const vccs = await engine.simulate({
      apiVersion: '1',
      input: { format: 'spice', source: 'VCTRL control 0 2\\nG1 out 0 control 0 2m\\nR1 out 0 1k\\n.op' },
    }, { requestId: 'packed-wasm-vccs-op' });
    const op = vccs.ok ? vccs.data.analyses[0] : undefined;
    if (!vccs.ok || op?.type !== 'op' || op.voltagesV.out !== -4) {
      throw new Error(JSON.stringify(vccs));
    }
    const cccs = await engine.simulate({
      apiVersion: '1',
      input: { format: 'spice', source: 'VCTRL control 0 2\\nRCTRL control 0 1k\\nF1 out 0 VCTRL 3\\nRLOAD out 0 1k\\n.op' },
    }, { requestId: 'packed-wasm-cccs-op' });
    const cccsOp = cccs.ok ? cccs.data.analyses[0] : undefined;
    if (!cccs.ok || cccsOp?.type !== 'op' || cccsOp.voltagesV.out !== 6) {
      throw new Error(JSON.stringify(cccs));
    }
    const vcvs = await engine.simulate({
      apiVersion: '1',
      input: { format: 'spice', source: 'VBIAS bias 0 1\\nVCTRL control 0 3\\nVREF ref 0 -1\\nE1 out ref control bias 2\\nRLOAD out 0 1k\\n.op' },
    }, { requestId: 'packed-wasm-vcvs-op' });
    const vcvsOp = vcvs.ok ? vcvs.data.analyses[0] : undefined;
    if (!vcvs.ok || vcvs.metadata.backend !== 'spice-ts-wasm'
      || vcvsOp?.type !== 'op' || vcvsOp.voltagesV.out !== 3
      || Math.abs(vcvsOp.currentsA.E1 - -0.003) > 1e-15) {
      throw new Error(JSON.stringify(vcvs));
    }
    const ccvs = await engine.simulate({
      apiVersion: '1',
      input: { format: 'spice', source: 'VCTRL control 0 1\\nRCTRL control 0 1k\\nH1 out 0 VCTRL 2k\\nRLOAD out 0 1k\\n.op' },
    }, { requestId: 'packed-wasm-ccvs-op' });
    const ccvsOp = ccvs.ok ? ccvs.data.analyses[0] : undefined;
    if (!ccvs.ok || ccvs.metadata.backend !== 'spice-ts-wasm'
      || ccvsOp?.type !== 'op' || ccvsOp.voltagesV.out !== -2
      || Math.abs(ccvsOp.currentsA.H1 - 0.002) > 1e-15) {
      throw new Error(JSON.stringify(ccvs));
    }
    const dcResult = await engine.simulate({
      apiVersion: '1',
      input: { format: 'spice', source: 'V1 in 0 0\\nR1 in out 1k\\nR2 out 0 1k\\n.dc V1 0 1 0.5' },
    }, { requestId: 'packed-wasm-dc' });
    const dc = dcResult.ok ? dcResult.data.analyses[0] : undefined;
    if (!dcResult.ok || dcResult.metadata.backend !== 'spice-ts-wasm'
      || dc?.type !== 'dc' || dc.axis.values.join(',') !== '0,0.5,1'
      || dc.voltagesV.out.join(',') !== '0,0.25,0.5') throw new Error(JSON.stringify(dcResult));
    await engine.close();
  `);
  run('node', ['consume.mjs'], consumerRoot);
  console.log('Packed bounded WebAssembly consumer passed.');
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}

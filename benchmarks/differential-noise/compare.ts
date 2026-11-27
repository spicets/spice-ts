#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { simulate } from '../../packages/core/src/index.js';
import { assertMatchedFrequencies, metrics, readNoiseRaw, required, type NoiseData } from '../noise-raw.js';

void main();

async function main(): Promise<void> {
  const fixturePath = resolve('benchmarks/differential-noise/differential-divider.cir');
  const fixture = readFileSync(fixturePath);
  const workspace = mkdtempSync(join(tmpdir(), 'spicets-differential-noise-'));
  try {
    const rawPath = join(workspace, 'ngspice.raw');
    const ngspiceVersionOutput = execFileSync('ngspice', ['--version'], { encoding: 'utf8' });
    const ngspiceVersion = ngspiceVersionOutput.match(/ngspice-(\d+)/)?.[0]
      ?? 'ngspice (version not parsed)';
    const ngspiceStart = performance.now();
    execFileSync('ngspice', ['-b', '-r', rawPath, fixturePath], {
      encoding: 'utf8', timeout: 30_000,
    });
    const ngspiceRuntimeMilliseconds = performance.now() - ngspiceStart;
    const reference = readNoiseRaw(rawPath);

    const spiceStart = performance.now();
    const result = await simulate(fixture.toString('utf8'));
    const spiceTsRuntimeMilliseconds = performance.now() - spiceStart;
    if (!result.noise) throw new Error('spice-ts returned no noise result');
    if (result.noise.outputNode !== 'outp' || result.noise.outputReferenceNode !== 'outn') {
      throw new Error('spice-ts returned the wrong differential output identity');
    }
    const actual: NoiseData = {
      frequencies: result.noise.frequencies,
      output: result.noise.outputNoiseDensity,
      input: result.noise.inputNoiseDensity,
      integratedOutput: required(result.noise.integratedOutputNoise, 'integrated output noise'),
      integratedInput: required(result.noise.integratedInputNoise, 'integrated input noise'),
    };
    assertMatchedFrequencies(actual.frequencies, reference.frequencies);
    const unsupported = await verifyUnsupportedForms();
    const diode = await compareDiode(workspace);

    const report = JSON.stringify({
      fixture: 'benchmarks/differential-noise/differential-divider.cir',
      sha256: createHash('sha256').update(fixture).digest('hex'),
      source: {
        url: 'https://github.com/mfiumara/spice-ts/issues/255',
        revision: 'issue-255 project-authored reference fixture as of 2026-10-10',
        licence: 'MIT',
      },
      identicalNetlistForBothEngines: true,
      commands: {
        ngspice: 'ngspice -b -r <temporary-raw-path> benchmarks/differential-noise/differential-divider.cir',
        spiceTs: 'pnpm bench:differential-noise',
      },
      versions: {
        reference: ngspiceVersion,
        spiceTsBaseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        spiceTsWorkingTreeDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
        node: process.version,
      },
      machine: {
        platform: platform(), release: release(), architecture: process.arch,
        cpu: cpus()[0]?.model ?? 'unknown',
      },
      convergence: { ngspice: 'success', spiceTs: 'success' },
      runtimeMilliseconds: {
        ngspiceProcess: ngspiceRuntimeMilliseconds,
        spiceTsInProcess: spiceTsRuntimeMilliseconds,
        caveat: 'Different process boundaries; reported honestly, not a speed claim.',
      },
      matchedPointCount: reference.frequencies.length,
      errors: {
        outputDensity: metrics(actual.output, reference.output),
        inputDensity: metrics(actual.input, reference.input),
        integratedOutput: metrics([actual.integratedOutput], [reference.integratedOutput]),
        integratedInput: metrics([actual.integratedInput], [reference.integratedInput]),
      },
      unsupported,
      diode,
      exclusions: [
        'Current-valued noise outputs remain unsupported; current-source input referral is covered by benchmarks/current-source-noise (#314).',
        'Differential output with BJT, JFET, MOS1, BSIM3, or broader noisy device forms remains unsupported; diodes with RS > 0 remain unsupported.',
        'Stepped noise remains unsupported; resistor noise follows circuit temperature.',
      ],
      losses: [
        'Every non-zero residual is retained in errors; no tolerance or circuit value is tuned per engine.',
        'The bounded differential form covers resistor and ideal-diode noise only.',
        'Runtime values are not directly comparable because ngspice includes process startup.',
      ],
      redReceipt: 'Remediation RED: focused noise test 1 failed, 47 passed; the reviewer NJF deck unexpectedly returned 7 points and outputNoiseDensity[0]=5.028812192176008e-9.',
      potetoModeReceipt: 'benchmarks/differential-noise/POTETO.md records the traced flow, considered designs, chosen explicit noisy-semiconductor guard, TDD sequence, benchmark checkpoint, and scope bounds.',
    }, null, 2);

    const outputIndex = process.argv.indexOf('--output');
    if (outputIndex >= 0) {
      const outputPath = process.argv[outputIndex + 1];
      if (!outputPath) throw new Error('--output requires a path');
      writeFileSync(resolve(outputPath), `${report}\n`);
    }
    console.log(report);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function compareDiode(workspace: string): Promise<object> {
  // This is the exact original MIT deck documented in diode-differential-noise.md.
  const deck = `* MIT original differential diode noise #2212
V1 in 0 DC 1 AC 1
R1 in outp 1k
R2 outn 0 1k
D1 outp outn DMOD
.model DMOD D(IS=1e-14 N=1 KF=1e-10 AF=1)
.noise v(outp,outn) V1 dec 3 100 10k
.end
`;
  const path = join(workspace, 'diode.cir');
  const raw = join(workspace, 'diode.raw');
  writeFileSync(path, deck);
  execFileSync('ngspice', ['-b', '-r', raw, path], { encoding: 'utf8', timeout: 30_000 });
  const reference = readNoiseRaw(raw);
  const result = await simulate(deck);
  if (!result.noise) throw new Error('spice-ts returned no diode noise result');
  assertMatchedFrequencies(result.noise.frequencies, reference.frequencies);
  const normalizedMetrics = (actual: number[], expected: number[]): object => ({
    ...metrics(actual, expected),
    normalizedMaximumError: Math.max(...actual.map((value, index) => Math.abs(value - expected[index])))
      / Math.max(1e-12, ...expected.map(Math.abs)),
  });
  return {
    sha256: createHash('sha256').update(deck).digest('hex'),
    identicalNetlistForBothEngines: true,
    matchedPointCount: reference.frequencies.length,
    errors: {
      outputDensity: normalizedMetrics(result.noise.outputNoiseDensity, reference.output),
      inputDensity: normalizedMetrics(result.noise.inputNoiseDensity, reference.input),
      integratedOutput: normalizedMetrics([required(result.noise.integratedOutputNoise, 'integrated output noise')], [reference.integratedOutput]),
      integratedInput: normalizedMetrics([required(result.noise.integratedInputNoise, 'integrated input noise')], [reference.integratedInput]),
    },
  };
}

async function verifyUnsupportedForms(): Promise<Array<{ form: string; status: string; error: string }>> {
  const cases = [
    {
      form: 'current output',
      deck: 'V1 in 0 AC 1\nR1 in 0 1k\n.noise i(V1) V1 dec 3 100 10k',
      expected: /Unsupported \.noise form/,
    },
    {
      form: 'stepped noise',
      deck: 'V1 in 0 AC 1\nR1 in 0 1k\n.noise v(in) V1 dec 3 100 10k\n.step param R1 list 1k 2k',
      expected: /\.step cannot be combined with \.noise/,
    },
    ...[
      {
        kind: 'BJT',
        body: 'Q1 outp in outn QMOD\n.model QMOD NPN (LEVEL=1 IS=1e-14 BF=100)',
      },
      {
        kind: 'MOS1',
        body: 'M1 outp in outn outn MMOD\n.model MMOD NMOS (LEVEL=1 VTO=0.7 KP=200u)',
      },
      {
        kind: 'JFET',
        body: 'J1 outp in outn JMOD\n.model JMOD NJF (LEVEL=1 BETA=2.69e-5 VTO=-3.795 LAMBDA=0.0181 AF=1 KF=0.05)',
      },
    ].map(({ kind, body }) => ({
      form: `differential ${kind} noise`,
      deck: `V1 in 0 DC 1 AC 1\nR1 in outp 1k\nR2 outn 0 1k\n${body}\n.noise v(outp,outn) V1 dec 3 100 10k`,
      expected: /differential voltage output only supports resistor noise/,
    })),
    {
      form: 'differential BSIM3 noise',
      deck: 'V1 in 0 DC 1 AC 1\nR1 in outp 1k\nR2 outn 0 1k\nM1 outp in outn outn MMOD\n.model MMOD NMOS (LEVEL=49 VTH0=1 U0=400 TOX=4n)\n.noise v(outp,outn) V1 dec 3 100 10k',
      expected: /differential voltage output only supports resistor noise/,
    },
  ];
  const results = [];
  for (const testCase of cases) {
    try {
      // The first SPICE line is the title; without one the first element card is dropped.
      await simulate(`* ${testCase.form}\n${testCase.deck}`);
      throw new Error(`${testCase.form} unexpectedly succeeded`);
    } catch (error) {
      const message = (error as Error).message;
      if (!testCase.expected.test(message)) throw error;
      results.push({ form: testCase.form, status: 'explicitly rejected', error: message });
    }
  }
  return results;
}

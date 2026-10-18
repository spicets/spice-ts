#!/usr/bin/env tsx
/** Run through spice-heavy: identical decks, ngspice-47 print-all source spectra. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate } from '../../packages/core/src/simulate.js';

function parseVectors(stdout: string): Record<string, number[]> {
  const vectors: Record<string, number[]> = {};
  let columns: string[] = [];
  for (const line of stdout.split('\n')) {
    if (/^Index\s+frequency/.test(line)) columns = line.trim().split(/\s+/).slice(1);
    else if (/^\d+\s/.test(line)) {
      const [point, ...row] = line.trim().split(/\s+/).map(Number);
      columns.forEach((column, index) => { (vectors[column] ??= [])[point] = row[index]; });
    }
  }
  return vectors;
}

async function main(): Promise<void> {
  if (!execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).includes('ngspice-47')) {
    throw new Error('This reference requires ngspice-47');
  }
  const decks = ['unsupported', 'flicker', 'pchan', 'self-heating', 'self-heating-inverse-n', 'self-heating-inverse-p'];
  const update = process.argv.includes('--update');
  const cases = [];
  for (const name of decks) {
    const path = fileURLToPath(new URL(`${name}.cir`, import.meta.url));
    const deck = readFileSync(path, 'utf8');
    const stdout = execFileSync('ngspice', ['-b', path], { encoding: 'utf8' });
    const vectors = parseVectors(stdout);
    if (!vectors.onoise_spectrum?.length || !vectors.inoise_spectrum?.length
      || Object.values(vectors).some(values => values.length !== vectors.frequency?.length || values.some(v => !Number.isFinite(v)))) {
      throw new Error(`ngspice did not produce complete finite noise spectra for ${name}`);
    }
    let ac: Record<string, number[]> | undefined;
    const acDeck = deck.slice(0, deck.indexOf('.noise')) + '.ac dec 1 1 1meg\n.end\n';
    if (name.startsWith('self-heating')) {
      const directory = mkdtempSync(join(tmpdir(), 'vdmos-ac-'));
      try {
        const path = join(directory, 'ac.cir');
        writeFileSync(path, acDeck.replace('.end\n', '.control\nrun\nset numdgt=16\nprint vr(out) vi(out)\n.endc\n.end\n'));
        ac = parseVectors(execFileSync('ngspice', ['-b', path], { encoding: 'utf8' }));
      } finally { rmSync(directory, { recursive: true }); }
      if (ac.frequency?.length !== vectors.frequency.length || !ac['vr(out)'] || !ac['vi(out)']
        || Object.values(ac).some(values => values.length !== vectors.frequency.length || values.some(v => !Number.isFinite(v)))) throw new Error('Incomplete AC reference');
    }
    cases.push({ name, vectors, ...(ac ? { ac } : {}) });
    if (!update) {
      const result = (await simulate(deck)).noise!;
      const output = result.outputNoiseDensity;
      const input = result.inputNoiseDensity;
      if (output.length !== vectors.frequency.length || input.length !== vectors.frequency.length) {
        throw new Error(`${name}: point count mismatch`);
      }
      const maxRelative = Math.max(...output.map((value, i) => Math.abs(value / vectors.onoise_spectrum[i] - 1)),
        ...input.map((value, i) => Math.abs(value / vectors.inoise_spectrum[i] - 1)));
      console.log(JSON.stringify({ name, frequencies: result.frequencies, ngspiceOutput: vectors.onoise_spectrum,
        output, ngspiceInput: vectors.inoise_spectrum, input, maxRelative }));
      if (!Number.isFinite(maxRelative) || maxRelative > 1e-4) throw new Error(`${name}: noise parity exceeds 0.01%`);
      if (ac) {
        const result = (await simulate(acDeck)).ac!;
        const actual = result.voltage('out').map(v => [v.magnitude * Math.cos(v.phase * Math.PI / 180), v.magnitude * Math.sin(v.phase * Math.PI / 180)]);
        const maxRelative = Math.max(...actual.map(([re, im], i) => Math.hypot(re - ac['vr(out)'][i], im - ac['vi(out)'][i]) / Math.hypot(ac['vr(out)'][i], ac['vi(out)'][i])));
        console.log(JSON.stringify({ name, acReference: ac, acActual: actual, maxRelative }));
        if (!Number.isFinite(maxRelative) || maxRelative > 1e-4) throw new Error('AC parity exceeds 0.01%');
      }
    }
  }
  if (update) {
    writeFileSync(new URL('reference.json', import.meta.url), `${JSON.stringify({ engine: 'ngspice-47', cases }, null, 2)}\n`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

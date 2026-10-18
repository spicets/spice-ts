import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from '../../packages/mcp/src/server.js';

const deck = fileURLToPath(new URL('../../packages/mcp/fixtures/sensitivity-divider.cir', import.meta.url));
const source = readFileSync(deck, 'utf8');
assert.match(execFileSync('ngspice', ['--version'], { encoding: 'utf8' }), /ngspice-47\b/);
const dir = mkdtempSync(join(tmpdir(), 'mcp-sensitivity-'));
try {
  const rawPath = join(dir, 'divider.raw');
  execFileSync('ngspice', ['-n', '-b', '-r', rawPath, deck], {
    encoding: 'utf8', env: { ...process.env, SPICE_ASCIIRAWFILE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const raw = readFileSync(rawPath, 'utf8');
  assert.match(raw, /^Flags: real$/m);
  assert.match(raw, /^No\. Points:\s*1\s*$/m);
  const [header, values] = raw.split('Values:\n');
  const names = header!.split('Variables:\n')[1]!.trim().split('\n').map(l => l.trim().split(/\s+/)[1]!);
  const scalars = values!.trim().split('\n').map(l => Number(l.trim().split(/\s+/).at(-1)));
  assert.equal(names.length, scalars.length);
  const response = await executeTool('spice_sensitivity', { netlist: source, output: 'v(out)' });
  assert.ok(!response.isError, JSON.stringify(response.structuredContent));
  const { entries } = response.structuredContent as { entries: {
    device: string; parameter: string; absolute: number; normalised: number; value: number;
  }[] };
  const comparisons = entries.map(e => {
    const suffix = e.parameter === 'multiplier' ? '_m' : e.parameter === 'scale' ? '_scale' : '';
    const vector = `v(${e.device.toLowerCase()}${suffix})`;
    const index = names.indexOf(vector);
    assert.ok(index >= 0, `Missing ${vector}`);
    const ngspice = scalars[index]!;
    assert.ok(Number.isFinite(ngspice));
    const absoluteError = Math.abs(e.absolute - ngspice);
    const relativeError = ngspice === 0 ? absoluteError : absoluteError / Math.abs(ngspice);
    return { device: e.device, parameter: e.parameter, ngspice, spiceTs: e.absolute,
      normalised: e.normalised, absoluteError, relativeError };
  });
  const maxAbsoluteError = Math.max(...comparisons.map(c => c.absoluteError));
  const maxRelativeError = Math.max(...comparisons.map(c => c.relativeError));
  console.log(JSON.stringify({ reference: 'ngspice-47 .sens', deckSha256: createHash('sha256').update(source).digest('hex'),
    comparisons, maxAbsoluteError, maxRelativeError, tolerance: '1e-5 relative (one-sided vs symmetric finite differences)' }, null, 2));
  // Same tolerance as the existing core sensitivity parity suite, not circuit tuning.
  assert.ok(maxRelativeError < 1e-5);
} finally { rmSync(dir, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '../../packages/mcp/src/server.js';

// Original MIT fixture. Both engines receive identical elements and AC sweep.
// ngspice's control block only observes that sweep; no solver options change.
const source = readFileSync(new URL('./two-pole.cir', import.meta.url), 'utf8');
const version = execFileSync('ngspice', ['--version'], { encoding: 'utf8' });
assert.match(version, /ngspice-47\b/, 'Parity reference requires ngspice-47');
const dir = mkdtempSync(join(tmpdir(), 'mcp-ac-metrics-'));
try {
  const deck = join(dir, 'two-pole.cir');
  writeFileSync(deck, source.replace('.end', () => `.control
run
let phase = 180 / pi * cph(v(out))
meas ac ugf when vdb(out)=0 fall=1
meas ac phase_at_ugf find phase at=$&ugf
quit
.endc
.end`));
  const log = execFileSync('ngspice', ['-b', deck], { encoding: 'utf8' });
  const measured = (name: string) => {
    const match = log.match(new RegExp(`^${name}\\s*=\\s*([-+0-9.eE]+)`, 'm'));
    assert.ok(match, `Missing ngspice .meas ac ${name}: ${log}`);
    const value = Number(match[1]);
    assert.ok(Number.isFinite(value));
    return value;
  };
  const reference = { unityGainHz: measured('ugf'), phaseMarginDeg: 180 + measured('phase_at_ugf') };
  const response = await executeTool('spice_ac_metrics', {
    request: { apiVersion: '1', input: { format: 'spice', source } }, output: 'out', input: 'in',
  });
  assert.ok(!response.isError, JSON.stringify(response.structuredContent));
  const actual = response.structuredContent as { unityGainHz: number; phaseMarginDeg: number };
  const unityRelativeError = Math.abs(actual.unityGainHz / reference.unityGainHz - 1);
  const phaseAbsoluteErrorDeg = Math.abs(actual.phaseMarginDeg - reference.phaseMarginDeg);
  console.log(JSON.stringify({ reference: 'ngspice-47 .meas ac', ngspice: reference, spiceTs: actual,
    unityRelativeError, phaseAbsoluteErrorDeg }, null, 2));
  // ngspice uses linear-frequency crossing interpolation; MCP uses log-frequency.
  assert.ok(unityRelativeError < 0.005, 'UGF error must be below 0.5%');
  assert.ok(phaseAbsoluteErrorDeg < 0.5, 'Phase margin error must be below 0.5 degrees');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

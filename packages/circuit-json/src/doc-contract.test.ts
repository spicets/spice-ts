import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CircuitJson } from 'circuit-json';
import type { CircuitIR } from '@spice-ts/core';
import { fromCircuitJSON, toCircuitJSON } from './index.js';
import type { ConversionDiagnosticV1 } from './index.js';

// Pins docs/architecture/ai-native-api.md to the shipped adapter contract (#514):
// circuit-json conversion runs client-side and reports unsupported content as
// ConversionResultV1 diagnostics (UNSUPPORTED_ELEMENT / UNSUPPORTED_PARAMETER)
// with no value, never as the API error code UNSUPPORTED_FEATURE.

const doc = readFileSync(new URL('../../../docs/architecture/ai-native-api.md', import.meta.url), 'utf8');

const component = (id: string, ftype: string, fields: Record<string, unknown>): Record<string, unknown> => ({
  type: 'source_component', ftype, source_component_id: id, name: id, ...fields,
});

function section(heading: string): string {
  const start = doc.indexOf(heading);
  expect(start, `missing doc heading ${heading}`).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('\n#', start + heading.length);
  return doc.slice(start, next === -1 ? undefined : next);
}

function emittedCodes(): Set<ConversionDiagnosticV1['code']> {
  const lossyIR: CircuitIR = {
    components: [{ type: 'I', id: 'I1', name: 'I1', ports: [{ name: 'p', net: 'a' }, { name: 'n', net: '0' }], params: { waveform: 'sine', dc: 1 } }],
    nets: ['a'],
  };
  const results = [
    fromCircuitJSON([component('X1', 'simple_chip', {})] as CircuitJson),
    fromCircuitJSON([component('R1', 'simple_resistor', { resistance: 1, temperature_coefficient: 1e-3 })] as CircuitJson),
    fromCircuitJSON([{ type: 'pcb_text', pcb_text_id: 't', text: 'T', anchor_position: { x: 0, y: 0 }, anchor_alignment: 'center', font_size: 1, layer: 'top', rotation: 0 }] as unknown as CircuitJson),
    toCircuitJSON(lossyIR),
  ];
  return new Set(results.flatMap((result) => result.diagnostics.map((diagnostic) => diagnostic.code)));
}

describe('ai-native-api doc matches the circuit-json adapter contract (#514)', () => {
  it('documents the new mappings and their model/schema limits (#1664)', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const [ftype, fields] of [
      ['simple_inductor', { inductance: 1e-3 }],
      ['simple_diode', {}],
      ['simple_led', {}],
      ['simple_voltage_source', { voltage: 5 }],
      ['simple_voltage_source', { voltage: 1, wave_shape: 'square', peak_to_peak_voltage: 4, frequency: 1000 }],
      ['simple_current_source', { current: 0.001, wave_shape: 'dc' }],
    ] as const) {
      expect(readme).toContain(ftype);
      expect(fromCircuitJSON([component('device', ftype, fields)] as CircuitJson).diagnostics).toEqual([]);
    }
    expect(readme).toContain('IS=1e-14 A, N=1');
    expect(readme).toContain('no voltage');
    expect(readme).toContain('## Square voltage sources');
    expect(readme).toContain('PER * 1e-6');
    expect(readme).toContain('phase / 360 * PER');
    expect(readme).toContain('LED color/wavelength');
  });

  it('adapter rejects unsupported simulation elements with UNSUPPORTED_ELEMENT and no value', () => {
    const result = fromCircuitJSON([component('X1', 'simple_chip', {})] as CircuitJson);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((d) => [d.severity, d.code, d.simulationRelevant])).toEqual([['error', 'UNSUPPORTED_ELEMENT', true]]);
    expect(emittedCodes()).toEqual(new Set(['UNSUPPORTED_ELEMENT', 'UNSUPPORTED_PARAMETER', 'LAYOUT_ONLY', 'LOSSY_EXPORT']));
    expect(emittedCodes().has('UNSUPPORTED_FEATURE' as ConversionDiagnosticV1['code'])).toBe(false);
  });

  it('section 3 describes adapter diagnostics, not API UNSUPPORTED_FEATURE', () => {
    const paragraph = doc.split('\n').find((line) => line.startsWith('A `circuit-json` input is validated and converted by #35'));
    expect(paragraph).toBeDefined();
    expect(paragraph).not.toContain('UNSUPPORTED_FEATURE` diagnostics');
    expect(paragraph).toContain('`UNSUPPORTED_ELEMENT`');
    expect(paragraph).toContain('`UNSUPPORTED_PARAMETER`');
  });

  it('Workflow B step 2 names the codes the adapter actually emits', () => {
    const workflow = section('### Workflow B');
    const step2 = workflow.split('\n').find((line) => line.startsWith('2. '));
    expect(step2).toBeDefined();
    expect(step2).not.toContain('UNSUPPORTED_FEATURE');
    expect(step2).toContain('`UNSUPPORTED_ELEMENT`');
    for (const code of step2!.match(/`[A-Z_]+`/g) ?? []) {
      expect(emittedCodes().has(code.slice(1, -1) as ConversionDiagnosticV1['code']), code).toBe(true);
    }
  });
});

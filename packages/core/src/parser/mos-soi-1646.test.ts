import { describe, expect, it } from 'vitest';
import { parse, parseAsync } from './index.js';

const deck = (nodes: string, nested: boolean, globalModel = false) => `* B3SOI diagnostic regression #1646
${nested ? '.subckt inv d g s\n' : ''}M1 ${nodes} CMOSN W=2u L=1u
${globalModel ? '' : '.model CMOSN NMOS (LEVEL=10)'}
${nested ? '.ends inv\nXINV1 d g 0 inv' : ''}
${globalModel ? '.model CMOSN NMOS (LEVEL=10)' : ''}
.op
.end`;

describe('unsupported B3SOI instance diagnostics (#1646)', () => {
  it.each([
    ['d g 0 0', false],
    ['d g 0 0 0', false],
    ['d g s s', true],
    ['d g s s s', true],
  ])('preserves the model for %s (subcircuit=%s)', async (nodes, nested) => {
    for (const circuit of [parse(deck(nodes, nested)), await parseAsync(deck(nodes, nested))]) {
      expect(() => circuit.compile()).toThrow(expect.objectContaining({
        code: 'UNSUPPORTED_MODEL_LEVEL',
        deviceName: nested ? 'XINV1.M1' : 'M1',
        modelName: nested ? 'XINV1:CMOSN' : 'CMOSN',
        level: 10,
      }));
    }
  });

  it('resolves a top-level model declared after the subcircuit call', () => {
    expect(() => parse(deck('d g s s s', true, true)).compile()).toThrow(expect.objectContaining({
      code: 'UNSUPPORTED_MODEL_LEVEL', deviceName: 'XINV1.M1', modelName: 'CMOSN', level: 10,
    }));
  });
});

import { describe, expect, it } from 'vitest';
import { parseTitleless as parse } from './index.js';
import { TransmissionLine } from '../devices/transmission-line.js';

describe('lossless transmission-line parser', () => {
  it.each(['IC=1,20m,1,20m', 'IC = 1 20m 1 20m'])('parses four port initial conditions: %s', ic => {
    const line = parse(`T1 in 0 out 0 ${ic} Z0=50 TD=1n`).compile().devices[0];
    expect(line).toMatchObject({ initialConditions: [1, 0.02, 1, 0.02] });
  });

  it.each(['IC=', 'IC=1,0,1', 'IC=1,0,1,0,2', 'IC=1,0,1,0 IC=0,0,0,0'])
    ('reports a structured parse error for %s', ic => {
      expect(() => parse(`T1 in 0 out 0 Z0=50 TD=1n ${ic}`)).toThrowError(
        expect.objectContaining({ name: 'ParseError', line: 1, context: expect.stringContaining('T1') }),
      );
    });
  it('parses the bounded Z0/TD T-card form', () => {
    const compiled = parse('T1 in 0 out 0 Z0=50 TD=5n\n.tran 50p 20n').compile();
    const line = compiled.devices[0];

    expect(line).toBeInstanceOf(TransmissionLine);
    expect(line).toMatchObject({ name: 'T1', impedance: 50, delay: 5e-9 });
    expect(compiled.branchNames).toEqual(['T1:1', 'T1:2']);
  });

  it.each([
    ['absolute tolerance', 'T1 in 0 out 0 Z0=50 TD=5n ABS=1'],
    ['unknown parameters', 'T1 in 0 out 0 Z0=50 TD=5n REL=1'],
    ['non-positive frequency', 'T1 in 0 out 0 Z0=50 F=0'],
    ['non-positive length', 'T1 in 0 out 0 Z0=50 NL=-1'],
    ['duplicate frequency', 'T1 in 0 out 0 Z0=50 F=1g F=2g'],
    ['non-positive impedance', 'T1 in 0 out 0 Z0=0 TD=5n'],
  ])('rejects unsupported %s explicitly', (_label, card) => {
    expect(() => parse(`${card}\n.tran 50p 20n`)).toThrow(/unsupported lossless transmission line|positive Z0 and TD/i);
  });

  it.each([
    ['F=10meg NL=.25', 25e-9],
    ['F=50meg', 5e-9],
    ['NL=10', 10e-9],
    ['', 0.25e-9],
    ['TD=5n F=1g NL=10', 5e-9],
    ['NL=10 F=1g TD=5n', 5e-9],
  ])('resolves ngspice defaults and TD precedence for %s', (parameters, delay) => {
    const line = parse(`T1 in 0 out 0 Z0=50 ${parameters}\n.tran 50p 20n`).compile().devices[0];
    expect(line).toMatchObject({ impedance: 50, delay });
  });

  it('parses the benchmark-bounded common-reference O/LTRA form', () => {
    const compiled = parse([
      'O1 in 0 out 0 LMOD',
      '.model LMOD LTRA(R=1 L=1n G=0 C=1p LEN=1 STEPLIMIT REL=1 COMPACTREL=1e-3 COMPACTABS=1e-14)',
      '.tran 1n 10n',
    ].join('\n')).compile();

    expect(compiled.devices.map(device => device.name)).toEqual(['O1']);
    expect(compiled.branchNames).toEqual(['O1:1', 'O1:2']);
  });

  it.each([
    ['different reference nodes', 'O1 in ref out 0 LMOD', '.model LMOD LTRA(R=1 L=1n C=1p LEN=1)'],
    ['nonzero shunt conductance', 'O1 in 0 out 0 LMOD', '.model LMOD LTRA(R=1 L=1n G=1u C=1p LEN=1)'],
    ['unknown model parameter', 'O1 in 0 out 0 LMOD', '.model LMOD LTRA(R=1 L=1n C=1p LEN=1 FOO=2)'],
    ['instance parameter', 'O1 in 0 out 0 LMOD IC=0', '.model LMOD LTRA(R=1 L=1n C=1p LEN=1)'],
  ])('rejects unsupported lossy %s explicitly', (_label, card, model) => {
    expect(() => parse(`${card}\n${model}\n.tran 1n 10n`).compile())
      .toThrow(/unsupported LTRA|common reference|parameter/i);
  });
});

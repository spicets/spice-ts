// packages/core/src/errors.test.ts
import { describe, it, expect } from 'vitest';
import {
  SpiceError,
  ParseError,
  InvalidCircuitError,
  SingularMatrixError,
  ConvergenceError,
  TimestepTooSmallError,
  CycleError,
  UnsupportedModelLevelError,
  UnsupportedModelVersionError,
  UnsupportedCircuitModelTypeError,
  ModelTypeMismatchError,
  UnsupportedModelParameterError,
  UnsupportedTemperatureError,
  UnsupportedMultiplicityError,
} from './errors.js';

describe('stable machine-readable error codes', () => {
  it.each([
    [new SpiceError('failure'), 'SPICE_ERROR'],
    [new ParseError('syntax', 2, 'bad'), 'PARSE_ERROR'],
    [new InvalidCircuitError('invalid'), 'INVALID_CIRCUIT'],
    [new SingularMatrixError('zero pivot', ['out']), 'SINGULAR_MATRIX'],
    [new ConvergenceError('iterations', undefined, [], new Float64Array(0), new Float64Array(0)), 'CONVERGENCE_FAILED'],
    [new TimestepTooSmallError(1, 1e-18), 'TIMESTEP_TOO_SMALL'],
    [new CycleError(['a', 'a']), 'CYCLE'],
    [new UnsupportedModelLevelError('M1', 'n', 7, [1]), 'UNSUPPORTED_MODEL_LEVEL'],
    [new UnsupportedModelVersionError('M1', 'n', 8, '3.0', ['3.3']), 'UNSUPPORTED_MODEL_VERSION'],
    [new UnsupportedCircuitModelTypeError('n', 'unknown', ['NMOS']), 'UNSUPPORTED_MODEL_TYPE'],
    [new ModelTypeMismatchError('M1', 'M', 'n', 'NPN', ['NMOS']), 'MODEL_TYPE_MISMATCH'],
    [new UnsupportedModelParameterError('D1', 'RSW', 'not implemented'), 'UNSUPPORTED_MODEL_PARAMETER'],
    [new UnsupportedTemperatureError('D1', 50), 'UNSUPPORTED_TEMPERATURE'],
    [new UnsupportedMultiplicityError('x1.g1', 'G', 'x1', 2), 'UNSUPPORTED_MULTIPLICITY'],
  ] as const)('%s exposes %s through SpiceError', (error, code) => {
    expect(error).toBeInstanceOf(SpiceError);
    expect(error).toBeInstanceOf(Error);
    const base: SpiceError = error;
    expect(base.code).toBe(code);
  });
});

describe('SpiceError hierarchy', () => {
  it('ParseError includes line and context', () => {
    const err = new ParseError('unknown device', 5, 'X1 1 2 mystery');
    expect(err).toBeInstanceOf(SpiceError);
    expect(err).toBeInstanceOf(ParseError);
    expect(err.line).toBe(5);
    expect(err.context).toBe('X1 1 2 mystery');
    expect(err.message).toContain('line 5');
    expect(err.message).toContain('unknown device');
  });

  it('ConvergenceError includes time and oscillating nodes', () => {
    const last = new Float64Array([1, 2]);
    const prev = new Float64Array([1.5, 2.5]);
    const err = new ConvergenceError('max iterations', 1e-6, ['3', '4'], last, prev);
    expect(err).toBeInstanceOf(SpiceError);
    expect(err.time).toBe(1e-6);
    expect(err.oscillatingNodes).toEqual(['3', '4']);
    expect(err.lastSolution).toBe(last);
    expect(err.message).toContain('t=');
  });

  it('SingularMatrixError includes structural matrix identity', () => {
    const err = new SingularMatrixError('floating node', ['5'], ['V1'], 2);
    expect(err).toBeInstanceOf(SpiceError);
    expect(err.involvedNodes).toEqual(['5']);
    expect(err.involvedBranches).toEqual(['V1']);
    expect(err.pivotIndex).toBe(2);
    expect(err.message).toContain('floating node');
  });

  it('TimestepTooSmallError includes time and dt', () => {
    const err = new TimestepTooSmallError(1e-3, 1e-18);
    expect(err).toBeInstanceOf(SpiceError);
    expect(err.time).toBe(1e-3);
    expect(err.timestep).toBe(1e-18);
  });

  it('InvalidCircuitError is a SpiceError', () => {
    const err = new InvalidCircuitError('no ground node');
    expect(err).toBeInstanceOf(SpiceError);
    expect(err.message).toBe('no ground node');
  });
});

describe('CycleError', () => {
  it('formats the dependency chain', () => {
    const err = new CycleError(['a.lib', 'b.lib', 'a.lib']);
    expect(err.name).toBe('CycleError');
    expect(err.message).toBe('Circular dependency detected: a.lib → b.lib → a.lib');
    expect(err.chain).toEqual(['a.lib', 'b.lib', 'a.lib']);
    expect(err).toBeInstanceOf(SpiceError);
  });
});

describe('ConvergenceError (extended)', () => {
  it('carries a kind discriminator', () => {
    const err = new ConvergenceError(
      'NR failed', 1e-9, ['n1'], new Float64Array([1]), new Float64Array([0]),
      'nr-divergence', 1e-12, 1e-8,
    );
    expect(err.kind).toBe('nr-divergence');
    expect(err.dt).toBe(1e-12);
    expect(err.gmin).toBe(1e-8);
  });

  it('defaults kind to nr-divergence when omitted', () => {
    const err = new ConvergenceError(
      'm', 0, [], new Float64Array(0), new Float64Array(0),
    );
    expect(err.kind).toBe('nr-divergence');
  });
});

describe('TimestepTooSmallError (now extends ConvergenceError)', () => {
  it('is instanceof ConvergenceError', () => {
    const err = new TimestepTooSmallError(1e-9, 1e-18);
    expect(err).toBeInstanceOf(ConvergenceError);
    expect(err).toBeInstanceOf(TimestepTooSmallError);
  });

  it('has kind=dt-floor and preserves timestep getter', () => {
    const err = new TimestepTooSmallError(1e-9, 1e-18);
    expect(err.kind).toBe('dt-floor');
    expect(err.timestep).toBe(1e-18);
    expect(err.time).toBe(1e-9);
    expect(err.dt).toBe(1e-18);
  });
});

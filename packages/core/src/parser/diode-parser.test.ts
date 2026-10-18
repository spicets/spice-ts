import { describe, expect, it } from 'vitest';
import { diodeModelIndex, parseDiodeInstanceParams } from './diode-parser.js';

describe('parseDiodeInstanceParams', () => {
  it.each(['1N4148', '2N_model'])('does not confuse thermal model %s with positional AREA', model => {
    expect(diodeModelIndex(['D1', '1', '0', 'tj', model, 'thermal'])).toBe(4);
  });

  it.each(['2', '.5', '1e-3', '2m', '2meg'])('keeps ordinary positional AREA %s after the model', area => {
    expect(diodeModelIndex(['D1', '1', '0', 'DM', area])).toBe(3);
  });

  it('accepts positional AREA plus named PJ and M geometry', () => {
    expect(parseDiodeInstanceParams(['D1', '1', '0', 'DMOD', '2', 'PJ=3', 'M=4'], 4))
      .toEqual({ AREA: 2, PJ: 3, M: 4 });
  });

  it.each(['OFF', 'IC=0.2', 'TEMP=50', 'DTEMP=5', 'UNKNOWN=1'])(
    'rejects unsupported trailing field %s',
    field => {
      expect(() => parseDiodeInstanceParams(['D1', '1', '0', 'DMOD', field], 4))
        .toThrow(`Unsupported diode parameter: '${field}'`);
    },
  );

  it('recognizes the optional thermal node and thermal flag (#1261)', () => {
    const tokens = ['D1', '1', '0', 'tj', 'dmod', 'thermal'];
    expect(diodeModelIndex(tokens)).toBe(4);
    expect(parseDiodeInstanceParams(tokens, 5)).toEqual({ THERMAL: 1 });
    expect(diodeModelIndex(['D1', '1', '0', 'dmod', 'thermal'])).toBe(3);
  });

  it('validates geometry domains', () => {
    expect(() => parseDiodeInstanceParams(['D1', '1', '0', 'DMOD', 'AREA=0'], 4))
      .toThrow('Diode AREA must be greater than zero');
    expect(() => parseDiodeInstanceParams(['D1', '1', '0', 'DMOD', 'PJ=-1'], 4))
      .toThrow('Diode PJ must be non-negative');
    expect(() => parseDiodeInstanceParams(['D1', '1', '0', 'DMOD', 'M=0'], 4))
      .toThrow('Diode M must be greater than zero');
  });
});

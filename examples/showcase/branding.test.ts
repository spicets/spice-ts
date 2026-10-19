import { describe, expect, it } from 'vitest';
import { plotTheme, traceColors, tracePalette } from './branding.js';

describe('Bode showcase branding', () => {
  it('uses the landing identity and self-hosted typography in both plot themes', () => {
    expect(plotTheme('dark').background).toBe('#18191D');
    expect(plotTheme('dark').text).toBe('#F5F1EA');
    expect(plotTheme('light').background).toBe('#F5F1EA');
    expect(plotTheme('light').text).toBe('#121317');
    expect(plotTheme('dark').font).toContain('JetBrains Mono');
  });

  it('assigns identical, distinct colours to stepped traces and their legends', () => {
    const datasets = [{ label: 'R=1k' }, { label: 'R=5k' }, { label: 'R=10k' }];
    const colors = traceColors(datasets, ['out'], 'dark');
    expect(Object.values(colors)).toEqual(tracePalette('dark').slice(0, 3));
    expect(colors['R=1k:out']).toBe('#E8962E');
    expect(traceColors([{ label: '' }], ['out'], 'light').out).toBe('#986324');
    expect(traceColors(null, ['out'], 'dark')).toEqual({});
  });
});

import type { ThemeConfig } from '@spice-ts/ui';

export type ColorMode = 'dark' | 'light';

export function plotTheme(mode: ColorMode): ThemeConfig {
  const dark = mode === 'dark';
  return {
    background: dark ? '#18191D' : '#F5F1EA',
    surface: dark ? '#202126' : '#EDE8DF',
    border: dark ? '#303137' : '#D5CFC5',
    grid: dark ? '#27282D' : '#E2DCD2',
    text: dark ? '#F5F1EA' : '#121317',
    textMuted: dark ? '#A7A49E' : '#625F59',
    cursor: dark ? '#A7A49E' : '#625F59',
    tooltipBg: dark ? '#202126' : '#F5F1EA',
    tooltipBorder: dark ? '#505158' : '#B8B1A7',
    font: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: 11,
  };
}

export function tracePalette(mode: ColorMode): string[] {
  return mode === 'dark'
    ? ['#E8962E', '#86AFBA', '#B7A0C8', '#96AD87', '#CE8F87', '#C9C2B7']
    : ['#986324', '#3B7180', '#795690', '#557747', '#9F5148', '#625F59'];
}

export function traceColors(
  datasets: { label: string }[] | null,
  signals: string[],
  mode: ColorMode,
): Record<string, string> {
  const palette = tracePalette(mode);
  const colors: Record<string, string> = {};
  let index = 0;
  for (const dataset of datasets ?? []) {
    for (const signal of signals) {
      colors[dataset.label ? `${dataset.label}:${signal}` : signal] = palette[index++ % palette.length];
    }
  }
  return colors;
}

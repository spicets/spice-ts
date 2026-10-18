# @spice-ts/ui

[![npm](https://img.shields.io/npm/v/@spice-ts/ui)](https://www.npmjs.com/package/@spice-ts/ui)

Waveform viewer, Bode plot, DC sweep plot, and schematic renderer for [spice-ts](https://github.com/spicets/spice-ts) simulation results. Ships framework-agnostic Canvas renderers plus a thin React wrapper.

**[Live showcase](https://spicets.github.io/spice-ts/)** — interactive demos with streaming parametric sweeps running in your browser.

## Install

```bash
npm install @spice-ts/ui @spice-ts/core
# React bindings are optional — only needed for the `/react` subpath
npm install react react-dom
```

Requires Node.js ≥ 20.

## Two entry points

- **`@spice-ts/ui`** — framework-agnostic Canvas renderers (`TransientRenderer`, `BodeRenderer`, `DCSweepRenderer`), layout helpers (`layoutSchematic`), themes, scales, and formatters. Use these directly if you're building your own UI layer.
- **`@spice-ts/ui/react`** — React components (`TransientPlot`, `BodePlot`, `DCSweepPlot`, `WaveformViewer`, `SchematicView`) built on top of the renderers. Auto-resize, cursor tracking, legend toggling, and streaming updates are handled for you.

## React components

### Transient plot

```tsx
import { simulate } from '@spice-ts/core';
import { TransientPlot } from '@spice-ts/ui/react';

const result = await simulate(netlist);

<TransientPlot
  data={result.transient}
  signals={['in', 'out']}
  theme="dark"
  height={300}
/>
```

### Bode plot (AC magnitude + phase)

```tsx
import { BodePlot } from '@spice-ts/ui/react';

<BodePlot
  data={result.ac}
  signals={['out']}
  theme="dark"
/>
```

### DC sweep plot

```tsx
import { DCSweepPlot } from '@spice-ts/ui/react';

<DCSweepPlot
  data={result.dcSweep}
  signals={['out']}
  theme="dark"
/>
```

### Schematic view

Renders a `CircuitIR` as a vector schematic with automatic node ranking, column packing, and orthogonal wire routing.

```tsx
import { parse } from '@spice-ts/core';
import { SchematicView } from '@spice-ts/ui/react';

const circuit = parse(netlist).toIR();

<SchematicView
  circuit={circuit}
  theme="dark"
  height={400}
  onNodeClick={(net) => console.log('clicked net', net)}
/>
```

Supported symbols: V, I, R, C, L, D (horizontal and vertical with rank-aware triangle direction), M (N/PMOS), Q (NPN/PNP), E/G (opamp), F/H (dependent sources). Feedback caps draw as arches above opamp loops; series output caps in inverting buck-boost converters get a dedicated rank rail.

### Waveform viewer (multi-analysis container)

Combines transient + AC + DC sweep plots with a shared legend, cursor, and theme.

```tsx
import { WaveformViewer } from '@spice-ts/ui/react';

<WaveformViewer
  result={simulationResult}
  theme="dark"
/>
```

## Themes

`'dark'` and `'light'` presets ship out of the box. For custom colours, pass a `ThemeConfig` object or spread over a preset with `mergeTheme`:

```ts
import { mergeTheme, DARK_THEME } from '@spice-ts/ui';

const myTheme = mergeTheme(DARK_THEME, {
  background: '#0a1628',
  signals: ['#00ff88', '#ff6b9d', '#4dabf7'],
});
```

## Framework-agnostic renderers

If you're not using React, drive the Canvas directly:

```ts
import { TransientRenderer, resolveTheme } from '@spice-ts/ui';

const canvas = document.getElementById('plot') as HTMLCanvasElement;
const renderer = new TransientRenderer(canvas, {
  theme: resolveTheme('dark'),
  data: result.transient,
  signals: ['out'],
});

renderer.draw();
// later, on resize or data update:
renderer.resize(newWidth, newHeight);
renderer.update({ data: newData });
```

Same pattern for `BodeRenderer` and `DCSweepRenderer`. The React components are thin wrappers around these.

## Streaming

`StreamingController` and `ACStreamingController` buffer incoming points from `simulateStream()` and incrementally update the renderer:

```ts
import { simulateStream } from '@spice-ts/core';
import { StreamingController } from '@spice-ts/ui';

const controller = new StreamingController(renderer);

for await (const step of simulateStream(netlist)) {
  controller.push(step);
}
```

## License

MIT · See the [spice-ts monorepo](https://github.com/spicets/spice-ts) for the full project.

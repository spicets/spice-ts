# @spice-ts/ui

## 0.3.1

### Patch Changes

- a69f059: Accept core 0.3.x and 0.4.x in the UI peer dependency. Only escalate peer dependents when the new dependency version leaves their supported range, avoiding an accidental UI 1.0.0 release.

## 0.3.0

### Minor Changes

- Release the new simulator and UI surface: passive capacitor/inductor parasitic expansion, optional ngspice-wasm backend selection, Gear-2 transient integration, stepped simulations, public IR exports, and the schematic/waveform UI updates.

### Patch Changes

- Updated dependencies
  - @spice-ts/core@0.3.0

## 0.2.0

### Minor Changes

- 752f0ad: Add `SchematicView` React component — renders a `CircuitIR` as a vector schematic with automatic node ranking, column packing, and orthogonal wire routing. Supports V/I/R/C/L/D/M/Q/E/G symbols, feedback-cap arches above opamp loops, series output caps in inverting buck-boost converters, and directional diode flipping based on net ranks. Exported from `@spice-ts/ui/react` alongside the existing waveform viewers.

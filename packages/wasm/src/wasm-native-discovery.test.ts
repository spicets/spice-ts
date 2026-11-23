import { expect, it } from 'vitest';
import { createSpiceEngine } from './index.js';

it('advertises native schema 1.0 on the numeric WASM backend', async () => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    expect(engine.capabilities.nativeSchemaVersions).toEqual(['1.0']);
    expect(engine.capabilities.numericWasm?.inputFormats).toEqual(['spice', 'spice-ts']);
  } finally {
    await engine.close();
  }
});

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolSchemasV1 } from '../src/protocol/wire/schemas.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(packageRoot, 'protocol/schemas');
await mkdir(output, { recursive: true });
await Promise.all(Object.entries(protocolSchemasV1).map(([name, schema]) =>
  writeFile(resolve(output, `${name}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`, 'utf8'),
));

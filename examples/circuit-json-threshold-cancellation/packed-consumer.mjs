import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = resolve(exampleRoot, '../..');
const consumerRoot = mkdtempSync(join(tmpdir(), 'spice-ts-circuit-json-cancel-'));
const packsRoot = join(consumerRoot, 'packs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} exited with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function tarballFor(packageName) {
  const normalized = packageName.replace('@', '').replace('/', '-');
  const name = readdirSync(packsRoot)
    .find(entry => entry.startsWith(`${normalized}-`) && entry.endsWith('.tgz'));
  if (!name) throw new Error(`Missing packed tarball for ${packageName}`);
  return join(packsRoot, name);
}

try {
  mkdirSync(packsRoot);
  for (const packageName of ['core', 'circuit-json', 'mcp']) {
    run('pnpm', ['pack', '--pack-destination', packsRoot], resolve(workspaceRoot, 'packages', packageName));
  }

  const coreTarball = tarballFor('@spice-ts/core');

  const circuitJsonTarball = tarballFor('@spice-ts/circuit-json');
  const mcpTarball = tarballFor('@spice-ts/mcp');
  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
    private: true,
    type: 'module',
    pnpm: {
      overrides: {
        '@spice-ts/core': `file:${coreTarball}`,

        '@spice-ts/circuit-json': `file:${circuitJsonTarball}`,
      },
    },
  }, null, 2)}\n`);
  run('pnpm', [
    'add', '--ignore-workspace', '--prefer-offline', '--save-exact',
    coreTarball, circuitJsonTarball, mcpTarball,
  ], consumerRoot);

  const installedCircuitJson = join(consumerRoot, 'node_modules', '@spice-ts', 'circuit-json');
  const installedMcp = join(consumerRoot, 'node_modules', '@spice-ts', 'mcp');
  if (!existsSync(join(installedCircuitJson, 'dist', 'index.js'))) {
    throw new Error('Packed circuit-json public entrypoint is missing');
  }
  if (!existsSync(join(installedMcp, 'dist', 'index.js'))) {
    throw new Error('Packed MCP public entrypoint is missing');
  }
  if (existsSync(join(installedMcp, 'examples', 'circuit-json-threshold-cancellation'))) {
    throw new Error('Threshold-cancellation implementation was unexpectedly shared with the MCP package');
  }

  copyFileSync(join(exampleRoot, 'workflow.mjs'), join(consumerRoot, 'workflow.mjs'));
  copyFileSync(join(exampleRoot, 'circuit.json'), join(consumerRoot, 'circuit.json'));
  run(process.execPath, [join(consumerRoot, 'workflow.mjs')], consumerRoot);
  console.log('Packed circuit-json threshold-cancellation workflow passed.');
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = resolve(exampleRoot, '../..');
const consumerRoot = mkdtempSync(join(tmpdir(), 'spice-ts-floating-node-repair-'));
const packsRoot = join(consumerRoot, 'packs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000 });
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
  const name = readdirSync(packsRoot).find(entry => entry.startsWith(`${normalized}-`) && entry.endsWith('.tgz'));
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
    pnpm: {
      overrides: {
        '@spice-ts/core': `file:${coreTarball}`,

        '@spice-ts/circuit-json': `file:${circuitJsonTarball}`,
      },
    },
  }, null, 2)}\n`);
  run('pnpm', ['add', '--ignore-workspace', '--offline', '--save-exact', mcpTarball], consumerRoot);

  const installedMcp = join(consumerRoot, 'node_modules', '@spice-ts', 'mcp');
  const server = join(installedMcp, 'dist', 'stdio.js');
  if (!existsSync(server)) throw new Error('Packed MCP stdio entrypoint is missing');
  if (existsSync(join(installedMcp, 'examples', 'floating-node-repair'))) {
    throw new Error('Floating-node workflow was unexpectedly shared with the MCP package');
  }

  const actual = run(process.execPath, [join(exampleRoot, 'workflow.mjs'), '--server', server], consumerRoot);
  const expected = readFileSync(join(exampleRoot, 'expected-output.json'), 'utf8');
  if (actual !== expected) {
    throw new Error(`Packed floating-node output drifted.\nExpected:\n${expected}\nActual:\n${actual}`);
  }
  console.log('Packed external-cwd floating-node repair workflow passed.');
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}

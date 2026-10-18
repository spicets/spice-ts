import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const coreRoot = resolve(packageRoot, '../core');
const consumerRoot = mkdtempSync(join(tmpdir(), 'spice-ts-circuit-json-consumer-'));
const packsRoot = join(consumerRoot, 'packs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

try {
  mkdirSync(packsRoot);
  run('pnpm', ['pack', '--pack-destination', packsRoot], coreRoot);
  run('pnpm', ['pack', '--pack-destination', packsRoot], packageRoot);

  const tarballs = readdirSync(packsRoot)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => join(packsRoot, name));
  if (tarballs.length !== 2) {
    throw new Error(`Expected two package tarballs, found ${tarballs.length}`);
  }
  const overrides = Object.fromEntries(['core', 'circuit-json'].map((name) => {
    const tarball = tarballs.find((path) => basename(path).startsWith(`spice-ts-${name}-`));
    if (!tarball) throw new Error(`Missing packed tarball for @spice-ts/${name}`);
    return [`@spice-ts/${name}`, `file:${tarball}`];
  }));

  writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
    private: true,
    type: 'module',
    pnpm: { overrides },
  }, null, 2)}\n`);
  // Any accidental registry lookup for our packages must fail, even after publication.
  writeFileSync(join(consumerRoot, '.npmrc'), '@spice-ts:registry=http://127.0.0.1:1/\nfetch-retries=0\n');
  writeFileSync(join(consumerRoot, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      strict: true,
      skipLibCheck: false,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      noEmit: true,
    },
    include: ['index.ts'],
  }, null, 2)}\n`);
  writeFileSync(
    join(consumerRoot, 'index.ts'),
    'import type { CircuitJSON } from "@spice-ts/circuit-json";\n\nconst circuit = {} as CircuitJSON;\nvoid circuit;\n',
  );

  run(
    'pnpm',
    ['add', '--ignore-workspace', '--prefer-offline', '--save-exact', 'typescript@5.9.3', ...tarballs],
    consumerRoot,
  );
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], consumerRoot);
  console.log('Packed strict TypeScript consumer compiled successfully.');

  const brokenTarball = join(packsRoot, 'broken-core.tgz');
  writeFileSync(brokenTarball, 'not a package tarball');
  writeFileSync(join(consumerRoot, 'package.json'), JSON.stringify({
    private: true,
    dependencies: { '@spice-ts/core': `file:${brokenTarball}` },
    pnpm: { overrides: { '@spice-ts/core': `file:${brokenTarball}` } },
  }));
  const broken = spawnSync('pnpm', ['install', '--ignore-workspace', '--prefer-offline', '--no-frozen-lockfile'], {
    cwd: consumerRoot, encoding: 'utf8',
  });
  if (broken.error) throw broken.error;
  assert.notEqual(broken.status, 0, 'A broken local tarball must not fall back to the registry');
  assert.match(broken.stdout + broken.stderr, /ERR_PNPM_TARBALL_EXTRACT/);
  console.log('Broken local tarball rejected without registry fallback.');
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Regression for #517: `pnpm -r build` / `pnpm -r run test:coverage` already
// order @spice-ts/core ahead of its dependants
// (workspace topological order; CI also builds them up front). A script in one
// package that rebuilds a sibling package re-runs tsup's `clean` on the
// sibling's dist/ while other workspace packages may be bundling or importing
// it, which races nondeterministically.
const packagesDir = new URL('../../', import.meta.url);
const siblingRebuild = /(-C|--dir|--filter)\s+\S*\.\.\/|\bcd\s+\.\.\//;

function readPkg(name: string) {
  return JSON.parse(
    readFileSync(new URL(`${name}/package.json`, packagesDir), 'utf8'),
  ) as { private?: boolean; scripts?: Record<string, string>; dependencies?: Record<string, string> };
}

const workspacePackages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('workspace package scripts (#517)', () => {
  it('finds the workspace packages', () => {
    expect(workspacePackages).toEqual(expect.arrayContaining(['core', 'mcp', 'wasm']));
  });

  it('publishes four packages with protocol folded into core', () => {
    expect(workspacePackages).not.toContain('protocol');
    expect(workspacePackages.filter(name => !readPkg(name).private).sort())
      .toEqual(['circuit-json', 'core', 'mcp', 'ui']);
  });

  it.each(workspacePackages)('packages/%s scripts never rebuild a sibling package', (name) => {
    const offenders = Object.entries(readPkg(name).scripts ?? {}).filter(([, cmd]) =>
      siblingRebuild.test(cmd),
    );
    expect(offenders).toEqual([]);
  });

  it('mcp declares core as a workspace dep without the superseded protocol package', () => {
    const deps = readPkg('mcp').dependencies ?? {};
    expect(deps['@spice-ts/core']).toBe('workspace:*');
    expect(deps['@spice-ts/protocol']).toBeUndefined();
  });
});

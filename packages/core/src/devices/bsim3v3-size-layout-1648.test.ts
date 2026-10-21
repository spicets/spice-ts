import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// This is specifically a Node/V8 performance regression, not a timing limit:
// dictionary-mode size records make every b3ld.c parameter read a hash lookup.
// Keep V8's diagnostic syntax in a child so no flags affect the test runner.
describe('BSIM3 size-record layout (#1648)', () => {
  it('keeps frozen size records in fast-property mode across geometry, temperature and revision', () => {
    const params = new URL('./bsim3v3-params.ts', import.meta.url).href;
    const output = execFileSync(process.execPath, [
      '--allow-natives-syntax', '--import', 'tsx', '--input-type=module', '-e', `
      import { computeBsim3Size, resolveBsim3Model } from ${JSON.stringify(params)};
      const records = [];
      for (const version of ['3.2', '3.2.2', '3.2.3', '3.2.4', '3.3.0']) {
        for (const type of [1, -1]) {
          for (const temperature of [300.15, 343.15]) {
            const model = resolveBsim3Model({}, type, temperature, version);
            for (const instance of [{}, { W: 10e-6, L: 1e-6, DELVTO: 0.02, MULU0: 0.9 }]) {
              const size = computeBsim3Size(model, instance);
              records.push({ fast: %HasFastProperties(size), frozen: Object.isFrozen(size),
                finite: Object.values(size).every(Number.isFinite), fields: Object.keys(size).length });
            }
          }
        }
      }
      console.log(JSON.stringify(records));
      `,
    ], { encoding: 'utf8', timeout: 30_000 });
    const records = JSON.parse(output) as { fast: boolean; frozen: boolean; finite: boolean; fields: number }[];
    expect(records).toHaveLength(40);
    for (const record of records) {
      expect(record.frozen).toBe(true);
      expect(record.finite).toBe(true);
      expect(record.fields).toBeGreaterThan(100);
      expect(record.fast).toBe(true);
    }
  });
});

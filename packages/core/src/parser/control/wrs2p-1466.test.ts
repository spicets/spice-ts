import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const ports = `* two-port
V1 in 0 dc 0 ac 1 portnum 1 z0 50
R1 in out 25
V2 out 0 dc 0 ac 0 portnum 2 z0 50`;
const deck = (commands: string) => `${ports}\n.control\n${commands}\n.endc\n.end`;

describe('$inputdir and wrs2p (#1466)', () => {
  it('resolves inputdir from the supplied deck path, without inventing cwd', async () => {
    const result = await simulate(deck('echo $inputdir'), { sourcePath: '/decks/rf/filter.cir' });
    expect(result.control!.output).toEqual(['/decks/rf']);
    await expect(simulate(deck('echo $inputdir'))).rejects.toMatchObject({
      code: 'CONTROL_SCRIPT_ERROR', message: expect.stringContaining('no such variable'),
    });
  });

  it('exports a two-port sp plot in ngspice Touchstone RI ordering and precision', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'spice-wrs2p-'));
    try {
      const result = await simulate(deck('sp lin 3 1k 3k\nwrs2p $inputdir/filter.s2p'), {
        sourcePath: join(directory, 'filter.cir'),
        writeControlFile: (path, contents) => writeFileSync(path, contents),
      });
      const text = readFileSync(join(directory, 'filter.s2p'), 'utf8');
      expect(text).toContain('# Hz S RI R 50\n');
      expect(text).toMatch(/1\.000000e\+03/);
      const rows = text.split('\n').filter(line => line.trim() && !/^[!#]/.test(line)).map(line => line.trim().split(/\s+/).map(Number));
      const sp = result.sParameters!;
      expect(rows).toHaveLength(3);
      rows.forEach((row, index) => {
        expect(row).toHaveLength(9);
        expect(row[0]).toBe(sp.frequencies[index]);
        ['S_1_1', 'S_2_1', 'S_1_2', 'S_2_2'].forEach((name, column) => {
          const value = sp.vector(name)[index];
          expect(row[1 + column * 2]).toBeCloseTo(value.real, 6);
          expect(row[2 + column * 2]).toBeCloseTo(value.imaginary, 6);
        });
      });
      expect(result.control!.files).toEqual([{ path: join(directory, 'filter.s2p'), contents: text }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['wrs2p bad.s2p', 'op\nwrs2p bad.s2p'])(
    'rejects a non-sp current plot with a typed error (%s)', async commands => {
      await expect(simulate(deck(commands))).rejects.toMatchObject({ code: 'CONTROL_SCRIPT_ERROR' });
    },
  );

  it('exports manually synthesized AC S vectors with Rbase, as in s-param.cir', async () => {
    const result = await simulate(deck('ac lin 2 1k 2k\nlet s_1_1=v(in)\nlet s_2_1=v(out)\nlet s_1_2=v(out)\nlet s_2_2=v(in)\nlet Rbase=75\nwrs2p manual.s2p'));
    expect(result.control!.files![0].contents).toContain('# Hz S RI R 75\n');
  });

  it('exports a selected retained plot and reports sink failures as typed errors', async () => {
    const commands = 'sp lin 2 1k 2k\nop\nsetplot sp1\nwrs2p retained.s2p';
    expect((await simulate(deck(commands))).control!.files).toHaveLength(1);
    await expect(simulate(deck(commands), {
      writeControlFile: () => { throw new Error('sandbox denied'); },
    })).rejects.toMatchObject({ code: 'CONTROL_SCRIPT_ERROR', message: expect.stringContaining('sandbox denied') });
  });

  it.each([['filter.cir', '.'], ['/filter.cir', '/'], ['rf/filter.cir', 'rf']])(
    'uses the lexical directory of %s', async (sourcePath, directory) => {
      expect((await simulate(deck('echo $inputdir'), { sourcePath })).control!.output).toEqual([directory]);
    },
  );

  it('rejects a three-port sp plot rather than emitting a two-port file', async () => {
    await expect(simulate(`${ports}\nV3 other 0 ac 0 portnum 3 z0 50\nR3 other 0 50\n.control\nsp lin 2 1k 2k\nwrs2p bad.s2p\n.endc\n.end`)).rejects.toMatchObject({ code: 'CONTROL_SCRIPT_ERROR' });
  });
});

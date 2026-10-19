import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

// Project-authored MIT microdecks. Feed these exact bytes to ngspice -b too.
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}-1547.cir`, import.meta.url), 'utf8');
const deck = (control: string): string => `Pre commands\nV1 in 0 1\nR1 in 0 1k\n.control\n${control}\n.endc\n.end`;

describe('ngspice-47 pre_<command> and absent commands (#1547)', () => {
  it.each(['pre-snp', 'snp'])('warns for %s and continues with the same operating point', async name => {
    const result = await simulate(fixture(name));
    expect(result.control!.output).toEqual(['RUNTIME', 'CONTINUED 1']);
    expect(result.control!.runs).toHaveLength(1);
    expect(result.warnings).toContainEqual({ type: 'control', message: 'snp: no such command available in ngspice' });
  });

  it('hoists generic commands with pre_set in source order, outside runtime control flow', async () => {
    const result = await simulate(fixture('pre-hoist'));
    expect(result.control!.output).toEqual(['first 4', 'second 7', 'third 7', 'runtime 7 5']);
  });

  it('does not execute absent commands in untaken runtime branches', async () => {
    const result = await simulate(deck('if 0\nnot_a_command\nend\necho done'));
    expect(result.warnings).toEqual([]);
    expect(result.control!.output).toEqual(['done']);
  });

  it('does not expose the loaded circuit to hoisted vector expressions', async () => {
    await expect(simulate(deck('pre_let resistance=@r1[resistance]'))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL_COMMAND' });
  });

  it.each(['pre_shell true', 'shell true', 'pre_osdi missing.osdi', 'pre_source missing.cir', 'pre_tf v(in) V1', 'pre_op'])('fails closed for existing unimplemented command or phase: %s', async command => {
    await expect(simulate(deck(command))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL_COMMAND' });
  });

  it('fails closed on the identical pre_shell oracle deck', async () => {
    await expect(simulate(fixture('pre-shell'))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL_COMMAND', command: 'shell' });
  });
});

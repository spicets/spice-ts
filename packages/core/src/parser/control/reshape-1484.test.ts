import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { evaluateVectorExpression, parseVectorExpression } from './vector-expression.js';
import { realVector, renamed } from './vector.js';

const run = (script: string) => simulate(`reshape tests\nV1 1 0 1\nR1 1 0 1k\n.control\n${script}\n.endc\n.end`);

// Oracle: ngspice-47, display v row; print row length(v) length(row).
// v: 30 long, dims = [5,6]; row: 6 long; row = 1 2 3 4 5 6.
describe('reshape and multidimensional indexing (#1484)', () => {
  it('assigns and reads a complete row without changing the total length', async () => {
    const result = await run('let v=vector(30)\nreshape v [5][6]\nlet v[2]=vector(6)+1\nlet row=v[2]\nlet n=length(v)\nlet m=length(row)\necho $&row / $&n / $&m\nlet untouched=v[3]\necho $&untouched');
    expect(result.control?.output).toEqual(['1 2 3 4 5 6 / 30 / 6', '18 19 20 21 22 23']);
  });

  it('preserves dimensions and independent storage when renaming and selecting rows', () => {
    const v = { ...realVector('v', Array.from({ length: 30 }, (_, i) => i)), dims: [5, 6] };
    const copy = renamed(v, 'copy');
    expect(copy).toMatchObject({ dims: [5, 6] });
    const row = evaluateVectorExpression(parseVectorExpression('v[2]'), { lookup: () => copy, userFunction: () => undefined, degrees: () => false });
    expect(Array.from(row.re)).toEqual([12, 13, 14, 15, 16, 17]);
    expect(row).toMatchObject({ dims: [6] });
    row.re[0] = 99;
    expect(copy.re[12]).toBe(12);
  });

  it('supports chained 3-D row and scalar assignments and reads', async () => {
    const result = await run('let v=vector(24)\nreshape v [2][3][4]\nlet v[1][2]=vector(4)+100\nlet v[0][1][2]=77\nlet row=v[1][2]\nlet item=v[0][1][2]\necho $&row / $&item');
    expect(result.control?.output).toEqual(['100 101 102 103 / 77']);
  });

  it('copies complex rows and transposes the last two axes of each matrix', async () => {
    const result = await run('let v=vector(12)+j(vector(12))\nreshape v [2][2][3]\nlet v[1][0]=vector(3)+j(vector(3)+20)\ntranspose v\nlet row=imag(v[1][1])\necho $&row');
    expect(result.control?.output).toEqual(['21 10']);
  });

  it('transposes the dc_loop 5 by 6 layout to 6 by 5', async () => {
    const result = await run('let v=vector(30)\nreshape v [5][6]\ntranspose v\nlet row=v[5]\necho $&row');
    expect(result.control?.output).toEqual(['5 11 17 23 29']);
  });

  it('retains the shape through arithmetic, unary negation and row ranges', async () => {
    const result = await run('let v=vector(30)\nreshape v [5][6]\nlet w=-(v+1)\nlet row=w[2]\nlet selected=v[1,2]\nlet row2=selected[1]\necho $&row / $&row2');
    expect(result.control?.output).toEqual(['-13 -14 -15 -16 -17 -18 / 12 13 14 15 16 17']);
  });

  it.each(['reshape v [2][4]', 'reshape v [0][6]', 'reshape v [-5][6]', 'reshape v [2.5][12]', 'let v[5]=vector(6)', 'let v[2]=1', 'let v[0][6]=1'])('rejects an invalid shape or indexed write: %s', async command => {
    await expect(run(`let v=vector(30)\nreshape v [5][6]\n${command}`)).rejects.toMatchObject({ code: 'CONTROL_SCRIPT_ERROR' });
  });
});

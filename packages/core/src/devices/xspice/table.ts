import { InvalidCircuitError } from '../../errors.js';
import { parseNumber } from '../../parser/tokenizer.js';
import type { CodeModelBehavior, ResolvedXspiceParams } from './models.js';

/** File shape: dimension counts, axis rows, then x-fastest rows (y inside z).
 * ngspice-47 table/{table2D,table3D}/cfunc.mod:533-595,648-711 / 569-660,715-784.
 * This implementation is independently expressed; no upstream source is embedded.
 */
interface Table {
  axes: number[][];
  values: number[];
}
const fail = (message: string): never => { throw new InvalidCircuitError(`XSPICE table: ${message}`); };

function readTable(text: string, dimensions: number, order: number): Table {
  const rows = text.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('*'))
    .map(line => line.trim().split(/[\s,]+/).map(word => {
      const value = parseNumber(word);
      if (!Number.isFinite(value)) fail(`invalid number '${word}'`);
      return value;
    }));
  const sizes = rows.slice(0, dimensions).map(row => row[0]);
  if (sizes.length !== dimensions || sizes.some((n, d) => !Number.isInteger(n) || n < (d ? 2 * order - 2 : order))) {
    fail('dimensions too small for interpolation order');
  }
  const axes = rows.slice(dimensions, 2 * dimensions);
  if (axes.length !== dimensions || axes.some((axis, d) => axis.length !== sizes[d]
    || axis.some((v, i) => i > 0 && v <= axis[i - 1]))) fail('axes must match dimensions and be strictly increasing');
  const data = rows.slice(2 * dimensions);
  if (data.length !== sizes.slice(1).reduce((a, b) => a * b, 1) || data.some(row => row.length !== sizes[0])) {
    fail('wrong number of table values');
  }
  return { axes, values: data.flat() };
}

interface Sample { value: number; derivative: number }

/** ENO: average the Newton polynomials on minimum highest-difference stencils.
 * Upstream numerical contract: table/mada/eno.c sf_eno_apply, eno2.c:138-171,
 * eno3.c:159-203. Offsets intentionally remain physical, not normalized.
 */
function eno(values: number[], index: number, offset: number, order: number): Sample {
  const differences = [values];
  for (let degree = 1; degree < order; degree++) {
    const previous = differences[degree - 1];
    differences.push(previous.slice(1).map((value, i) => value - previous[i]));
  }
  const last = Math.max(0, Math.min(index, values.length - order));
  const first = Math.min(last, Math.max(0, index - order + 2));
  const minimum = Math.min(...differences[order - 1].slice(first, last + 1).map(Math.abs));
  let value = 0, derivative = 0, count = 0;
  for (let start = first; start <= last; start++) {
    if (Math.abs(differences[order - 1][start]) > minimum) continue;
    count++;
    let basis = 1, slope = 0;
    for (let degree = 0; degree < order; degree++) {
      value += basis * differences[degree][start];
      derivative += slope * differences[degree][start];
      const factor = offset + index - start - degree;
      slope = (basis + slope * factor) / (degree + 1);
      basis *= factor / (degree + 1);
    }
  }
  return { value: value / count, derivative: derivative / count };
}

function enoND(values: number[], sizes: number[], indices: number[], offsets: number[], order: number): { value: number; derivatives: number[] } {
  if (sizes.length === 1) {
    const sample = eno(values, indices[0], offsets[0], order);
    return { value: sample.value, derivatives: [sample.derivative] };
  }
  const axis = sizes.length - 1;
  const width = 2 * order - 2;
  const index = indices[axis];
  const start = index - order + 2 < 0 ? 0 : index + order - 1 > sizes[axis] - 1 ? sizes[axis] - width : index - order + 2;
  const stride = sizes.slice(0, axis).reduce((a, b) => a * b, 1);
  const samples = Array.from({ length: width }, (_, i) => enoND(values.slice((start + i) * stride, (start + i + 1) * stride),
    sizes.slice(0, axis), indices.slice(0, axis), offsets.slice(0, axis), order));
  const sample = eno(samples.map(s => s.value), index - start, offsets[axis], order);
  return { value: sample.value, derivatives: [
    ...sizes.slice(0, axis).map((_, d) => eno(samples.map(s => s.derivatives[d]), index - start, offsets[axis], order).value),
    sample.derivative,
  ] };
}

export function tableModel(dimensions: number, params: ResolvedXspiceParams): CodeModelBehavior {
  const text = params.get('__file_data')?.[0];
  if (typeof text !== 'string') fail('file requires async parsing with a resolver');
  const order = Math.max(2, Number(params.get('order')?.[0] ?? 3));
  const table = readTable(text as string, dimensions, order);
  const gain = Number(params.get('gain')?.[0] ?? 1);
  const offset = Number(params.get('offset')?.[0] ?? 0);
  return {
    stateful: false,
    ac: { kind: 'static' },
    load(call) {
      // ngspice-47 table2D/cfunc.mod:286-377; table3D/cfunc.mod:285-410.
      const indices: number[] = [], offsets: number[] = [], ramps: number[] = [], spacings: number[] = [];
      const cells: number[] = [], fractions: number[] = [];
      for (let d = 0; d < dimensions; d++) {
        const axis = table.axes[d], last = axis.length - 1;
        const input = call.inputs[d];
        const x = Math.max(axis[0], Math.min(axis[last], input));
        let low = 0, high = last;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (axis[middle] <= x) low = middle; else high = middle - 1;
        }
        indices.push(low); offsets.push(x - axis[low]);
        spacings.push(low === 0 ? axis[1] - axis[0] : low === last ? axis[last] - axis[last - 1] : (axis[low + 1] - axis[low - 1]) / 2);
        const edgeSpacing = input < axis[0] ? axis[1] - axis[0] : axis[last] - axis[last - 1];
        ramps.push(Math.max(0, 1 - Math.abs(input - x) / (0.125 * edgeSpacing)));
        const cell = Math.min(low, last - 1);
        cells.push(cell); fractions.push((x - axis[cell]) / (axis[cell + 1] - axis[cell]));
      }
      let value = 0;
      for (let corner = 0; corner < 1 << dimensions; corner++) {
        let weight = 1, address = 0, stride = 1;
        for (let d = 0; d < dimensions; d++) {
          const upper = (corner >> d) & 1;
          weight *= upper ? fractions[d] : 1 - fractions[d];
          address += (cells[d] + upper) * stride;
          stride *= table.axes[d].length;
        }
        value += weight * table.values[address];
      }
      call.outputs[0] = offset + gain * value;
      const derivatives = enoND(table.values, table.axes.map(a => a.length), indices, offsets, order).derivatives;
      for (let d = 0; d < dimensions; d++) call.partials[d] = gain * ramps[d] * derivatives[d] / spacings[d];
    },
  };
}

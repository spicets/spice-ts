import { InvalidCircuitError } from '../../errors.js';
import type { XspiceModelCard } from '../../parser/xspice-parser.js';
import type { IncludeResolver } from '../../types.js';
import type { XspiceParamValue } from './spec.js';
import type { CodeModelBehavior, ResolvedXspiceParams } from './models.js';
import { STATIC } from './models.js';

interface TransferPoint { frequency: number; real: number; imaginary: number }

const fail = (message: string): never => { throw new InvalidCircuitError(`XSPICE xfer: ${message}`); };

/** ngspice-47 analog/xfer/cfunc.mod: convert once, interpolate complex components in Hz. */
export function xfer(params: ResolvedXspiceParams): CodeModelBehavior {
  const span = Number(params.get('span')?.[0] ?? 3);
  const offset = Number(params.get('offset')?.[0] ?? 1);
  if (offset < 1 || span < offset + 2) fail('impossible span/offset');
  if (params.get('file')?.length) fail('file requires async parsing with a resolver');
  const values = (params.get('table') ?? []).map(Number);
  if (!values.length || values.length % span || !values.every(Number.isFinite)) fail('badly formed table');
  const ri = params.get('r_i')?.[0] ?? false;
  const db = params.get('db')?.[0] ?? true;
  const rad = params.get('rad')?.[0] ?? false;
  const points: TransferPoint[] = [];
  for (let i = 0; i < values.length; i += span) {
    const frequency = values[i];
    if (frequency < 0 || frequency < (points.at(-1)?.frequency ?? 0)) fail('badly formed table');
    const a = values[i + offset];
    const b = values[i + offset + 1];
    const magnitude = db ? 10 ** (a / 20) : a;
    const phase = rad ? b : b * Math.PI / 180;
    points.push({ frequency, real: ri ? a : magnitude * Math.cos(phase), imaginary: ri ? b : magnitude * Math.sin(phase) });
  }
  return {
    stateful: false,
    ac: STATIC,
    acGains(omega) {
      const frequency = omega / (2 * Math.PI);
      if (frequency <= points[0].frequency) return [points[0]];
      if (frequency >= points.at(-1)!.frequency) return [points.at(-1)!];
      const index = points.findIndex(point => point.frequency > frequency);
      const a = points[index - 1];
      const b = points[index];
      const factor = (frequency - a.frequency) / (b.frequency - a.frequency);
      return [{ real: a.real + factor * (b.real - a.real), imaginary: a.imaginary + factor * (b.imaginary - a.imaginary) }];
    },
    load({ inputs, outputs, partials }) {
      // cfunc.mod deliberately sets no PARTIAL in DC/TRAN.
      outputs[0] = points[0].real * inputs[0];
      partials[0] = 0;
    },
  };
}

/** Read the same selected columns as read_file(), including continuation lines and noise cutoff. */
export function touchstone(text: string, span: number, offset: number): { table: number[]; r_i: boolean; db: boolean } {
  if (offset < 1 || span < offset + 2) fail('impossible span/offset');
  const lines = text.split(/\r?\n/);
  const option = lines.findIndex(line => line.startsWith('#'));
  if (option < 0) fail('no option line in Touchstone file');
  const words = lines[option].slice(1).trim().split(/\s+/);

  const data: number[] = [];
  for (const line of lines.slice(option + 1)) {
    const row: number[] = [];
    for (const token of line.trim().split(/\s+/).slice(0, 9)) {
      const value = Number(token);
      if (!token || !Number.isFinite(value)) break;
      row.push(value);
    }
    if (span === 9 && row.length === 5) break;
    data.push(...row);
  }
  const table: number[] = [];
  for (let i = 0; i + offset + 1 < data.length; i += span) {
    // ngspice-47 calculates `mult` from the option line but never applies it.
    // Preserve its effective Hz interpretation, even for MHz/GHz files.
    table.push(data[i], data[i + offset], data[i + offset + 1]);
  }
  if (!table.length) fail('empty Touchstone table');
  return { table, r_i: words.includes('RI'), db: words.includes('DB') };
}

/** Resolve external data without importing Node APIs into the browser-native core. */
export async function resolveXferFile(model: XspiceModelCard, resolver?: IncludeResolver): Promise<XspiceModelCard> {
  const file = model.params.get('file')?.[0];
  if (model.codeModel !== 'xfer' || file === undefined) return model;
  if (model.params.has('table')) fail('both file and table parameters given');
  const params = new Map<string, readonly XspiceParamValue[]>(model.params);
  const warnings = [...model.warnings];
  const span = Number(params.get('span')?.[0] ?? 3);
  const offset = Number(params.get('offset')?.[0] ?? 1);
  if (offset < 1 || span < offset + 2) fail('impossible span/offset');
  let text: string | undefined;
  try {
    if (resolver) text = await resolver(String(file));
  } catch {
    // ngspice leaves an uninitialized model with zero output when fopen fails.
  }
  if (text === undefined) {
    warnings.push(`XSPICE xfer: Can not open file ${String(file)}; output is zero (ngspice behavior)`);
    params.set('table', [0, 0, 0]);
    params.set('r_i', [true]);
  } else {
    const data = touchstone(text, span, offset);
    params.set('table', data.table);
    for (const name of ['r_i', 'db'] as const) if (!params.has(name)) params.set(name, [data[name]]);
  }
  params.delete('file');
  params.set('span', [3]);
  params.set('offset', [1]);
  return { ...model, params, warnings };
}

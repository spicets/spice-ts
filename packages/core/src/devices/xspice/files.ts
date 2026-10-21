import { InvalidCircuitError } from '../../errors.js';
import type { IncludeResolver } from '../../types.js';
import type { XspiceModelCard } from '../../parser/xspice-parser.js';
import { resolveXferData, resolveXferFile } from './xfer.js';

/** Host-owned data loading: reusable by other file-driven code models. */
export function xspiceFilePath(model: XspiceModelCard): string | undefined {
  if (model.codeModel === 'd_source') return String(model.params.get('input_file')?.[0] ?? 'source.txt');
  if (model.codeModel === 'table2d' || model.codeModel === 'table3d') {
    return String(model.params.get('file')?.[0] ?? `${model.codeModel === 'table2d' ? '2D' : '3D'}-table-model.txt`);
  }
  return model.codeModel === 'xfer' ? model.params.get('file')?.[0] as string | undefined : undefined;
}

export function resolveXspiceData(model: XspiceModelCard, text: string | undefined): XspiceModelCard {
  if (model.codeModel === 'xfer') return resolveXferData(model, text);
  if (xspiceFilePath(model) === undefined) return model;
  if (text === undefined) throw new InvalidCircuitError(`XSPICE ${model.codeModel}: cannot open file ${xspiceFilePath(model)}`);
  return { ...model, fileData: text };
}

export async function resolveXspiceFile(model: XspiceModelCard, resolver?: IncludeResolver): Promise<XspiceModelCard> {
  if (model.codeModel === 'xfer') return resolveXferFile(model, resolver);
  const file = xspiceFilePath(model);
  if (file === undefined) return model;
  if (!resolver) throw new InvalidCircuitError(`XSPICE ${model.codeModel}: file requires async parsing with a resolver`);
  let text: string | undefined;
  try { text = await resolver(file); } catch { /* Report a structured file diagnostic below. */ }
  return resolveXspiceData(model, text);
}

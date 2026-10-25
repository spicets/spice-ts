import type { CircuitIR, ComponentType, IRComponent } from '@spice-ts/core';
import type { CircuitJson } from 'circuit-json';

export type CircuitJSON = CircuitJson;
export type Circuit = CircuitIR;

export interface ConversionDiagnosticV1 {
  severity: 'info' | 'warning' | 'error';
  code: 'LAYOUT_ONLY' | 'UNSUPPORTED_ELEMENT' | 'UNSUPPORTED_PARAMETER' | 'LOSSY_EXPORT';
  message: string;
  path: string;
  elementId?: string;
  simulationRelevant: boolean;
}

export interface ConversionResultV1<T> {
  value?: T;
  diagnostics: ConversionDiagnosticV1[];
  lossy: boolean;
}

export interface CircuitJSONExportOptions {
  allowLossy?: boolean;
}

type ElementRecord = Record<string, unknown>;

function sourceParams(element: ElementRecord, valueField: 'voltage' | 'current'): Record<string, number | string | boolean> {
  const offset = element[valueField] as number;
  const amplitude = (element[`peak_to_peak_${valueField}`] as number) / 2;
  if (element.wave_shape === 'sinewave') {
    return { waveform: 'sin', offset, amplitude, frequency: element.frequency as number, phase: (element.phase as number | undefined) ?? 0 };
  }
  if (element.wave_shape === 'square') {
    const period = 1 / (element.frequency as number);
    return {
      waveform: 'pulse', v1: offset - amplitude, v2: offset + amplitude,
      delay: ((element.phase as number | undefined) ?? 0) / 360 * period,
      rise: period * 1e-6, fall: period * 1e-6,
      width: ((element.duty_cycle as number | undefined) ?? 0.5) * period, period,
    };
  }
  return { waveform: 'dc', dc: offset };
}

const COMPONENT_FIELDS = new Set([
  'type',
  'ftype',
  'source_component_id',
  'name',
  'manufacturer_part_number',
  'supplier_part_numbers',
  'display_value',
  'display_name',
]);

const PORT_FIELDS = new Set([
  'type', 'pin_number', 'port_hints', 'name', 'source_port_id',
  'source_component_id', 'most_frequently_referenced_by_name',
]);

const NET_FIELDS = new Set([
  'type', 'source_net_id', 'name', 'member_source_group_ids', 'is_power',
  'is_ground', 'is_digital_signal', 'is_analog_signal',
  'is_positive_voltage_source', 'trace_width',
]);

const TRACE_FIELDS = new Set([
  'type', 'source_trace_id', 'connected_source_port_ids',
  'connected_source_net_ids', 'max_length', 'max_via_count', 'name',
  'display_name', 'min_trace_thickness',
]);

const COMPONENT_MAPPING: Record<string, {
  type: ComponentType;
  fields: readonly string[];
  params: (element: ElementRecord) => Record<string, number | string | boolean>;
}> = {
  simple_resistor: {
    type: 'R',
    fields: ['resistance', 'display_resistance'],
    params: element => ({ resistance: element.resistance as number }),
  },
  simple_capacitor: {
    type: 'C',
    fields: ['capacitance', 'display_capacitance', 'max_voltage_rating', 'max_decoupling_trace_length'],
    params: element => ({ capacitance: element.capacitance as number }),
  },
  simple_inductor: {
    type: 'L',
    fields: ['inductance', 'display_inductance', 'max_current_rating'],
    params: element => ({ inductance: element.inductance as number }),
  },
  simple_diode: {
    type: 'D',
    fields: [],
    params: () => ({ modelName: '' }),
  },
  simple_led: {
    type: 'D',
    fields: [],
    params: () => ({ modelName: '' }),
  },
  simple_voltage_source: {
    type: 'V',
    fields: ['voltage', 'wave_shape'],
    params: element => sourceParams(element, 'voltage'),
  },
  simple_current_source: {
    type: 'I',
    fields: ['current', 'wave_shape'],
    params: element => sourceParams(element, 'current'),
  },
  simple_mosfet: {
    type: 'M',
    fields: ['channel_type', 'mosfet_mode'],
    params: element => ({ channelType: element.channel_type as string }),
  },
  simple_transistor: {
    type: 'Q',
    fields: ['transistor_type'],
    params: element => ({ type: element.transistor_type as string }),
  },
};

const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  simple_resistor: ['resistance'],
  simple_capacitor: ['capacitance'],
  simple_inductor: ['inductance'],
  simple_diode: [],
  simple_led: [],
  simple_voltage_source: ['voltage'],
  simple_current_source: ['current'],
  simple_mosfet: ['channel_type', 'mosfet_mode'],
  simple_transistor: ['transistor_type'],
};

const LAYOUT_PREFIXES = ['pcb_', 'schematic_', 'cad_'];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortDiagnostics(diagnostics: ConversionDiagnosticV1[]): ConversionDiagnosticV1[] {
  return diagnostics.sort((left, right) =>
    compareText(left.path, right.path)
    || compareText(left.code, right.code)
    || compareText(left.elementId ?? '', right.elementId ?? ''));
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is ElementRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function elementId(element: ElementRecord): string | undefined {
  const type = typeof element.type === 'string' ? element.type : '';
  const id = element[`${type}_id`];
  if (typeof id === 'string') return id;
  return typeof element.source_component_id === 'string' ? element.source_component_id : undefined;
}

function importDiagnostic(
  code: 'UNSUPPORTED_ELEMENT' | 'UNSUPPORTED_PARAMETER',
  message: string,
  path: string,
  element: ElementRecord,
): ConversionDiagnosticV1 {
  return {
    severity: 'error',
    code,
    message,
    path,
    ...(elementId(element) ? { elementId: elementId(element) } : {}),
    simulationRelevant: true,
  };
}

function layoutDiagnostic(element: ElementRecord, path: string): ConversionDiagnosticV1 {
  const type = typeof element.type === 'string' ? element.type : 'unknown';
  return {
    severity: 'info',
    code: 'LAYOUT_ONLY',
    message: `Ignored layout-only circuit-json element ${type}`,
    path,
    ...(elementId(element) ? { elementId: elementId(element) } : {}),
    simulationRelevant: false,
  };
}

function exportDiagnostic(
  message: string,
  path: string,
  component: IRComponent,
): ConversionDiagnosticV1 {
  return {
    severity: 'warning',
    code: 'LOSSY_EXPORT',
    message,
    path,
    elementId: component.id,
    simulationRelevant: true,
  };
}

function validateComponentFields(
  element: ElementRecord,
  index: number,
  ftype: string,
  diagnostics: ConversionDiagnosticV1[],
): void {
  const allowed = new Set([...COMPONENT_FIELDS, ...COMPONENT_MAPPING[ftype].fields]);
  if (ftype === 'simple_voltage_source' || ftype === 'simple_current_source') {
    const valueField = ftype === 'simple_voltage_source' ? 'voltage' : 'current';
    const peakField = `peak_to_peak_${valueField}`;
    if (element.wave_shape === 'sinewave') {
      for (const key of ['frequency', peakField, 'phase']) {
        allowed.add(key);
        if ((key === 'phase' && element[key] === undefined) || isFiniteNumber(element[key])) continue;
        diagnostics.push(importDiagnostic(
          'UNSUPPORTED_PARAMETER', `Sine parameter ${key} must be a finite number`,
          `/${index}/${key}`, element,
        ));
      }
    } else if (element.wave_shape === 'square') {
      const diagnosticCount = diagnostics.length;
      for (const key of ['frequency', peakField, 'phase', 'duty_cycle']) {
        allowed.add(key);
        const value = element[key];
        if ((key === 'phase' || key === 'duty_cycle') && value === undefined) continue;
        const valid = isFiniteNumber(value)
          && (key !== 'frequency' || value > 0)
          && (key !== 'phase' || value >= 0)
          && (key !== 'duty_cycle' || (value > 0 && value < 1));
        if (!valid) diagnostics.push(importDiagnostic(
          'UNSUPPORTED_PARAMETER', `Square parameter ${key} is outside its supported numeric range`,
          `/${index}/${key}`, element,
        ));
      }
      if (diagnostics.length === diagnosticCount && isFiniteNumber(element[valueField])) {
        const params = sourceParams(element, valueField);
        const positiveFinite = (value: unknown): boolean => isFiniteNumber(value) && value > 0;
        const amplitude = (element[peakField] as number) / 2;
        const checks: Array<[string, boolean]> = [
          ['frequency', positiveFinite(params.period) && positiveFinite(params.rise) && positiveFinite(params.fall)],
          [peakField, isFiniteNumber(params.v1) && isFiniteNumber(params.v2)
            && (element[peakField] === 0 || amplitude !== 0)],
          ['duty_cycle', positiveFinite(params.width)],
          ['phase', isFiniteNumber(params.delay)
            && (((element.phase as number | undefined) ?? 0) === 0 || positiveFinite(params.delay))],
        ];
        for (const [key, valid] of checks) {
          if (!valid) diagnostics.push(importDiagnostic(
            'UNSUPPORTED_PARAMETER', `Square parameter ${key} produces unrepresentable PULSE parameters`,
            `/${index}/${key}`, element,
          ));
        }
      }
    } else if (element.wave_shape !== undefined && element.wave_shape !== 'dc') {
      diagnostics.push(importDiagnostic(
        'UNSUPPORTED_PARAMETER', `Only DC, sinewave and square ${valueField} sources are supported`,
        `/${index}/wave_shape`, element,
      ));
    }
  }
  for (const key of Object.keys(element)) {
    if (allowed.has(key)) continue;
    diagnostics.push(importDiagnostic(
      'UNSUPPORTED_PARAMETER',
      `Unsupported simulation-relevant parameter ${key} on ${String(element.source_component_id)}`,
      `/${index}/${pointerSegment(key)}`,
      element,
    ));
  }
  for (const key of REQUIRED_FIELDS[ftype]) {
    if (element[key] !== undefined) continue;
    diagnostics.push(importDiagnostic(
      'UNSUPPORTED_PARAMETER',
      `Required simulation parameter ${key} is missing on ${String(element.source_component_id)}`,
      `/${index}/${pointerSegment(key)}`,
      element,
    ));
  }
  const numericField = ftype === 'simple_resistor' ? 'resistance'
    : ftype === 'simple_capacitor' ? 'capacitance'
      : ftype === 'simple_inductor' ? 'inductance'
        : ftype === 'simple_voltage_source' ? 'voltage'
          : ftype === 'simple_current_source' ? 'current' : undefined;
  if (numericField && element[numericField] !== undefined && !isFiniteNumber(element[numericField])) {
    diagnostics.push(importDiagnostic(
      'UNSUPPORTED_PARAMETER',
      `Simulation parameter ${numericField} on ${String(element.source_component_id)} must be a finite number`,
      `/${index}/${numericField}`,
      element,
    ));
  }
  if (ftype === 'simple_mosfet' && !['n', 'p'].includes(String(element.channel_type))) {
    diagnostics.push(importDiagnostic(
      'UNSUPPORTED_PARAMETER',
      `Unsupported simulation-relevant parameter channel_type on ${String(element.source_component_id)}`,
      `/${index}/channel_type`,
      element,
    ));
  }
  if (ftype === 'simple_mosfet' && element.mosfet_mode !== undefined && element.mosfet_mode !== 'enhancement') {
    diagnostics.push(importDiagnostic(
      'UNSUPPORTED_PARAMETER',
      `Unsupported simulation-relevant parameter mosfet_mode on ${String(element.source_component_id)}`,
      `/${index}/mosfet_mode`,
      element,
    ));
  }
  if (ftype === 'simple_transistor' && !['npn', 'pnp'].includes(String(element.transistor_type))) {
    diagnostics.push(importDiagnostic(
      'UNSUPPORTED_PARAMETER',
      `Unsupported simulation-relevant parameter transistor_type on ${String(element.source_component_id)}`,
      `/${index}/transistor_type`,
      element,
    ));
  }
}

function validateElementFields(
  element: ElementRecord,
  index: number,
  allowed: ReadonlySet<string>,
  diagnostics: ConversionDiagnosticV1[],
): void {
  for (const key of Object.keys(element)) {
    if (allowed.has(key)) continue;
    diagnostics.push(importDiagnostic(
      'UNSUPPORTED_PARAMETER',
      `Unsupported simulation-relevant parameter ${key} on ${elementId(element) ?? element.type}`,
      `/${index}/${pointerSegment(key)}`,
      element,
    ));
  }
}

export function fromCircuitJSON(circuitJSON: CircuitJson): ConversionResultV1<CircuitIR> {
  const diagnostics: ConversionDiagnosticV1[] = [];
  const records = circuitJSON as ElementRecord[];
  const components: Array<{ component: IRComponent; sourceIndex: number }> = [];
  const sourcePorts = new Map<string, { element: ElementRecord; index: number }>();
  const sourceNets = new Map<string, { name: string; index: number; element: ElementRecord }>();
  const traces: Array<{ element: ElementRecord; index: number }> = [];

  records.forEach((element, index) => {
    const path = `/${index}`;
    if (!isRecord(element) || typeof element.type !== 'string') {
      diagnostics.push(importDiagnostic(
        'UNSUPPORTED_ELEMENT',
        'Unsupported simulation-relevant circuit-json element with no type',
        path,
        isRecord(element) ? element : {},
      ));
      return;
    }

    if (LAYOUT_PREFIXES.some(prefix => (element.type as string).startsWith(prefix))) {
      diagnostics.push(layoutDiagnostic(element, path));
      return;
    }

    if (element.type === 'source_component') {
      const ftype = typeof element.ftype === 'string' ? element.ftype : '';
      const mapping = COMPONENT_MAPPING[ftype];
      if (ftype === 'simple_current_source' && element.wave_shape !== 'sinewave' && element.wave_shape !== 'square' && (
        !isFiniteNumber(element.current)
        || (element.wave_shape !== undefined && element.wave_shape !== 'dc')
        || Object.keys(element).some(key => !COMPONENT_FIELDS.has(key) && !mapping.fields.includes(key))
      )) {
        diagnostics.push(importDiagnostic(
          'UNSUPPORTED_ELEMENT',
          'simple_current_source requires a finite current in amperes and only supports DC without waveform parameters',
          path,
          element,
        ));
        return;
      }
      if (!mapping) {
        diagnostics.push(importDiagnostic(
          'UNSUPPORTED_ELEMENT',
          `Unsupported simulation-relevant circuit-json element source_component/${ftype || 'unknown'}`,
          path,
          element,
        ));
        return;
      }
      validateComponentFields(element, index, ftype, diagnostics);
      if (typeof element.source_component_id !== 'string') {
        diagnostics.push(importDiagnostic(
          'UNSUPPORTED_PARAMETER',
          'source_component requires source_component_id',
          `${path}/source_component_id`,
          element,
        ));
      }
      if (typeof element.name !== 'string') {
        diagnostics.push(importDiagnostic(
          'UNSUPPORTED_PARAMETER',
          'source_component requires name',
          `${path}/name`,
          element,
        ));
      }
      const id = typeof element.source_component_id === 'string' ? element.source_component_id : `invalid_component_${index}`;
      if (components.some(entry => entry.component.id === id)) {
        diagnostics.push(importDiagnostic(
          'UNSUPPORTED_PARAMETER',
          `Duplicate source_component_id ${id}`,
          `${path}/source_component_id`,
          element,
        ));
      }
      const name = typeof element.name === 'string' ? element.name : id;
      components.push({
        sourceIndex: index,
        component: {
          type: mapping.type,
          id,
          name,
          ports: [],
          params: mapping.params(element),
          ...(typeof element.display_value === 'string' ? { displayValue: element.display_value } : {}),
        },
      });
      return;
    }

    if (element.type === 'source_port') {
      validateElementFields(element, index, PORT_FIELDS, diagnostics);
      if (
        typeof element.source_port_id !== 'string'
        || typeof element.source_component_id !== 'string'
        || typeof element.name !== 'string'
      ) {
        diagnostics.push(importDiagnostic(
          'UNSUPPORTED_PARAMETER',
          'source_port requires string source_port_id, source_component_id, and name',
          path,
          element,
        ));
        return;
      }
      if (sourcePorts.has(element.source_port_id)) {
        diagnostics.push(importDiagnostic(
          'UNSUPPORTED_PARAMETER',
          `Duplicate source_port_id ${element.source_port_id}`,
          `${path}/source_port_id`,
          element,
        ));
      }
      sourcePorts.set(element.source_port_id, { element, index });
      return;
    }

    if (element.type === 'source_net') {
      validateElementFields(element, index, NET_FIELDS, diagnostics);
      if (typeof element.source_net_id !== 'string' || typeof element.name !== 'string') {
        diagnostics.push(importDiagnostic('UNSUPPORTED_PARAMETER', 'source_net requires string id and name', path, element));
        return;
      }
      if (sourceNets.has(element.source_net_id)) {
        diagnostics.push(importDiagnostic(
          'UNSUPPORTED_PARAMETER',
          `Duplicate source_net_id ${element.source_net_id}`,
          `${path}/source_net_id`,
          element,
        ));
      }
      sourceNets.set(element.source_net_id, {
        name: element.is_ground === true || element.name === '0' ? '0' : element.name,
        index,
        element,
      });
      return;
    }

    if (element.type === 'source_trace') {
      validateElementFields(element, index, TRACE_FIELDS, diagnostics);
      if (
        typeof element.source_trace_id !== 'string'
        || !Array.isArray(element.connected_source_port_ids)
        || !element.connected_source_port_ids.every(id => typeof id === 'string')
        || !Array.isArray(element.connected_source_net_ids)
        || !element.connected_source_net_ids.every(id => typeof id === 'string')
      ) {
        diagnostics.push(importDiagnostic(
          'UNSUPPORTED_PARAMETER',
          'source_trace requires an id and string port/net id arrays',
          path,
          element,
        ));
        return;
      }
      traces.push({ element, index });
      return;
    }

    diagnostics.push(importDiagnostic(
      'UNSUPPORTED_ELEMENT',
      `Unsupported simulation-relevant circuit-json element ${element.type}`,
      path,
      element,
    ));
  });

  const traceNetsByPort = new Map<string, Set<string>>();
  for (const { element, index } of traces) {
    const portIds = Array.isArray(element.connected_source_port_ids)
      ? element.connected_source_port_ids.filter((id): id is string => typeof id === 'string')
      : [];
    const netIds = Array.isArray(element.connected_source_net_ids)
      ? element.connected_source_net_ids.filter((id): id is string => typeof id === 'string')
      : [];
    const resolvedNames = netIds.flatMap(id => sourceNets.has(id) ? [sourceNets.get(id)!.name] : []);
    if (
      portIds.length === 0
      || portIds.some(id => !sourcePorts.has(id))
      || resolvedNames.length !== 1
      || resolvedNames.length !== netIds.length
    ) {
      diagnostics.push(importDiagnostic(
        'UNSUPPORTED_PARAMETER',
        'source_trace must connect at least one source_port to exactly one known source_net',
        `/${index}`,
        element,
      ));
      continue;
    }
    for (const portId of portIds) {
      const names = traceNetsByPort.get(portId) ?? new Set<string>();
      names.add(resolvedNames[0]);
      traceNetsByPort.set(portId, names);
    }
  }

  const componentById = new Map(components.map(entry => [entry.component.id, entry]));
  for (const { element, index } of sourcePorts.values()) {
    const ownerId = element.source_component_id;
    const portId = element.source_port_id;
    const owner = typeof ownerId === 'string' ? componentById.get(ownerId) : undefined;
    if (!owner) {
      diagnostics.push(importDiagnostic(
        'UNSUPPORTED_PARAMETER',
        'source_port must reference a supported source_component_id',
        `/${index}/source_component_id`,
        element,
      ));
      continue;
    }
    const names = typeof portId === 'string' ? traceNetsByPort.get(portId) : undefined;
    if (!names || names.size !== 1) {
      diagnostics.push(importDiagnostic(
        'UNSUPPORTED_PARAMETER',
        'source_port must resolve through source_trace to exactly one source_net',
        `/${index}`,
        element,
      ));
      continue;
    }
    owner.component.ports.push({
      name: typeof element.name === 'string' ? element.name : String(portId),
      net: [...names][0],
    });
  }

  const orderedDiagnostics = sortDiagnostics(diagnostics);
  const fatal = orderedDiagnostics.some(diagnostic => diagnostic.severity === 'error');
  if (fatal) return { diagnostics: orderedDiagnostics, lossy: true };

  const nets = [...new Set([...sourceNets.values()].map(net => net.name).filter(name => name !== '0'))]
    .sort(compareText);
  return {
    value: { components: components.map(entry => entry.component), nets },
    diagnostics: orderedDiagnostics,
    lossy: orderedDiagnostics.length > 0,
  };
}

function mapExportComponent(
  component: IRComponent,
  index: number,
  diagnostics: ConversionDiagnosticV1[],
): ElementRecord | undefined {
  const base = {
    type: 'source_component',
    source_component_id: component.id,
    name: component.name,
    ...(component.displayValue !== undefined ? { display_value: component.displayValue } : {}),
  };
  let ftype: string;
  let fields: ElementRecord;
  let allowedParams: readonly string[];

  switch (component.type) {
    case 'R':
      ftype = 'simple_resistor';
      fields = { resistance: component.params.resistance };
      allowedParams = ['resistance'];
      if (!isFiniteNumber(component.params.resistance)) {
        diagnostics.push(exportDiagnostic(
          `Parameter resistance on ${component.id} must be a finite number`,
          `/components/${index}/params/resistance`,
          component,
        ));
        return undefined;
      }
      break;
    case 'C':
      ftype = 'simple_capacitor';
      fields = { capacitance: component.params.capacitance };
      allowedParams = ['capacitance'];
      if (!isFiniteNumber(component.params.capacitance)) {
        diagnostics.push(exportDiagnostic(
          `Parameter capacitance on ${component.id} must be a finite number`,
          `/components/${index}/params/capacitance`,
          component,
        ));
        return undefined;
      }
      break;
    case 'L':
      ftype = 'simple_inductor';
      fields = { inductance: component.params.inductance };
      allowedParams = ['inductance'];
      if (!isFiniteNumber(component.params.inductance)) {
        diagnostics.push(exportDiagnostic(
          `Parameter inductance on ${component.id} must be a finite number`,
          `/components/${index}/params/inductance`, component,
        ));
        return undefined;
      }
      break;
    case 'D':
      ftype = 'simple_diode';
      fields = {};
      allowedParams = ['modelName'];
      if (component.params.modelName !== undefined && component.params.modelName !== '') {
        diagnostics.push(exportDiagnostic(
          `Custom diode model on ${component.id} cannot be represented in circuit-json`,
          `/components/${index}/params/modelName`, component,
        ));
        return undefined;
      }
      break;
    case 'V':
    case 'I': {
      ftype = component.type === 'V' ? 'simple_voltage_source' : 'simple_current_source';
      const valueField = component.type === 'V' ? 'voltage' : 'current';
      const peakField = `peak_to_peak_${valueField}`;
      if (component.params.waveform === 'pulse') {
        allowedParams = ['waveform', 'v1', 'v2', 'delay', 'rise', 'fall', 'width', 'period'];
        const params = component.params;
        const period = params.period as number;
        const offset = (params.v1 as number) / 2 + (params.v2 as number) / 2;
        const peakToPeak = (params.v2 as number) - (params.v1 as number);
        fields = {
          [valueField]: offset, wave_shape: 'square', [peakField]: peakToPeak,
          frequency: 1 / period, phase: (params.delay as number) / period * 360,
          duty_cycle: (params.width as number) / period,
        };
        // Re-import must reproduce every timing/level exactly. In particular,
        // equal but noncanonical edges cannot be represented by this schema.
        const reconstructed = sourceParams(fields, valueField);
        const diagnosticCount = diagnostics.length;
        for (const key of allowedParams.slice(1)) {
          if (isFiniteNumber(params[key]) && params[key] === reconstructed[key]
            && (key !== 'period' || period > 0)
            && (key !== 'delay' || (params.delay as number) >= 0)
            && (key !== 'width' || ((params.width as number) > 0 && (params.width as number) < period))
            && (!['rise', 'fall'].includes(key) || (params[key] as number) > 0)) continue;
          diagnostics.push(exportDiagnostic(
            `PULSE parameter ${key} on ${component.id} cannot be represented exactly as a square wave`,
            `/components/${index}/params/${key}`, component,
          ));
        }
        // Even allowLossy must not emit invalid square fields (e.g. Infinity
        // serializes to null). Keep only the independently representable subset.
        if (diagnostics.length !== diagnosticCount) return undefined;
        break;
      }
      if (component.params.waveform === 'sin') {
        allowedParams = ['waveform', 'offset', 'amplitude', 'frequency', 'phase', 'delay', 'damping'];
        const params = component.params;
        for (const key of ['offset', 'amplitude', 'frequency', 'phase', 'delay', 'damping']) {
          const value = params[key] ?? (['phase', 'delay', 'damping'].includes(key) ? 0 : undefined);
          if (isFiniteNumber(value) && (!['delay', 'damping'].includes(key) || value === 0)) continue;
          diagnostics.push(exportDiagnostic(
            `SIN parameter ${key} on ${component.id} cannot be represented in circuit-json`,
            `/components/${index}/params/${key}`, component,
          ));
        }
        const peakToPeak = (params.amplitude as number) * 2;
        if (!Number.isFinite(peakToPeak) && isFiniteNumber(params.amplitude)) {
          diagnostics.push(exportDiagnostic(
            `SIN amplitude on ${component.id} overflows peak-to-peak ${valueField}`,
            `/components/${index}/params/amplitude`, component,
          ));
        }
        fields = { [valueField]: params.offset, wave_shape: 'sinewave', [peakField]: peakToPeak, frequency: params.frequency, phase: params.phase ?? 0 };
        break;
      }
      fields = component.type === 'V' ? { voltage: component.params.dc } : { current: component.params.dc, wave_shape: 'dc' };
      allowedParams = ['waveform', 'dc'];
      if (component.params.waveform !== 'dc' || !isFiniteNumber(component.params.dc)) {
        diagnostics.push(exportDiagnostic(
          `Only a finite DC ${component.type === 'V' ? 'voltage' : 'current'} source on ${component.id} can be represented in circuit-json`,
          `/components/${index}/params/${component.params.waveform !== 'dc' ? 'waveform' : 'dc'}`, component,
        ));
        return undefined;
      }
      break;
    }
    case 'M':
      ftype = 'simple_mosfet';
      fields = {
        channel_type: component.params.channelType,
        mosfet_mode: 'enhancement',
      };
      allowedParams = ['channelType'];
      if (component.params.channelType !== 'n' && component.params.channelType !== 'p') {
        diagnostics.push(exportDiagnostic(
          `Parameter channelType on ${component.id} must be n or p`,
          `/components/${index}/params/channelType`,
          component,
        ));
        return undefined;
      }
      break;
    case 'Q':
      ftype = 'simple_transistor';
      fields = { transistor_type: component.params.type };
      allowedParams = ['type'];
      if (component.params.type !== 'npn' && component.params.type !== 'pnp') {
        diagnostics.push(exportDiagnostic(
          `Parameter type on ${component.id} must be npn or pnp`,
          `/components/${index}/params/type`,
          component,
        ));
        return undefined;
      }
      break;
    default:
      diagnostics.push(exportDiagnostic(
        `Component type ${component.type} cannot be represented in circuit-json`,
        `/components/${index}`,
        component,
      ));
      return undefined;
  }

  for (const key of Object.keys(component.params)) {
    if (allowedParams.includes(key)) continue;
    diagnostics.push(exportDiagnostic(
      `Parameter ${key} on ${component.id} cannot be represented in circuit-json`,
      `/components/${index}/params/${pointerSegment(key)}`,
      component,
    ));
  }

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) continue;
    diagnostics.push(exportDiagnostic(
      `Required parameter ${key} on ${component.id} is missing`,
      `/components/${index}/params/${pointerSegment(allowedParams[0])}`,
      component,
    ));
    return undefined;
  }
  return { ...base, ftype, ...fields };
}

export function toCircuitJSON(
  circuit: CircuitIR,
  options: CircuitJSONExportOptions = {},
): ConversionResultV1<CircuitJson> {
  const diagnostics: ConversionDiagnosticV1[] = [];
  const output: ElementRecord[] = [];
  const converted: Array<{ component: IRComponent; index: number }> = [];
  const componentIds = new Set<string>();

  circuit.components.forEach((component, index) => {
    if (componentIds.has(component.id)) {
      diagnostics.push(exportDiagnostic(
        `Duplicate component id ${component.id} cannot be represented unambiguously in circuit-json`,
        `/components/${index}`,
        component,
      ));
      return;
    }
    componentIds.add(component.id);
    const mapped = mapExportComponent(component, index, diagnostics);
    if (!mapped) return;
    output.push(mapped);
    converted.push({ component, index });
  });

  const netNames = new Set(circuit.nets);
  for (const { component } of converted) {
    for (const port of component.ports) netNames.add(port.net);
  }
  const orderedNets = [...netNames].sort(compareText);
  const netIds = new Map(orderedNets.map((name, index) => [name, `source_net_${index}`]));

  for (const { component, index: componentIndex } of converted) {
    component.ports.forEach((port, portIndex) => {
      const sourcePortId = `source_port_${componentIndex}_${portIndex}`;
      output.push({
        type: 'source_port',
        source_port_id: sourcePortId,
        source_component_id: component.id,
        name: port.name,
      });
      output.push({
        type: 'source_trace',
        source_trace_id: `source_trace_${componentIndex}_${portIndex}`,
        connected_source_port_ids: [sourcePortId],
        connected_source_net_ids: [netIds.get(port.net)],
      });
    });
  }

  orderedNets.forEach((name, index) => {
    output.push({
      type: 'source_net',
      source_net_id: `source_net_${index}`,
      name: name === '0' ? 'GND' : name,
      member_source_group_ids: [],
      ...(name === '0' ? { is_ground: true } : {}),
    });
  });

  const orderedDiagnostics = sortDiagnostics(diagnostics);
  const lossy = orderedDiagnostics.length > 0;
  if (lossy && options.allowLossy !== true) {
    return { diagnostics: orderedDiagnostics, lossy: true };
  }
  return {
    value: output as unknown as CircuitJson,
    diagnostics: orderedDiagnostics,
    lossy,
  };
}

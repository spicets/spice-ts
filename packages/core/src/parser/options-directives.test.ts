import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.js';
import { simulate } from '../simulate.js';
import { parse as parseDeck, parseTitleless as parse } from './index.js';

const ngspiceFixtureRoot = new URL('../../../../benchmarks/corpus/ngspice/fixtures/', import.meta.url);

const outputControlFixtures = [
  ['tests/filters/lowpass.cir', 'aa48cf8809bb62ada7bd48b8d81808589126a69f784482e5fb0c80cc3fbf718d'],
  ['examples/probe/ac-test.cir', '3afb9105918f939cbbdab957f8f872bbc886209fb83dbd27003c605977916479'],
] as const;

const noacctFirstFailureFixtures = [
  ['tests/vbic/FO.cir', 'de57231ef8879e785b07068db662bfa5ecfde8734011b88b09f319b826242e92'],
  ['tests/mos6/mos6inv.cir', 'c1ee39a6f458dc2b527ab1de29d6d6a4858e35c6acc4ff760ac45774512534dc'],
  ['tests/jfet/jfet_vds-vgs.cir', '64d61d79415c585195fcda1a21a170bda67f863e20b9492eaeb33e1efc9fd72a'],
  ['tests/vbic/CEamp.cir', '088d1ebede86588ff8b823ba45219006bfeec34939af69e10c176e23d8a020ab'],
  ['tests/general/rc.cir', '293c22e9953f3e28efcae55d6c00cab0b929d2c3fdf88810ab27b7a71e900bfe'],
  ['tests/general/mosamp.cir', 'a6d0f4220bde7a548209e0e845e3c9bb731b2819f7f7e256d284e5a85e10fa7c'],
  ['tests/mos6/simpleinv.cir', '3ad1ef05a4197b420b0d35b3a4c4c0aa2544025e200b619743a890e305b7e1b8'],
  ['tests/hfet/inverter.cir', '3fa93266e9036443173bf9416eb67e8ff4c2c24aeefc6ef687f355d8548239e1'],
  ['tests/mesa/mesosc.cir', '3cd4609cca7874775b7b2cac8cd0124bd2b8c5512064a0550a29de2da4896bcf'],
  ['tests/general/schmitt.cir', 'c3e897ecd60c66cb5350c2a0fa7788f34af374803c10f4cf58d6f5ed01b00e55'],
] as const;

describe('ngspice option directives', () => {
  it('parses legacy .opt cards while ignoring reporting-only fields', () => {
    const circuit = parse('.opt abstol=1u acct list node lvlcod=2\n.op');

    expect(circuit.simulationOptions).toEqual({ abstol: 1e-6 });
  });

  it.each([
    ['ACCT', '.options ACCT'],
    ['NOACCT', '.options NOACCT'],
    ['noacct', '.options noacct'],
    ['LIMPTS', '.options LIMPTS=5000'],
    ['ITL5', '.options ITL5=0'],
  ])('accepts classic compatibility no-op %s', (_field, card) => {
    expect(parse(`${card}\n.op`).simulationOptions).toEqual({});
  });

  it.each(noacctFirstFailureFixtures)(
    'advances the unchanged NOACCT fixture %s to its next outcome',
    (path, sha256) => {
      const bytes = readFileSync(new URL(path, ngspiceFixtureRoot));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);

      try {
        parseDeck(bytes.toString('utf8'));
      } catch (error) {
        expect(error).toBeInstanceOf(ParseError);
        expect((error as Error).message.toLowerCase()).not.toContain('noacct');
      }
    },
  );

  it.each([
    '.options noacct=1\n.op',
    '.options noincmode nobypass noacct\n.op',
  ])('does not broaden report-only NOACCT into behavior-changing forms: %s', netlist => {
    expect(() => parse(netlist)).toThrow(ParseError);
  });

  it('ignores a stray word after NOACCT that ngspice-47 does not recognise (#790)', () => {
    const circuit = parse('.options noacct yes\n.op');
    expect(circuit.simulationOptions).toEqual({});
    expect(circuit.parseWarnings).toEqual(['Ignored .options fields ngspice-47 does not recognise: yes']);
  });

  it('maps only solver-backed ngspice options to SimulationOptions', () => {
    const circuit = parse(`
.options abstol=2p vntol=3u reltol=4m gmin=5p
+ itl1=11 itl4=12 method=gear trtol=6
V1 in 0 1
R1 in 0 1k
.op
`);

    expect(circuit.simulationOptions).toEqual({
      abstol: 2e-12,
      vntol: 3e-6,
      reltol: 4e-3,
      deviceGmin: 5e-12,
      maxIterations: 11,
      maxTransientIterations: 12,
      integrationMethod: 'gear2',
      trtol: 6,
    });
    expect(circuit.compile().simulationOptions).toEqual(circuit.simulationOptions);
  });

  it('accepts ngspice trap as the trapezoidal integration method', () => {
    expect(parse('.options method=trap\n.op').simulationOptions.integrationMethod)
      .toBe('trapezoidal');
  });

  it('merges repeated cards with the later value winning', () => {
    const circuit = parse('.options reltol=1m\n.options reltol=2m abstol=3p\n.op');
    expect(circuit.simulationOptions).toMatchObject({ reltol: 2e-3, abstol: 3e-12 });
  });

  it('preserves implemented options when serializing a Circuit', () => {
    const circuit = parse('.options reltol=2m itl1=25 method=gear\nV1 in 0 1\n.op');
    const reparsed = parse(circuit.toNetlist());

    expect(reparsed.simulationOptions).toEqual(circuit.simulationOptions);
  });

  it('applies deck options while explicit API options take precedence', async () => {
    const netlist = 'Options precedence test\n.options itl1=0\nV1 in 0 1\nR1 in 0 1k\n.op';

    await expect(simulate(netlist)).rejects.toThrow();
    await expect(simulate(netlist, { maxIterations: 100 })).resolves.toMatchObject({
      dc: expect.anything(),
    });
  });

  it.each([
    '.options method=euler\n.op',
    '.options reltol=not-a-number\n.op',
    '.options reltol=-1m\n.op',
    '.options itl1=1.5\n.op',
    '.options limpts=1.5\n.op',
    '.options itl5=-1\n.op',
  ])('rejects unsupported or invalid option semantics: %s', netlist => {
    expect(() => parse(netlist)).toThrow();
  });

  // ngspice-47 if_option() silently returns for names it does not know (#790).
  it.each([
    ['.options unsupported_option=1\n.op', 'unsupported_option=1'],
    ['.options unsupported_flag\n.op', 'unsupported_flag'],
  ])('ignores option names ngspice-47 does not recognise with a warning: %s', (netlist, field) => {
    const circuit = parse(netlist);
    expect(circuit.simulationOptions).toEqual({});
    expect(circuit.parseWarnings).toEqual([`Ignored .options fields ngspice-47 does not recognise: ${field}`]);
  });
});

describe('Xyce TIMEINT option directives', () => {
  // ngspice-47 has no TIMEINT package (#713): the package keyword is ignored and
  // each field is an ordinary `.options` field, so ABSTOL is the current
  // tolerance only and names ngspice does not know are ignored.
  it.each([
    ['.options timeint reltol=1e-6 abstol=1e-6', { reltol: 1e-6, abstol: 1e-6 }],
    ['.options timeint reltol=1.0e-4', { reltol: 1e-4 }],
    ['.options timeint reltol=1.0e-4 abstol=1e-4 method=7', { reltol: 1e-4, abstol: 1e-4 }],
  ])('maps ngspice option fields from the primitive corpus card: %s', (card, expected) => {
    expect(parse(`${card}\n.op`).simulationOptions).toEqual(expected);
  });

  it.each([
    ['trap', 'trapezoidal'],
    ['7', undefined],
    ['gear', 'gear2'],
    ['8', undefined],
    ['9', undefined],
  ] as const)('reads TIMEINT METHOD=%s as the string-typed ngspice METHOD option', (method, expected) => {
    expect(parse(`.options timeint method=${method}\n.op`).simulationOptions.integrationMethod)
      .toBe(expected);
  });

  it.each([
    ['.options timeint reltol=1e-6 abstol=1e-6 newlte=2', { reltol: 1e-6, abstol: 1e-6 }],
    ['.options timeint delmax=1u', {}],
    ['.options timeint newbpstepping=0', {}],
    ['.options timeint NEWBPSTEPPING=0 newbpstepping=0 reltol=1.0e-4', { reltol: 1e-4 }],
    ['.options timeint newbpstepping=1', {}],
    ['.options timeint newbpstepping', {}],
  ])('ignores Xyce-only TIMEINT fields like ngspice-47: %s', (card, expected) => {
    const circuit = parse(`${card}\n.op`);

    expect(circuit.simulationOptions).toEqual(expected);
    expect(circuit.parseWarnings[0]).toContain('ignored option names it does not recognise');
  });

  it.each([
    '.options timeint method=euler\n.op',
    '.options timeint reltol=-1m\n.op',
    '.options timeint abstol=not-a-number\n.op',
  ])('rejects unsupported or invalid ngspice option values: %s', netlist => {
    expect(() => parse(netlist)).toThrow();
  });
});

describe('ngspice control and output directives', () => {
  it('accepts legacy .width input/output formatting metadata', () => {
    expect(() => parse('.width in=72 out=133\n.op')).not.toThrow();
  });

  it.each([
    '.save v(out)\n.op',
    '.print tran v(out)\n.op',
    '.plot v(out)\n.op',
    '.probe v(out)\n.op',
  ])('explicitly ignores output-only metadata: %s', netlist => {
    expect(() => parse(netlist)).not.toThrow();
  });

  it('keeps every computed AC vector available when .probe requests a subset', async () => {
    const result = await simulate(`Probe output selection
V1 1 0 dc 0 ac 1
R1 1 2 1k
R2 2 0 1k
.ac lin 1 1k 1k
.probe v(2)
.end`);

    expect([...result.ac!.voltages.keys()]).toEqual(['1', '2']);
    expect([...result.ac!.currents.keys()]).toEqual(['V1']);
  });

  // ngspice-47 treats a bare .probe as `.probe alli`, and if_option() ignores
  // POST/TRANS (with or without a value) and any other name it does not know (#790).
  it.each([
    ['.probe', []],
    ['.options post=1\n.op', ['Ignored .options fields ngspice-47 does not recognise: post=1']],
    ['.options trans=1\n.op', ['Ignored .options fields ngspice-47 does not recognise: trans=1']],
    ['.options post enabled\n.op', ['Ignored .options fields ngspice-47 does not recognise: enabled']],
  ])('accepts output-control forms ngspice-47 runs: %s', (netlist, warnings) => {
    const circuit = parse(netlist);
    expect(circuit.simulationOptions).toEqual({});
    expect(circuit.parseWarnings).toEqual(warnings);
  });

  it('accepts only bare POST and TRANS reporting flags', () => {
    expect(parse('.options list node post trans noacct\n.op').simulationOptions).toEqual({});
  });

  it('advances both unchanged output-control fixtures to their next honest outcome', async () => {
    const [lowpassFixture, probeFixture] = outputControlFixtures.map(([path, sha256]) => {
      const bytes = readFileSync(new URL(path, ngspiceFixtureRoot));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
      return bytes.toString('utf8');
    });

    const lowpass = await simulate(lowpassFixture!);
    expect(lowpass.dc).toBeDefined();
    expect(lowpass.ac?.frequencies).toHaveLength(31);

    const probe = await simulate(probeFixture!);
    expect(probe.ac?.frequencies).toHaveLength(16);
    expect([...probe.ac!.voltages.keys()]).toEqual(['1', '2', '3']);
  });

  it.each([
    '.temp 27 77\n.op',
    '.control\nspec 10 1000 10 v(1)\n.endc',
  ])('rejects unsupported semantic/control directives: %s', netlist => {
    expect(() => parse(netlist)).toThrow();
  });
});

describe('ngspice .control/.endc contract', () => {
  const deck = (control: string) => `V1 1 0 dc 0 ac 1
R1 1 2 1k
C1 2 0 1u
.ac dec 2 10 1k
.control
${control}
.endc`;

  it.each([
    'run',
    'display',
    'print vd_r2/i(r2)',
    'plot mag(v(2))',
    'asciiplot v(2)',
    'echo done',
    'listing',
    'quit',
    'exit',
    'RUN\nPrint v(2)\nQUIT 0',
  ])('accepts run and output-only commands without changing results: %s', async control => {
    const reference = await simulate(`Control contract\n${deck('').replace('.control\n\n.endc', '')}`);
    const withControl = await simulate(`Control contract\n${deck(control)}`);

    expect(withControl.ac!.frequencies).toEqual(reference.ac!.frequencies);
    expect(withControl.ac!.voltages.get('2')).toEqual(reference.ac!.voltages.get('2'));
  });

  it('accepts an empty control block and multiple control blocks', () => {
    expect(() => parse(`${deck('')}\n.control\nprint v(2)\n.endc`)).not.toThrow();
  });

  it.each([
    ['measure ac gain max vm(2)', 'measure'],
    ['remcirc', 'remcirc'],
    ['spec 10 1000 10 v(2)', 'spec'],
  ])('rejects an unexecuted control command %s with a structured error at parse time', (control, command) => {
    let error: unknown;
    try {
      parse(deck(`print v(2)\n${control}`));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ParseError);
    expect((error as ParseError).line).toBe(7);
    expect((error as ParseError).message).toContain(`Unsupported .control command '${command}'`);
  });

  it('does not parse control-language lines as devices', () => {
    // `run`, `display` and `print` would otherwise be read as R/D/P elements.
    const circuit = parse(deck('run\ndisplay'));
    expect(circuit.compile().devices.map(device => device.name)).toEqual(['V1', 'R1', 'C1']);
  });

  it.each([
    ['.control\nrun', "Unterminated .control block: missing '.endc'"],
    ['.control\n.control\n.endc', "Nested '.control' blocks are not supported"],
    ['.control extra\n.endc', "Unsupported .control arguments: 'extra'"],
    ['.control\n.endc extra', "Unsupported .endc arguments: 'extra'"],
  ])('rejects malformed control block structure: %s', (netlist, message) => {
    expect(() => parse(`V1 1 0 1\nR1 1 0 1k\n.op\n${netlist}`)).toThrow(ParseError);
    expect(() => parse(`V1 1 0 1\nR1 1 0 1k\n.op\n${netlist}`)).toThrow(message);
  });
});

describe('Gnucap control and output directives', () => {
  it.each([
    '.list',
    '.width out=132',
    '.stat',
    '.stat notime',
    '.status',
    '.status notime',
  ])('accepts the bounded output-only directive as a no-op: %s', directive => {
    const circuit = parse(`${directive}\nV1 in 0 1\nR1 in 0 1k\n.op`);

    expect(circuit.compile().analyses).toEqual([{ type: 'op' }]);
    expect(circuit.simulationOptions).toEqual({});
  });

  it.each([
    '.list devices',
    '.width',
    '.width out=-1',
    '.width columns=80',
    '.stat timing',
    '.status verbose',
  ])('rejects unclassified output-directive forms: %s', directive => {
    expect(() => parse(`${directive}\n.op`)).toThrow(ParseError);
  });

  it('supports the singular .option spelling and output-only Gnucap fields', () => {
    const circuit = parse(`
.option method=gear nopage acct list node outwidth=80 phase=radians lvlcod=2
.op
`);

    expect(circuit.simulationOptions).toEqual({ integrationMethod: 'gear2' });
  });

  it('accepts a bare .option or .options display request as output-only', () => {
    expect(parse('.option\n.op').simulationOptions).toEqual({});
    expect(parse('.options\n.op').simulationOptions).toEqual({});
  });

  it.each([
    ['rstray', 'rstray'],
    ['cstray', 'cstray'],
    ['noincmode', 'noincmode'],
    ['nobypass', 'nobypass'],
    ['dampstrategy=11', 'dampstrategy'],
    ['trsteporder=1', 'trsteporder'],
    ['itermin=99', 'itermin'],
  ])('rejects behavior-changing Gnucap option field %s explicitly', (field, name) => {
    try {
      parse(`V1 in 0 1\n.option ${field}\n.op`);
      throw new Error('expected parsing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect(error).toMatchObject({ line: 2, context: `.option ${field}` });
      expect((error as Error).message).toContain(`Unsupported behavior-changing .options field: '${name}'`);
    }
  });

  it.each([
    ['.op trace iter', { type: 'op' }],
    ['.tran 1n 10n trace all', { type: 'tran', timestep: 1e-9, stopTime: 1e-8 }],
    [
      '.tran 1n 10n 0 0.5n uic trace rejected',
      {
        type: 'tran', timestep: 1e-9, stopTime: 1e-8, startTime: 0,
        maxTimestep: 0.5e-9, useInitialConditions: true,
      },
    ],
  ])('accepts bounded output-only analysis tracing: %s', (directive, expected) => {
    expect(parse(directive).compile().analyses).toEqual([expected]);
  });

  it.each([
    '.op rejected',
    '.op trace all',
    '.op trace',
    '.tran 1n 10n rejected',
    '.tran 1n 10n trace iter',
    '.tran 1n 10n trace rejected extra',
    '.tran 1n 10n 0 0.5n extra',
  ])('rejects unsupported analysis control arguments: %s', directive => {
    expect(() => parse(directive)).toThrow(ParseError);
  });
});
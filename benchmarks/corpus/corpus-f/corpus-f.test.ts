import assert from 'node:assert/strict';
import './metric-performance.test.js';
import './noise-reference.test.js';
import './control-sp.test.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { existingCorpusIdentity, renderSources, selectDecks, type CorpusFManifest } from './ingest.js';
import {
  classifyNgspiceFailure,
  companionReferences,
  declaredAnalyses,
  firstNgspiceErrorLine,
  fixtureId,
  gapBucket,
  hostCommand,
  corpusFPlotType,
  CURRENT_PEAK_FLOOR,
  MATCH_THRESHOLD,
  needsExternalInput,
  NGSPICE_ABSTOL,
  NGSPICE_VNTOL,
  normalizedSignalErrors,
  pairedReferenceSeries,
  outcome,
  PEAK_FLOOR,
  peakFloor,
  scoredPlotTypes,
  VOLTAGE_PEAK_FLOOR,
  thirdPartyNotice,
} from './lib.js';
import { type FixtureOutcome, mergeReadme, outcomeDigest, packExecution, referenceSelection, renderMarkdown, runBoundedSimulate, runFixture, summarize, unpackExecution, type CorpusFReport } from './outcomes.js';
import { batchControlPlots, controlPlotAnalyses, runCorpusFSpiceTs, sensitivitySignalName } from './plot-adapter.js';
import { asPacked, compareInBatches, lazyExecution, PACKED_SAMPLES, packEncoded, samples } from './packed.js';
import { PACKED_COLUMNS, parseRawLines, parseRawLinesInto } from './raw-stream.js';
import { parseNgspiceRaw } from '../../comparison-harness.js';
import { analysisType, OBJECT_SAMPLES, type ClassicCircuit, type EngineExecution } from '../classic/report.js';
import { compareExecutions } from '../../aggregate-report.js';
import { CONTROL_SECTION, controlExportDiagnostics, controlWrapperDeck, hasControlBlock, noReferenceNote, renderControlSection, runControlReference, trackingIssue } from './control-vectors.js';

const ROOT = 'benchmarks/corpus/corpus-f';
const HAS_NGSPICE = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).status === 0;
const HAS_CORE_DIST = existsSync('packages/core/dist/index.js');

describe('corpus-f control wrapper (#521)', () => {
  it('passes the resolver through classic, extra and mixed simulate paths (#1548)', { skip: !HAS_CORE_DIST }, async () => {
    const input = Buffer.from('resolver\nv1 in 0 ac 1\n.include model.inc\n.control\nac lin 2 10 20\nsens v(out) ac lin 2 10 20\n.endc\n.end\n');
    for (const analyses of [['ac'], ['sens'], ['ac', 'sens']]) {
      const paths: string[] = [];
      const circuit = { analyses, sourcePath: 'upstream/not-the-cwd/deck.cir' } as ClassicCircuit;
      const execution = await runCorpusFSpiceTs(input, circuit, OBJECT_SAMPLES, {
        resolveInclude: async path => {
          paths.push(path);
          return 'r1 in out 1k\nr2 out 0 1k\n';
        },
      });
      assert.equal(execution.status, 'success', execution.error);
      assert.deepEqual(paths, analyses.length === 2 ? ['model.inc', 'model.inc'] : ['model.inc']);
      assert.equal(execution.analyses.length, analyses.length);
    }
  });

  it('resolves absent xfer companions in the bounded run (#1548)', { skip: !HAS_NGSPICE || !HAS_CORE_DIST }, async () => {
    const manifest = JSON.parse(await readFile(`${ROOT}/manifest.json`, 'utf8')) as CorpusFManifest;
    const circuit = manifest.circuits.find(c => c.id === 'examples-rf-sp-file-cir')!;
    assert.equal(sha256(await readFile(circuit.localPath)), '2cc8b6d32c958f320a1f6b3b47995ef654a46559bb224d16de61a7f198779402');
    const fixture = await runFixture({ ...circuit, analyses: scoredPlotTypes(circuit) }, runControlReference);
    assert.equal(fixture.spiceTs.status, 'success', JSON.stringify(fixture));
    assert.ok(fixture.comparedAnalyses > 0);
    assert.ok(fixture.comparedSignals > 0);
    assert.equal(fixture.outcome, 'matched');
  });

  it('selects batch final plots without changing explicit, multiple-raw or non-dot identities (#1423)', () => {
    const deck = 'toy\n.dc V1 0 1 .1\n.control\nrepeat 10\nrun\nend\n.endc\n.end';
    const own = [1, 2, 10].map(n => ({ type: 'dc' as const, plotName: 'DC transfer characteristic', plotId: `dc${n}` }));
    const raw = [{ type: 'dc' as const, plotName: 'DC transfer characteristic' }];
    assert.deepEqual(batchControlPlots(deck, own, raw), { candidate: [own[2]], reference: [{ ...raw[0], plotId: 'dc10' }] });
    for (const [text, reference] of [
      [deck, own], // source/write exports
      [deck, [...raw, ...raw]], // repeated batch dot cards
      [deck.replace('.dc V1 0 1 .1\n', ''), raw], // control-only commands
      ['toy\n.dc V1 0 1 .1\n.end', raw], // no control block
    ] as const) {
      assert.deepEqual(batchControlPlots(text, own, reference), { candidate: own, reference });
    }
    assert.deepEqual(own.map(p => p.plotId), ['dc1', 'dc2', 'dc10']);
    assert.equal('plotId' in raw[0], false);
  });
  it('pairs the final control run with the final batch dot-card plot (#1423)', { skip: !HAS_NGSPICE || !HAS_CORE_DIST }, async () => {
    const data = await manifest();
    const circuit = data.circuits.find(c => c.sourcePath === 'examples/various/param_sweep.cir')!;
    const batch = await runFixture(circuit, undefined, { fineReference: false });
    assert.equal(batch.outcome, 'matched');
    assert.ok(batch.worstNormalizedError! <= MATCH_THRESHOLD);
    assert.equal(batch.comparedAnalyses, 1);
    // The source/write supplement still scores every retained plot by its real ID.
    const retained = await runFixture(circuit, runControlReference);
    assert.equal(retained.outcome, 'matched');
    assert.equal(retained.comparedAnalyses, 10);
  });
  it('skips only paired unwritable exports and preserves other errors (#1356)', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'corpus-f-export-'));
    const warning = 'Warning from checkvalid: vector @r1[i] is not available or has zero length.';
    const message = "Error during 'write': no writable vector found.";
    try {
      await writeFile(resolve(directory, 'ac1.export-log'), `${warning}\n`);
      await writeFile(resolve(directory, 'ac2.export-log'), `${warning}\nError: unrelated export failure\n`);
      await writeFile(resolve(directory, 'ac2.raw'), 'existing raw data');
      await writeFile(resolve(directory, 'noise1.export-log'), 'Error: unrelated noise export failure\n');
      const diagnostics = await controlExportDiagnostics(directory, `Error: analysis failed\n${message}\n${message}`);
      assert.match(diagnostics.note ?? '', /ac1/);
      assert.doesNotMatch(diagnostics.note ?? '', /ac2|noise1/);
      assert.equal(diagnostics.output.split(message).length - 1, 1);
      assert.match(diagnostics.output, /Error: analysis failed/);
      assert.match(diagnostics.output, /Error: unrelated export failure/);
      assert.match(diagnostics.output, /Error: unrelated noise export failure/);
      assert.match(diagnostics.output, /Warning from checkvalid/);
      const unpaired = await controlExportDiagnostics(directory, 'Error: analysis failed');
      assert.equal(unpaired.note, undefined);
      assert.match(unpaired.output, /Warning from checkvalid/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('recovers writable control plots and reports the skipped plot (#1356)', { skip: !HAS_NGSPICE }, async () => {
    const input = Buffer.from('empty AC export\nV1 in 0 dc 1 ac 1\nR1 in out 1k\nR2 out 0 1k\n.save @r1[i] v(out)\n.control\nop\nac dec 2 1 10\n.endc\n.end\n');
    const before = Buffer.from(input);
    const circuit = { localPath: 'toy.cir', analyses: ['op', 'ac'] } as CorpusFManifest['circuits'][number];
    const reference = await runControlReference(input, circuit);
    assert.equal(reference.status, 'success');
    assert.deepEqual(reference.execution.analyses.map(a => a.plotId), ['op1']);
    assert.match(reference.note ?? '', /ac1.*unavailable or zero-length vector/);
    assert.deepEqual(input, before);
    const fixture: FixtureOutcome = {
      id: 'toy.cir', sourcePath: 'toy.cir', sha256: sha256(input), analyses: ['op', 'ac'],
      unmappedAnalyses: [], sameNameAs: [],
      ngspice: { status: 'success', analyses: ['op'], note: reference.note },
      spiceTs: { status: 'failed', analyses: [], firstErrorLine: 'candidate failure' },
      comparedAnalyses: 0, comparedSignals: 0, worstNormalizedError: null,
      worstSignal: null, outcome: 'spice-ts-loss', gapBucket: null,
    };
    assert.match(renderControlSection([fixture], 'test-head', 'ngspice-47'), /Skipped reference plot exports: ac1/);
  });
  it('sources a separate unchanged fixture and exports every retained plot', () => {
    assert.equal(controlWrapperDeck(['dc', 'dc', 'ac']), '* corpus-f unmodified-fixture export wrapper\n.control\nalias quit echo corpus-f: deck quit deferred until export\nalias exit echo corpus-f: deck exit deferred until export\nsource fixture.cir\nforeach exported_plot $plots\nsetplot $exported_plot\nwrite {$exported_plot}.raw all >& {$exported_plot}.export-log\nend\n.endc\n.end\n');
    assert.equal(hasControlBlock('.control in title\n.op\n.end\n'), false);
    assert.equal(hasControlBlock('title\n .CONTROL\nop\n.endc\n'), true);
  });
  it('exports control-only op/DC vectors without changing the fixture', { skip: !HAS_NGSPICE }, async () => {
    const input = Buffer.from('control toy\nV1 1 0 1\nR1 1 2 1k\nR2 2 0 1k\n.control\nop\ndc V1 0 1 0.5\n.endc\n.end\n');
    const before = sha256(input);
    const circuit = { localPath: 'toy.cir', analyses: ['op', 'tran', 'dc'] } as CorpusFManifest['circuits'][number];
    const result = await runControlReference(input, circuit);
    assert.equal(result.status, 'success');
    assert.deepEqual(result.execution.analyses.map(analysis => analysis.type), ['op', 'dc']);
    const dc = result.execution.analyses[1].series;
    assert.deepEqual(dc.grid, [0, 0.5, 1]);
    assert.deepEqual(dc.signals['v(2)'].map(value => value.re), [0, 0.25, 0.5]);
    assert.equal(sha256(input), before);
  });
  it('exports vectors from a deck whose control block ends with quit or exit (#528)', { skip: !HAS_NGSPICE }, async () => {
    const circuit = { localPath: 'toy.cir', analyses: ['op', 'tran'] } as CorpusFManifest['circuits'][number];
    for (const stop of ['quit', 'quit 1', 'exit']) {
      const input = Buffer.from(`quit toy\nV1 1 0 1\nR1 1 2 1k\nR2 2 0 3k\n.control\nop\ntran 1u 3u\n${stop}\necho never-reached-before-528\n.endc\n.end\n`);
      const before = sha256(input);
      const result = await runControlReference(input, circuit);
      assert.equal(result.status, 'success', stop);
      assert.deepEqual(result.execution.analyses.map(analysis => analysis.type), ['op', 'tran'], stop);
      assert.equal(result.execution.analyses[0].series.signals['v(2)'][0].re, 0.75, stop);
      assert.equal(result.note, undefined, stop);
      assert.equal(sha256(input), before, stop);
    }
  });
  it('does not score a deck that leaves no plot of its analysis type as a match', { skip: !HAS_NGSPICE }, async () => {
    const circuit = { localPath: 'toy.cir', analyses: ['op'] } as CorpusFManifest['circuits'][number];
    const result = await runControlReference(Buffer.from('destroy toy\nV1 1 0 1\nR1 1 0 1k\n.control\nop\ndestroy op1\n.endc\n.end\n'), circuit);
    assert.deepEqual(result.execution.analyses, []);
    assert.equal(result.status, 'success');
    assert.match(result.note ?? '', /no plot of a declared analysis type/);
    assert.equal(outcome({ ngspice: result.status, spiceTs: 'success', comparedAnalyses: 0, spiceTsAnalyses: 1, worstNormalized: null, missingSignals: 0 }), 'not-compared');
  });
  it('names why a successful ngspice run left no reference (#528)', () => {
    assert.match(noReferenceNote({ analyses: [], unmappedAnalyses: ['sens', 'sens'] }), /runs only sens analyses, which the comparison adapter does not map/);
    assert.match(noReferenceNote({ analyses: ['tran'], unmappedAnalyses: [] }, ['tran.raw (ERR_STRING_TOO_LONG)']), /tran\.raw \(ERR_STRING_TOO_LONG\) could not be read/);
    assert.match(noReferenceNote({ analyses: ['op'], unmappedAnalyses: [] }), /no plot of a declared analysis type was left to write/);
  });
  it('reports ngspice source failures rather than inventing a reference', { skip: !HAS_NGSPICE }, async () => {
    const circuit = { localPath: 'toy.cir', analyses: ['op'] } as CorpusFManifest['circuits'][number];
    const result = await runControlReference(Buffer.from('invalid toy\nQ1 1 0 0 missing_model\n.control\nop\n.endc\n.end\n'), circuit);
    assert.notEqual(result.status, 'success');
    assert.deepEqual(result.execution.analyses, []);
    assert.ok(result.firstErrorLine);
  });
});

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function manifest(): Promise<CorpusFManifest> {
  return JSON.parse(await readFile(resolve(ROOT, 'manifest.json'), 'utf8')) as CorpusFManifest;
}

describe('corpus-f spice-ts child transport', () => {
  it('round-trips an execution through packed Float64Arrays bit-for-bit', () => {
    const execution = {
      status: 'success' as const,
      convergence: 'converged' as const,
      analyses: [
        { type: 'tran' as const, plotName: 'tran1', series: { grid: [0, 1e-9, 0.1 + 0.2], signals: { 'v(1)': [{ re: 1 / 3, im: 0 }, { re: -0, im: 0 }, { re: Number.NaN, im: 0 }] } } },
        { type: 'ac' as const, plotName: 'ac1', series: { grid: [1, 10], signals: { 'v(2)': [{ re: 5e-300, im: -2.5 }, { re: 1e300, im: Number.MIN_VALUE }] } } },
      ],
    };
    assert.deepEqual(unpackExecution(deserialize(serialize(packExecution(execution))) as ReturnType<typeof packExecution>), execution);
    const failed = { status: 'failed' as const, convergence: 'not-run' as const, analyses: [], error: 'boom' };
    assert.deepEqual(unpackExecution(packExecution(failed)), failed);
  });
});

describe('corpus-f deck classification', () => {
  it('reads dot-card and control-block analyses but never the title line', () => {
    const deck = '.tran in the title\nV1 1 0 1\n.op\n.AC dec 10 1 1k\n.control\ntran 1n 1u\nsens v(1)\n.endc\n.end\n';
    assert.deepEqual(declaredAnalyses(deck), { mapped: ['op', 'ac', 'tran'], unmapped: ['sens'] });
    assert.deepEqual(declaredAnalyses('title\n* .tran 1 2\nR1 1 0 1\n.end\n'), { mapped: [], unmapped: [] });
  });

  it('defers decks that need companion files or compiled OSDI models', () => {
    assert.equal(needsExternalInput('t\n.include models.lib\n'), '.include models.lib');
    assert.equal(needsExternalInput('t\n.control\npre_osdi ../x.osdi\n.endc\n'), 'pre_osdi ../x.osdi');
    assert.match(needsExternalInput('t\nN1 1 0 rmodel w=1u\n') ?? '', /OSDI device N1/);
    assert.equal(needsExternalInput('t\n.control\nnoise v(1) v1 dec 10 1 1k\n.endc\n'), undefined);
    const files = new Set(['examples/a/deck.cir', 'examples/a/stim.txt', 'examples/b/model.mod']);
    assert.deepEqual(companionReferences('t\na1 [1] filesource input_file="stim.txt"\n.inc ../b/model.mod\n', 'examples/a/deck.cir', files), [
      'examples/a/stim.txt',
      'examples/b/model.mod',
    ]);
  });

  it('flags host commands and third-party notices', () => {
    assert.equal(hostCommand('t\n.control\nrun\n  shell ls\n.endc\n'), 'shell ls');
    assert.equal(hostCommand('t\n.control\nrun\nplot v(1)\n.endc\n'), undefined);
    assert.equal(thirdPartyNotice('t\n* Copyright 1993 by Analog Devices, Inc.\n'), 'Copyright 1993 by Analog Devices, Inc.');
    assert.equal(thirdPartyNotice('t\nR1 1 0 1\n'), undefined);
  });

  it('flags (c), (C) and © copyright marks but not a node named c', () => {
    assert.equal(thirdPartyNotice('t\n* David Zan, (c) 2017/03/02 Preliminary\n'), 'David Zan, (c) 2017/03/02 Preliminary');
    assert.equal(thirdPartyNotice('t\n* (C) National Semiconductor, Inc.\n'), '(C) National Semiconductor, Inc.');
    assert.equal(thirdPartyNotice('t\n* © 2017 Example Corp.\n'), '© 2017 Example Corp.');
    assert.equal(thirdPartyNotice('t\n*©2017 Example Corp.\n'), '©2017 Example Corp.');
    assert.equal(thirdPartyNotice('t\n.control\nplot v(in) v(b) v(c) v(vp)\n.endc\n'), undefined);
    assert.equal(thirdPartyNotice('t\nB1 1 0 v=(c)*2\n'), undefined);
  });

  it('derives stable path ids', () => {
    assert.equal(fixtureId('examples/xspice/various/xspice_c1.cir'), 'examples-xspice-various-xspice-c1-cir');
  });

  it('selects in path order, deduplicates by content, and keeps exclusions with reasons', () => {
    const deck = Buffer.from('t\nR1 1 0 1\nV1 1 0 1\n.op\n.end\n');
    const { circuits, exclusions } = selectDecks(
      [
        { sourcePath: 'tests/b.cir', bytes: deck },
        { sourcePath: 'tests/a.cir', bytes: deck },
        { sourcePath: 'tests/known.cir', bytes: Buffer.from('known\n.op\n') },
        { sourcePath: 'tests/lib.cir', bytes: Buffer.from('t\n.subckt x 1 2\nR1 1 2 1\n.ends\n') },
      ],
      new Set(['tests/a.cir', 'tests/b.cir', 'tests/known.cir', 'tests/lib.cir']),
      { hashes: new Set([sha256('known\n.op')]), ngspicePaths: new Set(), names: new Map([['a.cir', ['benchmarks/corpus/classic/fixtures/a.cir']]]) },
    );
    assert.deepEqual(circuits.map(circuit => circuit.sourcePath), ['tests/a.cir']);
    assert.deepEqual(circuits[0].sameNameAs, ['benchmarks/corpus/classic/fixtures/a.cir']);
    assert.deepEqual(exclusions.map(exclusion => [exclusion.sourcePath, exclusion.reason]), [
      ['tests/b.cir', 'duplicate-content'],
      ['tests/known.cir', 'already-in-corpus'],
      ['tests/lib.cir', 'no-analysis'],
    ]);
  });
});

describe('corpus-f outcome rules', () => {
  it('extracts the first ngspice error line and classifies it', () => {
    const output = 'Circuit: t\nWarning: something\nError on line 3 :\n  q1 1 2 3 nomodel\nError: unknown device type\n';
    assert.equal(firstNgspiceErrorLine(output), 'Error on line 3 :');
    assert.equal(classifyNgspiceFailure(output), 'unsupported');
    assert.equal(classifyNgspiceFailure('doAnalyses: TRAN:  Timestep too small'), 'failed');
  });

  it('buckets spice-ts failures by their own error text', () => {
    assert.equal(gapBucket(undefined, 'success'), undefined);
    assert.equal(gapBucket("Parse error at line 19: Unsupported .control command 'dc': only bare", 'unsupported'), "control: analysis commands inside .control (tran/dc/op/ac/...)");
    assert.equal(gapBucket("Parse error at line 3: Unsupported .control command 'set': only bare", 'unsupported'), 'control: ngspice control-language scripting (set/let/save/foreach/meas/...)');
    assert.equal(gapBucket("Parse error at line 4: Unsupported device card: 'A' a1 1 2 gain_block", 'unsupported'), 'device: XSPICE A-element code models');
    assert.equal(gapBucket("Parse error at line 4: Unsupported dot command: '.global' .global vdd", 'unsupported'), 'directive: .global');
    assert.equal(gapBucket("MOSFET 'MNA0' (model 'Nmod') uses unsupported LEVEL=8 VERSION=3.2.2 (supported versions: 3.3)", 'unsupported'), 'model: BSIM3 revisions other than 3.3 (VERSION=3.0/3.1/3.2.x)');
    assert.equal(gapBucket("Device 'MNA0' uses unsupported model parameter 'NQSMOD': the BSIM3 non-quasi-static (NQS) charge model is not implemented", 'unsupported'), 'model: BSIM3 non-quasi-static model (NQSMOD=1)');
    assert.equal(gapBucket("MOSFET 'M1' (model 'n1') uses unsupported model LEVEL=54 (supported MOSFET levels: 1, 6, 8, 49)", 'unsupported'), 'model: BSIM4 (LEVEL=14/54)');
    assert.equal(gapBucket('weird', 'unsupported'), 'parse: other unsupported syntax');
    assert.equal(gapBucket('spice-ts exceeded the 120000 ms aggregate execution bound', 'failed'), 'timeout: spice-ts exceeded the 120 s bound');
    assert.equal(gapBucket('Transient analysis: timestep too small at t=1e-9', 'failed'), 'convergence');
  });

  it('normalises errors to the ngspice peak and applies one threshold to every fixture', () => {
    const reference = { grid: [0, 1], signals: { 'v(1)': [{ re: 0, im: 0 }, { re: 10, im: 0 }], 'v(2)': [{ re: 0, im: 0 }, { re: 0, im: 0 }] } };
    const compared = (max: number) => ({ status: 'compared' as const, sampleCount: 2, absoluteError: { max, rms: max }, relativeError: { max: null, rms: null, sampleCount: 0, excludedZeroReferences: 2 } });
    const { errors, missing } = normalizedSignalErrors(
      [{ analysis: 'tran', metrics: { grid: { spiceTsPoints: 2, ngspicePoints: 2, alignedPoints: 2, excludedOutOfRange: 0 }, signals: { 'v(1)': compared(0.05), 'v(2)': compared(0) } } }],
      () => reference,
    );
    assert.equal(missing, 0);
    assert.deepEqual(errors.map(error => [error.signal, error.normalized]), [['v(1)', 0.005], ['v(2)', 0]]);
    const base = { ngspice: 'success' as const, spiceTs: 'success' as const, comparedAnalyses: 1, spiceTsAnalyses: 1, missingSignals: 0 };
    assert.equal(outcome({ ...base, worstNormalized: MATCH_THRESHOLD }), 'matched');
    assert.equal(outcome({ ...base, worstNormalized: MATCH_THRESHOLD * 1.01 }), 'mismatch');
    assert.equal(outcome({ ...base, comparedAnalyses: 0, worstNormalized: null }), 'not-compared');
    assert.equal(outcome({ ...base, spiceTs: 'unsupported', worstNormalized: null }), 'spice-ts-loss');
    assert.equal(outcome({ ...base, ngspice: 'failed', worstNormalized: null }), 'ngspice-failed');
    assert.equal(outcome({ ...base, ngspice: 'failed', spiceTs: 'failed', worstNormalized: null }), 'both-failed');
  });

  it('normalises .noise integrated totals by their own ngspice value, not the floor (#774)', () => {
    // ngspice-47 .noise emits two plots of type noise; the totals exist only in the second one.
    const complex = (values: number[]) => values.map(re => ({ re, im: 0 }));
    const spectrum = (scale: number) => ({ grid: [1, 10], signals: { inoise_spectrum: complex([2e-6 * scale, 1e-6 * scale]), onoise_spectrum: complex([3e-9 * scale, 2e-9 * scale]) } });
    const totals = (input: number, output: number) => ({ grid: [0], signals: { 'v(inoise_total)': complex([input]), 'v(onoise_total)': complex([output]) } });
    const ngspice = { analyses: [
      { type: 'noise' as const, plotName: 'Noise Spectral Density Curves', series: spectrum(1) },
      { type: 'noise' as const, plotName: 'Integrated Noise', series: totals(163.7749495863544, 2.5e-3) },
    ] };
    const relative = 1.74e-7;
    const spiceTs = { analyses: [
      { type: 'noise' as const, plotName: 'Noise Spectral Density Curves', series: spectrum(1 + relative) },
      { type: 'noise' as const, plotName: 'Integrated Noise', series: totals(163.7749495863544 * (1 + relative), 2.5e-3 * (1 + relative)) },
    ] };
    const comparisons = compareExecutions(
      { status: 'success', analyses: spiceTs.analyses } as unknown as EngineExecution,
      { status: 'success', analyses: ngspice.analyses } as unknown as EngineExecution,
    );
    assert.equal(comparisons.length, 2);
    const { errors, missing } = normalizedSignalErrors(comparisons, pairedReferenceSeries(spiceTs, ngspice));
    assert.equal(missing, 0);
    const scored = Object.fromEntries(errors.map(error => [error.signal, error]));
    assert.deepEqual(Object.keys(scored).sort(), ['inoise_spectrum', 'onoise_spectrum', 'v(inoise_total)', 'v(onoise_total)']);
    // Every signal, totals included, is scored relative to its own ngspice value: about 1.74e-7.
    for (const error of errors) assert.ok(Math.abs(error.normalized - relative) < 1e-12, `${error.signal}: ${error.normalized}`);
    assert.equal(scored['v(inoise_total)'].ngspicePeak, 163.7749495863544);
    assert.equal(scored['v(onoise_total)'].ngspicePeak, 2.5e-3);
    // The pre-#774 first-plot-of-type lookup divided the 2.85e-5 total error by the 1e-4 floor.
    const firstPlot = normalizedSignalErrors(comparisons, analysis => ngspice.analyses.find(candidate => candidate.type === analysis)?.series);
    const before = firstPlot.errors.find(error => error.signal === 'v(inoise_total)');
    assert.ok(before && before.ngspicePeak === 0 && before.normalized > MATCH_THRESHOLD, JSON.stringify(before));
  });

  it('scores zero and near-zero ngspice peaks against the ngspice VNTOL/ABSTOL absolute floor (#593)', () => {
    const zeros = [{ re: 0, im: 0 }, { re: 0, im: 0 }];
    const tiny = [{ re: 0, im: 0 }, { re: 1e-4, im: 0 }];
    const reference = { grid: [0, 1], signals: { 'v(2)': zeros, 'v(8)': tiny, 'i(vs)': zeros, onoise_spectrum: zeros, 'v(pole(1))': zeros, 'v(big)': [{ re: 0, im: 0 }, { re: 5, im: 0 }] } };
    const compared = (max: number) => ({ status: 'compared' as const, sampleCount: 2, absoluteError: { max, rms: max }, relativeError: { max: null, rms: null, sampleCount: 0, excludedZeroReferences: 2 } });
    const grid = { spiceTsPoints: 2, ngspicePoints: 2, alignedPoints: 2, excludedOutOfRange: 0 };
    const score = (analysis: string, signals: Record<string, number>) => Object.fromEntries(normalizedSignalErrors(
      [{ analysis, metrics: { grid, signals: Object.fromEntries(Object.entries(signals).map(([name, max]) => [name, compared(max)])) } }],
      () => reference,
    ).errors.map(error => [error.signal, error.normalized]));
    // Floors: voltage VNTOL / MATCH_THRESHOLD, current ABSTOL / MATCH_THRESHOLD, other quantities PEAK_FLOOR.
    assert.deepEqual([NGSPICE_VNTOL, NGSPICE_ABSTOL, VOLTAGE_PEAK_FLOOR, CURRENT_PEAK_FLOOR], [1e-6, 1e-12, 1e-4, 1e-10]);
    assert.ok(Math.abs(VOLTAGE_PEAK_FLOOR * MATCH_THRESHOLD - NGSPICE_VNTOL) < 1e-21);
    assert.ok(Math.abs(CURRENT_PEAK_FLOOR * MATCH_THRESHOLD - NGSPICE_ABSTOL) < 1e-27);
    // rca3040 AC v(2): exact answer 0, spice-ts roundoff 4.84e-14 V is far below VNTOL, so it matches.
    const ac = score('ac', { 'v(2)': 4.84e-14, 'i(vs)': 5e-13, onoise_spectrum: 1e-15, 'v(big)': 0.04 });
    assert.ok(ac['v(2)'] <= MATCH_THRESHOLD && Math.abs(ac['v(2)'] - 4.84e-10) < 1e-20, String(ac['v(2)']));
    assert.ok(Math.abs(ac['i(vs)'] - 5e-3) < 1e-15, String(ac['i(vs)']));
    // A difference at or above VNTOL on a zero-peak node is still a mismatch, not hidden by the floor.
    assert.ok(score('tran', { 'v(2)': 2e-6 })['v(2)'] > MATCH_THRESHOLD);
    // Signals whose peak exceeds the floor keep plain peak normalisation (fourbitadder-style 100 uV nodes).
    assert.equal(score('tran', { 'v(8)': 6.7e-6 })['v(8)'], 6.7e-6 / 1e-4);
    assert.equal(ac['v(big)'], 0.04 / 5);
    // Quantities that are not node voltages or branch currents keep the 1e-12 floor.
    assert.equal(ac.onoise_spectrum, 1e-15 / PEAK_FLOOR);
    assert.equal(score('pz', { 'v(pole(1))': 1e-14 })['v(pole(1))'], 1e-14 / PEAK_FLOOR);
  });
});

describe('corpus-f committed artifacts', () => {
  it('pins every fixture byte-for-byte and accounts for every candidate', async () => {
    const committed = await manifest();
    assert.equal(committed.source.revision, '3ef069fb1f04177a153f342a32d941fc20ff047e');
    assert.equal(sha256(await readFile(resolve(committed.source.licenseTextLocalPath))), committed.source.licenseTextSha256);
    assert.ok(committed.circuits.length >= 60, `expected >= 60 fixtures, found ${committed.circuits.length}`);
    assert.equal(committed.selection.selected, committed.circuits.length);
    assert.equal(committed.selection.candidates, committed.circuits.length + committed.exclusions.length);
    for (const [reason, count] of Object.entries(committed.selection.excluded)) {
      assert.equal(committed.exclusions.filter(exclusion => exclusion.reason === reason).length, count, reason);
    }
    const existing = await existingCorpusIdentity(resolve('.'));
    const hashes = new Set<string>();
    for (const circuit of committed.circuits) {
      const bytes = await readFile(resolve(circuit.localPath));
      assert.equal(sha256(bytes), circuit.sha256, circuit.id);
      assert.equal(circuit.licence, 'BSD-3-Clause');
      assert.ok(circuit.localPath.startsWith(`${ROOT}/fixtures/`), circuit.id);
      assert.ok(!hashes.has(circuit.sha256), `${circuit.id}: duplicate content`);
      assert.ok(!existing.hashes.has(circuit.sha256) && !existing.ngspicePaths.has(circuit.sourcePath), `${circuit.id}: already in a corpus`);
      hashes.add(circuit.sha256);
    }
    for (const exclusion of committed.exclusions.filter(candidate => candidate.reason === 'licence')) {
      assert.ok(!committed.circuits.some(circuit => circuit.sourcePath === exclusion.sourcePath));
    }
  });

  it('keeps SOURCES.md generated from the manifest', async () => {
    assert.equal(await readFile(resolve(ROOT, 'SOURCES.md'), 'utf8'), renderSources(await manifest()));
  });

  it('keeps README.md and totals generated from outcomes.json', async () => {
    const report = JSON.parse(await readFile(resolve(ROOT, 'outcomes.json'), 'utf8')) as CorpusFReport;
    const committed = await manifest();
    assert.equal(report.source.manifestSha256, sha256(await readFile(resolve(ROOT, 'manifest.json'))));
    assert.deepEqual(report.fixtures.map(fixture => fixture.id), committed.circuits.map(circuit => circuit.id));
    assert.equal(report.outcomeSha256, outcomeDigest(report));
    for (const fixture of report.fixtures) {
      assert.equal(fixture.gapBucket, gapBucket(fixture.spiceTs.firstErrorLine, fixture.spiceTs.status) ?? null, fixture.id);
    }
    const { totals, gapBuckets } = summarize(report.fixtures);
    assert.deepEqual(report.totals, totals);
    assert.deepEqual(report.gapBuckets, gapBuckets);
    const readme = await readFile(resolve(ROOT, 'README.md'), 'utf8');
    assert.equal(readme.split(CONTROL_SECTION)[0].trimEnd(), renderMarkdown(report).trimEnd());
  });
  it('regenerating the batch-1 README keeps the control-vector supplement', async () => {
    const readme = await readFile(resolve(ROOT, 'README.md'), 'utf8');
    const report = JSON.parse(await readFile(resolve(ROOT, 'outcomes.json'), 'utf8')) as CorpusFReport;
    assert.equal(mergeReadme(readme, renderMarkdown(report)), readme);
    assert.equal(mergeReadme('# old batch\n', '# new batch\n'), '# new batch\n');
    assert.equal(mergeReadme(`# old\n${CONTROL_SECTION}rows\n`, '# new\n'), `# new\n${CONTROL_SECTION}rows\n`);
  });
  it('lists every control deck exactly once in the supplemental table', async () => {
    const readme = await readFile(resolve(ROOT, 'README.md'), 'utf8');
    const section = readme.split(CONTROL_SECTION)[1] ?? '';
    const rows = section.split('\n').filter(line => line.startsWith('| ['));
    const expected: string[] = [];
    for (const circuit of (await manifest()).circuits) {
      if (hasControlBlock(await readFile(resolve(circuit.localPath), 'utf8'))) expected.push(circuit.sourcePath);
    }
    assert.deepEqual(rows.map(row => /^\| \[([^\]]+)\]/.exec(row)?.[1]), expected);
    for (const row of rows.filter(line => line.includes(' | loss | '))) assert.match(row, /https:\/\/github.com\/mfiumara\/spice-ts\/issues\/\d+/);
  });
});

describe('corpus-f sp/sens plots and streamed references (#694)', () => {
  const RAW = [
    'Title: toy', 'Date: today', 'Plotname: Transient Analysis', 'Flags: real', 'No. Variables: 3', 'No. Points: 3',
    'Variables:', '\t0\ttime\ttime', '\t1\tV(1)\tvoltage', '\t2\ti(v1)\tcurrent', 'Values:',
    ' 0\t0.000000e+00', '\t1.0', '\t-1e-3', '', ' 1\t1e-9', '\t2.5', '\t-2e-3', ' 2\t2e-9', '\t3', '\t-3e-3',
    'Title: toy', 'Date: today', 'Plotname: SP Analysis', 'Flags: complex', 'No. Variables: 3', 'No. Points: 2',
    'Variables:', '\t0\tfrequency\tfrequency grid=3', '\t1\ts_1_1\ts-param', '\t2\ti(cy_1_1)\tcurrent', 'Values:',
    ' 0\t1.0e+06,0.0e+00', '\t0.5,-0.25', '\t1e-20,0', ' 1\t2.0e+06,0.0e+00', '\t0.4,-0.3', '\t2e-20,0',
    'Title: toy', 'Plotname: Sensitivity Analysis', 'Flags: real', 'No. Variables: 2', 'No. Points: 1',
    'Variables:', '\t0\tv(r1)\tvoltage', '\t1\tfail_count\tnotype', 'Values:', ' 0\t4.2e-02', '\t0',
  ];

  it('streams the same plots as parseNgspiceRaw, LF or CRLF', async () => {
    const reference = parseNgspiceRaw(`${RAW.join('\n')}\n`);
    for (const eol of ['\n', '\r\n']) {
      const lines = RAW.join(eol).split(/\r?\n/);
      const streamed = (await parseRawLines(lines)).map(({ points: _points, ...plot }) => plot);
      assert.deepEqual(streamed, reference, JSON.stringify(eol));
    }
    // A truncated values section is padded like parseNgspiceRaw (Number('') = 0).
    const truncated = RAW.slice(0, 17);
    assert.deepEqual((await parseRawLines(truncated)).map(({ points: _points, ...plot }) => plot), parseNgspiceRaw(truncated.join('\n')));
  });

  it('keeps the grid and only the selected signals', async () => {
    const plots = await parseRawLines(RAW, (plotName, signal) => plotName === 'SP Analysis' && signal === 's_1_1');
    assert.deepEqual(plots.map(plot => [plot.plotName, plot.points, plot.grid, Object.keys(plot.signals)]), [
      ['Transient Analysis', 3, [0, 1e-9, 2e-9], []],
      ['SP Analysis', 2, [1e6, 2e6], ['s_1_1']],
      ['Sensitivity Analysis', 1, [0], []],
    ]);
    assert.deepEqual(plots[1].signals.s_1_1, [{ re: 0.5, im: -0.25 }, { re: 0.4, im: -0.3 }]);
  });

  it('selects the union of signals over every spice-ts plot of a type', () => {
    const series = (...names: string[]) => ({ grid: [1], signals: Object.fromEntries(names.map(name => [name, [{ re: 1, im: 0 }]])) });
    const select = referenceSelection({ analyses: [
      { type: 'noise', plotName: 'Noise Spectral Density Curves', series: series('onoise_spectrum') },
      { type: 'noise', plotName: 'Integrated Noise', series: series('onoise_total') },
      { type: 'ac', plotName: 'AC Analysis', series: series('v(1)') },
    ] });
    assert.equal(select('noise', 'onoise_spectrum'), true);
    assert.equal(select('noise', 'onoise_total'), true);
    assert.equal(select('noise', 'v(1)'), false);
    assert.equal(select('ac', 'v(1)'), true);
    assert.equal(select('tran', 'v(1)'), false);
    assert.equal(referenceSelection({ analyses: [] })('op', 'v(1)'), false);
  });

  it('maps SP and sensitivity plots and scores them on the control decks only', () => {
    assert.equal(corpusFPlotType('SP Analysis', analysisType), 'sp');
    assert.equal(corpusFPlotType('Sensitivity Analysis', analysisType), 'sens');
    assert.equal(corpusFPlotType('AC Analysis', analysisType), 'ac');
    assert.equal(corpusFPlotType('Transfer Function', analysisType), null);
    assert.deepEqual(scoredPlotTypes({ analyses: ['ac'], unmappedAnalyses: ['sp', 'tf', 'sens', 'sp'] }), ['ac', 'sp', 'sens']);
    assert.deepEqual(scoredPlotTypes({ analyses: [], unmappedAnalyses: ['tf', 'pss'] }), []);
    // Sensitivities are written as v(<device>) but are derivatives, not node voltages.
    assert.equal(peakFloor('sens', 'v(r1)'), PEAK_FLOOR);
    assert.equal(peakFloor('sp', 'v(in)'), VOLTAGE_PEAK_FLOOR);
    assert.equal(peakFloor('sp', 's_1_1'), PEAK_FLOOR);
  });

  it('links the new sp/sens/linearize losses to their own issues (reporting only)', () => {
    const loss = (firstErrorLine: string) => ({ outcome: 'spice-ts-loss', sourcePath: 'x.cir', ngspice: { status: 'success', analyses: ['sp:3'] }, spiceTs: { status: 'unsupported', analyses: [], firstErrorLine } }) as unknown as Parameters<typeof trackingIssue>[0];
    const issue = (line: string) => trackingIssue(loss(line)).split('/').at(-1);
    assert.equal(issue("Parse error at line 14: Unsupported .control command 'sp': S-parameter analysis is not implemented"), '750');
    assert.equal(issue("Parse error at line 18: Unsupported .control command 'sens': control-language sensitivity"), '750');
    assert.equal(issue("Control script error at line 15: no such vector 's_1_1' in plot 'sp1'"), '751');
    assert.equal(issue("Control script error at line 50: no such vector 'i1_m' in plot 'sens1'"), '760');
    assert.equal(issue("Control script error at line 50: no such vector 'r1_scale' in plot 'sens1'"), '760');
    assert.equal(issue("Parse error at line 41: Unsupported .control command 'linearize': vector re-interpolation"), '752');
    assert.equal(issue("Parse error at line 9: XSPICE code model 'cpline' (.model 'CPLINE1') is not supported"), '553');
  });

  it('names spice-ts sp/sens vectors as ngspice writes them and retains every control run', () => {
    const c = (real: number, imaginary = 0) => ({ real, imaginary });
    const first = { sParameters: { frequencies: [1e6], vectors: new Map([['S_1_1', [c(0.5, -0.25)]], ['Cy_1_1', [c(1e-20)]], ['NF', [c(3)]]]) } };
    const later = { sParameters: { frequencies: [2e6], vectors: new Map([['S_1_1', [c(0.1)]]]) } };
    const sens = { mode: 'dc' as const, frequencies: [], entries: [
      { device: 'R1', parameter: 'resistance' as const, dc: 0.042 },
      { device: 'I1', parameter: 'dc' as const, dc: 1000 },
      { device: 'E1', parameter: 'gain' as const, dc: 2 },
    ] };
    const result = { ...later, sensitivity: sens, control: { runs: [{ plot: 'sp1', analysis: 'sp', result: first }, { plot: 'sp2', analysis: 'sp', result: later }] } };
    const [sp, laterSp, sensitivity] = controlPlotAnalyses(result, ['sp', 'sens']);
    assert.equal(sp.plotId, 'sp1');
    assert.equal(laterSp.plotId, 'sp2');
    assert.deepEqual(laterSp.series.grid, [2e6]);
    assert.deepEqual(sp.series, { grid: [1e6], signals: { s_1_1: [{ re: 0.5, im: -0.25 }], 'i(cy_1_1)': [{ re: 1e-20, im: 0 }], nf: [{ re: 3, im: 0 }] } });
    assert.deepEqual(sensitivity.series, { grid: [0], signals: { 'v(r1)': [{ re: 0.042, im: 0 }], 'v(i1)': [{ re: 1000, im: 0 }], 'v(e1_gain)': [{ re: 2, im: 0 }] } });
    assert.equal(sensitivitySignalName({ device: 'R1', parameter: 'resistance' }, 'ac'), 'v(r1_ac)');
    assert.equal(sensitivitySignalName({ device: 'V1', parameter: 'acMagnitude' }, 'ac'), 'v(v1_acmag)');
    // #760: instance multiplier and scale, named like ngspice-47 writes them to a raw file.
    assert.equal(sensitivitySignalName({ device: 'R1', parameter: 'multiplier' }, 'dc'), 'v(r1_m)');
    assert.equal(sensitivitySignalName({ device: 'C1', parameter: 'scale' }, 'ac'), 'v(c1_scale)');
    assert.deepEqual(controlPlotAnalyses({}, ['sp', 'sens']), []);
  });

  it('exports sp and sens plots from .control and keeps only selected signals', { skip: !HAS_NGSPICE }, async () => {
    const sp = Buffer.from('sp toy\nV1 in 0 dc 0 ac 1 portnum 1 z0 50\nR1 in out 50\nV2 out 0 dc 0 ac 0 portnum 2 z0 50\n.control\nsp lin 3 1e6 3e6\nquit\n.endc\n.end\n');
    const circuit = { analyses: [], unmappedAnalyses: ['sp'] };
    const full = await runControlReference(sp, circuit);
    assert.equal(full.status, 'success');
    assert.deepEqual(full.execution.analyses.map(analysis => [analysis.type, analysis.series.grid]), [['sp', [1e6, 2e6, 3e6]]]);
    const s21 = full.execution.analyses[0].series.signals.s_2_1;
    assert.ok(Math.abs(s21[0].re - 2 / 3) < 1e-9, `S21 of a 50 ohm series resistor between 50 ohm ports is 2/3, got ${s21[0].re}`);
    const selected = await runControlReference(sp, circuit, (type, signal) => type === 'sp' && signal === 's_1_1');
    assert.deepEqual(Object.keys(selected.execution.analyses[0].series.signals), ['s_1_1']);
    const none = await runControlReference(sp, circuit, () => false);
    assert.equal(none.status, 'success');
    assert.deepEqual(none.execution.analyses[0].series, { grid: [1e6, 2e6, 3e6], signals: {} });

    const sens = await runControlReference(Buffer.from('sens toy\ni1 0 1 dc=42mA\nr1 1 0 1k\n.control\nsens v(1) dc\n.endc\n.end\n'), { analyses: [], unmappedAnalyses: ['sens'] });
    assert.equal(sens.status, 'success');
    assert.equal(sens.execution.analyses[0].type, 'sens');
    // dv(1)/dR1 = 42 mA and dv(1)/dI1 = 1 k; ngspice's finite difference gives 0.04199996 for the former.
    assert.ok(Math.abs(sens.execution.analyses[0].series.signals['v(r1)'][0].re / 0.042 - 1) < 1e-5);
    assert.ok(Math.abs(sens.execution.analyses[0].series.signals['v(i1)'][0].re / 1000 - 1) < 1e-5);
  });

  it('scores sp and sens control commands against ngspice on identical bytes (#750)', { skip: !HAS_NGSPICE || !HAS_CORE_DIST }, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'corpus-f-750-'));
    try {
      const decks = {
        sp: 'sp command\nV1 in 0 dc 0 ac 1 portnum 1 z0 50\nC1 in 0 1n\nR1 in out 20\nV2 out 0 dc 0 ac 0 portnum 2 z0 50\n.control\nsp lin 5 1e6 1e8\n.endc\n.end\n',
        sens: 'sens command\ni1 0 1 dc=1.27 ac=42mA\nr1 1 0 1k\nc1 1 0 100p\n.control\nsens v(1) ac lin 1 1e6 1.1e6\nquit\n.endc\n.end\n',
      };
      for (const [type, text] of Object.entries(decks)) {
        const bytes = Buffer.from(text);
        const localPath = resolve(directory, `${type}.cir`);
        await writeFile(localPath, bytes);
        const circuit = { id: type, sourcePath: `toy/${type}.cir`, localPath, sha256: sha256(bytes), analyses: [], unmappedAnalyses: [type], sameNameAs: [] } as unknown as CorpusFManifest['circuits'][number];
        const fixture = await runFixture({ ...circuit, analyses: scoredPlotTypes(circuit) }, runControlReference);
        assert.equal(fixture.outcome, 'matched', JSON.stringify(fixture));
        assert.ok(fixture.comparedSignals >= (type === 'sp' ? 12 : 3), `${type}: compared ${fixture.comparedSignals}`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('scores a dot-card .sp deck run from .control against ngspice (identical bytes)', { skip: !HAS_NGSPICE || !HAS_CORE_DIST }, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'corpus-f-694-'));
    try {
      const bytes = Buffer.from('sp e2e\nV1 in 0 dc 0 ac 1 portnum 1 z0 50\nC1 in 0 1n\nR1 in out 20\nV2 out 0 dc 0 ac 0 portnum 2 z0 50\n.sp lin 5 1e6 1e8\n.control\nrun\n.endc\n.end\n');
      const localPath = resolve(directory, 'sp-e2e.cir');
      await writeFile(localPath, bytes);
      const circuit = { id: 'sp-e2e', sourcePath: 'toy/sp-e2e.cir', localPath, sha256: sha256(bytes), analyses: [], unmappedAnalyses: ['sp'], sameNameAs: [] } as unknown as CorpusFManifest['circuits'][number];
      const fixture = await runFixture({ ...circuit, analyses: scoredPlotTypes(circuit) }, runControlReference);
      assert.equal(fixture.outcome, 'matched', JSON.stringify(fixture));
      assert.ok(fixture.comparedSignals >= 12, `S/Y/Z vectors compared, got ${fixture.comparedSignals}`);
      assert.equal(sha256(await readFile(localPath)), sha256(bytes));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * #839: a 50-section RC ladder, 1e5 transient points x 52 signals (5.2M samples per engine). One
 * object per sample is about 300 MB of heap per engine, more than the 256 MB bound used below; the
 * packed runner needs the simulator's own result plus one bounded comparison batch.
 */
const LADDER_SECTIONS = 50;
const LADDER_DECK = [
  '* corpus-f bounded-heap probe (#839)',
  'V1 n0 0 SIN(0 1 50k)',
  ...Array.from({ length: LADDER_SECTIONS }, (_, index) => `R${index + 1} n${index} n${index + 1} 1k\nC${index + 1} n${index + 1} 0 1n`),
  '.tran 2n 200u 0 2n',
  '.end',
  '',
].join('\n');
const BOUNDED_HEAP_MB = 256;

describe('corpus-f long transients in a bounded heap (#839)', () => {
  // Deterministic waveforms with a few ngspice-only and spice-ts-only signals; ties in the worst
  // error must resolve to the same signal as the unbatched metric.
  const wave = (points: number, scale: number, phase: number) => Array.from({ length: points }, (_, index) => ({ re: scale * Math.sin(index / 7 + phase), im: 0 }));
  const phasorWave = (points: number, scale: number) => Array.from({ length: points }, (_, index) => ({ re: scale * Math.cos(index), im: -scale * Math.sin(index / 3) }));
  const engine = (shift: number, extra: string): EngineExecution => ({
    status: 'success',
    convergence: 'converged',
    analyses: [
      { type: 'tran', plotName: 'Transient Analysis', series: { grid: [0, 1e-9, 1e-9, 2e-9, 3.5e-9, 4e-9, 6e-9].map(t => t * (shift === 0 ? 1 : 1.0001)), signals: Object.fromEntries(['v(a)', 'v(b)', 'v(c)', 'i(v1)', 'v(tie1)', 'v(tie2)', extra].map((name, index) => [name, wave(7, index + 1 + shift * (name.startsWith('v(tie') ? 0.5 : 0.01), index)])) } },
      { type: 'ac', plotName: 'AC Analysis', series: { grid: [1, 10, 100], signals: { 'v(a)': phasorWave(3, 1 + shift), 'v(b)': phasorWave(3, 2) } } },
      { type: 'noise', plotName: 'Noise Spectral Density Curves', series: { grid: [1, 10], signals: { onoise_spectrum: wave(2, 1e-9 * (1 + shift), 0) } } },
      { type: 'noise', plotName: 'Integrated Noise', series: { grid: [0], signals: { 'v(onoise_total)': wave(1, 2e-3 * (1 + shift), 1) } } },
    ],
  });
  const spiceTs = engine(0.02, 'v(only-spice-ts)');
  const ngspice = engine(0, 'v(only-ngspice)');

  it('scores packed executions in any batch size exactly like one compareExecutions call', () => {
    const expected = compareExecutions(spiceTs, ngspice);
    const expectedErrors = normalizedSignalErrors(expected, pairedReferenceSeries(spiceTs, ngspice));
    for (const budget of [1, 15, 40, 1e9]) {
      const actual = compareInBatches(packExecution(spiceTs), packExecution(ngspice), budget);
      assert.deepEqual(actual, expected, `budget ${budget}`);
      assert.deepEqual(JSON.stringify(actual), JSON.stringify(expected), `key order, budget ${budget}`);
      const lazy = normalizedSignalErrors(actual, pairedReferenceSeries(lazyExecution(packExecution(spiceTs)), lazyExecution(packExecution(ngspice))));
      assert.deepEqual(lazy, expectedErrors);
    }
    assert.deepEqual(unpackExecution(asPacked(ngspice)), ngspice);
    assert.equal(asPacked(packExecution(ngspice)).analyses[0].grid.length, 7);
  });

  it('reads an ngspice raw file into packed columns with the object reader\'s values', async () => {
    const raw = ['Title: t', 'Plotname: Transient Analysis', 'Flags: real', 'No. Variables: 3', 'No. Points: 3', 'Variables:', '\t0\ttime\ttime', '\t1\tv(1)\tvoltage', '\t2\ti(v1)\tcurrent', 'Values:',
      ' 0\t0', '\t-0', '\t1e-3', '', ' 1\t1e-9', '\t0.5', '\t-2.5e-300', ' 2\t2e-9', '\t1', ''];
    const keep = (_plot: string, signal: string) => signal !== 'i(v1)';
    for (const select of [undefined, keep]) {
      const objects = await parseRawLines(raw, select);
      const packed = await parseRawLinesInto(raw, PACKED_COLUMNS, select);
      assert.deepEqual(packed.map(plot => ({ ...plot, signals: Object.fromEntries(Object.entries(plot.signals).map(([name, column]) => [name, samples(column)])) })), objects);
    }
  });

  it('packs the spice-ts adapter result without changing a value', { skip: !HAS_CORE_DIST }, async () => {
    const deck = Buffer.from('packed adapter\nV1 1 0 SIN(0 1 1k) AC 1\nR1 1 2 1k\nC1 2 0 1u\n.op\n.tran 10u 2m\n.ac dec 5 10 1e5\n.end\n');
    const circuit: ClassicCircuit = { id: 'rc', category: 'corpus-f', analyses: ['op', 'tran', 'ac'], sourcePath: 'toy/rc.cir', sourceUrl: '', localPath: 'toy/rc.cir', sha256: '', ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } };
    const objects = await runCorpusFSpiceTs(deck, circuit);
    assert.equal(objects.status, 'success', objects.error);
    const packed = packEncoded(await runCorpusFSpiceTs(deck, circuit, PACKED_SAMPLES));
    assert.deepEqual(unpackExecution(deserialize(serialize(packed)) as typeof packed), objects);
    // Real waveforms travel without an imaginary column.
    assert.equal(packed.analyses.find(analysis => analysis.type === 'tran')?.signals['v(2)'].im, undefined);
  });

  it('runs the spice-ts child without per-sample objects', { skip: !HAS_CORE_DIST }, async () => {
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${previous ?? ''} --max-old-space-size=${BOUNDED_HEAP_MB}`.trim();
    try {
      const circuit: ClassicCircuit = { id: 'ladder', category: 'corpus-f', analyses: ['tran'], sourcePath: 'toy/ladder.cir', sourceUrl: '', localPath: 'toy/ladder.cir', sha256: '', ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } };
      const execution = await runBoundedSimulate(Buffer.from(LADDER_DECK), circuit);
      assert.equal(execution.status, 'success', execution.error);
      const [tran] = execution.analyses;
      assert.ok(tran.series.grid.length >= 100_000, `points ${tran.series.grid.length}`);
      assert.equal(Object.keys(tran.series.signals).length, LADDER_SECTIONS + 2);
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });

  it('compares both engines on every signal within the same bound', { skip: !HAS_NGSPICE || !HAS_CORE_DIST }, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'corpus-f-839-'));
    try {
      const localPath = resolve(directory, 'ladder.cir');
      await writeFile(localPath, LADDER_DECK);
      const run = spawnSync(process.execPath, [...process.execArgv, `--max-old-space-size=${BOUNDED_HEAP_MB}`, resolve(ROOT, 'run-deck.ts'), localPath, 'toy/ladder.cir'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      assert.equal(run.status, 0, run.stderr.slice(-2000));
      const fixture = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as FixtureOutcome;
      assert.equal(fixture.ngspice.status, 'success', JSON.stringify(fixture));
      assert.equal(fixture.spiceTs.status, 'success', JSON.stringify(fixture));
      assert.equal(fixture.comparedSignals, LADDER_SECTIONS + 2, JSON.stringify(fixture));
      assert.equal(fixture.outcome, 'matched', JSON.stringify(fixture));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

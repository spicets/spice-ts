import { describe, it, expect } from 'vitest';
import { preprocess } from './preprocessor.js';
import type { IncludeResolver } from '../types.js';
import { ParseError } from '../errors.js';

describe('preprocessor', () => {
  describe('.param substitution', () => {
    it('substitutes a simple param into a device value', async () => {
      const input = `.param rval = 1000\nR1 1 0 {rval}\n.op`;
      const result = await preprocess(input);
      expect(result).toContain('R1 1 0 1.000000000000000e+3');
      expect(result).not.toContain('.param');
      expect(result).not.toContain('{');
    });

    it('substitutes param with SI suffix', async () => {
      const input = `.param cap = 100n\nC1 1 0 {cap}\n.op`;
      const result = await preprocess(input);
      expect(result).toContain('C1 1 0 1.000000000000000e-7');
    });

    it('substitutes param expression', async () => {
      const input = `.param w = 1e-6\n.param w2 = {w*2}\nM1 d g s NMOD W={w2}\n.op`;
      const result = await preprocess(input);
      expect(result).toContain('W=2.000000000000000e-6');
    });

    it('handles multiple params', async () => {
      const input = `.param a = 2\n.param b = 3\nR1 1 0 {a+b}\n.op`;
      const result = await preprocess(input);
      expect(result).toContain('R1 1 0 5');
    });

    it('passes through netlist with no directives unchanged', async () => {
      const input = 'V1 1 0 DC 5\nR1 1 0 1k\n.op';
      const result = await preprocess(input);
      expect(result).toBe(input);
    });

    it('preserves .subckt blocks without evaluating internal params', async () => {
      const input = `.subckt inv in out W=1u\nR1 in out {W}\n.ends inv\n.op`;
      const result = await preprocess(input);
      expect(result).toContain('.subckt inv in out W=1u');
      expect(result).toContain('{W}');
    });

    it.each([
      '.print tran {v(2)+0.002}',
      '.PRINT TRAN {V(3)/I(VMON)}',
      '.print tran {i(v1)-1.0}',
    ])('preserves case-insensitive V/I output expressions: %s', async directive => {
      await expect(preprocess(directive)).resolves.toBe(directive);
    });

    it('keeps V/I calls in behavioral {..} expressions as ASRC sub-expressions (#615)', async () => {
      // ngspice-47 runs this card with v(out) = v(in) (inp_modify_exp).
      await expect(preprocess('B1 out 0 V={V(in)}')).resolves.toBe('B1 out 0 V=(V(in))');
    });

    it.each([
      '.print tran {abs(V(out))}',
      '.print tran {V(out)+gain}',
      '.print dc {2*gain}',
      '.plot noise {log(inoise)}',
      '.print tran v(1)\n+ {int(v(1))}',
    ])('leaves .print/.plot braces unsubstituted like ngspice-47 numparam (#714): %s', async directive => {
      await expect(preprocess(`.param gain=3\n${directive}`)).resolves.toBe(`\n${directive}`);
    });

    it('resolves a device reference to a .param defined later (ngspice global .param scope)', async () => {
      const result = await preprocess('T\nR1 a 0 {r}\nV1 a 0 1\n.param r=1k\n.op\n.end');
      expect(result).toContain('R1 a 0 1.000000000000000e+3');
    });

    it('resolves a .param expression that references a later .param', async () => {
      const result = await preprocess('R1 a 0 {r}\n.param r={2*k}\n.param k=1k\n.op');
      expect(result).toContain('R1 a 0 2.000000000000000e+3');
    });

    it('uses the last definition of a redefined .param everywhere, like ngspice', async () => {
      const result = await preprocess('.param r=1k\nR1 a 0 {r}\n.param r=2k\n.op');
      expect(result).toContain('R1 a 0 2.000000000000000e+3');
    });

    it('resolves a forward reference to a .param defined in an included file', async () => {
      const resolver: IncludeResolver = async () => '.param r=3k';
      const result = await preprocess('R1 a 0 {r}\n.include params.inc\n.op', resolver);
      expect(result).toContain('R1 a 0 3.000000000000000e+3');
    });

    it('throws a ParseError with the line for an undefined parameter', async () => {
      const failure = await preprocess('T\nR1 a 0 {zz}\n.op').catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ParseError);
      expect((failure as ParseError).line).toBe(2);
      expect((failure as ParseError).message).toContain("Undefined parameter 'zz'");
    });

    it('throws an undefined-parameter ParseError at the .param line for an undefined RHS name', async () => {
      const failure = await preprocess('R1 a 0 {r}\nV1 a 0 1\n.param r={zz}\n.op').catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ParseError);
      expect((failure as ParseError).line).toBe(3);
      expect((failure as ParseError).message).toContain("Undefined parameter 'zz'");
    });

    it('throws a ParseError at the definition line for circular .param dependencies', async () => {
      const failure = await preprocess('.param a={b}\n.param b={a}\nR1 x 0 {a}\n.op')
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ParseError);
      expect((failure as ParseError).message).toContain('Circular .param dependency');
      expect([1, 2]).toContain((failure as ParseError).line);
    });

    it('handles .param with = sign and spaces', async () => {
      const input = `.param vdd = 1.8\nV1 1 0 DC {vdd}\n.op`;
      const result = await preprocess(input);
      expect(result).toContain('V1 1 0 DC 1.8');
    });
  });

  describe('quoted and brace numparam expressions (#493)', () => {
    // Card lines are copied from the corpus-f ngspice decks listed in #493.
    it('evaluates a single-quoted instance value (minus-minus.cir)', async () => {
      expect(await preprocess("v1  1 0  '2--3'\n.op")).toContain('v1  1 0  5');
    });

    it('evaluates single-quoted function calls (xpressn-2.cir, log-functions-1.cir)', async () => {
      const result = await preprocess("v0 n0 0 'sin(1.0e-9)'\nvn1 n1 0 'ln(2.7)'\n.op");
      expect(result).toContain('v0 n0 0 1.000000000000000e-9');
      expect(result).toContain('vn1 n1 0 9.932517730102834e-1');
    });

    it('evaluates a single-quoted .param value with spaces (alterparam.sp)', async () => {
      const result = await preprocess(".param vv = 1\n.param rr = 'vv + 1'\nR1 1 0 {rr + 1}\n.op");
      expect(result).toContain('R1 1 0 3');
    });

    it('evaluates TEMPER at the 27 C circuit temperature in braces and quotes (temper-1.cir, dc_loop.sp)', async () => {
      const result = await preprocess([
        "R1 r2 0 r = {5k + 50*TEMPER}",
        ".model dplain d is='temper+1000'",
        '.model dt d is={temper >= 25 ? 1e-10 : (temper+1)*1e-11}',
        ".model rtest r r='1000 + temper'",
        '.op',
      ].join('\n'));
      expect(result).toContain('R1 r2 0 r = 6.350000000000000e+3');
      expect(result).toContain('.model dplain d is=1.027000000000000e+3');
      expect(result).toContain('.model dt d is=1.000000000000000e-10');
      expect(result).toContain('.model rtest r r=1.027000000000000e+3');
    });

    it('evaluates TEMPER at the .options TEMP circuit temperature; the last TEMP wins', async () => {
      const result = await preprocess([
        '.options reltol=1e-4 temp=40',
        "R1 1 0 r = {1k + TEMPER}",
        ".model rtest r r='1000 + temper'",
        '.option TEMP = 50',
        '.op',
      ].join('\n'));
      expect(result).toContain('R1 1 0 r = 1.050000000000000e+3');
      expect(result).toContain('.model rtest r r=1.050000000000000e+3');
    });

    it('ignores TEMP fields outside .options when choosing TEMPER', async () => {
      const result = await preprocess(".model q1 npn temp=80\nR1 1 0 {TEMPER}\n.op");
      expect(result).toContain('R1 1 0 2.700000000000000e+1');
    });

    it('accepts TEMPER under a .step TEMP sweep (the parser retains its evaluator)', async () => {
      const text = await preprocess("T\n.model d1 d is='1e-12*temper'\n.step temp list 0 50\n.op");
      expect(text).toContain('.model d1 d is=2.700000000000000e-11');
    });

    it('accepts an unused vector .param and rejects its scalar use', async () => {
      await expect(preprocess('.param actual_vec="[1.3e-3 2e-3]"\nR1 1 0 1k\n.op')).resolves.toContain('R1 1 0 1k');
      const failure = await preprocess('T\n.param actual_vec="[1.3e-3 2e-3]"\nR1 1 0 {actual_vec+0}\n.op')
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ParseError);
      expect((failure as ParseError).line).toBe(3);
    });

    it('rewrites a node-voltage dependent resistor into an ngspice B-source (tmp-noise.cir)', async () => {
      const result = await preprocess("R20 20 0 '1k*v(200)' tc1=0.001 ; tc2=1e-5\n.op");
      expect(result).toContain('bR20 20 0 i = v(20, 0)/(1k*v(200)) tc1=0.001 reciproctc=1');
    });

    it('rewrites an r= {expression} with v() into a B-source (asrc-tc-2.cir)', async () => {
      const result = await preprocess('.param base=1k\nr3  1 3  r = {base + v(9)}  tc1=0.001\n.op');
      expect(result).toContain('br3 1 3 i = v(1, 3)/(1000 + v(9)) tc1=0.001 reciproctc=1');
    });

    it('rejects resistor parameters the behavioral rewrite cannot carry', async () => {
      await expect(preprocess("R20 20 0 '1k*v(200)' noisy=1\n.op"))
        .rejects.toThrow("behavioral resistor 'R20'");
    });

    it('leaves quotes in .control blocks, comments and B-cards to their own handlers', async () => {
      const input = [
        "* it's a comment",
        "b1 2 0 v = '2*3' + v(1)",
        '.control',
        "echo 'it''s fine'",
        '.endc',
      ].join('\n');
      const result = await preprocess(input);
      expect(result).toContain("* it's a comment");
      expect(result).toContain("echo 'it''s fine'");
      expect(result).toContain('b1 2 0 v = 6 + v(1)');
    });

    it('normalises quoted subcircuit-body values to compact brace expressions (alterparam.sp)', async () => {
      const result = await preprocess(".subckt subr in out rint1 = 6\n  R1 in out 'rint1 * 2'\n  R2 in out {rint1 + 1}\n.ends\n.op");
      expect(result).toContain('R1 in out {rint1*2}');
      expect(result).toContain('R2 in out {rint1+1}');
    });
  });

  describe('.include resolution', () => {
    it('resolves a simple .include', async () => {
      const resolver: IncludeResolver = async (path) => {
        if (path === 'models.lib') return '.model DMOD D(IS=1e-14)';
        throw new Error(`Unknown file: ${path}`);
      };
      const input = `.include 'models.lib'\nD1 1 0 DMOD\n.op`;
      const result = await preprocess(input, resolver);
      expect(result).toContain('.model DMOD D(IS=1e-14)');
      expect(result).toContain('D1 1 0 DMOD');
      expect(result).not.toContain('.include');
    });

    it('strips quotes from include path', async () => {
      const paths: string[] = [];
      const resolver: IncludeResolver = async (path) => {
        paths.push(path);
        return '* empty';
      };
      await preprocess(`.include "file.lib"\n.op`, resolver);
      expect(paths).toEqual(['file.lib']);
    });

    it('handles unquoted include path', async () => {
      const paths: string[] = [];
      const resolver: IncludeResolver = async (path) => {
        paths.push(path);
        return '* empty';
      };
      await preprocess(`.include file.lib\n.op`, resolver);
      expect(paths).toEqual(['file.lib']);
    });

    it('resolves recursive includes', async () => {
      const resolver: IncludeResolver = async (path) => {
        if (path === 'a.lib') return `.include 'b.lib'\n.model A D(IS=1e-14)`;
        if (path === 'b.lib') return '.model B D(IS=2e-14)';
        throw new Error(`Unknown: ${path}`);
      };
      const result = await preprocess(`.include 'a.lib'\n.op`, resolver);
      expect(result).toContain('.model A D(IS=1e-14)');
      expect(result).toContain('.model B D(IS=2e-14)');
    });

    it('detects circular includes', async () => {
      const resolver: IncludeResolver = async (path) => {
        if (path === 'a.lib') return `.include 'b.lib'`;
        if (path === 'b.lib') return `.include 'a.lib'`;
        throw new Error(`Unknown: ${path}`);
      };
      await expect(preprocess(`.include 'a.lib'\n.op`, resolver))
        .rejects.toThrow('Circular dependency detected');
    });

    it('throws when resolver is not provided', async () => {
      await expect(preprocess(`.include 'file.lib'\n.op`))
        .rejects.toThrow();
    });

    it('throws on depth limit exceeded', async () => {
      const resolver: IncludeResolver = async (path) => {
        const n = parseInt(path.replace('file', '').replace('.lib', ''));
        if (n < 65) return `.include 'file${n + 1}.lib'`;
        return '* end';
      };
      await expect(preprocess(`.include 'file0.lib'\n.op`, resolver))
        .rejects.toThrow();
    });
  });

  describe('.lib/.endl section selection', () => {
    it('selects the requested section from a file', async () => {
      const libContent = [
        '.lib TT',
        '.model nch nmos(VTO=0.5 KP=120u)',
        '.endl TT',
        '.lib FF',
        '.model nch nmos(VTO=0.4 KP=140u)',
        '.endl FF',
      ].join('\n');
      const resolver: IncludeResolver = async () => libContent;
      const result = await preprocess(`.lib 'models.lib' TT\n.op`, resolver);
      expect(result).toContain('VTO=0.5');
      expect(result).not.toContain('VTO=0.4');
    });

    it('includes unconditional content outside sections', async () => {
      const libContent = [
        '* Shared content',
        '.param vdd = 1.8',
        '.lib TT',
        '.model nch nmos(VTO=0.5)',
        '.endl TT',
      ].join('\n');
      const resolver: IncludeResolver = async () => libContent;
      const result = await preprocess(`.lib 'models.lib' TT\n.op`, resolver);
      expect(result).toContain('VTO=0.5');
    });

    it('handles .lib with section containing .include', async () => {
      const topLib = [
        '.lib TT',
        `.include 'tt-models.lib'`,
        '.endl TT',
      ].join('\n');
      const resolver: IncludeResolver = async (path) => {
        if (path === 'top.lib') return topLib;
        if (path === 'tt-models.lib') return '.model nch nmos(VTO=0.5)';
        throw new Error(`Unknown: ${path}`);
      };
      const result = await preprocess(`.lib 'top.lib' TT\n.op`, resolver);
      expect(result).toContain('VTO=0.5');
    });

    it('detects circular .lib references', async () => {
      const resolver: IncludeResolver = async (path) => {
        if (path === 'a.lib') return `.lib TT\n.lib 'b.lib' TT\n.endl TT`;
        if (path === 'b.lib') return `.lib TT\n.lib 'a.lib' TT\n.endl TT`;
        throw new Error(`Unknown: ${path}`);
      };
      await expect(preprocess(`.lib 'a.lib' TT\n.op`, resolver))
        .rejects.toThrow('Circular dependency detected');
    });

    it('throws when resolver not provided for .lib with file', async () => {
      await expect(preprocess(`.lib 'models.lib' TT\n.op`))
        .rejects.toThrow();
    });
  });
});

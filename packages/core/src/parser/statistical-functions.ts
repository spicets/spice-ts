import { NgspiceRandom } from '../devices/transient-noise.js';

/** Per-deck streams, not process-global state; scopes never leak between parses. */
class ParameterRandom {
  private generator?: NgspiceRandom;
  private initialSeed = 1;
  seed(seed: number): void {
    this.initialSeed = seed;
    this.generator?.seed(seed);
  }
  drand(): number {
    this.generator ??= new NgspiceRandom(this.initialSeed);
    return this.generator.drand();
  }
  gauss(complex: boolean): number {
    this.generator ??= new NgspiceRandom(this.initialSeed);
    // cmath2.c: real sgauss uses uncached gauss1, complex uses cached gauss0.
    if (complex) return this.generator.gauss0();
    let v1: number;
    let v2: number;
    let radius: number;
    do {
      v1 = this.drand();
      v2 = this.drand();
      radius = v1 * v1 + v2 * v2;
    } while (radius >= 1 || radius === 0);
    return v2 * Math.sqrt(-2 * Math.log(radius) / radius);
  }
}
const streams = new WeakMap<object, ParameterRandom>();
export function parameterRandom(scope: object): ParameterRandom {
  let random = streams.get(scope);
  if (!random) {
    random = new ParameterRandom();
    streams.set(scope, random);
  }
  return random;
}
export function bindParameterRandom(scope: object, random: ParameterRandom): void {
  streams.set(scope, random);
}

/** ngspice 3ef069fb src/frontend/numparam/xpressn.c:45-86 (BSD-3-Clause).
 * The existing generator ports randnumb.c:101-147 (BSD/macOS libc seeding).
 * gauss1, randnumb.c:220-230, deliberately does NOT cache the other variate.
 */
export function statisticalFunction(name: string, args: number[], scope: object): number | undefined {
  const arity = name === 'agauss' || name === 'gauss' ? 3
    : name === 'aunif' || name === 'unif' || name === 'limit' ? 2 : undefined;
  // Retain the existing three-argument compatibility clamp (#870).
  if (arity === undefined || (name === 'limit' && args.length === 3)) return undefined;
  if (args.length !== arity || args.some(value => !Number.isFinite(value))) {
    throw new Error(`${name}() takes ${arity} finite arguments, got ${args.length}`);
  }
  const [nominal, variation, sigma] = args;
  const random = parameterRandom(scope);
  if (name === 'agauss' || name === 'gauss') {
    if (variation <= 0 || sigma <= 0) return nominal;
    const standardDeviation = (name === 'gauss' ? nominal * variation : variation) / sigma;
    return nominal + standardDeviation * random.gauss(false);
  }
  const draw = random.drand();
  if (name === 'limit') return nominal + (draw > 0 ? variation : -variation);
  return nominal + (name === 'unif' ? nominal * variation : variation) * draw;
}

export function isStatisticalFunction(name: string): boolean {
  return ['agauss', 'gauss', 'aunif', 'unif', 'limit'].includes(name);
}

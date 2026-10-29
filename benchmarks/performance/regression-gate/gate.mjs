// Receipts contain engine metadata and exactly five or more samples per case.
export const cases = ['rc-10', 'rc-100', 'rc-ladder-tran-1000'];
export const order = round => round % 2 ? ['candidate', 'base'] : ['base', 'candidate'];
export function median(values) {
  if (!values.length || values.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('invalid timings');
  const a = [...values].sort((x, y) => x - y), i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}
const hash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function validate(r) {
  if (!r || typeof r !== 'object' || !['engine', 'version', 'runtime', 'environment'].every(k => typeof r[k] === 'string' && r[k].length)) throw new Error('missing baseline or metadata');
  if (!r.cases || Object.keys(r.cases).sort().join() !== [...cases].sort().join()) throw new Error('missing cases');
  let count;
  for (const id of cases) {
    const c = r.cases[id];
    if (!c || !hash(c.deck) || !Array.isArray(c.samples) || c.samples.length < 5 || (count !== undefined && c.samples.length !== count)) throw new Error(`invalid case ${id}`);
    count = c.samples.length;
    for (const s of c.samples) {
      if (!s || !hash(s.output) || !Number.isFinite(s.cold) || s.cold <= 0 || !Number.isFinite(s.warm) || s.warm <= 0) throw new Error(`invalid sample ${id}`);
      if (s.output !== c.samples[0].output) throw new Error(`inconsistent output ${id}`);
    }
  }
  return count;
}
export function compare(base, candidate) {
  const count = validate(base);
  if (validate(candidate) !== count) throw new Error('sample count mismatch');
  for (const k of ['engine', 'version', 'runtime', 'environment']) if (base[k] !== candidate[k]) throw new Error(`${k} mismatch`);
  const rows = [];
  for (const id of cases) {
    const a = base.cases[id], b = candidate.cases[id];
    if (a.deck !== b.deck) throw new Error(`deck mismatch ${id}`);
    if (a.samples[0].output !== b.samples[0].output) throw new Error(`output mismatch ${id}`);
    for (const mode of ['cold', 'warm']) {
      const before = median(a.samples.map(s => s[mode])), after = median(b.samples.map(s => s[mode]));
      rows.push({ id, mode, baseMs: before, candidateMs: after, changePercent: (after / before - 1) * 100, pass: after <= before * 1.1 });
    }
  }
  return { ok: rows.every(row => row.pass), rows };
}

import { readFileSync } from 'node:fs';
import { compare } from './gate.mjs';
const [basePath, candidatePath] = process.argv.slice(2);
if (!basePath || !candidatePath) throw new Error('usage: node compare.mjs BASE.json CANDIDATE.json');
const result = compare(JSON.parse(readFileSync(basePath)), JSON.parse(readFileSync(candidatePath)));
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

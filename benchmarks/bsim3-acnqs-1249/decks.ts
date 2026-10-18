import { readFileSync } from 'node:fs';

const commonSource = readFileSync(new URL('./common-source.cir', import.meta.url), 'utf8');

/** Original MIT probes: identical bytes are consumed by both engines. */
export const acNqsDecks = [
  { name: 'common-source', deck: commonSource },
  { name: 'reverse', deck: commonSource.replace('M1 out in 0 0', 'M1 0 in out 0') },
  { name: 'resistive-gate', deck: commonSource.replace('VIN in 0', 'VIN drive 0')
    .replace('RD vdd out', 'RG drive in 1k\nRD vdd out') },
  { name: 'pmos', deck: commonSource.replace('vdd 0 1.8', 'vdd 0 -1.8')
    .replace('DC 0.9', 'DC -0.9').replace('NMOS', 'PMOS').replace('VTH0=0.5', 'VTH0=-0.5') },
  { name: 'hot-multiplier', deck: commonSource.replace('W=10u', 'M=3 W=10u')
    .replace('.ac dec', '.options temp=85\n.ac dec') },
];

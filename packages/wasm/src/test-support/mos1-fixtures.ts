// Original project-authored circuits, MIT; shared byte-for-byte by tests and oracle.
export const fixtures = ['NMOS', 'PMOS'].flatMap(polarity => [
  { region: 'saturation', bias: 1.5, supply: 5 },
  { region: 'triode', bias: 3, supply: 1 },
  { region: 'cutoff', bias: 0, supply: 5 },
  { region: 'reverse', bias: 1.5, supply: -1 },
].map(({ region, bias, supply }) => {
  const sign = polarity === 'NMOS' ? 1 : -1;
  return {
    name: `${polarity}-${region}`,
    source: `* Original spice-ts MIT MOS1 ${polarity} ${region}\nVDD supply 0 ${sign * supply}\nVG gate 0 ${sign * bias}\nRD supply drain 1k\nRS source 0 100\nM1 drain gate source 0 channel W=10u L=1u\n.model channel ${polarity}(LEVEL=1 VTO=${sign * 0.7} KP=100u LAMBDA=0.02 GAMMA=0.4 PHI=0.6)\n.op\n.end\n`,
  };
}));
for (const bias of [0, 1.5, 3]) {
  fixtures.push({
    name: `CMOS-${bias}`,
    source: `* Original spice-ts MIT CMOS inverter\nVDD supply 0 3\nVIN gate 0 ${bias}\nMN out gate 0 0 nch W=10u L=1u\nMP out gate supply supply pch W=20u L=1u\n.model nch NMOS(VTO=0.7 KP=100u LAMBDA=0.02)\n.model pch PMOS(VTO=-0.7 KP=50u LAMBDA=0.02)\n.op\n.end\n`,
  });
}
fixtures.push({
  name: 'defaults',
  source: '* Original spice-ts MIT MOS1 defaults\nVDD supply 0 3\nVG gate 0 1\nR1 supply drain 1k\nM1 drain gate 0 0 channel\n.model channel NMOS\n.op\n.end\n',
});

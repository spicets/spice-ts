// Original project-authored fixtures, distributed under the repository MIT licence.
export const mos1AcFixtures = ['NMOS', 'PMOS'].flatMap(polarity => {
  const sign = polarity === 'NMOS' ? 1 : -1;
  return ['common-source', 'body-driven', 'triode', 'inverse'].map(mode => ({
    name: `${polarity} ${mode}`,
    source: [
      `* ${polarity} ${mode}`,
      `VDD supply 0 ${sign * (mode === 'triode' ? 0.2 : 5)}`,
      `VG bias 0 DC ${sign * 1.5} AC ${mode === 'body-driven' ? 0 : 1}`,
      'RG bias gate 10k',
      `VB bulk 0 DC ${sign * -0.3} AC ${mode === 'body-driven' ? 1 : 0}`,
      'RD supply out 2k',
      `M1 ${mode === 'inverse' ? '0 gate out' : 'out gate 0'} bulk transistor W=20u L=2u AD=20p AS=20p PD=24u PS=24u`,
      `.model transistor ${polarity}(LEVEL=1 VTO=${sign * 0.7} KP=100u LAMBDA=0.02 GAMMA=0.4 PHI=0.6 TOX=20n CGSO=200p CGDO=300p CGBO=100p CBD=2p CBS=3p CJ=100u CJSW=200p PB=0.8 MJ=0.5 MJSW=0.33 FC=0.5)`,
      '.ac dec 10 1 1G',
    ].join('\n'),
  }));
});

// Original project-authored fixtures, distributed under the repository MIT licence.
export const bjtAcFixtures = ['NPN', 'PNP'].flatMap(polarity => {
  const sign = polarity === 'NPN' ? 1 : -1;
  const model = `.model transistor ${polarity}(IS=1e-14 BF=120 BR=3 NF=1.1 NR=1.2 VAF=80)`;
  return [
    {
      name: `${polarity} common-emitter`,
      source: `VCC supply 0 ${sign * 5}\nVB bias 0 DC ${sign * 1.2} AC 1\nRC supply collector 1k\nRB bias base 100k\nRE emitter 0 100\nCL collector 0 1n\nQ1 collector base emitter transistor\n${model}\n.ac dec 8 10 100k`,
    },
    {
      name: `${polarity} common-base`,
      source: `VCC supply 0 ${sign * 5}\nVB base 0 ${sign * 0.7}\nVE emitter 0 DC 0 AC 1\nRC supply collector 1k\nCL collector 0 1n\nQ1 collector base emitter transistor\n${model}\n.ac dec 8 10 100k`,
    },
    {
      name: `${polarity} forward-biased collector-base junction`,
      source: `VCC supply 0 ${sign * 0.1}\nVB bias 0 DC ${sign * 0.8} AC 1\nRC supply collector 1k\nRB bias base 1k\nRE emitter 0 100\nCL collector 0 1n\nQ1 collector base emitter transistor\n${model}\n.ac dec 8 10 100k`,
    },
  ].map(fixture => ({ ...fixture, source: `* ${fixture.name}\n${fixture.source}` }));
});

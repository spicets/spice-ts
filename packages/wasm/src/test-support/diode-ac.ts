// Original project-authored diode + RC fixture, MIT (repository LICENSE).
// The leading comment is also ngspice's title; both engines receive identical bytes.
export const diodeAcSource = `* bounded diode RC small-signal response
V1 in 0 DC 2 AC 1 30
R1 in out 1k
C1 out 0 100p
D1 out 0 junction
.model junction D(IS=1e-14 N=1.2 RS=10 CJO=20p VJ=0.7 M=0.4 FC=0.5 TT=2n)
.ac dec 4 10 100meg
.end`;

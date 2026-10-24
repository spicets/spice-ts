ngspice extension coverage
V1 in 0 1
R1 in out 1k
L1 in n1 1u
L2 out n2 1u
K1 L1 L2 0.9
J1 out g 0 jmod
.model jmod NJF
O1 in 0 out 0 omod
.model omod LTRA rel=1 r=0 l=1u g=0 c=1p len=1
Z1 out g 0 zmod
.model zmod NMF
A1 in aout gain_block
.model gain_block gain(gain=2.0)
Rg g 0 1meg
Ra aout 0 1k
.param p={~1 + !0 + (2&3) + (4|1) + (5^1) + (1<<2)}
.op
.end

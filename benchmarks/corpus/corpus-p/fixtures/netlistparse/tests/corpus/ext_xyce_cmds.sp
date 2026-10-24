Xyce feature sweep
.param rval=1k
.global_param tc=27
.func half(x) {x/2}
V1 in 0 DC 1 AC 1
R1 in out {rval}
C1 out 0 1u
M1 d g s b nmos w=1u l=0.18u
.model nmos nmos level=1 vto=0.7
.subckt buf a y
Rb a y 1k
.ends
Xb in mid buf
.step rval 1k 5k 1k
.tran 1u 1m
.op
.print tran format=csv V(out) I(V1)
.measure tran vmax MAX V(out)
.options timeint reltol=1e-4
.nodeset V(out)=0
.ic V(out)=0
.end

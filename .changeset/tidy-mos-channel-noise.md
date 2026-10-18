---
"@spice-ts/core": patch
---

Support MOS2, MOS3 and MOS9 channel thermal and KF/AF flicker noise, including compiler-expanded drain/source resistance noise. Match ngspice-47 MOS2/MOS3 NLEV=0/1/2 and MOS9's legacy flicker formula. Keep unported MOS2/MOS3 NLEV=3 as an explicit circuit error.

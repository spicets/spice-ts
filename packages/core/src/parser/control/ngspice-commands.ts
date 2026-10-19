/**
 * ngspice-47 command-table membership, including conditionally built commands.
 * https://github.com/ngspice/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/frontend/commands.c
 * spcp_coms (not the standalone Nutmeg table). Keeping optional commands here
 * fails closed when their implementation/build support is unavailable.
 *
 * The newer corpus revision 3ef069fb1f04177a153f342a32d941fc20ff047e adds
 * snp at src/frontend/commands.c:303. It is NOT in the ngspice-47 oracle.
 */
const NGSPICE_47_COMMANDS = new Set(`
ac alias alter altermod alterparam asciiplot aspice bltplot break bug cd cdump
check_ifparm circbyline codemodel compose continue cross cutout dc define deftype
delete destroy devhelp diff display disto dowhile dump echo edisplay edit else
end eprint eprvcd esave fclose fft fopen foreach fourier fread getcwd gnuplot goto
hardcopy help history if inventory iplot jobs label let linearize listing load
mc_source mdump meas mrdump newhelp noise oldhelp op option options optran osdi
plot print psd pss pyplot pz quit rehash remcirc removecirc remzerovec repeat
reset reshape resume rspice run rusage save sens set setcirc setcs setplot
setscale setseed settype shell shift show showmod sndparam sndprint snload
snsave source sp spec state status step stop strcmp strslice strstr sysinfo tf
trace tran transpose tutorial unalias undefine unlet unset use version where
while wrdata write wrnodev wrs2p
`.trim().split(/\s+/));

export function isNgspice47Command(name: string): boolean {
  return NGSPICE_47_COMMANDS.has(name);
}

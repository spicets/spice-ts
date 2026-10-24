"""Generate the authored MIT grounded-channel reference from the identical transient.cir.

Run: python3 packages/core/src/devices/bsim4/__fixtures__/grounded-channel/generate-transient.py
Requires ngspice-47. Only output-control commands are added to the shared deck.
"""
import bisect
import hashlib
import json
import pathlib
import subprocess
import tempfile

base = pathlib.Path(__file__).resolve().parent
version = subprocess.check_output(['ngspice', '--version'], text=True)
assert 'ngspice-47 ' in version, version
deck = (base / 'transient.cir').read_text()
with tempfile.TemporaryDirectory() as tmp:
    tmp = pathlib.Path(tmp)
    control = f'''.control
set wr_vecnames
set wr_singlescale
set numdgt=17
run
wrdata {tmp / 'transient.dat'} v(gate) v(sense) i(Vdrive)
quit
.endc
.end
'''
    native = tmp / 'native.cir'
    native.write_text(deck.replace('.end\n', control))
    run = subprocess.run(['ngspice', '-b', str(native)], cwd=tmp, capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr
    rows = [list(map(float, line.split())) for line in (tmp / 'transient.dat').read_text().splitlines()[1:]]
    times = [row[0] for row in rows]
    grid = [n * 2e-12 for n in range(401)]
    signals = {}
    for col, name in enumerate(['gate', 'sense', 'Vdrive'], 1):
        values = []
        for t in grid:
            j = max(0, min(len(rows) - 2, bisect.bisect_right(times, t) - 1))
            weight = (t - times[j]) / (times[j + 1] - times[j])
            values.append(rows[j][col] + weight * (rows[j + 1][col] - rows[j][col]))
        signals[name] = values
    result = dict(version=version.splitlines()[1], sha256=hashlib.sha256(deck.encode()).hexdigest(), grid=grid, signals=signals)
    (base / 'transient-ngspice-47.json').write_text(json.dumps(result, indent=2) + '\n')
print(f'Generated {len(grid)} grounded-channel samples from {len(rows)} native points')

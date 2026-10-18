"""Read-only ngspice sharedsync observer, including points before TRAN TSTART.

Usage: python3 native-trajectory.py /path/to/libngspice.dylib /path/to/deck.cir
No callback changes the proposed timestep or asks ngspice to redo a step.
"""
import ctypes as c
import json
import sys

lib = c.CDLL(sys.argv[1])
trials = []
messages = []
CHAR = c.CFUNCTYPE(c.c_int, c.c_char_p, c.c_int, c.c_void_p)
SYNC = c.CFUNCTYPE(c.c_int, c.c_double, c.POINTER(c.c_double), c.c_double,
                  c.c_int, c.c_int, c.c_int, c.c_void_p)

@CHAR
def output(text, _ident, _user):
    messages.append(text.decode())
    return 0

@SYNC
def sync(time, delta, old_delta, redo, _ident, location, _user):
    if location == 1:
        # sharedsync subtracts olddelta BEFORE the callback on a rejected trial.
        trials.append(dict(time=time + old_delta if redo else time,
                           delta=old_delta, nextDelta=delta[0], rejected=bool(redo)))
    return 0

lib.ngSpice_Init(output, None, None, None, None, None, None)
lib.ngSpice_Init_Sync(None, None, sync, None, None)
lib.ngSpice_Command(b'unset interp')
status = lib.ngSpice_Command(('source ' + sys.argv[2]).encode())
if status or not trials:
    raise RuntimeError('\n'.join(messages))
print(json.dumps(dict(trials=trials, messages=messages)))

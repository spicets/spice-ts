// Investigative CI instrumentation, not a repair. Log only fork lifecycle metadata.
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { writeSync } = require('node:fs');
const originalFork = childProcess.fork;
childProcess.fork = function (...args) {
  const child = originalFork.apply(this, args);
  const report = (event, extra = {}) => writeSync(2, `[wasm-fork-diagnostic] ${JSON.stringify({ event, parentPid: process.pid, pid: child.pid, ...extra })}\n`);
  report('start');
  child.on('exit', (code, signal) => report('exit', { code, signal }));
  child.on('error', error => report('error', { message: error.message }));
  return child;
};
syncBuiltinESMExports();

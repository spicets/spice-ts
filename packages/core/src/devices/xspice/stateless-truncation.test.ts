import { describe, expect, it } from 'vitest';
import { createTransientSim, type TransientRejection } from '../../analysis/transient-driver.js';

describe('stateless XSPICE transient truncation (#1464)', () => {
  it('does not apply node-voltage LTE to an algebraic limit output', async () => {
    const rejections: TransientRejection[] = [];
    const sim = await createTransientSim(`Stateless limit with a capacitive load
v1 in 0 sin(0 1 1meg)
a1 in out lim
.model lim limit(gain=2 out_lower_limit=-12 out_upper_limit=12)
r1 out filtered 1k
c1 filtered 0 1n
.tran 100n 3u
.end`, { onReject: rejection => rejections.push(rejection) });
    try {
      while (!sim.isDone) sim.advance();
      expect(rejections.some(rejection => rejection.reason === 'charge-lte')).toBe(true);
      expect(rejections.filter(rejection => rejection.reason.includes('voltage'))).toEqual([]);
    } finally {
      sim.dispose();
    }
  });
});

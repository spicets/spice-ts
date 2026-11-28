# Batched AC group delay

`spice_ac_metrics` accepts `groupDelayFrequenciesHz`, an array of 1 to 128 finite positive frequencies in Hz. The optional `groupDelays` response contains `{ frequencyHz, delaySeconds }` in request order, including duplicates. A scalar `groupDelayAtHz` can be requested at the same time. Both use the same AC simulation.

Delay is the negative slope of unwrapped transfer phase in cycles per Hz. Sample delays use centered differences and one-sided differences at sweep endpoints. Delays between samples are interpolated linearly in Hz, not log frequency. The sampled phase must change by less than 180 degrees between adjacent frequencies. Faster changes can alias even when their sampled difference is below 180 degrees; use a denser sweep when needed.

Each query outside the sweep returns `delaySeconds: null` and `reason: "OUT_OF_RANGE"`. A query returns `reason: "UNDEFINED_PHASE"` when its required difference stencil contains a zero output magnitude, an exactly 180-degree adjacent phase difference, fewer than two sweep samples, or a non-finite computed delay. No extrapolation is performed. Invalid input arrays reject the request. The existing scalar's error behavior remains unchanged.

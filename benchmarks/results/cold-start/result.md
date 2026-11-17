# Cold process operating-point timings

Five runs, milliseconds. Both engines receive the identical generated deck. Wall includes process startup and output; phase timings exclude startup. Solve includes validation and result mapping; ngspice timings include output. These are timing measurements, not correctness comparisons.

Core 0.4.0, source 3e25974387b0aa107b47ecc6d6e9ac30b26660d6; Node v22.23.4; Apple M5 Pro, darwin 27.0.0, arm64.

| Nodes | Import median/min ms | Parse median/min ms | Setup median/min ms | Solve median/min ms | spice-ts wall median/min ms | ngspice wall median/min ms |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 36.400/35.692 | 9.826/8.749 | 11.296/10.366 | 4.822/4.130 | 118.114/111.906 | 25.359/22.329 |
| 100 | 37.558/36.228 | 13.472/12.927 | 11.709/11.118 | 5.668/5.532 | 122.223/119.572 | 26.212/25.575 |
| 1000 | 36.987/36.493 | 36.954/36.304 | 18.592/18.310 | 15.444/15.109 | 163.156/158.265 | 34.893/34.149 |

Not reproduced: no matching 0.3.0 run with this harness.

# Load Test Report

## Machine Specifications

* CPU: 11th Gen Intel(R) Core(TM) i7-11370H @ 3.30GHz (4 physical cores, 8 threads)
* RAM: 16 GB DDR4
* OS: Windows 11 Enterprise (x64)
* Node.js: v23.3.0

The load bots ran on the same machine as the server, so real capacity is likely somewhat higher.

## How It Was Measured

The test was measured using automated bots that connect over real WebSocket connections. Each room has one drawer bot streaming coordinate batches at 30 batches per second, while guesser bots receive strokes and submit periodic chat guesses. Room sizes are uniformly distributed between 2 and 12 players, averaging 7 players per room. In the realistic scenario, the drawer alternates between 2.2-second drawing bursts and 1.8-second pauses (about 55 percent drawing duty cycle), and churn simulates a 10 percent chance every 5 seconds per room of one guesser dropping and rejoining. Latency is measured by embedding a timestamp in each stroke batch and recording the arrival time at each guesser socket. Rooms were added in stepped increments, and a step is considered healthy if p95 delivery latency stays under 100 ms, event loop p99 delay stays under 50 ms, and server process CPU stays under 70 percent of one core.

## Benchmark Results

| Scenario | Rooms | Players | p95 Latency | Server CPU | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Scenario B (Realistic Mix) | 25 | 183 | 9 ms | 10.6% | PASS |
| Scenario B (Realistic Mix) | 50 | 305 | 15 ms | 17.2% | PASS |
| Scenario B (Realistic Mix) | 75 | 486 | 23 ms | 48.9% | PASS |
| Scenario B (Realistic Mix) | 100 | 729 | 58 ms | 36.3% | FAIL |
| Scenario C (Worst Case) | 25 | 300 | 16 ms | 42.9% | PASS |
| Scenario C (Worst Case) | 35 | 420 | 23 ms | 63.7% | PASS |
| Scenario C (Worst Case) | 50 | 600 | 55 ms | 81.8% | FAIL |

## Idle Rooms

Each idle room consumed approximately 74.7 KB of RSS memory.
Memory is not the practical limit, as thousands of idle rooms consume negligible RAM before operating system socket limits are reached.

## Key Optimizations

Pre-serializing each broadcast once per room rather than once per recipient reduced p95 latency from 40 ms to 28 ms under heavy load.
Switching disk persistence from synchronous file writes to asynchronous non-blocking writes reduced player churn p95 latency from 213 ms to 30 ms.

## Soak and Spike Tests

The soak test ran for 3 minutes at 70 percent capacity with 53 rooms (352 players), during which continuous drawing load was confirmed past the 80-second turn mark and memory leveled off at 211 MB, though a longer test would be needed to be sure there is no slow leak.
The spike test severed all client sockets across 50 rooms (331 players) simultaneously, and all 331 players successfully reconnected using their session tokens within 292 ms with zero duplicate players.

## Limits

These results were measured on a single Windows laptop where the load generator ran on the same machine as the server, competing for CPU time and cache. The load generator runs as a single Node thread on the same machine as the server, so latency at higher room counts includes bot-side scheduling lag. The event loop delay measurements include the sampling interval of the monitor, so they tend to read slightly high. Any multi-core numbers are estimates based on independent room routing, not direct physical measurements.

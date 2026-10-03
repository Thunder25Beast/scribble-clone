# Load Test and Capacity Report

## Test Environment and Hardware Specifications

* Processor: 11th Gen Intel(R) Core(TM) i7-11370H @ 3.30GHz (8 cores)
* Memory: 16 GB RAM
* Node Version: v23.3.0
* Operating System: Windows_NT 10.0.26300 (Windows 11)
* Load Test Script: tools/loadtest.ts

## Methodology

The test script simulates multiple concurrent game rooms running against a single Node.js process. Each room contains 8 participants: 1 drawer bot and 7 guesser bots.

1. The drawer bot streams drawing stroke batches at approximately 30 batches per second, with 10 logical coordinate points per batch.
2. Every drawing stroke message carries a client creation timestamp.
3. Guessers receive the stroke batches over WebSockets on the same host. The end to end latency is measured as local receive time minus client send time.
4. Guessers submit intermittent guess chat messages every 3 seconds to emulate human guessing traffic.
5. The server process exposes runtime metrics via its `/stats` endpoint, sampling heap memory and event loop delay via Node's `perf_hooks.monitorEventLoopDelay`.
6. Traffic ramps in stepped increments: 25 rooms (200 bots), 50 rooms (400 bots), 100 rooms (800 bots), and 150 rooms (1200 bots).
7. Each step runs for a 30 second sustained measurement period following an initial warmup.
8. A test step is judged healthy if p95 latency remains under 100 ms and event loop delay p99 remains under 50 ms.

## Measured Results

| Rooms | Total Players | Total Msgs/sec | p50 Latency (ms) | p95 Latency (ms) | p99 Latency (ms) | Event Loop p99 (ms) | Server Heap (MB) | Result |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 25 | 200 | 3,564 | 2 | 4 | 5 | 34.2 | 35 | PASS |
| 50 | 400 | 7,416 | 5 | 11 | 15 | 33.2 | 75 | PASS |
| 100 | 800 | 14,869 | 9 | 19 | 23 | 37.7 | 171 | PASS |
| 150 | 1,200 | 22,331 | 15 | 36 | 57 | 44.1 | 308 | PASS |

## Observations and Capacity Limit

* The server handled 150 concurrent rooms (1,200 connected WebSocket players) while maintaining a p95 latency of 36 ms and an event loop p99 delay of 44.1 ms.
* At 150 rooms, the process processed over 22,000 WebSocket messages per second with 308 MB heap consumption.
* Because both the server and the 1,200 load bot clients ran concurrently on the same host machine, client generation overhead consumed substantial CPU cycles. On dedicated production hardware with distributed clients, capacity per core is expected to be higher.
* The measured healthy capacity on this machine is 150 rooms (1,200 players) on one Node.js process.

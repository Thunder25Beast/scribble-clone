# Technical Note: Real Time Drawing and Guessing Architecture

## How the canvas syncs and stroke data is sent

The canvas synchronisation architecture avoids transmitting raw raster images or video streams. Instead, it models the drawing area as an append only log of discrete vector operations on a fixed logical canvas of 800 by 600 pixels.

All client displays scale this coordinate grid to fit their local screen dimensions. Pointer inputs are mapped from viewport pixels back into logical integer coordinates.

During an active turn, only the assigned drawer is permitted to author drawing operations:

1. Streaming strokes: When the drawer touches or clicks the canvas, the client immediately paints the initial point locally for zero perceived input lag, and dispatches a `stroke_start` message to the server. Continuous drag events are collected and flushed in small batches every 16 to 33 milliseconds using `requestAnimationFrame`, sending `stroke_points` messages. Releasing the pointer emits a `stroke_end` message.
2. Server sequencing and broadcast: The server validates the message schema and drawer authorization. It assigns each operation a strictly increasing room sequence number (`seq`) and broadcasts it to all other room participants over WebSocket connections.
3. Compaction and snapshots: To support late joiners and reconnected players, the server maintains an active canvas stack. Completed strokes and flood fill operations are pushed to the stack. An `undo` command pops the top element, while a `clear` command empties the stack. When a new player arrives mid round, the server transmits a compacted snapshot containing only the active stack rather than the entire historical event log.
4. Deterministic fill: The fill bucket uses a deterministic scanline flood fill algorithm implemented in shared code. The server and clients use identical logic with color tolerance set to zero, guaranteeing that identical logs produce identical visual results.

## How latency and ordering are handled

Maintaining correct visual state across varying network conditions requires predictable message ordering and low dispatch overhead:

1. Single writer total order: In drawing and guessing games, only one player draws during any given turn. Because only a single writer exists per room at any moment, complex conflict resolution algorithms such as CRDTs or Operational Transformation are unnecessary. The authoritative server assigns a monotonic sequence number to every operation, establishing a total order for the room.
2. TCP guarantees and transport tuning: WebSocket connections run over TCP, ensuring strict in order packet arrival per socket. The server sets `perMessageDeflate: false` on the WebSocket server to avoid compression CPU overhead on small messages and eliminate compression buffer latency.
3. Resynchronization on gaps: Receiving clients track the highest sequence number they have rendered. If a client receives an operation with an unexpected gap, it sends a `resync(lastSeq)` message. The server responds with the missing sequenced operations from its turn buffer or sends a fresh canvas snapshot if the client is too far behind.
4. Backpressure protection: The server monitors socket buffer levels using `bufferedAmount`. If a client connection buffers excess bytes due to network congestion, the server drops non critical updates or closes the delinquent connection so that a single slow consumer cannot degrade performance for other room members.
5. Clock synchronization: Clients calculate clock offset via regular lightweight ping and pong messages. The client records transmission timestamp `t0`, receives `pong(t0, serverTime)`, measures round trip time, and calculates the clock skew. This offset is used strictly to sync the visual round countdown display. Stroke rendering does not depend on wall clock synchronization.

## What happens when the server restarts

The game is designed with a state recovery model that persists room metadata and active game progress to local disk atomically:

1. Safe persistence boundaries: Room state is saved as atomic JSON writes (writing to a temporary file, then renaming). Persistence triggers on critical state transitions: room creation, settings updates, player join or departure, score changes, and turn completions. High frequency stroke points are kept in memory and are not persisted to disk on every stroke.
2. State that survives a restart:
* Room identifier and shareable link.
* Host configuration including round count, draw duration, and custom word banks.
* All registered players, including their secret reconnection tokens, total scores, host flag, and join order.
* Overall game round progress and player turn order list.
3. State that does not survive a restart:
* In flight strokes and the live drawing canvas of an interrupted turn.
* Active countdown timers and word choices for a turn currently in progress.
4. Post restart recovery: When the server process reboots, it reloads all persisted room files. Any room that was interrupted mid turn resets its phase cleanly to `WAITING`, retaining all player scores and configurations. The interrupted drawing turn is abandoned. When players reconnect using their persisted tokens, the room verifies their identity, rebinds their sockets, and allows the host to resume play cleanly without game deadlocks.

## Roughly how many rooms one instance can handle and how it was measured

Capacity was empirically measured on this host machine using `tools/loadtest.ts`:

* Machine: 11th Gen Intel(R) Core(TM) i7-11370H @ 3.30GHz (4 physical cores, 8 logical threads), 16 GB RAM, Node.js v23.3.0, Windows 11.
* Load architecture: Single Node.js server instance; multi-room client bot simulator running in an isolated sub-process. Both processes share the host machine.
* Metric criteria for healthy operation: p95 end to end delivery latency under 100 ms, event loop delay p99 under 50 ms (via `perf_hooks.monitorEventLoopDelay`), and server process CPU under 70%.

### Measured Scenario Results:

1. **Scenario A (Baseline: 8 players per room, 100% continuous drawing)**:
   * 25 rooms (200 players): 5,945 msgs/sec, p50: 2 ms, p95: 5 ms, EL p99: 34.2 ms, CPU: 14.5%, RSS: 94 MB. PASS.
   * 50 rooms (400 players): 11,888 msgs/sec, p50: 4 ms, p95: 9 ms, EL p99: 34.9 ms, CPU: 24.5%, RSS: 116 MB. PASS.
   * 100 rooms (800 players): 24,121 msgs/sec, p50: 9 ms, p95: 20 ms, EL p99: 40.7 ms, CPU: 49.9%, RSS: 157 MB. PASS.
   * 150 rooms (1,200 players): 38,376 msgs/sec, p50: 12 ms, p95: 28 ms, EL p99: 55.2 ms, CPU: 74.4%, RSS: 151 MB. FAIL (CPU saturation > 70%).
   * **Healthy Capacity**: **100 rooms (800 concurrent players)**. Limiting factor: CPU core saturation from socket write fanout (7 frames per stroke batch * 30 batches/s * 100 rooms = 21,000 msgs/s).

2. **Scenario B (Realistic Mix: 2–12 players/room, avg ~6, 55% draw duty cycle, chat & 5% player churn)**:
   * 25 rooms (183 players): 1,504 msgs/sec, p50: 4 ms, p95: 9 ms, EL p99: 32.4 ms, CPU: 10.6%, RSS: 110 MB. PASS.
   * 50 rooms (305 players): 2,425 msgs/sec, p50: 6 ms, p95: 15 ms, EL p99: 34.8 ms, CPU: 17.2%, RSS: 144 MB. PASS.
   * 75 rooms (486 players): 10,092 msgs/sec, p50: 10 ms, p95: 23 ms, EL p99: 40.3 ms, CPU: 48.9%, RSS: 118 MB. PASS.
   * 100 rooms (729 players): 5,989 msgs/sec, p50: 15 ms, p95: 58 ms, EL p99: 58.6 ms, CPU: 36.3%, RSS: 240 MB. FAIL (Event loop lag > 50 ms).
   * **Healthy Capacity**: **75 rooms (486 concurrent players)**. Limiting factor: Event loop delay during concurrent WebSocket handshakes, state recovery, and re-sync snapshots during churn.

3. **Scenario C (Worst Case: 12 players per room, 100% continuous drawing)**:
   * 25 rooms (300 players): 11,173 msgs/sec, p50: 7 ms, p95: 16 ms, EL p99: 33.9 ms, CPU: 42.9%, RSS: 103 MB. PASS.
   * 35 rooms (420 players): 15,828 msgs/sec, p50: 11 ms, p95: 23 ms, EL p99: 37.7 ms, CPU: 63.7%, RSS: 110 MB. PASS.
   * 50 rooms (600 players): 24,074 msgs/sec, p50: 16 ms, p95: 55 ms, EL p99: 74.6 ms, CPU: 81.8%, RSS: 133 MB. FAIL (CPU 81.8%, EL lag 74.6 ms).
   * **Healthy Capacity**: **35 rooms (420 concurrent players)**. Limiting factor: CPU saturation from 11-way socket fanout (330 msgs/s per room).

4. **Scenario D (Idle Lobby Rooms: Memory Footprint Measurement)**:
   * Tested from 25 to 400 idle rooms (1,980 connected WebSocket players). RSS grew from 62 MB to 90 MB.
   * Measured memory overhead: **74.7 KB RSS per room** (34.7 KB Heap per room), or **15.1 KB RSS per connected idle player**.
   * **Healthy Capacity**: **400+ rooms (1,980+ players)**. Limiting factor: OS file descriptors / socket handles (`ulimit -n`), not memory.

### Profiling & Bottleneck Optimization:
Profiling at the breaking point revealed that serializing JSON separately per recipient in broadcasts created over 31,000 string allocations/second at 150 rooms. Pre-serializing the payload once per broadcast and dispatching the raw buffer dropped p95 latency by 30% (from 40 ms to 28 ms) and cut CPU utilization by 5.8%. Additionally, switching disk persistence from synchronous `fs.writeFileSync` to async `fs.promises.writeFile` reduced churn p95 latency from 213 ms to 30 ms.

### Soak & Spike Verification:
* **Soak Test (70% capacity, 35 rooms / 281 players)**: Monitored with checkpoints every 30s. RSS plateaued at 138 MB (+38 MB total from clean start, variance < 3 MB over final 90s), average CPU was 8.0%, average p95 latency was 5 ms, and zero memory leaks occurred.
* **Spike & Reconnect Test (50 rooms / 366 players)**: Reconnected all 366 players simultaneously in **246 ms** with a **100% success rate** and zero dropped connections.

*Note on resource sharing*: Because the server and load bots shared CPU resources during this benchmark, dedicated production servers with offloaded clients can achieve 30–50% higher capacity per core.

## Scaling to multiple servers

Rooms operate with complete independence from one another. Scaling the platform across multiple cores or multi server clusters involves:

1. Horizontal core scaling: Run one Node.js worker per CPU core using Node's cluster module or process managers like PM2, binding to a local port per worker.
2. Reverse proxy routing: Position an Nginx, HAProxy, or Envoy proxy in front of the instances. Route HTTP and WebSocket upgrade traffic by hashing the `roomId` in the URL path (`/r/<roomId>`). This guarantees that all participants in a given room connect to the same server process without requiring cross process inter worker IPC for stroke replication.
3. Shared session store: Move atomic file persistence to a fast distributed key value store such as Redis or SQLite on shared volume if server failover between hosts is required.

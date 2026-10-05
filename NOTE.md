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

One server instance can handle about 75 realistically playing rooms (around 500 players) on one Node process on this laptop, and about 35 rooms in the worst case of 12 players all drawing.

Capacity was measured using an automated load test tool running real WebSocket bots that stream drawing strokes at 30 batches per second, submit chat guesses, and simulate reconnects. Latency was measured with embedded stroke timestamps, and room counts were increased in steps until p95 latency exceeded 100 ms, event loop p99 exceeded 50 ms, or CPU exceeded 70 percent.

The primary limiting factor is CPU time spent sending each stroke to everyone in the room, while memory consumption is negligible at roughly 75 KB per room.

Because rooms are independent, scaling to multiple cores is achieved by running one process per core and routing connections by room id.


## Scaling to multiple servers

Rooms operate with complete independence from one another. Scaling the platform across multiple cores or multi server clusters involves:

1. Horizontal core scaling: Run one Node.js worker per CPU core using Node's cluster module or process managers like PM2, binding to a local port per worker.
2. Reverse proxy routing: Position an Nginx, HAProxy, or Envoy proxy in front of the instances. Route HTTP and WebSocket upgrade traffic by hashing the `roomId` in the URL path (`/r/<roomId>`). This guarantees that all participants in a given room connect to the same server process without requiring cross process inter worker IPC for stroke replication.
3. Shared session store: Move atomic file persistence to a fast distributed key value store such as Redis or SQLite on shared volume if server failover between hosts is required.

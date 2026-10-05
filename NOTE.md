# Technical Note: Drawing and Guessing Architecture

## How the canvas syncs and stroke data is sent

We do not send images or video streams. Instead, the canvas uses a fixed 800x600 coordinate grid, and strokes are sent as lightweight vector points over WebSockets.

1. **Immediate drawing with batched sending**: When the drawer touches the canvas, the local browser paints immediately so there is zero input lag. Continuous movement points are batched every 16 to 33 ms using `requestAnimationFrame` before sending.
2. **Server sequencing**: The server checks that the sender is the active drawer, attaches an increasing sequence number (`seq`), and broadcasts the points to other players in the room.
3. **Snapshots for late joiners**: Late joiners and reconnecting players do not download the full stroke history. The server maintains an active canvas stack (which updates when undo or clear is used) and sends only this clean snapshot when a player joins mid-round.
4. **Deterministic fill**: Every client runs the same scanline flood fill code on the same operations with zero color tolerance, so fills match on every screen.

## How latency and ordering are handled

1. **Single drawer means no merge conflicts**: Only one person draws per turn. Because there is only one writer at any moment, we do not need complex algorithms like CRDTs or Operational Transformation. The server gives each message an increasing sequence number to set a clear order.
2. **Ordered delivery over TCP**: WebSockets use TCP, so packets arrive in order. If a client ever spots a missing sequence number, it asks the server to resend the missing events or requests a fresh canvas snapshot.
3. **No compression overhead**: We turn off WebSocket per-message compression (`perMessageDeflate: false`). Drawing packets are tiny (a few hundred bytes), so compressing them wastes CPU and adds delay.
4. **Clock synchronization**: Clients do simple ping and pong round trips with the server to measure latency and clock offset. This is only used to keep the round timer countdown in sync across screens; drawing itself does not depend on wall clock time.

## What happens when the server restarts

1. **Safe persistence to disk**: The server saves room data to atomic JSON files on disk whenever important events happen: room creation, settings updates, player joins or leaves, score changes, and round ends. High-frequency drawing points stay in memory to avoid hurting disk performance.
2. **What survives**: Room code, host settings, all players and their secret reconnect tokens, current scores, and round progress.
3. **What is lost**: In-flight drawing strokes and the active countdown timer of an interrupted turn.
4. **Clean recovery on reboot**: When the server restarts, it reloads all room files. Any game that was interrupted mid-turn resets to the `WAITING` lobby state with all scores intact. When players reconnect with their stored tokens, their seats are restored, and the host can start the next turn without the game getting stuck.

## Roughly how many rooms one instance can handle and how it was measured

One server process on a single core of my laptop handles **at least 75 and fewer than 100 realistic rooms** (around 500 active players). In the worst-case scenario where 12 players in every room are drawing at the same time, capacity drops to about **35 rooms**.

Measured on an Intel i7-11370H laptop (4 cores, 16 GB, Windows 11, Node 23). The load bots ran on the same machine as the server, so these numbers are a rough estimate.

### How it was measured

1. **Realistic bot load**: I built an automated benchmark tool (`tools/loadtest.ts`) that runs the actual server and connects real WebSocket bots. Bots draw at 30 batches per second, guess words in chat, and simulate reconnects.
2. **Direct latency measurement**: Each stroke carries a send timestamp, so guessers measure exact end-to-end delivery time on arrival.
3. **Failure criteria**: Rooms were added in steps until p95 latency exceeded 100 ms, event loop lag exceeded 50 ms, or CPU usage crossed 70%.
4. **Bottleneck**: The primary limit is CPU time spent serializing and broadcasting messages to everyone in the room. Memory usage is low, averaging about 75 KB per idle room, and a few hundred MB total for 100 active rooms. Detailed graphs and numbers are documented in [LOAD_TEST.md](LOAD_TEST.md).

## Scaling to multiple cores and servers

Because rooms do not share state, scaling is straightforward:
1. Run one Node process per CPU core, each on its own port, and put Nginx in front to pick the process by hashing the room ID from the URL (`/r/<roomId>`). All players in a room then reach the same process.
2. For multi-server clusters, replace local file persistence with a shared Redis or database store.

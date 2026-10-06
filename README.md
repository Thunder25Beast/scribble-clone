# Multiplayer Drawing and Guessing Game

A real-time multiplayer drawing and guessing game inspired by Skribbl.io. The server is the single authoritative source of truth for rooms, turns, scoring, drawing op logs, and chat verification.

## Deliverables

* **The game running from one documented command**:
  ```bash
  npm install && npm start
  ```
  Installs dependencies, builds server and client bundles, and starts the server on port 3000 (`http://localhost:3000`).
  * Live hosted game: [https://scribble-clone-o3mx.onrender.com/](https://scribble-clone-o3mx.onrender.com/)

* **A screen recording with at least 3 players in separate browsers**:
  * [Watch 3-Player Walkthrough on Google Drive](https://drive.google.com/file/d/1h5fWh2yjbOTirvkLuDWnbO5oZI2LGsgC/view?usp=sharing)
  * Demonstrates room creation, live drawing tools, chat guessing with near-miss alerts, anti-spoiler chat isolation, mid-round reconnect resilience, and post-game stroke replay.

* **A short technical note ([NOTE.md](NOTE.md)) covering**:
  * **[How you sync the canvas and send stroke data](NOTE.md#how-the-canvas-syncs-and-stroke-data-is-sent)**: Append-only vector op log on a fixed 800x600 logical canvas streamed via WebSockets with local optimistic painting.
  * **[How you handle latency and ordering](NOTE.md#how-latency-and-ordering-are-handled)**: Single-writer total order, monotonic sequence numbers, and uncompressed TCP WebSockets with resync on sequence gaps.
  * **[What happens when the server restarts](NOTE.md#what-happens-when-the-server-restarts)**: Atomic disk persistence on game boundaries; interrupted turns reset cleanly to WAITING state with scores intact.
  * **[Roughly how many rooms one server instance can handle, and how you measured it](NOTE.md#roughly-how-many-rooms-one-instance-can-handle-and-how-it-was-measured)**: Empirically measured at least 75 and fewer than 100 realistic rooms (~500 players) on one core, and about 35 rooms in the worst case (full report in [LOAD_TEST.md](LOAD_TEST.md)).

## Running Tests & Benchmarks

* **Automated test suite**:
  ```bash
  npm test
  ```
  Runs 23 automated unit and integration tests using real WebSocket sockets.

* **Capacity load test**:
  ```bash
  npm run loadtest
  ```
  Executes the automated bot benchmark suite measuring latency percentiles and event loop lag under load (documented in [LOAD_TEST.md](LOAD_TEST.md)).

# Multiplayer Drawing and Guessing Game

A real time multiplayer drawing and guessing browser game inspired by Skribbl.io. The server acts as the single source of truth for all game mechanics, turns, scoring, drawing streams, and chat verification.

## Quick Start: The One Command

Run the following command from the repository root:

```bash
npm install && npm start
```

This installs dependencies, builds both server and client bundles, and starts the server on port 3000 (or the port specified by the `PORT` environment variable).

Access the game in your browser at:
`http://localhost:3000`

## How to Play

1. Landing Screen: Click "Create Room" to create a new game room, or enter a room code or link to join an existing game.
2. Enter Name: Provide a display name (1 to 20 characters).
3. Lobby:
* Copy and share the room link (`/r/<roomId>`) with friends.
* The room host can configure the number of rounds (1 to 10), the draw time per turn (30 to 180 seconds), and the word bank (Default words, Custom words, or a Mix of both).
* When at least 2 players have joined, the host clicks "Start Game".
4. Choosing a Word: When it is your turn to draw, choose 1 of 3 secret words within 15 seconds. Other players see that you are picking a word.
5. Drawing and Guessing:
* The drawer uses the pen, eraser, brush size slider, color palette, custom color picker, fill bucket, undo, and clear canvas tools.
* Other players type guesses into the chat box. Correct guesses award points based on speed and early bonus.
* Close guesses (within an edit distance of 1 or 2) notify the guesser privately with "Close!".
* Players who have guessed enter a private chat channel to prevent leaking the word.
6. Game Over and Replay: At the end of all rounds, the final leaderboard is presented. Players can select any completed turn and watch a stroke by stroke replay with play, pause, speed controls (1x, 2x, 4x), and an interactive timeline scrubber. The host can restart a new match with the same players.

## PDF Requirement Mapping Table

| Requirement from Assignment PDF | Implementation Details | File Location |
| :--- | :--- | :--- |
| Shareable room links and room creation | Cryptographic URL-safe room IDs (8 characters), `/r/<roomId>` routes | `server/index.ts`, `client/main.ts` |
| Host room settings | Rounds (1 to 10), draw time (30 to 180s), word modes (default, custom, mix) | `server/room.ts`, `shared/schemas.ts` |
| Drawing tools | Pen, 16+ palette, custom color, brush size (2 to 40px), eraser, flood fill, undo, clear | `client/main.ts`, `shared/utils.ts` |
| Low latency stroke streaming | Pointer events with `requestAnimationFrame` batching every 16 to 33ms, local optimistic drawing | `client/main.ts`, `server/room.ts` |
| Fixed logical canvas | 800x600 logical coordinate space scaled to client viewports | `shared/config.ts`, `client/main.ts` |
| Word selection | 3 distinct random words per turn with a 15s countdown and fallback | `server/room.ts`, `shared/words.ts` |
| Authoritative timer and hints | Server side deadline (`endsAt`), letter reveals at 40%, 60%, 80% of draw time | `server/room.ts`, `shared/utils.ts` |
| Guessing and chat mechanics | Normalized string comparisons, edit distance for near misses, private chat for guessed players | `shared/utils.ts`, `server/room.ts` |
| Authoritative scoring | Time decay points (max 500, floor 50), early bonus (+50, +30, +10), drawer points based on guessers | `shared/utils.ts`, `server/room.ts` |
| Op log compaction and late joiners | Active stack pops on undo, clears on clear, compact snapshot sent to late joiners | `server/room.ts`, `tests/unit.test.ts` |
| Reconnection with token | Player secret token in localStorage, 30s grace period, rebinds socket to player score | `server/room.ts`, `server/index.ts` |
| Drawer leaves mid turn | 5s grace period before ending turn cleanly, awarding guesser points and passing turn | `server/room.ts`, `tests/integration.test.ts` |
| Stroke by stroke replay | Turn archive with millisecond offsets, replay UI with play, pause, 1x/2x/4x, scrubber | `server/room.ts`, `client/main.ts` |
| Abuse and rate limiting | Token bucket rate limits on chat and drawing, 16KB WebSocket payload limit, text sanitization | `server/ratelimit.ts`, `shared/config.ts` |
| Server restart recovery | Atomic JSON writes to disk on safe boundaries, reloads rooms in WAITING state | `server/index.ts`, `server/room.ts` |
| End to end tests | Node test runner covering unit logic and integration scenarios with real sockets | `tests/unit.test.ts`, `tests/integration.test.ts` |
| Capacity measurement | Load test tool with bot rooms, p50/p95/p99 latency, event loop delay | `tools/loadtest.ts`, `LOAD_TEST.md` |

## Assumptions

1. Canvas aspect ratio: The game uses a standard 800x600 logical canvas. On mobile screens and small viewports, the canvas maintains its 4:3 aspect ratio and scales via CSS transforms.
2. Disconnect grace period: A disconnected player has 30 seconds to rejoin. After 30 seconds, their turn is skipped, but their final score remains on the room leaderboard marked as disconnected.
3. Drawer disconnect: If the current drawer disconnects during DRAWING, the server grants a 5 second grace window. If they do not return, the turn terminates cleanly without awarding drawer points, while guessers keep earned points.
4. Server reboot state: When the server reboots, active in flight drawing strokes are discarded, and active rooms enter the `WAITING` state with all scores and players preserved. The host can then start the next turn cleanly.
5. In game word list: Custom word lists require a minimum of 10 words and a maximum of 1,000 words. Built in word list includes 350 common nouns and phrases.

## Known Limitations

1. Single process memory store: Active rooms are indexed in memory with atomic file persistence. Scaling across multiple machines requires an external proxy routing by room ID or a shared Redis store.
2. In flight stroke persistence: Strokes are kept in memory during an active turn and are not flushed to disk on every pointer event to protect I/O throughput. A crash mid stroke restarts the turn in WAITING state.
3. Mobile virtual keyboard: On very small mobile screens in landscape orientation, opening the virtual keyboard can reduce visible canvas area. Portrait orientation is recommended on mobile phones.

## Running Tests

Run the full automated test suite:

```bash
npm test
```

This runs both unit tests and integration tests with real WebSocket clients.

## Running the Capacity Load Test

Run the load test tool to measure capacity:

```bash
npm run loadtest
```

Custom step sizes and durations can be specified:

```bash
npx tsx tools/loadtest.ts --steps=25,50,100,150 --duration=30
```

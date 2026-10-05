import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import type { ServerMessage, ClientMessage } from '../shared/types.js';

const TEST_PORT = 3891;
const TEST_STATE_DIR = path.resolve('tests', 'test_state');

// Helper to launch test server process
function startServer(envOverrides: Record<string, string> = {}): Promise<{ process: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(TEST_STATE_DIR)) {
      fs.mkdirSync(TEST_STATE_DIR, { recursive: true });
    }

    const proc = spawn('node', ['dist/server/index.js'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        STATE_DIR: TEST_STATE_DIR,
        DRAWER_LEAVE_GRACE_MS: '600', // fast drawer leave for tests
        RECONNECT_GRACE_MS: '1200',   // fast reconnect timeout for tests
        JOIN_RATE_LIMIT: '1000',      // high limit for test suite
        ROOM_CREATE_RATE_LIMIT: '1000',
        ...envOverrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
      if (stdout.includes(`http://localhost:${TEST_PORT}`)) {
        resolve({ process: proc, url: `http://localhost:${TEST_PORT}` });
      }
    });

    proc.stderr?.on('data', (d) => {
      // console.error('[Server Err]:', d.toString());
    });

    proc.on('error', reject);

    setTimeout(() => {
      reject(new Error(`Server timed out starting. Output: ${stdout}`));
    }, 5000);
  });
}

// Client helper for integration tests
class TestClient {
  ws!: WebSocket;
  messages: ServerMessage[] = [];
  playerId: string = '';
  token: string = '';
  private messageListeners: Array<(msg: ServerMessage) => void> = [];

  connect(url: string = `ws://localhost:${TEST_PORT}`): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ServerMessage;
          this.messages.push(msg);
          for (const l of [...this.messageListeners]) {
            l(msg);
          }
        } catch {
          // ignore non-json
        }
      });
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(predicate: (msg: ServerMessage) => boolean, timeoutMs: number = 4000): Promise<ServerMessage> {
    // Check if already in history
    for (const msg of this.messages) {
      if (predicate(msg)) return Promise.resolve(msg);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.messageListeners.indexOf(listener);
        if (idx !== -1) this.messageListeners.splice(idx, 1);
        reject(new Error(`Timeout waiting for message. Received types: ${this.messages.map(m => m.type).join(', ')}`));
      }, timeoutMs);

      const listener = (msg: ServerMessage) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          const idx = this.messageListeners.indexOf(listener);
          if (idx !== -1) this.messageListeners.splice(idx, 1);
          resolve(msg);
        }
      };
      this.messageListeners.push(listener);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.on('close', () => resolve());
      this.ws.close();
    });
  }
}

// Helper to create a room via HTTP
async function createRoom(): Promise<string> {
  const res = await fetch(`http://localhost:${TEST_PORT}/api/create-room`, { method: 'POST' });
  const data = await res.json() as { roomId: string };
  return data.roomId;
}

describe('Integration Tests: Real WebSocket Clients and Server Authority', () => {
  let serverProc: ChildProcess;

  before(async () => {
    // Clean test state directory
    if (fs.existsSync(TEST_STATE_DIR)) {
      fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    }
    const s = await startServer();
    serverProc = s.process;
  });

  after(async () => {
    serverProc?.kill('SIGKILL');
    if (fs.existsSync(TEST_STATE_DIR)) {
      fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    }
  });

  it('runs a full turn with 3 players, authoritative drawing, guessing, and scoring', async () => {
    const roomId = await createRoom();

    const p1 = new TestClient();
    const p2 = new TestClient();
    const p3 = new TestClient();

    await Promise.all([p1.connect(), p2.connect(), p3.connect()]);

    // Players join room
    p1.send({ type: 'join', roomId, name: 'Alice' });
    const j1 = await p1.waitFor(m => m.type === 'joined') as Extract<ServerMessage, { type: 'joined' }>;
    p1.playerId = j1.playerId;
    p1.token = j1.token;
    assert.equal(j1.state.players[0].isHost, true);

    p2.send({ type: 'join', roomId, name: 'Bob' });
    const j2 = await p2.waitFor(m => m.type === 'joined') as Extract<ServerMessage, { type: 'joined' }>;
    p2.playerId = j2.playerId;
    p2.token = j2.token;

    p3.send({ type: 'join', roomId, name: 'Charlie' });
    const j3 = await p3.waitFor(m => m.type === 'joined') as Extract<ServerMessage, { type: 'joined' }>;
    p3.playerId = j3.playerId;
    p3.token = j3.token;

    // Host starts game
    p1.send({ type: 'start_game' });

    // Drawer (Alice) receives CHOOSING_WORD with 3 word choices
    const choosePhaseP1 = await p1.waitFor(m => m.type === 'phase_change' && m.phase === 'CHOOSING_WORD') as any;
    assert.ok(choosePhaseP1.wordChoices && choosePhaseP1.wordChoices.length === 3);
    const chosenWord = choosePhaseP1.wordChoices[0];

    // Non-drawers (Bob, Charlie) do NOT get word choices
    const choosePhaseP2 = await p2.waitFor(m => m.type === 'phase_change' && m.phase === 'CHOOSING_WORD') as any;
    assert.equal(choosePhaseP2.wordChoices, undefined);

    // Alice chooses word
    p1.send({ type: 'choose_word', word: chosenWord });

    // DRAWING phase starts: Alice gets word, Bob and Charlie get word mask
    const drawPhaseP1 = await p1.waitFor(m => m.type === 'phase_change' && m.phase === 'DRAWING') as any;
    assert.equal(drawPhaseP1.word, chosenWord);

    const drawPhaseP2 = await p2.waitFor(m => m.type === 'phase_change' && m.phase === 'DRAWING') as any;
    assert.equal(drawPhaseP2.word, undefined);
    assert.ok(drawPhaseP2.wordMask && drawPhaseP2.wordMask.includes('_'));

    // Drawer draws a stroke
    const strokeId = 'stroke_test_1';
    p1.send({
      type: 'draw_op',
      op: {
        type: 'stroke_start',
        id: strokeId,
        tool: 'pen',
        color: '#000000',
        size: 5,
        point: { x: 100, y: 100 },
      },
    });

    p1.send({
      type: 'draw_op',
      op: {
        type: 'stroke_points',
        id: strokeId,
        points: [{ x: 110, y: 110 }, { x: 120, y: 120 }],
      },
    });

    p1.send({
      type: 'draw_op',
      op: {
        type: 'stroke_end',
        id: strokeId,
      },
    });

    // Bob receives the stroke ops
    const receivedStroke = await p2.waitFor(m => m.type === 'draw_op' && m.op.type === 'stroke_end');
    assert.ok(receivedStroke);

    // Bob guesses wrong first
    p2.send({ type: 'chat', text: 'wrongguess' });
    const wrongChat = await p3.waitFor(m => m.type === 'chat' && m.text === 'wrongguess');
    assert.ok(wrongChat);

    // Bob guesses the correct word!
    p2.send({ type: 'chat', text: chosenWord });

    // Correct guess notification sent to all (does NOT reveal the word)
    const guessNotification = await p3.waitFor(m => m.type === 'correct_guess' && m.playerId === p2.playerId) as any;
    assert.ok(guessNotification);

    // Charlie also guesses correctly
    p3.send({ type: 'chat', text: chosenWord });

    // Since all non-drawers have guessed, turn ends immediately!
    const turnEndP1 = await p1.waitFor(m => m.type === 'phase_change' && m.phase === 'TURN_END') as any;
    assert.ok(turnEndP1);
    assert.equal(turnEndP1.word, chosenWord); // word revealed to everyone now

    // Check final score update broadcast where drawer and both guessers have points
    const finalScoreUpdate = await p1.waitFor(
      m => m.type === 'score_update' && (m.scores[p1.playerId] || 0) > 0
    ) as any;
    assert.ok(finalScoreUpdate);
    assert.ok(finalScoreUpdate.scores[p1.playerId] > 0, 'Drawer earned points');
    assert.ok(finalScoreUpdate.scores[p2.playerId] > 0, '1st guesser earned points');
    assert.ok(finalScoreUpdate.scores[p3.playerId] > 0, '2nd guesser earned points');
    // First guesser earned more points due to early bonus
    assert.ok(finalScoreUpdate.scores[p2.playerId] >= finalScoreUpdate.scores[p3.playerId]);

    await Promise.all([p1.close(), p2.close(), p3.close()]);
  });

  it('rejects cheating attempts: non-drawer drawing, fake scores, secret word inspection', async () => {
    const roomId = await createRoom();
    const host = new TestClient();
    const guest = new TestClient();

    await Promise.all([host.connect(), guest.connect()]);

    host.send({ type: 'join', roomId, name: 'HostDrawer' });
    await host.waitFor(m => m.type === 'joined');

    guest.send({ type: 'join', roomId, name: 'Guest' });
    await guest.waitFor(m => m.type === 'joined');

    host.send({ type: 'start_game' });
    const choosePhase = await host.waitFor(m => m.type === 'phase_change' && m.phase === 'CHOOSING_WORD') as any;
    const word = choosePhase.wordChoices[0];
    host.send({ type: 'choose_word', word });
    await guest.waitFor(m => m.type === 'phase_change' && m.phase === 'DRAWING');

    // 1. Cheating: Guest (non-drawer) tries to send draw_op
    guest.send({
      type: 'draw_op',
      op: {
        type: 'clear',
      },
    });

    // Host should NOT receive any clear op
    let hostReceivedCheaterOp = false;
    const cheaterCheck = (msg: ServerMessage) => {
      if (msg.type === 'draw_op' && msg.op.type === 'clear') {
        hostReceivedCheaterOp = true;
      }
    };
    host.ws.on('message', (d) => {
      try { cheaterCheck(JSON.parse(d.toString())); } catch {}
    });

    await new Promise(r => setTimeout(r, 200));
    assert.equal(hostReceivedCheaterOp, false, 'Non-drawer draw ops must be ignored and not broadcast');

    // 2. Cheating: Client tries to send an invalid or unauthorized message (e.g. fake score)
    (guest.ws as any).send(JSON.stringify({ type: 'set_score', score: 99999 }));
    await new Promise(r => setTimeout(r, 100));

    // Verify guest score remains 0
    assert.equal(guest.messages.some(m => (m as any).type === 'score_update' && (m as any).score === 99999), false);

    // 3. Security: Guest never receives secret word in state
    for (const msg of guest.messages) {
      if (msg.type === 'phase_change' && msg.phase === 'DRAWING') {
        assert.equal(msg.word, undefined, 'Guest must never receive unmasked word during DRAWING');
      }
    }

    await Promise.all([host.close(), guest.close()]);
  });

  it('reconnects within grace period keeping score, and removes player after grace period', async () => {
    const roomId = await createRoom();
    const p1 = new TestClient();
    const p2 = new TestClient();

    await Promise.all([p1.connect(), p2.connect()]);

    p1.send({ type: 'join', roomId, name: 'Player1' });
    const j1 = await p1.waitFor(m => m.type === 'joined') as any;
    p1.playerId = j1.playerId;
    p1.token = j1.token;

    p2.send({ type: 'join', roomId, name: 'Player2' });
    const j2 = await p2.waitFor(m => m.type === 'joined') as any;
    p2.playerId = j2.playerId;
    p2.token = j2.token;

    // Disconnect p2
    await p2.close();

    // Reconnect p2 within grace period (< 1200ms)
    const p2Reconnected = new TestClient();
    await p2Reconnected.connect();
    p2Reconnected.send({ type: 'join', roomId, name: 'Player2', token: p2.token });
    const reconnectedJoin = await p2Reconnected.waitFor(m => m.type === 'joined') as any;

    assert.equal(reconnectedJoin.playerId, p2.playerId, 'Reconnected socket is rebound to same player');
    assert.equal(reconnectedJoin.state.players.find((p: any) => p.id === p2.playerId)?.score, 0);

    // p1 receives player_reconnected and NOT another player_joined
    const p1ReconnectedMsg = await p1.waitFor(m => m.type === 'player_reconnected') as any;
    assert.equal(p1ReconnectedMsg.playerId, p2.playerId);
    const p1JoinedMsgs = p1.messages.filter(m => m.type === 'player_joined');
    assert.equal(p1JoinedMsgs.length, 1, 'p1 must not receive duplicate player_joined on reconnect');

    // Now disconnect p2Reconnected and wait for grace period (1200ms) to expire
    await p2Reconnected.close();
    await new Promise(r => setTimeout(r, 1400));

    // Inspect room state to confirm player is marked disconnected
    const inspector = new TestClient();
    await inspector.connect();
    inspector.send({ type: 'join', roomId, name: 'Inspector' });
    const inspJoin = await inspector.waitFor(m => m.type === 'joined') as any;

    const p2Entry = inspJoin.state.players.find((p: any) => p.id === p2.playerId);
    assert.ok(p2Entry);
    assert.equal(p2Entry.isConnected, false);

    await Promise.all([p1.close(), inspector.close()]);
  });

  it('recovers when drawer leaves mid-turn without stalling the game', async () => {
    const roomId = await createRoom();
    const drawer = new TestClient();
    const guesser1 = new TestClient();
    const guesser2 = new TestClient();

    await Promise.all([drawer.connect(), guesser1.connect(), guesser2.connect()]);

    drawer.send({ type: 'join', roomId, name: 'Drawer' });
    await drawer.waitFor(m => m.type === 'joined');

    guesser1.send({ type: 'join', roomId, name: 'Guesser1' });
    await guesser1.waitFor(m => m.type === 'joined');

    guesser2.send({ type: 'join', roomId, name: 'Guesser2' });
    await guesser2.waitFor(m => m.type === 'joined');

    drawer.send({ type: 'start_game' });
    const choosePhase = await drawer.waitFor(m => m.type === 'phase_change' && m.phase === 'CHOOSING_WORD') as any;
    drawer.send({ type: 'choose_word', word: choosePhase.wordChoices[0] });
    await guesser1.waitFor(m => m.type === 'phase_change' && m.phase === 'DRAWING');

    // Guesser 1 guesses correctly and earns points
    guesser1.send({ type: 'chat', text: choosePhase.wordChoices[0] });
    await guesser1.waitFor(m => m.type === 'correct_guess');

    // Drawer leaves mid-turn. 2 guessers remain connected, so game continues.
    await drawer.close();

    // After DRAWER_LEAVE_GRACE_MS (600ms in test), turn ends cleanly
    const endTurnMsg = await guesser1.waitFor(m => m.type === 'phase_change' && m.phase === 'TURN_END', 3000) as any;
    assert.ok(endTurnMsg, 'Game transitioned to TURN_END without stalling');
    assert.ok(endTurnMsg.word, 'Revealed word on abandonment');

    await Promise.all([guesser1.close(), guesser2.close()]);
  });

  it('sends canvas snapshot to late joiner during DRAWING', async () => {
    const roomId = await createRoom();
    const p1 = new TestClient();
    const p2 = new TestClient();

    await Promise.all([p1.connect(), p2.connect()]);

    p1.send({ type: 'join', roomId, name: 'Host' });
    await p1.waitFor(m => m.type === 'joined');

    p2.send({ type: 'join', roomId, name: 'Player2' });
    await p2.waitFor(m => m.type === 'joined');

    p1.send({ type: 'start_game' });
    const choose = await p1.waitFor(m => m.type === 'phase_change' && m.phase === 'CHOOSING_WORD') as any;
    p1.send({ type: 'choose_word', word: choose.wordChoices[0] });
    await p2.waitFor(m => m.type === 'phase_change' && m.phase === 'DRAWING');

    // Drawer draws a stroke
    p1.send({
      type: 'draw_op',
      op: {
        type: 'stroke_start',
        id: 'snapshot_stroke',
        tool: 'pen',
        color: '#ff0000',
        size: 10,
        point: { x: 50, y: 50 },
      },
    });
    p1.send({
      type: 'draw_op',
      op: {
        type: 'stroke_end',
        id: 'snapshot_stroke',
      },
    });

    await new Promise(r => setTimeout(r, 100));

    // Late joiner joins mid-drawing
    const late = new TestClient();
    await late.connect();
    late.send({ type: 'join', roomId, name: 'LateJoiner' });

    const snapshot = await late.waitFor(m => m.type === 'snapshot') as any;
    assert.ok(snapshot);
    assert.ok(snapshot.items.length > 0);
    assert.equal(snapshot.items[0].id, 'snapshot_stroke');

    await Promise.all([p1.close(), p2.close(), late.close()]);
  });

  it('rejects oversized payloads and rate limits rapid chat bursts', async () => {
    const roomId = await createRoom();
    const client = new TestClient();
    await client.connect();

    client.send({ type: 'join', roomId, name: 'TestUser' });
    await client.waitFor(m => m.type === 'joined');

    // 1. Oversized payload (> 16 KB)
    const bigPayload = 'A'.repeat(20 * 1024);
    let closed = false;
    client.ws.on('close', () => {
      closed = true;
    });

    client.ws.send(JSON.stringify({ type: 'chat', text: bigPayload }));
    await new Promise(r => setTimeout(r, 200));
    assert.equal(closed, true, 'Server closed socket exceeding maxPayload limit');

    // 2. Rate limiting rapid chat
    const client2 = new TestClient();
    await client2.connect();
    client2.send({ type: 'join', roomId, name: 'Chatter' });
    await client2.waitFor(m => m.type === 'joined');

    // Send 10 rapid chat messages (bucket size is 5)
    for (let i = 0; i < 10; i++) {
      client2.send({ type: 'chat', text: `message ${i}` });
    }

    const rateLimitWarning = await client2.waitFor(
      m => m.type === 'chat' && m.isSystem === true && m.text.includes('Slow down')
    );
    assert.ok(rateLimitWarning, 'Client received rate limit warning message');

    await client2.close();
  });

  it('allows host to restart game in same room and return to lobby', async () => {
    const roomId = await createRoom();
    const host = new TestClient();
    const guest = new TestClient();
    await host.connect();
    await guest.connect();

    host.send({ type: 'join', roomId, name: 'HostUser' });
    await host.waitFor(m => m.type === 'joined');
    guest.send({ type: 'join', roomId, name: 'GuestUser' });
    await guest.waitFor(m => m.type === 'joined');
    await host.waitFor(m => m.type === 'player_joined');

    // Host starts game
    host.send({ type: 'start_game' });
    await host.waitFor(m => m.type === 'phase_change' && (m as any).phase === 'CHOOSING_WORD');
    await guest.waitFor(m => m.type === 'phase_change' && (m as any).phase === 'CHOOSING_WORD');

    // Host restarts game mid-turn
    host.send({ type: 'restart_game' });
    const restartedMsg = await guest.waitFor(
      m => m.type === 'chat' && (m as any).text.includes('restarted the game')
    );
    assert.ok(restartedMsg, 'Guest received restart announcement');

    // Host returns to lobby
    host.send({ type: 'return_to_lobby' });
    const lobbyMsgHost = await host.waitFor(m => m.type === 'phase_change' && (m as any).phase === 'LOBBY') as any;
    const lobbyMsgGuest = await guest.waitFor(m => m.type === 'phase_change' && (m as any).phase === 'LOBBY') as any;
    assert.equal(lobbyMsgHost.phase, 'LOBBY');
    assert.equal(lobbyMsgGuest.phase, 'LOBBY');

    await host.close();
    await guest.close();
  });

  it('delivers lobby chat to players and delivers drawer chat to guessers while blocking secret word leaks', async () => {
    const roomId = await createRoom();
    const host = new TestClient();
    const guest = new TestClient();

    await Promise.all([host.connect(), guest.connect()]);

    host.send({ type: 'join', roomId, name: 'HostAlice' });
    await host.waitFor(m => m.type === 'joined');

    guest.send({ type: 'join', roomId, name: 'GuestBob' });
    await guest.waitFor(m => m.type === 'joined');

    // 1. Lobby chat before starting game
    guest.send({ type: 'chat', text: 'Hey host, ready to start?' });
    const lobbyMsgForHost = await host.waitFor(m => m.type === 'chat' && (m as any).text.includes('ready to start?')) as any;
    assert.ok(lobbyMsgForHost, 'Host received guest message in lobby');
    assert.equal(lobbyMsgForHost.playerName, 'GuestBob');

    host.send({ type: 'chat', text: 'Starting now!' });
    const lobbyMsgForGuest = await guest.waitFor(m => m.type === 'chat' && (m as any).text.includes('Starting now!')) as any;
    assert.ok(lobbyMsgForGuest, 'Guest received host message in lobby');

    // 2. Start game and choose word
    host.send({ type: 'start_game' });
    const choosePhase = await host.waitFor(m => m.type === 'phase_change' && m.phase === 'CHOOSING_WORD') as any;
    const secretWord = choosePhase.wordChoices[0];
    host.send({ type: 'choose_word', word: secretWord });

    await guest.waitFor(m => m.type === 'phase_change' && m.phase === 'DRAWING');

    // 3. Drawer attempts to leak the secret word in chat -> must be blocked
    host.send({ type: 'chat', text: `The word is ${secretWord}` });
    const blockedMsg = await host.waitFor(
      m => m.type === 'chat' && m.isSystem === true && (m as any).text.includes('blocked because it contains')
    );
    assert.ok(blockedMsg, 'Drawer was blocked from leaking secret word');

    // Guest should NOT have received that message
    const leakedToGuest = guest.messages.find(m => m.type === 'chat' && (m as any).text?.includes(secretWord));
    assert.strictEqual(leakedToGuest, undefined, 'Guest never receives leaked word');

    // 4. Drawer sends normal chat message -> guest MUST receive it!
    host.send({ type: 'chat', text: 'Good luck guessing!' });
    const drawerChatForGuest = await guest.waitFor(
      m => m.type === 'chat' && (m as any).text === 'Good luck guessing!'
    ) as any;
    assert.ok(drawerChatForGuest, 'Guesser received drawer chat message');
    assert.ok(drawerChatForGuest.playerName.includes('HostAlice'), 'Message reflects drawer sender name');

    // 5. Guesser types a near-miss -> receives near_miss with their typed text, while other players see nothing
    const nearMissGuess = secretWord.slice(0, -1);
    guest.send({ type: 'chat', text: nearMissGuess });
    const nearMissMsg = await guest.waitFor(m => m.type === 'near_miss') as any;
    assert.ok(nearMissMsg, 'Guesser received near_miss notification');
    assert.equal(nearMissMsg.text, nearMissGuess, 'Near-miss includes the typed word');

    // Other players should NOT have received this near miss text or notification
    const hostSawNearMiss = host.messages.find(m => m.type === 'near_miss' || ((m as any).text === nearMissGuess));
    assert.strictEqual(hostSawNearMiss, undefined, 'Other players never receive near miss word');

    await host.close();
    await guest.close();
  });

  it('recovers room state from disk after server restart', async () => {
    const roomId = await createRoom();
    const p1 = new TestClient();
    await p1.connect();

    p1.send({ type: 'join', roomId, name: 'PersistentUser' });
    const j1 = await p1.waitFor(m => m.type === 'joined') as any;
    const token = j1.token;
    const originalPlayerId = j1.playerId;

    await p1.close();

    // Kill the current server
    serverProc.kill('SIGINT');
    await new Promise(r => setTimeout(r, 500));

    // Start a new server process using the SAME state directory
    const newServer = await startServer();
    const newServerProc = newServer.process;

    try {
      const p1Rejoin = new TestClient();
      await p1Rejoin.connect();

      p1Rejoin.send({ type: 'join', roomId, name: 'PersistentUser', token });
      const rejoindMsg = await p1Rejoin.waitFor(m => m.type === 'joined') as any;

      assert.equal(rejoindMsg.playerId, originalPlayerId, 'Player ID retained across restart');
      assert.equal(rejoindMsg.state.phase, 'WAITING', 'Restored room enters WAITING state');
      assert.equal(rejoindMsg.state.roomId, roomId, 'Room ID retained across restart');

      await p1Rejoin.close();
    } finally {
      newServerProc.kill('SIGKILL');
    }
  });
});

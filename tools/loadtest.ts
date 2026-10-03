// Load test script: simulates N rooms of 8 players (1 drawer + 7 guessers).
// Measures end-to-end latency (send to receive), server CPU, memory, event loop delay.

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';

interface StepResult {
  rooms: number;
  players: number;
  durationSec: number;
  totalMessagesSent: number;
  totalMessagesRecv: number;
  msgsPerSec: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  serverHeapMB: number;
  eventLoopDelayP50: number;
  eventLoopDelayP99: number;
  healthy: boolean;
}

const SERVER_PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const WS_URL = `ws://localhost:${SERVER_PORT}`;

// Parse command line arguments
const args = process.argv.slice(2);
let stepList = [25, 50, 100, 150];
let stepDurationSec = 30;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--steps=')) {
    const raw = arg.slice(8);
    if (raw.includes(',')) {
      stepList = raw.split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
    } else {
      stepList = [parseInt(raw, 10)];
      while (i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
        stepList.push(parseInt(args[++i], 10));
      }
    }
  } else if (arg.startsWith('--duration=')) {
    stepDurationSec = parseInt(arg.slice(11), 10);
  }
}

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['dist/server/index.js'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        JOIN_RATE_LIMIT: '100000',
        ROOM_CREATE_RATE_LIMIT: '100000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
      if (stdout.includes(`http://localhost:${SERVER_PORT}`)) {
        resolve(proc);
      }
    });

    proc.on('error', reject);

    setTimeout(() => {
      reject(new Error(`Server start timeout: ${stdout}`));
    }, 10000);
  });
}

async function fetchStats(): Promise<{
  memoryMB: number;
  eventLoopDelayMs?: { p50: number; p99: number };
}> {
  try {
    const res = await fetch(`${SERVER_URL}/stats`);
    return await res.json() as any;
  } catch {
    return { memoryMB: 0 };
  }
}

async function createRoom(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/create-room`, { method: 'POST' });
  const data = await res.json() as { roomId: string };
  return data.roomId;
}

function connectSocket(roomId: string, name: string): Promise<{ ws: WebSocket; playerId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', roomId, name }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'joined') {
          resolve({ ws, playerId: msg.playerId });
        }
      } catch {}
    });
    ws.on('error', reject);
  });
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const idx = Math.min(Math.floor((p / 100) * arr.length), arr.length - 1);
  return arr[idx];
}

async function runStep(roomCount: number, durationSec: number): Promise<StepResult> {
  console.log(`\nStarting step: ${roomCount} rooms (${roomCount * 8} bots) for ${durationSec} seconds...`);

  const latencies: number[] = [];
  let totalSent = 0;
  let totalRecv = 0;

  interface RoomSession {
    roomId: string;
    drawerWs: WebSocket;
    drawerId: string;
    guesserSockets: WebSocket[];
    strokeInterval?: ReturnType<typeof setInterval>;
    guessInterval?: ReturnType<typeof setInterval>;
  }

  const sessions: RoomSession[] = [];

  // Setup rooms in batches to avoid connection stampede
  const BATCH_SIZE = 10;
  for (let i = 0; i < roomCount; i += BATCH_SIZE) {
    const currentBatch = Math.min(BATCH_SIZE, roomCount - i);
    const batchPromises = Array.from({ length: currentBatch }, async (_, idx) => {
      const roomIndex = i + idx;
      const roomId = await createRoom();

      // Drawer
      const { ws: drawerWs, playerId: drawerId } = await connectSocket(roomId, `Drawer_${roomIndex}`);

      // 7 Guessers
      const guesserSockets: WebSocket[] = [];
      for (let g = 1; g <= 7; g++) {
        const { ws } = await connectSocket(roomId, `Guesser_${roomIndex}_${g}`);
        ws.on('message', (rawData) => {
          totalRecv++;
          try {
            const msg = JSON.parse(rawData.toString());
            if (msg.type === 'draw_op' && msg.op && typeof msg.op.t === 'number') {
              const latency = Date.now() - msg.op.t;
              if (latency >= 0 && latencies.length < 200_000) {
                latencies.push(latency);
              }
            }
          } catch {}
        });
        guesserSockets.push(ws);
      }

      // Start game
      drawerWs.send(JSON.stringify({ type: 'start_game' }));

      // Wait for CHOOSING_WORD then choose word
      await new Promise<void>((res) => {
        const handler = (rawData: any) => {
          try {
            const msg = JSON.parse(rawData.toString());
            if (msg.type === 'phase_change' && msg.phase === 'CHOOSING_WORD' && msg.wordChoices) {
              drawerWs.send(JSON.stringify({ type: 'choose_word', word: msg.wordChoices[0] }));
              drawerWs.off('message', handler);
              res();
            }
          } catch {}
        };
        drawerWs.on('message', handler);
      });

      return {
        roomId,
        drawerWs,
        drawerId,
        guesserSockets,
      };
    });

    const batchSessions = await Promise.all(batchPromises);
    sessions.push(...batchSessions);
  }

  console.log(`All ${roomCount} rooms and ${roomCount * 8} bots connected. Generating traffic...`);

  // Start traffic generation
  let strokeIdCounter = 0;

  for (const session of sessions) {
    const strokeId = `s_${session.roomId}_${++strokeIdCounter}`;
    session.drawerWs.send(JSON.stringify({
      type: 'draw_op',
      op: {
        type: 'stroke_start',
        id: strokeId,
        tool: 'pen',
        color: '#000000',
        size: 5,
        point: { x: 50, y: 50 },
        t: Date.now(),
      },
    }));
    totalSent++;

    // ~30 batches per second (every ~33ms), 10 points per batch
    session.strokeInterval = setInterval(() => {
      if (session.drawerWs.readyState === WebSocket.OPEN) {
        const now = Date.now();
        const points = Array.from({ length: 10 }, (_, p) => ({
          x: (50 + (p * 5)) % 800,
          y: (50 + (p * 3)) % 600,
        }));
        session.drawerWs.send(JSON.stringify({
          type: 'draw_op',
          op: {
            type: 'stroke_points',
            id: strokeId,
            points,
            t: now,
          },
        }));
        totalSent++;
      }
    }, 33);

    // Guessers send occasional guesses
    session.guessInterval = setInterval(() => {
      const randomGuesser = session.guesserSockets[Math.floor(Math.random() * session.guesserSockets.length)];
      if (randomGuesser && randomGuesser.readyState === WebSocket.OPEN) {
        randomGuesser.send(JSON.stringify({
          type: 'chat',
          text: 'guessing...',
        }));
        totalSent++;
      }
    }, 3000);
  }

  // Warmup 5 seconds, then sample
  await new Promise(r => setTimeout(r, 5000));
  latencies.length = 0; // reset to measure steady state

  // Run for measurement duration
  await new Promise(r => setTimeout(r, (durationSec - 5) * 1000));

  // Get server stats
  const stats = await fetchStats();

  // Stop traffic and disconnect
  for (const session of sessions) {
    if (session.strokeInterval) clearInterval(session.strokeInterval);
    if (session.guessInterval) clearInterval(session.guessInterval);
    session.drawerWs.close();
    for (const g of session.guesserSockets) {
      g.close();
    }
  }

  // Cool down period before next step
  await new Promise(r => setTimeout(r, 2000));

  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);

  const elP50 = stats.eventLoopDelayMs ? Math.round(stats.eventLoopDelayMs.p50 * 10) / 10 : 0;
  const elP99 = stats.eventLoopDelayMs ? Math.round(stats.eventLoopDelayMs.p99 * 10) / 10 : 0;

  const msgsPerSec = Math.round((totalSent + totalRecv) / durationSec);
  const healthy = p95 < 100 && elP99 < 50;

  console.log(`Results for ${roomCount} rooms:`);
  console.log(`  p50 latency: ${p50} ms, p95 latency: ${p95} ms, p99 latency: ${p99} ms`);
  console.log(`  Event loop delay: p50 = ${elP50} ms, p99 = ${elP99} ms`);
  console.log(`  Messages/sec: ${msgsPerSec}, Server Heap: ${stats.memoryMB} MB`);
  console.log(`  Healthy: ${healthy ? 'YES' : 'NO'}`);

  return {
    rooms: roomCount,
    players: roomCount * 8,
    durationSec,
    totalMessagesSent: totalSent,
    totalMessagesRecv: totalRecv,
    msgsPerSec,
    latencyP50: p50,
    latencyP95: p95,
    latencyP99: p99,
    serverHeapMB: stats.memoryMB,
    eventLoopDelayP50: elP50,
    eventLoopDelayP99: elP99,
    healthy,
  };
}

async function main() {
  console.log('====================================================');
  console.log('  Skribbl Multiplayer Load & Capacity Test');
  console.log('====================================================');
  console.log(`Machine: ${os.cpus()[0].model} (${os.cpus().length} cores), ${Math.round(os.totalmem() / (1024**3))} GB RAM`);
  console.log(`Node: ${process.version}, OS: ${os.type()} ${os.release()}`);
  console.log(`Steps: ${stepList.join(', ')} rooms | Step Duration: ${stepDurationSec}s\n`);

  let serverProc: ChildProcess | null = null;
  const alreadyRunning = await isServerRunning();

  if (!alreadyRunning) {
    console.log('Starting local server with high rate limits for load test...');
    serverProc = await startServer();
    console.log(`Server started on port ${SERVER_PORT}\n`);
  } else {
    console.log(`Using existing server on port ${SERVER_PORT}\n`);
  }

  const results: StepResult[] = [];

  try {
    for (const rooms of stepList) {
      const res = await runStep(rooms, stepDurationSec);
      results.push(res);
      if (!res.healthy && rooms >= 100) {
        console.log(`Threshold reached at ${rooms} rooms. Stopping ramp.`);
        break;
      }
    }
  } finally {
    if (serverProc) {
      serverProc.kill('SIGKILL');
    }
  }

  console.log('\n====================================================');
  console.log('  LOAD TEST SUMMARY TABLE');
  console.log('====================================================');
  console.table(results.map(r => ({
    'Rooms': r.rooms,
    'Players': r.players,
    'Msgs/sec': r.msgsPerSec,
    'p50 Latency (ms)': r.latencyP50,
    'p95 Latency (ms)': r.latencyP95,
    'p99 Latency (ms)': r.latencyP99,
    'Event Loop p99 (ms)': r.eventLoopDelayP99,
    'Heap (MB)': r.serverHeapMB,
    'Healthy': r.healthy ? 'PASS' : 'FAIL',
  })));

  const highestHealthy = results.filter(r => r.healthy).pop();
  if (highestHealthy) {
    console.log(`\nMeasured Capacity: ${highestHealthy.rooms} rooms (${highestHealthy.players} players) healthy on this machine.`);
  } else {
    console.log('\nNo step satisfied healthy criteria.');
  }
}

main().catch(err => {
  console.error('Load test failed:', err);
  process.exit(1);
});

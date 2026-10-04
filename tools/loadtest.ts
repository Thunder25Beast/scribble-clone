// Realistic Skribbl Load Testing & Capacity Benchmark Tool
// Supports Scenarios A, B, C, D with Ramp, Soak, and Spike modes.

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';

export interface StepResult {
  scenario: string;
  rooms: number;
  players: number;
  durationSec: number;
  totalMessagesSent: number;
  totalMessagesRecv: number;
  msgsPerSec: number;
  bandwidthKBps: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  serverHeapMB: number;
  serverRssMB: number;
  serverCpuPercent: number;
  eventLoopDelayP50: number;
  eventLoopDelayP99: number;
  slowClientDrops: number;
  healthy: boolean;
  limitingFactor?: string;
}

export interface SoakResult {
  scenario: string;
  rooms: number;
  players: number;
  durationSec: number;
  startRssMB: number;
  endRssMB: number;
  rssDeltaMB: number;
  avgCpuPercent: number;
  avgLatencyP95: number;
  maxEventLoopDelayP99: number;
  slowClientDrops: number;
  memoryLeakDetected: boolean;
  healthy: boolean;
}

export interface SpikeResult {
  scenario: string;
  rooms: number;
  players: number;
  recoveryTimeMs: number;
  reconnectSuccessRate: number;
  reconnectedPlayers: number;
  totalExpectedPlayers: number;
  healthy: boolean;
}

// ── CLI Configuration ──
const args = process.argv.slice(2);

function getArg(prefix: string, defaultVal: string): string {
  const match = args.find(a => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : defaultVal;
}

const SERVER_PORT = parseInt(getArg('--port=', process.env.PORT || '3000'), 10);
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const WS_URL = `ws://localhost:${SERVER_PORT}`;

const scenarioArg = getArg('--scenario=', 'all').toUpperCase(); // A, B, C, D, ALL
const modeArg = getArg('--mode=', 'ramp').toLowerCase(); // ramp, soak, spike, all
let stepList = [25, 50, 100, 200, 400];
const stepsIdx = args.findIndex(a => a.startsWith('--steps='));
if (stepsIdx >= 0) {
  const firstVal = args[stepsIdx].slice(8);
  if (firstVal.includes(',')) {
    stepList = firstVal.split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
  } else {
    stepList = [parseInt(firstVal, 10)];
    let j = stepsIdx + 1;
    while (j < args.length && /^\d+$/.test(args[j])) {
      stepList.push(parseInt(args[j], 10));
      j++;
    }
  }
}
const stepDurationSec = parseInt(getArg('--duration=', '60'), 10);
const soakDurationSec = parseInt(getArg('--soak-duration=', '900'), 10); // default 15 min (900s)
const spikeRooms = parseInt(getArg('--spike-rooms=', '50'), 10);

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function startServerProcess(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['dist/server/index.js'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        JOIN_RATE_LIMIT: '500000',
        ROOM_CREATE_RATE_LIMIT: '500000',
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

    proc.stderr?.on('data', (d) => {
      stdout += d.toString();
    });

    proc.on('error', reject);

    setTimeout(() => {
      reject(new Error(`Server start timeout: ${stdout}`));
    }, 15000);
  });
}

async function fetchStats(): Promise<{
  memoryMB: number;
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  cpuPercent: number;
  messagesSent: number;
  messagesRecv: number;
  bytesSent: number;
  bytesRecv: number;
  slowClientDrops: number;
  eventLoopDelayMs?: { p50: number; p95: number; p99: number; min: number; max: number };
}> {
  try {
    const res = await fetch(`${SERVER_URL}/stats`);
    return await res.json() as any;
  } catch {
    return {
      memoryMB: 0, heapUsedMB: 0, heapTotalMB: 0, rssMB: 0,
      cpuPercent: 0, messagesSent: 0, messagesRecv: 0,
      bytesSent: 0, bytesRecv: 0, slowClientDrops: 0
    };
  }
}

async function resetStats(): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/stats/reset`);
  } catch {}
}

async function createRoom(): Promise<string> {
  const res = await fetch(`${SERVER_URL}/api/create-room`, { method: 'POST' });
  const data = await res.json() as { roomId: string };
  return data.roomId;
}

function connectSocket(roomId: string, name: string, token?: string): Promise<{ ws: WebSocket; playerId: string; token: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', roomId, name, token }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'joined') {
          resolve({ ws, playerId: msg.playerId, token: msg.token });
        }
      } catch {}
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connect timeout')), 10000);
  });
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const idx = Math.min(Math.floor((p / 100) * arr.length), arr.length - 1);
  return arr[idx];
}

// ── Room Session Definition ──
interface BotPlayer {
  id: string;
  name: string;
  token: string;
  ws: WebSocket;
  isDrawer: boolean;
}

interface RoomSession {
  roomId: string;
  players: BotPlayer[];
  drawer: BotPlayer;
  strokeInterval?: ReturnType<typeof setInterval>;
  guessInterval?: ReturnType<typeof setInterval>;
  churnInterval?: ReturnType<typeof setInterval>;
  isDrawingActive: boolean;
}

// ── Scenario Setup Helper ──
async function setupRoom(scenario: string, roomIndex: number, onDrawOpLatency: (lat: number) => void): Promise<RoomSession> {
  const roomId = await createRoom();
  let playerCount = 8;

  if (scenario === 'A') {
    playerCount = 8;
  } else if (scenario === 'B') {
    // Random between 2 and 12, average ~6
    playerCount = Math.floor(Math.random() * 11) + 2;
  } else if (scenario === 'C') {
    playerCount = 12;
  } else if (scenario === 'D') {
    // Idle lobby rooms
    playerCount = Math.floor(Math.random() * 7) + 2; // 2 to 8
  }

  // Connect Drawer (Player 0)
  const drawerInfo = await connectSocket(roomId, `D_${roomIndex}_0`);
  const drawerPlayer: BotPlayer = {
    id: drawerInfo.playerId,
    name: `D_${roomIndex}_0`,
    token: drawerInfo.token,
    ws: drawerInfo.ws,
    isDrawer: true,
  };

  const players: BotPlayer[] = [drawerPlayer];

  // Connect Guessers
  for (let g = 1; g < playerCount; g++) {
    const guesserInfo = await connectSocket(roomId, `G_${roomIndex}_${g}`);
    const guesser: BotPlayer = {
      id: guesserInfo.playerId,
      name: `G_${roomIndex}_${g}`,
      token: guesserInfo.token,
      ws: guesserInfo.ws,
      isDrawer: false,
    };
    guesser.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'draw_op' && msg.op && typeof msg.op.t === 'number') {
          const lat = Date.now() - msg.op.t;
          if (lat >= 0) onDrawOpLatency(lat);
        }
      } catch {}
    });
    players.push(guesser);
  }

  if (scenario === 'D') {
    // Scenario D: Stay in LOBBY phase
    return {
      roomId,
      players,
      drawer: drawerPlayer,
      isDrawingActive: false,
    };
  }

  // Scenarios A, B, C: Advance to DRAWING phase
  drawerPlayer.ws.send(JSON.stringify({ type: 'start_game' }));

  await new Promise<void>((resolve) => {
    const handler = (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'phase_change' && msg.phase === 'CHOOSING_WORD' && msg.wordChoices) {
          drawerPlayer.ws.send(JSON.stringify({ type: 'choose_word', word: msg.wordChoices[0] }));
          drawerPlayer.ws.off('message', handler);
          resolve();
        }
      } catch {}
    };
    drawerPlayer.ws.on('message', handler);
  });

  return {
    roomId,
    players,
    drawer: drawerPlayer,
    isDrawingActive: true,
  };
}

// ── Traffic Generator ──
function startTraffic(session: RoomSession, scenario: string, onSent: () => void, onDrawLatency?: (lat: number) => void) {
  if (scenario === 'D') return; // Idle lobby has no traffic

  let strokeId = `s_${session.roomId}_1`;
  session.drawer.ws.send(JSON.stringify({
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
  onSent();

  // Duty cycle state for Scenario B (~55% drawing time)
  let isCurrentlyDrawing = true;
  let strokeCounter = 0;

  if (scenario === 'B') {
    // Switch between drawing bursts (~2.2s) and pause/thinking intervals (~1.8s) => ~55% duty cycle
    const cycle = () => {
      const activeMs = 2200 + Math.random() * 600;
      const pauseMs = 1800 + Math.random() * 400;
      isCurrentlyDrawing = true;
      setTimeout(() => {
        isCurrentlyDrawing = false;
        setTimeout(cycle, pauseMs);
      }, activeMs);
    };
    cycle();
  }

  // Draw loop: 30 batches per second (~33ms)
  session.strokeInterval = setInterval(() => {
    if (scenario === 'B' && !isCurrentlyDrawing) return;

    if (session.drawer.ws.readyState === WebSocket.OPEN) {
      strokeCounter++;
      const now = Date.now();
      const points = Array.from({ length: 10 }, (_, p) => ({
        x: (50 + ((strokeCounter * 3 + p * 5) % 700)),
        y: (50 + ((strokeCounter * 2 + p * 4) % 500)),
      }));
      session.drawer.ws.send(JSON.stringify({
        type: 'draw_op',
        op: {
          type: 'stroke_points',
          id: strokeId,
          points,
          t: now,
        },
      }));
      onSent();
    }
  }, 33);

  // Guessers chat / guess traffic
  const guessIntervalMs = scenario === 'B' ? 3500 : 3000;
  session.guessInterval = setInterval(() => {
    const guessers = session.players.filter(p => !p.isDrawer && p.ws.readyState === WebSocket.OPEN);
    if (guessers.length === 0) return;
    const randomGuesser = guessers[Math.floor(Math.random() * guessers.length)];
    const words = ['apple', 'banana', 'tree', 'cat', 'guitar', 'house', 'water', 'car'];
    const guessText = words[Math.floor(Math.random() * words.length)];
    randomGuesser.ws.send(JSON.stringify({ type: 'chat', text: guessText }));
    onSent();
  }, guessIntervalMs);

  // Scenario B: Churn (random reconnect / refresh of ~5% of players)
  if (scenario === 'B') {
    session.churnInterval = setInterval(async () => {
      const guessers = session.players.filter(p => !p.isDrawer);
      if (guessers.length === 0) return;
      // ~5% chance across players in room
      if (Math.random() < 0.1) {
        const churnPlayer = guessers[Math.floor(Math.random() * guessers.length)];
        if (churnPlayer.ws.readyState === WebSocket.OPEN) {
          churnPlayer.ws.close();
          // Reconnect with same token after 500ms
          setTimeout(async () => {
            try {
              const res = await connectSocket(session.roomId, churnPlayer.name, churnPlayer.token);
              churnPlayer.ws = res.ws;
              if (onDrawLatency) {
                churnPlayer.ws.on('message', (raw) => {
                  try {
                    const msg = JSON.parse(raw.toString());
                    if (msg.type === 'draw_op' && msg.op && typeof msg.op.t === 'number') {
                      const lat = Date.now() - msg.op.t;
                      if (lat >= 0) onDrawLatency(lat);
                    }
                  } catch {}
                });
              }
            } catch {}
          }, 500);
        }
      }
    }, 5000);
  }
}

function stopTraffic(session: RoomSession) {
  if (session.strokeInterval) clearInterval(session.strokeInterval);
  if (session.guessInterval) clearInterval(session.guessInterval);
  if (session.churnInterval) clearInterval(session.churnInterval);
  for (const p of session.players) {
    try { p.ws.close(); } catch {}
  }
}

// ── Ramp Step Runner ──
async function runRampStep(scenario: string, roomCount: number, durationSec: number): Promise<StepResult> {
  const scenarioNames: Record<string, string> = {
    A: 'Scenario A (8 players, 100% drawing)',
    B: 'Scenario B (Realistic Mix 2-12 players, 55% draw, churn)',
    C: 'Scenario C (Worst Case 12 players, 100% drawing)',
    D: 'Scenario D (Idle Lobby Rooms)',
  };

  console.log(`\n--------------------------------------------------------------`);
  console.log(`Running: ${scenarioNames[scenario] || scenario}`);
  console.log(`Step: ${roomCount} rooms | Duration: ${durationSec}s`);
  console.log(`--------------------------------------------------------------`);

  const latencies: number[] = [];
  let totalSent = 0;
  const onDrawLatency = (lat: number) => {
    if (latencies.length < 250_000) latencies.push(lat);
  };

  const sessions: RoomSession[] = [];
  const BATCH_SIZE = 10;
  let totalBots = 0;

  process.stdout.write(`Connecting ${roomCount} rooms... `);
  for (let i = 0; i < roomCount; i += BATCH_SIZE) {
    const curBatch = Math.min(BATCH_SIZE, roomCount - i);
    const promises = Array.from({ length: curBatch }, (_, idx) =>
      setupRoom(scenario, i + idx, onDrawLatency)
    );
    const created = await Promise.all(promises);
    for (const s of created) {
      totalBots += s.players.length;
      sessions.push(s);
    }
    process.stdout.write(`\rConnecting ${roomCount} rooms... ${sessions.length}/${roomCount} connected (${totalBots} bots)`);
  }
  console.log(' [OK]');

  // Reset server metrics to sample clean window
  await resetStats();

  // Start traffic
  for (const s of sessions) {
    startTraffic(s, scenario, () => totalSent++, onDrawLatency);
  }

  // Warmup 5 seconds
  console.log('Warming up for 5s...');
  await new Promise(r => setTimeout(r, 5000));
  latencies.length = 0; // Clear warmup latencies

  // Measurement window
  const measureSec = Math.max(5, durationSec - 5);
  console.log(`Measuring steady state for ${measureSec}s...`);
  await new Promise(r => setTimeout(r, measureSec * 1000));

  // Collect final stats
  const stats = await fetchStats();

  // Teardown step
  for (const s of sessions) {
    stopTraffic(s);
  }
  await new Promise(r => setTimeout(r, 2000)); // Cool down

  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);

  const elP50 = stats.eventLoopDelayMs ? stats.eventLoopDelayMs.p50 : 0;
  const elP99 = stats.eventLoopDelayMs ? stats.eventLoopDelayMs.p99 : 0;
  const msgsPerSec = Math.round(stats.messagesSent / measureSec);
  const bandwidthKBps = Math.round((stats.bytesSent + stats.bytesRecv) / (measureSec * 1024));

  // Health Criteria: p95 < 100ms, eventLoopDelay p99 < 50ms, CPU < 70%
  const latencyHealthy = p95 < 100;
  const elHealthy = elP99 < 50;
  const cpuHealthy = stats.cpuPercent < 70;
  const healthy = latencyHealthy && elHealthy && cpuHealthy;

  let limitingFactor = 'None (Healthy)';
  if (!healthy) {
    const reasons: string[] = [];
    if (!cpuHealthy) reasons.push(`CPU Saturated (${stats.cpuPercent}% >= 70%)`);
    if (!elHealthy) reasons.push(`Event Loop Lag (p99 ${elP99}ms >= 50ms)`);
    if (!latencyHealthy) reasons.push(`Delivery Latency (p95 ${p95}ms >= 100ms)`);
    limitingFactor = reasons.join(', ');
  }

  console.log(`\nResults for ${roomCount} rooms (${totalBots} players):`);
  console.log(`  Throughput:    ${msgsPerSec.toLocaleString()} msgs/sec | Bandwidth: ${bandwidthKBps.toLocaleString()} KB/s`);
  console.log(`  Latency (ms):  p50=${p50}ms | p95=${p95}ms | p99=${p99}ms`);
  console.log(`  Event Loop:    p50=${elP50}ms | p99=${elP99}ms`);
  console.log(`  Server CPU:    ${stats.cpuPercent}% | RSS: ${stats.rssMB} MB | Heap: ${stats.heapUsedMB} MB`);
  console.log(`  Slow Drops:    ${stats.slowClientDrops}`);
  console.log(`  Health Status: ${healthy ? 'PASS (Healthy)' : 'FAIL (' + limitingFactor + ')'}`);

  return {
    scenario,
    rooms: roomCount,
    players: totalBots,
    durationSec,
    totalMessagesSent: stats.messagesSent,
    totalMessagesRecv: stats.messagesRecv,
    msgsPerSec,
    bandwidthKBps,
    latencyP50: p50,
    latencyP95: p95,
    latencyP99: p99,
    serverHeapMB: stats.heapUsedMB,
    serverRssMB: stats.rssMB,
    serverCpuPercent: stats.cpuPercent,
    eventLoopDelayP50: elP50,
    eventLoopDelayP99: elP99,
    slowClientDrops: stats.slowClientDrops,
    healthy,
    limitingFactor,
  };
}

// ── 15-Minute Soak Test ──
async function runSoakTest(scenario: string, rooms: number, durationSec: number): Promise<SoakResult> {
  console.log(`\n==============================================================`);
  console.log(`  SOAK TEST: Scenario ${scenario} at 70% Capacity (${rooms} rooms)`);
  console.log(`  Duration: ${durationSec}s (${Math.round(durationSec / 60)} minutes)`);
  console.log(`==============================================================`);

  const latencies: number[] = [];
  const onDrawLatency = (lat: number) => {
    if (latencies.length < 300_000) latencies.push(lat);
  };

  const sessions: RoomSession[] = [];
  const BATCH_SIZE = 10;
  let totalBots = 0;

  for (let i = 0; i < rooms; i += BATCH_SIZE) {
    const curBatch = Math.min(BATCH_SIZE, rooms - i);
    const created = await Promise.all(
      Array.from({ length: curBatch }, (_, idx) => setupRoom(scenario, i + idx, onDrawLatency))
    );
    for (const s of created) {
      totalBots += s.players.length;
      sessions.push(s);
    }
  }

  await resetStats();
  for (const s of sessions) {
    startTraffic(s, scenario, () => {}, onDrawLatency);
  }

  const initialStats = await fetchStats();
  const cpuSamples: number[] = [];
  const p95Samples: number[] = [];
  let maxElP99 = 0;

  const sampleIntervalSec = 30;
  const numSamples = Math.floor(durationSec / sampleIntervalSec);

  console.log(`Sampling every ${sampleIntervalSec}s for ${numSamples} checkpoints...`);
  for (let s = 1; s <= numSamples; s++) {
    await new Promise(r => setTimeout(r, sampleIntervalSec * 1000));
    const currentStats = await fetchStats();
    cpuSamples.push(currentStats.cpuPercent);
    if (currentStats.eventLoopDelayMs && currentStats.eventLoopDelayMs.p99 > maxElP99) {
      maxElP99 = currentStats.eventLoopDelayMs.p99;
    }
    latencies.sort((a, b) => a - b);
    const curP95 = percentile(latencies, 95);
    p95Samples.push(curP95);
    latencies.length = 0; // Clear for next window

    console.log(`[Soak ${s * sampleIntervalSec}s / ${durationSec}s] RSS: ${currentStats.rssMB} MB | CPU: ${currentStats.cpuPercent}% | p95 Latency: ${curP95}ms | EL p99: ${currentStats.eventLoopDelayMs?.p99 || 0}ms`);
  }

  const finalStats = await fetchStats();
  for (const s of sessions) stopTraffic(s);

  const rssDeltaMB = finalStats.rssMB - initialStats.rssMB;
  // A memory leak is flagged if RSS grows by more than 150 MB steadily over 15 minutes
  const memoryLeakDetected = rssDeltaMB > 150;
  const avgCpu = Math.round(cpuSamples.reduce((a, b) => a + b, 0) / (cpuSamples.length || 1));
  const avgP95 = Math.round(p95Samples.reduce((a, b) => a + b, 0) / (p95Samples.length || 1));
  const healthy = !memoryLeakDetected && avgP95 < 100 && maxElP99 < 50 && avgCpu < 70;

  console.log('\nSoak Test Summary:');
  console.log(`  Initial RSS: ${initialStats.rssMB} MB -> Final RSS: ${finalStats.rssMB} MB (Delta: ${rssDeltaMB >= 0 ? '+' : ''}${rssDeltaMB} MB)`);
  console.log(`  Avg CPU: ${avgCpu}% | Avg p95 Latency: ${avgP95}ms | Max EL p99: ${maxElP99}ms`);
  console.log(`  Memory Leak Detected: ${memoryLeakDetected ? 'YES' : 'NO'}`);
  console.log(`  Soak Result: ${healthy ? 'PASS (Stable)' : 'FAIL'}`);

  return {
    scenario,
    rooms,
    players: totalBots,
    durationSec,
    startRssMB: initialStats.rssMB,
    endRssMB: finalStats.rssMB,
    rssDeltaMB,
    avgCpuPercent: avgCpu,
    avgLatencyP95: avgP95,
    maxEventLoopDelayP99: maxElP99,
    slowClientDrops: finalStats.slowClientDrops,
    memoryLeakDetected,
    healthy,
  };
}

// ── Spike & Reconnect Test ──
async function runSpikeTest(scenario: string, roomCount: number, serverProc: ChildProcess | null): Promise<SpikeResult> {
  console.log(`\n==============================================================`);
  console.log(`  SPIKE & RECONNECT TEST: ${roomCount} rooms concurrent stampede`);
  console.log(`==============================================================`);

  const sessions: RoomSession[] = [];
  const BATCH_SIZE = 15;
  let totalBots = 0;

  console.log(`Burst creating ${roomCount} rooms simultaneously...`);
  const spikeStart = Date.now();
  for (let i = 0; i < roomCount; i += BATCH_SIZE) {
    const curBatch = Math.min(BATCH_SIZE, roomCount - i);
    const created = await Promise.all(
      Array.from({ length: curBatch }, (_, idx) => setupRoom(scenario, i + idx, () => {}))
    );
    for (const s of created) {
      totalBots += s.players.length;
      sessions.push(s);
    }
  }
  const connectDuration = Date.now() - spikeStart;
  console.log(`Created ${roomCount} rooms (${totalBots} players) in ${connectDuration}ms`);

  // Disconnect all sockets to emulate sudden network drop or server restart
  console.log(`Disconnecting all ${totalBots} player sockets simultaneously...`);
  for (const s of sessions) {
    for (const p of s.players) {
      try { p.ws.close(); } catch {}
    }
  }

  await new Promise(r => setTimeout(r, 1000));

  // Stampede: All players attempt to reconnect simultaneously using their tokens
  console.log(`Reconnection stampede: Reconnecting all ${totalBots} players...`);
  const reconnectStart = Date.now();
  let reconnectedCount = 0;

  const reconnectPromises = sessions.flatMap(s =>
    s.players.map(async p => {
      try {
        const res = await connectSocket(s.roomId, p.name, p.token);
        p.ws = res.ws;
        reconnectedCount++;
      } catch {}
    })
  );

  await Promise.all(reconnectPromises);
  const recoveryTimeMs = Date.now() - reconnectStart;
  const successRate = Math.round((reconnectedCount / (totalBots || 1)) * 100);

  console.log(`Recovery Time: ${recoveryTimeMs}ms`);
  console.log(`Reconnected: ${reconnectedCount}/${totalBots} players (${successRate}%)`);

  for (const s of sessions) stopTraffic(s);

  const healthy = successRate >= 95 && recoveryTimeMs < 10000;
  return {
    scenario,
    rooms: roomCount,
    players: totalBots,
    recoveryTimeMs,
    reconnectSuccessRate: successRate,
    reconnectedPlayers: reconnectedCount,
    totalExpectedPlayers: totalBots,
    healthy,
  };
}

// ── Main Entrypoint ──
async function main() {
  console.log('==============================================================');
  console.log('  Comprehensive Multiplayer Game Load & Capacity Benchmark');
  console.log('==============================================================');
  console.log(`CPU:    ${os.cpus()[0].model} (${os.cpus().length} cores @ ${os.cpus()[0].speed}MHz)`);
  console.log(`RAM:    ${Math.round(os.totalmem() / (1024**3))} GB Total (${Math.round(os.freemem() / (1024**3))} GB Free)`);
  console.log(`OS:     ${os.type()} ${os.release()} (${os.arch()})`);
  console.log(`Node:   ${process.version}`);
  console.log(`Mode:   ${modeArg.toUpperCase()} | Scenarios: ${scenarioArg}`);
  console.log(`Steps:  ${stepList.join(', ')} rooms | Step Duration: ${stepDurationSec}s\n`);

  let serverProc: ChildProcess | null = null;
  const alreadyRunning = await isServerRunning();

  if (!alreadyRunning) {
    console.log('Spawning standalone server process for load testing...');
    serverProc = await startServerProcess();
    console.log(`Server started on PID ${serverProc.pid}, listening on port ${SERVER_PORT}\n`);
  } else {
    console.log(`Using existing server running on port ${SERVER_PORT}\n`);
  }

  const rampResults: StepResult[] = [];
  const soakResults: SoakResult[] = [];
  const spikeResults: SpikeResult[] = [];

  const scenariosToRun = scenarioArg === 'ALL' ? ['A', 'B', 'C', 'D'] : [scenarioArg];

  try {
    for (const sc of scenariosToRun) {
      console.log(`\n==============================================================`);
      console.log(`  STARTING SCENARIO ${sc}`);
      console.log(`==============================================================`);

      // 1. Ramp Test
      let maxHealthyRooms = 0;
      for (const rooms of stepList) {
        const res = await runRampStep(sc, rooms, stepDurationSec);
        rampResults.push(res);
        if (res.healthy) {
          maxHealthyRooms = Math.max(maxHealthyRooms, rooms);
        } else {
          console.log(`Capacity limit reached for Scenario ${sc} at ${rooms} rooms.`);
          break;
        }
      }

      // 2. Soak Test (if requested and capacity found)
      if (modeArg === 'soak' || modeArg === 'all') {
        const targetSoakRooms = Math.max(10, Math.floor(maxHealthyRooms * 0.7));
        const soakRes = await runSoakTest(sc, targetSoakRooms, soakDurationSec);
        soakResults.push(soakRes);
      }

      // 3. Spike Test (if requested)
      if (modeArg === 'spike' || modeArg === 'all') {
        const targetSpike = Math.min(spikeRooms, maxHealthyRooms || 50);
        const spikeRes = await runSpikeTest(sc, targetSpike, serverProc);
        spikeResults.push(spikeRes);
      }
    }
  } finally {
    if (serverProc) {
      console.log('\nStopping server process...');
      serverProc.kill('SIGKILL');
    }
  }

  // Print Summary Tables
  console.log('\n==============================================================');
  console.log('  FINAL CAPACITY & LOAD TEST RESULTS');
  console.log('==============================================================\n');

  console.log('RAMP TEST RESULTS:');
  console.table(rampResults.map(r => ({
    'Scenario': r.scenario,
    'Rooms': r.rooms,
    'Players': r.players,
    'Msgs/sec': r.msgsPerSec.toLocaleString(),
    'BW (KB/s)': r.bandwidthKBps.toLocaleString(),
    'p50 (ms)': r.latencyP50,
    'p95 (ms)': r.latencyP95,
    'p99 (ms)': r.latencyP99,
    'EL p99 (ms)': r.eventLoopDelayP99,
    'CPU %': `${r.serverCpuPercent}%`,
    'RSS (MB)': r.serverRssMB,
    'Drops': r.slowClientDrops,
    'Health': r.healthy ? 'PASS' : 'FAIL',
    'Limiting Factor': r.limitingFactor,
  })));

  if (soakResults.length > 0) {
    console.log('\nSOAK TEST RESULTS (70% Capacity):');
    console.table(soakResults.map(s => ({
      'Scenario': s.scenario,
      'Rooms': s.rooms,
      'Players': s.players,
      'Duration': `${Math.round(s.durationSec / 60)} min`,
      'Start RSS': `${s.startRssMB} MB`,
      'End RSS': `${s.endRssMB} MB`,
      'RSS Delta': `${s.rssDeltaMB >= 0 ? '+' : ''}${s.rssDeltaMB} MB`,
      'Avg CPU': `${s.avgCpuPercent}%`,
      'Avg p95': `${s.avgLatencyP95} ms`,
      'Max EL p99': `${s.maxEventLoopDelayP99} ms`,
      'Leak?': s.memoryLeakDetected ? 'YES' : 'NO',
      'Result': s.healthy ? 'PASS' : 'FAIL',
    })));
  }

  if (spikeResults.length > 0) {
    console.log('\nSPIKE & RECONNECT RESULTS:');
    console.table(spikeResults.map(sp => ({
      'Scenario': sp.scenario,
      'Rooms': sp.rooms,
      'Players': sp.players,
      'Recovery Time': `${sp.recoveryTimeMs} ms`,
      'Success Rate': `${sp.reconnectSuccessRate}%`,
      'Reconnected': `${sp.reconnectedPlayers} / ${sp.totalExpectedPlayers}`,
      'Result': sp.healthy ? 'PASS' : 'FAIL',
    })));
  }
}

main().catch(err => {
  console.error('Fatal loadtest error:', err);
  process.exit(1);
});

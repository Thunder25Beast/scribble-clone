// Main server: HTTP for static files and health, WebSocket for game.
// Room manager handles creation, lookup, cleanup, and persistence.

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { CONFIG } from '../shared/config.js';
import { clientMessageSchema } from '../shared/schemas.js';
import { Room, PersistedRoom, Player } from './room.js';
import { IPRateLimiter } from './ratelimit.js';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';

const __dirname = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/i, '$1');

// ── Event loop monitoring ──
let eld: IntervalHistogram | null = null;
try {
  eld = monitorEventLoopDelay({ resolution: 20 });
  eld.enable();
} catch {
  // Not available in all environments
}

// ── Room storage ──
const rooms = new Map<string, Room>();
const joinRateLimit = new IPRateLimiter(CONFIG.JOIN_RATE_PER_IP);
const createRateLimit = new IPRateLimiter(CONFIG.ROOM_CREATE_RATE_PER_IP);

// ── State directory for persistence ──
const stateDir = path.resolve(CONFIG.STATE_DIR);
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
}

// ── Persistence ──
function persistRoom(room: Room): void {
  const data = room.toPersistedState();
  const filePath = path.join(stateDir, `${room.roomId}.json`);
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`Failed to persist room ${room.roomId}:`, err);
  }
}

function loadPersistedRooms(): void {
  try {
    const files = fs.readdirSync(stateDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf-8')) as PersistedRoom;
        const room = Room.fromPersisted(data, persistRoom);
        rooms.set(room.roomId, room);
        console.log(`Restored room ${room.roomId} (${data.players.length} players, was in phase ${data.phase})`);
      } catch (err) {
        console.error(`Failed to load room from ${file}:`, err);
      }
    }
  } catch {
    // No state directory yet, that's fine
  }
}

function deletePersistedRoom(roomId: string): void {
  const filePath = path.join(stateDir, `${roomId}.json`);
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

// ── Room management ──

function createRoom(ip: string): Room | null {
  if (!createRateLimit.consume(ip)) return null;

  // Generate cryptographically random room id
  const roomId = crypto.randomBytes(CONFIG.ROOM_ID_LENGTH)
    .toString('base64url')
    .slice(0, CONFIG.ROOM_ID_LENGTH);

  const room = new Room(roomId, persistRoom);
  rooms.set(roomId, room);
  room.persist();
  return room;
}

function cleanupRooms(): void {
  for (const [id, room] of rooms) {
    if (room.isExpired()) {
      room.destroy();
      rooms.delete(id);
      deletePersistedRoom(id);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupRooms, 60_000);
// Clean up IP rate limit maps periodically
setInterval(() => {
  joinRateLimit.cleanup();
  createRateLimit.cleanup();
}, 300_000);

// ── MIME types ──
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

// ── HTTP server ──
const clientDir = path.resolve(__dirname, '..', 'client');
const distClientDir = path.resolve(__dirname, '..', 'client');

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // Health endpoint
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }

  // Stats endpoint for load testing
  if (url.pathname === '/stats') {
    const stats: Record<string, unknown> = {
      rooms: rooms.size,
      players: 0,
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      cpuUser: process.cpuUsage().user,
      cpuSystem: process.cpuUsage().system,
    };
    for (const room of rooms.values()) {
      stats.players = (stats.players as number) + room.getConnectedPlayers().length;
    }
    if (eld) {
      stats.eventLoopDelayMs = {
        min: eld.min / 1e6,
        max: eld.max / 1e6,
        mean: eld.mean / 1e6,
        p50: eld.percentile(50) / 1e6,
        p99: eld.percentile(99) / 1e6,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  // API: create room
  if (url.pathname === '/api/create-room' && req.method === 'POST') {
    const ip = getIP(req);
    const room = createRoom(ip);
    if (!room) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limited' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ roomId: room.roomId }));
    return;
  }

  // Room link: /r/<roomId> serves the same index.html
  let filePath: string;
  if (url.pathname.startsWith('/r/')) {
    filePath = path.join(distClientDir, 'index.html');
  } else {
    let safePath = url.pathname === '/' ? '/index.html' : url.pathname;
    // Prevent directory traversal
    safePath = path.normalize(safePath).replace(/^(\.\.[\/\\])+/, '');
    filePath = path.join(distClientDir, safePath);
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Try serving index.html for SPA routing
      fs.readFile(path.join(distClientDir, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ── WebSocket server ──
const wss = new WebSocketServer({
  server,
  maxPayload: CONFIG.MAX_WS_PAYLOAD,
  perMessageDeflate: false, // small messages, not worth the CPU
});

// Track which player each socket belongs to
const socketPlayerMap = new WeakMap<WebSocket, { roomId: string; playerId: string }>();

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const ip = getIP(req);

  // Origin check (basic)
  const origin = req.headers.origin;
  // In development, allow any origin; in production, check against allowed list
  // For this project, we'll be permissive but log it

  ws.on('message', (rawData: Buffer | string) => {
    let data: string;
    if (Buffer.isBuffer(rawData)) {
      data = rawData.toString('utf-8');
    } else {
      data = rawData as string;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // invalid JSON, drop
    }

    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) {
      // Track violation on associated player
      const info = socketPlayerMap.get(ws);
      if (info) {
        const room = rooms.get(info.roomId);
        if (room) {
          const player = room.players.get(info.playerId);
          if (player) {
            player.violations++;
            if (player.violations >= CONFIG.VIOLATION_DISCONNECT_THRESHOLD) {
              ws.close(1008, 'Too many invalid messages');
              return;
            }
          }
        }
      }
      return;
    }

    const msg = result.data;

    // Handle join (special: not yet associated with a room)
    if (msg.type === 'join') {
      handleJoin(ws, msg, ip);
      return;
    }

    // Handle ping (no room needed)
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({
        type: 'pong',
        t0: msg.t0,
        serverTime: Date.now(),
      }));
      return;
    }

    // All other messages need a room association
    const info = socketPlayerMap.get(ws);
    if (!info) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not in a room' }));
      return;
    }

    const room = rooms.get(info.roomId);
    if (!room) {
      ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
      return;
    }

    const player = room.players.get(info.playerId);
    if (!player) {
      ws.send(JSON.stringify({ type: 'error', message: 'Player not found' }));
      return;
    }

    handleMessage(room, player, msg);
  });

  ws.on('close', () => {
    const info = socketPlayerMap.get(ws);
    if (info) {
      const room = rooms.get(info.roomId);
      if (room) {
        room.handleDisconnect(info.playerId);
      }
    }
  });

  ws.on('error', () => {
    // Will trigger close event
  });
});

function handleJoin(ws: WebSocket, msg: { type: 'join'; roomId: string; name: string; token?: string }, ip: string): void {
  if (!joinRateLimit.consume(ip)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Rate limited. Try again shortly.' }));
    return;
  }

  const room = rooms.get(msg.roomId);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    return;
  }

  // Sanitize name
  const name = msg.name.trim().slice(0, CONFIG.MAX_NAME_LENGTH);
  if (name.length < CONFIG.MIN_NAME_LENGTH) {
    ws.send(JSON.stringify({ type: 'error', message: 'Name too short' }));
    return;
  }

  const player = room.addPlayer(name, ws, msg.token);
  if (!player) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
    return;
  }

  socketPlayerMap.set(ws, { roomId: room.roomId, playerId: player.id });

  // Send joined response with full state
  const state = room.getRoomState();

  // For the drawer during CHOOSING_WORD, include word choices
  // For non-drawers, never include the word
  const joinedMsg: any = {
    type: 'joined',
    playerId: player.id,
    token: player.token,
    state,
  };

  // If drawer reconnecting during CHOOSING_WORD, include choices
  if (room.phase === 'CHOOSING_WORD' && player.id === room.currentDrawerId) {
    joinedMsg.state = { ...state };
    // Word choices are included via phase_change, not in state
  }

  ws.send(JSON.stringify(joinedMsg));

  // If joining mid-drawing, send canvas snapshot
  if (room.phase === 'DRAWING') {
    const snapshot = room.getCanvasSnapshot();
    ws.send(JSON.stringify({
      type: 'snapshot',
      items: snapshot.items,
      nextSeq: snapshot.nextSeq,
    }));
  }

  // Notify other players
  room.broadcastExcept(player.id, {
    type: 'player_joined',
    player: {
      id: player.id,
      name: player.name,
      score: player.score,
      isHost: player.isHost,
      isConnected: true,
      hasGuessed: player.hasGuessed,
    },
  });

  // Check if we can resume from WAITING
  room.checkResumeFromWaiting();
}

function handleMessage(room: Room, player: Player, msg: Exclude<import('../shared/types.js').ClientMessage, { type: 'join' } | { type: 'ping' }>): void {
  switch (msg.type) {
    case 'update_settings':
      if (!room.updateSettings(player.id, msg.settings)) {
        room.sendTo(player.id, { type: 'error', message: 'Cannot update settings' });
      }
      break;

    case 'start_game':
      if (!room.startGame(player.id)) {
        room.sendTo(player.id, { type: 'error', message: 'Cannot start game' });
      }
      break;

    case 'new_game':
      if (!room.startNewGame(player.id)) {
        room.sendTo(player.id, { type: 'error', message: 'Cannot start new game' });
      }
      break;

    case 'choose_word':
      if (!room.chooseWord(player.id, msg.word)) {
        room.sendTo(player.id, { type: 'error', message: 'Invalid word choice' });
      }
      break;

    case 'draw_op': {
      // Rate limit drawing messages
      if (!player.drawMsgBucket.consume()) {
        player.violations++;
        if (player.violations >= CONFIG.VIOLATION_DISCONNECT_THRESHOLD) {
          player.socket?.close(1008, 'Rate limited');
        }
        break;
      }
      // Rate limit points
      if (msg.op.type === 'stroke_points') {
        if (!player.drawPointsBucket.consume(msg.op.points.length)) {
          player.violations++;
          break;
        }
      }
      if (!room.handleDrawOp(player.id, msg.op)) {
        player.violations++;
      }
      break;
    }

    case 'chat': {
      if (!player.chatBucket.consume()) {
        room.sendTo(player.id, {
          type: 'chat',
          playerId: 'system',
          playerName: 'System',
          text: 'Slow down! You are sending messages too fast.',
          isSystem: true,
          isPrivate: true,
        });
        break;
      }
      room.handleChat(player.id, msg.text);
      break;
    }

    case 'resync':
      room.handleResync(player.id, msg.lastSeq);
      break;
  }
}

function getIP(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '127.0.0.1';
}

// ── Load persisted rooms on startup ──
loadPersistedRooms();

// ── Start server ──
server.listen(CONFIG.PORT, () => {
  console.log(`Server running on http://localhost:${CONFIG.PORT}`);
  console.log(`Restored ${rooms.size} rooms from disk`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  // Persist all rooms
  for (const room of rooms.values()) {
    room.persist();
  }
  wss.close();
  server.close();
  process.exit(0);
});

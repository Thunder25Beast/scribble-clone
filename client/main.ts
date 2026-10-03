// Client: display and input device. All logic runs on the server.
// The client sends inputs, receives state, and renders it.

import type {
  ServerMessage, RoomState, PlayerInfo, DrawOp, CanvasItem,
  CompletedStroke, TurnReplay, ReplayOp, Point, FillOp
} from '../shared/types';

// ── Constants ──
const COLORS = [
  '#000000', '#FFFFFF', '#808080', '#C0C0C0',
  '#FF0000', '#FF6B6B', '#FF8C00', '#FFD93D',
  '#FFFF00', '#00FF00', '#00CEC9', '#0984E3',
  '#6C5CE7', '#A29BFE', '#FD79A8', '#E84393',
  '#D63031', '#744210', '#2D3436', '#636E72',
];

const CANVAS_W = 800;
const CANVAS_H = 600;

// ── State ──
let ws: WebSocket | null = null;
let playerId = '';
let playerToken = '';
let roomId = '';
let state: RoomState | null = null;
let isDrawer = false;
let clockOffset = 0; // serverTime = clientTime + offset
let bestRtt = Infinity;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Drawing state
let currentTool: 'pen' | 'eraser' | 'fill' = 'pen';
let currentColor = '#000000';
let brushSize = 5;
let drawing = false;
let currentStrokeId = '';
let currentStrokePoints: Point[] = [];
let pointBatchBuffer: Point[] = [];
let lastBatchTime = 0;
let lastSeq = 0;

// ── DOM elements ──
const $ = (id: string) => document.getElementById(id)!;
const screens = {
  landing: $('screen-landing'),
  name: $('screen-name'),
  lobby: $('screen-lobby'),
  game: $('screen-game'),
  end: $('screen-end'),
};

function showScreen(name: keyof typeof screens): void {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ── Canvas ──
const canvas = $('game-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const replayCanvas = $('replay-canvas') as HTMLCanvasElement;
const replayCtx = replayCanvas.getContext('2d')!;

function clearCanvas(context: CanvasRenderingContext2D): void {
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

clearCanvas(ctx);

// ── Scale canvas for different screen sizes ──
function getCanvasScale(): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    scaleX: CANVAS_W / rect.width,
    scaleY: CANVAS_H / rect.height,
    offsetX: rect.left,
    offsetY: rect.top,
  };
}

function pointerToLogical(e: PointerEvent): Point {
  const s = getCanvasScale();
  return {
    x: Math.round((e.clientX - s.offsetX) * s.scaleX),
    y: Math.round((e.clientY - s.offsetY) * s.scaleY),
  };
}

// ── WebSocket connection ──

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    $('reconnect-banner').classList.add('hidden');
    reconnectAttempts = 0;

    // If we have a room and token, rejoin
    if (roomId && playerToken) {
      const savedName = localStorage.getItem(`name_${roomId}`) || 'Player';
      send({ type: 'join', roomId, name: savedName, token: playerToken });
    }

    // Start clock sync
    startClockSync();
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data as string) as ServerMessage;
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    ws = null;
    if (roomId) {
      $('reconnect-banner').classList.remove('hidden');
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    // onclose will fire
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000) + Math.random() * 1000;
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(data: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ── Clock sync ──
function startClockSync(): void {
  doClockPing();
  setInterval(doClockPing, 10000);
}

function doClockPing(): void {
  send({ type: 'ping', t0: Date.now() });
}

function handlePong(t0: number, serverTime: number): void {
  const now = Date.now();
  const rtt = now - t0;
  if (rtt < bestRtt) {
    bestRtt = rtt;
    clockOffset = serverTime - (t0 + rtt / 2);
  }
  // Update ping display
  const pingDot = $('ping-display');
  pingDot.title = `Ping: ${rtt}ms`;
  pingDot.className = 'ping-dot' + (rtt > 200 ? ' critical' : rtt > 100 ? ' high' : '');
}

function serverNow(): number {
  return Date.now() + clockOffset;
}

// ── Message handler ──
function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'joined':
      playerId = msg.playerId;
      playerToken = msg.token;
      state = msg.state;
      roomId = msg.state.roomId;
      // Persist token and name
      localStorage.setItem(`token_${roomId}`, playerToken);
      localStorage.setItem(`name_${roomId}`, '');
      renderState();
      break;

    case 'error':
      showError(msg.message);
      break;

    case 'player_joined':
      if (state) {
        state.players.push(msg.player);
        renderPlayerList();
      }
      break;

    case 'player_left':
      if (state) {
        state.players = state.players.filter(p => p.id !== msg.playerId);
        renderPlayerList();
      }
      break;

    case 'player_disconnected':
      if (state) {
        const p = state.players.find(p => p.id === msg.playerId);
        if (p) p.isConnected = false;
        renderPlayerList();
      }
      break;

    case 'player_reconnected':
      if (state) {
        const p = state.players.find(p => p.id === msg.playerId);
        if (p) p.isConnected = true;
        renderPlayerList();
      }
      break;

    case 'host_changed':
      if (state) {
        for (const p of state.players) p.isHost = p.id === msg.playerId;
        renderPlayerList();
        renderLobbySettings();
      }
      break;

    case 'settings_updated':
      if (state) {
        state.settings = msg.settings;
        renderLobbySettings();
      }
      break;

    case 'phase_change':
      handlePhaseChange(msg);
      break;

    case 'draw_op':
      lastSeq = msg.seq;
      applyDrawOp(msg.op, ctx);
      break;

    case 'snapshot':
      lastSeq = msg.nextSeq - 1;
      clearCanvas(ctx);
      renderSnapshot(msg.items, ctx);
      break;

    case 'resync':
      for (const seqOp of msg.ops) {
        lastSeq = seqOp.seq;
        applyDrawOp(seqOp.op, ctx);
      }
      break;

    case 'chat':
      addChatMessage(msg.playerName, msg.text, msg.isSystem, msg.isPrivate);
      break;

    case 'correct_guess':
      addChatMessage('', `${msg.playerName} guessed the word!`, false, false, 'correct');
      if (state) {
        const p = state.players.find(p => p.id === msg.playerId);
        if (p) p.hasGuessed = true;
        renderPlayerList();
      }
      break;

    case 'near_miss':
      addChatMessage('', 'Close!', false, false, 'near-miss');
      break;

    case 'hint_update':
      if (state) {
        state.wordMask = msg.wordMask;
        renderWordDisplay();
      }
      break;

    case 'score_update':
      if (state) {
        for (const p of state.players) {
          if (msg.scores[p.id] !== undefined) p.score = msg.scores[p.id];
        }
        renderPlayerList();
      }
      break;

    case 'pong':
      handlePong(msg.t0, msg.serverTime);
      break;

    case 'guessed_chat':
      addChatMessage(msg.playerName, msg.text, false, false, 'guessed');
      break;
  }
}

function handlePhaseChange(msg: any): void {
  if (!state) return;
  state.phase = msg.phase;
  if (msg.currentRound) state.currentRound = msg.currentRound;
  if (msg.drawerId) state.currentDrawerId = msg.drawerId;
  if (msg.endsAt) state.endsAt = msg.endsAt;
  if (msg.wordMask !== undefined) state.wordMask = msg.wordMask;

  isDrawer = msg.drawerId === playerId;

  switch (msg.phase) {
    case 'CHOOSING_WORD':
      showScreen('game');
      clearCanvas(ctx);
      if (isDrawer && msg.wordChoices) {
        showWordChoices(msg.wordChoices);
      } else {
        hideWordChoices();
        addChatMessage('', `${msg.drawerName || 'Someone'} is choosing a word...`, true, false);
      }
      $('toolbar').classList.add('hidden');
      startTimer(msg.endsAt);
      renderWordDisplay();
      renderPlayerList();
      break;

    case 'DRAWING':
      showScreen('game');
      hideWordChoices();
      if (isDrawer) {
        $('toolbar').classList.remove('hidden');
        // Drawer sees the word
        if (msg.word) {
          $('word-display').textContent = msg.word;
        }
      } else {
        $('toolbar').classList.add('hidden');
      }
      startTimer(msg.endsAt);
      renderWordDisplay();
      renderPlayerList();
      updateRoundDisplay();
      break;

    case 'TURN_END':
      $('toolbar').classList.add('hidden');
      hideWordChoices();
      drawing = false;
      if (msg.word) {
        $('word-display').textContent = `The word was: ${msg.word}`;
      }
      stopTimer();
      renderPlayerList();
      break;

    case 'GAME_END':
      state.turnReplays = msg.turnReplays || [];
      showGameEnd();
      stopTimer();
      break;

    case 'WAITING':
      addChatMessage('', 'Waiting for more players...', true, false);
      stopTimer();
      break;

    case 'LOBBY':
      showScreen('lobby');
      renderLobbySettings();
      renderPlayerList();
      stopTimer();
      break;
  }
}

// ── Rendering ──

function renderState(): void {
  if (!state) return;

  switch (state.phase) {
    case 'LOBBY':
      showScreen('lobby');
      renderLobbySettings();
      setupShareLink();
      break;
    case 'GAME_END':
      showGameEnd();
      break;
    default:
      showScreen('game');
      isDrawer = state.currentDrawerId === playerId;
      if (isDrawer && state.phase === 'DRAWING') {
        $('toolbar').classList.remove('hidden');
      }
      if (state.endsAt) startTimer(state.endsAt);
      break;
  }

  renderPlayerList();
  renderWordDisplay();
  updateRoundDisplay();
}

function renderPlayerList(): void {
  if (!state) return;

  const isGame = state.phase !== 'LOBBY';
  const listEl = isGame ? $('game-player-list') : $('lobby-player-list');

  // Sort by score (descending) for game, join order for lobby
  const sorted = [...state.players].sort((a, b) =>
    isGame ? b.score - a.score : 0
  );

  listEl.innerHTML = sorted.map(p => {
    const dotClass = p.isConnected ? 'connected' : 'disconnected';
    const hostBadge = p.isHost ? '<span class="player-host-badge">HOST</span>' : '';
    const scoreHtml = isGame ? `<span class="player-score">${p.score}</span>` : '';
    const statusHtml = p.id === state!.currentDrawerId && isGame
      ? '<span class="player-drawing">Drawing</span>'
      : (p.hasGuessed && isGame && state!.phase === 'DRAWING'
        ? '<span class="player-guessed">Guessed!</span>' : '');
    const meClass = p.id === playerId ? ' style="font-weight:700"' : '';

    return `<li${meClass}>
      <span class="player-dot ${dotClass}"></span>
      <span class="player-name">${escapeHtml(p.name)}</span>
      ${hostBadge}${statusHtml}${scoreHtml}
    </li>`;
  }).join('');
}

function renderWordDisplay(): void {
  if (!state) return;
  const el = $('word-display');
  if (state.phase === 'DRAWING' && !isDrawer && state.wordMask) {
    el.textContent = state.wordMask;
  } else if (state.phase === 'CHOOSING_WORD') {
    if (!isDrawer) el.textContent = '...';
  }
}

function updateRoundDisplay(): void {
  if (!state) return;
  $('round-current').textContent = String(state.currentRound);
  $('round-total').textContent = String(state.totalRounds);
}

function renderLobbySettings(): void {
  if (!state) return;
  const isHost = state.players.find(p => p.id === playerId)?.isHost || false;

  const roundsEl = $('setting-rounds') as HTMLSelectElement;
  const drawTimeEl = $('setting-draw-time') as HTMLInputElement;
  const wordModeEl = $('setting-word-mode') as HTMLSelectElement;
  const customWordsEl = $('setting-custom-words') as HTMLTextAreaElement;
  const startBtn = $('btn-start-game') as HTMLButtonElement;
  const customArea = $('custom-words-area');

  roundsEl.value = String(state.settings.rounds);
  drawTimeEl.value = String(state.settings.drawTime);
  wordModeEl.value = state.settings.wordListMode;
  customWordsEl.value = state.settings.customWords.join('\n');

  // Show custom words area if mode includes custom
  if (state.settings.wordListMode === 'custom' || state.settings.wordListMode === 'mix') {
    customArea.classList.remove('hidden');
  } else {
    customArea.classList.add('hidden');
  }

  // Enable/disable based on host
  roundsEl.disabled = !isHost;
  drawTimeEl.disabled = !isHost;
  wordModeEl.disabled = !isHost;
  customWordsEl.disabled = !isHost;
  startBtn.disabled = !isHost || state.players.filter(p => p.isConnected).length < 2;
  startBtn.classList.toggle('hidden', !isHost);
  $('host-only-badge').classList.toggle('hidden', isHost);
}

function setupShareLink(): void {
  const url = `${location.origin}/r/${roomId}`;
  ($('share-url') as HTMLInputElement).value = url;
}

// ── Word choices ──
function showWordChoices(words: string[]): void {
  const overlay = $('word-choice-overlay');
  const container = $('word-choices');
  overlay.classList.remove('hidden');
  container.innerHTML = words.map(w =>
    `<button class="word-choice-btn">${escapeHtml(w)}</button>`
  ).join('');

  container.querySelectorAll('.word-choice-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      send({ type: 'choose_word', word: words[i] });
      overlay.classList.add('hidden');
    });
  });
}

function hideWordChoices(): void {
  $('word-choice-overlay').classList.add('hidden');
}

// ── Timer ──
function startTimer(endsAt: number): void {
  stopTimer();
  const timerEl = $('timer-value');
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.round((endsAt - serverNow()) / 1000));
    timerEl.textContent = String(remaining);
    if (remaining <= 0) stopTimer();
  }, 200);
}

function stopTimer(): void {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ── Chat ──
function addChatMessage(name: string, text: string, isSystem: boolean, isPrivate: boolean, extraClass?: string): void {
  const container = $('chat-messages');
  const div = document.createElement('div');
  let cls = 'chat-msg';
  if (isSystem) cls += ' system';
  if (isPrivate) cls += ' private';
  if (extraClass) cls += ` ${extraClass}`;
  div.className = cls;

  if (name && !isSystem) {
    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.textContent = name + ':';
    div.appendChild(nameSpan);
    div.appendChild(document.createTextNode(' ' + text));
  } else {
    div.textContent = text;
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  // Keep max 200 messages
  while (container.children.length > 200) {
    container.removeChild(container.firstChild!);
  }
}

// ── Drawing on canvas ──

function applyDrawOp(op: DrawOp, context: CanvasRenderingContext2D): void {
  switch (op.type) {
    case 'stroke_start':
      context.beginPath();
      context.moveTo(op.point.x, op.point.y);
      context.strokeStyle = op.tool === 'eraser' ? '#FFFFFF' : op.color;
      context.lineWidth = op.size;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.stroke();
      // Store for continued drawing
      (context as any)._lastPoint = op.point;
      (context as any)._strokeTool = op.tool;
      (context as any)._strokeColor = op.color;
      (context as any)._strokeSize = op.size;
      break;

    case 'stroke_points': {
      const lastPt = (context as any)._lastPoint as Point | undefined;
      context.strokeStyle = (context as any)._strokeTool === 'eraser' ? '#FFFFFF' : ((context as any)._strokeColor || '#000000');
      context.lineWidth = (context as any)._strokeSize || 5;
      context.lineCap = 'round';
      context.lineJoin = 'round';

      context.beginPath();
      if (lastPt) {
        context.moveTo(lastPt.x, lastPt.y);
      } else if (op.points.length > 0) {
        context.moveTo(op.points[0].x, op.points[0].y);
      }

      for (const pt of op.points) {
        context.lineTo(pt.x, pt.y);
      }
      context.stroke();

      if (op.points.length > 0) {
        (context as any)._lastPoint = op.points[op.points.length - 1];
      }
      break;
    }

    case 'stroke_end':
      (context as any)._lastPoint = null;
      break;

    case 'fill':
      canvasFill(context, op.x, op.y, op.color);
      break;

    case 'undo':
      // For remote undo, we need to redraw from snapshot
      // This is handled by requesting a resync or snapshot
      // For now, request a resync
      if (context === ctx) {
        send({ type: 'resync', lastSeq: 0 });
      }
      break;

    case 'clear':
      clearCanvas(context);
      break;
  }
}

function renderSnapshot(items: CanvasItem[], context: CanvasRenderingContext2D): void {
  for (const item of items) {
    if (item.type === 'stroke') {
      renderCompletedStroke(item, context);
    } else if (item.type === 'fill') {
      canvasFill(context, item.x, item.y, item.color);
    }
  }
}

function renderCompletedStroke(stroke: CompletedStroke, context: CanvasRenderingContext2D): void {
  if (stroke.points.length === 0) return;
  context.beginPath();
  context.strokeStyle = stroke.tool === 'eraser' ? '#FFFFFF' : stroke.color;
  context.lineWidth = stroke.size;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i++) {
    context.lineTo(stroke.points[i].x, stroke.points[i].y);
  }
  context.stroke();
}

function canvasFill(context: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  // Use shared flood fill on the canvas imageData
  const imageData = context.getImageData(0, 0, CANVAS_W, CANVAS_H);
  const { r, g, b } = hexToRgb(color);
  // Import flood fill from shared utils
  floodFillCanvas(imageData.data, CANVAS_W, CANVAS_H, x, y, { r, g, b, a: 255 });
  context.putImageData(imageData, 0, 0);
}

// Inline flood fill (same algorithm as shared/utils, duplicated here to avoid import issues in browser bundle)
function floodFillCanvas(
  imageData: Uint8ClampedArray, width: number, height: number,
  startX: number, startY: number,
  fillColor: { r: number; g: number; b: number; a: number }
): void {
  const sx = Math.floor(startX);
  const sy = Math.floor(startY);
  if (sx < 0 || sx >= width || sy < 0 || sy >= height) return;

  const idx = (sy * width + sx) * 4;
  const targetR = imageData[idx];
  const targetG = imageData[idx + 1];
  const targetB = imageData[idx + 2];
  const targetA = imageData[idx + 3];

  if (targetR === fillColor.r && targetG === fillColor.g &&
      targetB === fillColor.b && targetA === fillColor.a) return;

  const matchesTarget = (i: number) =>
    imageData[i] === targetR && imageData[i + 1] === targetG &&
    imageData[i + 2] === targetB && imageData[i + 3] === targetA;

  const setPixel = (i: number) => {
    imageData[i] = fillColor.r;
    imageData[i + 1] = fillColor.g;
    imageData[i + 2] = fillColor.b;
    imageData[i + 3] = fillColor.a;
  };

  const stack: [number, number][] = [[sx, sy]];
  while (stack.length > 0) {
    const [px, py] = stack.pop()!;
    let lx = px;
    while (lx > 0 && matchesTarget(((py * width) + lx - 1) * 4)) lx--;
    let spanAbove = false, spanBelow = false;
    while (lx < width) {
      const ci = (py * width + lx) * 4;
      if (!matchesTarget(ci)) break;
      setPixel(ci);
      if (py > 0) {
        const ai = ((py - 1) * width + lx) * 4;
        if (matchesTarget(ai)) { if (!spanAbove) { stack.push([lx, py - 1]); spanAbove = true; } }
        else spanAbove = false;
      }
      if (py < height - 1) {
        const bi = ((py + 1) * width + lx) * 4;
        if (matchesTarget(bi)) { if (!spanBelow) { stack.push([lx, py + 1]); spanBelow = true; } }
        else spanBelow = false;
      }
      lx++;
    }
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

// ── Drawing input (drawer only) ──

// Local drawing state for optimistic rendering
let localStrokeId = '';
let localStrokePoints: Point[] = [];

function generateStrokeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

canvas.addEventListener('pointerdown', (e: PointerEvent) => {
  if (!isDrawer || state?.phase !== 'DRAWING') return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);

  const pt = pointerToLogical(e);

  if (currentTool === 'fill') {
    const id = generateStrokeId();
    send({ type: 'draw_op', op: { type: 'fill', id, x: pt.x, y: pt.y, color: currentColor } });
    // Optimistic: render locally
    canvasFill(ctx, pt.x, pt.y, currentColor);
    return;
  }

  drawing = true;
  localStrokeId = generateStrokeId();
  localStrokePoints = [pt];
  pointBatchBuffer = [];
  lastBatchTime = performance.now();

  const tool = currentTool === 'eraser' ? 'eraser' as const : 'pen' as const;

  // Send stroke_start
  send({
    type: 'draw_op',
    op: { type: 'stroke_start', id: localStrokeId, tool, color: currentColor, size: brushSize, point: pt }
  });

  // Optimistic render
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y);
  ctx.strokeStyle = tool === 'eraser' ? '#FFFFFF' : currentColor;
  ctx.lineWidth = brushSize;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Draw a dot
  ctx.lineTo(pt.x, pt.y);
  ctx.stroke();
});

canvas.addEventListener('pointermove', (e: PointerEvent) => {
  if (!drawing || !isDrawer) return;
  e.preventDefault();

  const pt = pointerToLogical(e);
  localStrokePoints.push(pt);
  pointBatchBuffer.push(pt);

  // Optimistic render
  ctx.beginPath();
  const prev = localStrokePoints[localStrokePoints.length - 2];
  ctx.moveTo(prev.x, prev.y);
  ctx.lineTo(pt.x, pt.y);
  ctx.strokeStyle = currentTool === 'eraser' ? '#FFFFFF' : currentColor;
  ctx.lineWidth = brushSize;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Batch send using requestAnimationFrame timing (every ~16ms)
  const now = performance.now();
  if (now - lastBatchTime >= 16 && pointBatchBuffer.length > 0) {
    send({
      type: 'draw_op',
      op: { type: 'stroke_points', id: localStrokeId, points: [...pointBatchBuffer] }
    });
    pointBatchBuffer = [];
    lastBatchTime = now;
  }
});

canvas.addEventListener('pointerup', (e: PointerEvent) => {
  if (!drawing || !isDrawer) return;
  e.preventDefault();
  drawing = false;

  // Send remaining points
  if (pointBatchBuffer.length > 0) {
    send({
      type: 'draw_op',
      op: { type: 'stroke_points', id: localStrokeId, points: [...pointBatchBuffer] }
    });
    pointBatchBuffer = [];
  }

  // Send stroke_end
  send({ type: 'draw_op', op: { type: 'stroke_end', id: localStrokeId } });
});

canvas.addEventListener('pointerleave', (e: PointerEvent) => {
  if (drawing && isDrawer) {
    // End stroke on leave
    if (pointBatchBuffer.length > 0) {
      send({
        type: 'draw_op',
        op: { type: 'stroke_points', id: localStrokeId, points: [...pointBatchBuffer] }
      });
      pointBatchBuffer = [];
    }
    send({ type: 'draw_op', op: { type: 'stroke_end', id: localStrokeId } });
    drawing = false;
  }
});

// ── Toolbar ──

// Color palette
function initColorPalette(): void {
  const palette = $('color-palette');
  palette.innerHTML = COLORS.map(c =>
    `<div class="color-swatch${c === currentColor ? ' active' : ''}" style="background:${c}" data-color="${c}"></div>`
  ).join('');

  palette.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('color-swatch')) {
      currentColor = target.dataset.color!;
      palette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      target.classList.add('active');
      if (currentTool === 'eraser') {
        currentTool = 'pen';
        updateToolButtons();
      }
    }
  });
}

initColorPalette();

// Custom color
$('custom-color').addEventListener('input', (e) => {
  currentColor = (e.target as HTMLInputElement).value;
  $('color-palette').querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
  if (currentTool === 'eraser') {
    currentTool = 'pen';
    updateToolButtons();
  }
});

// Tool buttons
document.querySelectorAll('[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTool = (btn as HTMLElement).dataset.tool as 'pen' | 'eraser' | 'fill';
    updateToolButtons();
  });
});

function updateToolButtons(): void {
  document.querySelectorAll('[data-tool]').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.tool === currentTool);
  });
}

// Brush size
const brushSlider = $('brush-size') as HTMLInputElement;
brushSlider.addEventListener('input', () => {
  brushSize = parseInt(brushSlider.value);
  $('brush-size-label').textContent = String(brushSize);
});

// Undo
$('btn-undo').addEventListener('click', () => {
  if (!isDrawer || state?.phase !== 'DRAWING') return;
  send({ type: 'draw_op', op: { type: 'undo' } });
  // We need to request a fresh snapshot since we can't undo locally reliably
  send({ type: 'resync', lastSeq: 0 });
});

// Clear
$('btn-clear').addEventListener('click', () => {
  if (!isDrawer || state?.phase !== 'DRAWING') return;
  send({ type: 'draw_op', op: { type: 'clear' } });
  clearCanvas(ctx);
});

// ── Chat ──
function sendChat(): void {
  const input = $('chat-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  input.value = '';
}

$('btn-send-chat').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') sendChat();
});

// ── Landing page ──
$('btn-create-room').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/create-room', { method: 'POST' });
    const data = await res.json();
    if (data.error) { showError(data.error); return; }
    roomId = data.roomId;
    showScreen('name');
  } catch (err) {
    showError('Failed to create room');
  }
});

$('btn-join-room').addEventListener('click', () => {
  const input = ($('input-room-code') as HTMLInputElement).value.trim();
  // Extract room id from URL or plain code
  const match = input.match(/\/r\/([A-Za-z0-9_-]+)/);
  if (match) {
    roomId = match[1];
  } else if (input.length >= 6) {
    roomId = input;
  } else {
    showError('Please enter a valid room link or code');
    return;
  }
  showScreen('name');
});

// Check if we have a room in the URL
function checkUrlRoom(): void {
  const match = location.pathname.match(/\/r\/([A-Za-z0-9_-]+)/);
  if (match) {
    roomId = match[1];
    // Check for saved token
    const savedToken = localStorage.getItem(`token_${roomId}`);
    if (savedToken) {
      playerToken = savedToken;
      // Try to reconnect with saved name
      const savedName = localStorage.getItem(`name_${roomId}`) || '';
      if (savedName) {
        connect();
        send({ type: 'join', roomId, name: savedName, token: playerToken });
        return;
      }
    }
    showScreen('name');
  }
}

// Name entry
$('btn-enter').addEventListener('click', () => {
  const name = ($('input-name') as HTMLInputElement).value.trim();
  if (name.length < 1 || name.length > 20) {
    $('name-error').textContent = 'Name must be 1 to 20 characters';
    return;
  }
  localStorage.setItem(`name_${roomId}`, name);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
    // Wait for connection, then join
    const checkInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(checkInterval);
        send({ type: 'join', roomId, name, token: playerToken || undefined });
      }
    }, 100);
  } else {
    send({ type: 'join', roomId, name, token: playerToken || undefined });
  }
});

$('input-name').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') $('btn-enter').click();
});

// ── Lobby settings ──
$('setting-rounds').addEventListener('change', (e) => {
  send({ type: 'update_settings', settings: { rounds: parseInt((e.target as HTMLSelectElement).value) } });
});
$('setting-draw-time').addEventListener('change', (e) => {
  send({ type: 'update_settings', settings: { drawTime: parseInt((e.target as HTMLInputElement).value) } });
});
$('setting-word-mode').addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value as 'default' | 'custom' | 'mix';
  send({ type: 'update_settings', settings: { wordListMode: mode } });
  $('custom-words-area').classList.toggle('hidden', mode === 'default');
});
$('setting-custom-words').addEventListener('change', (e) => {
  const words = (e.target as HTMLTextAreaElement).value.split('\n').map(w => w.trim()).filter(w => w);
  send({ type: 'update_settings', settings: { customWords: words } });
});
$('btn-start-game').addEventListener('click', () => {
  send({ type: 'start_game' });
});
$('btn-copy-link').addEventListener('click', () => {
  const url = ($('share-url') as HTMLInputElement).value;
  navigator.clipboard.writeText(url).then(() => {
    $('btn-copy-link').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy-link').textContent = 'Copy'; }, 2000);
  });
});

// ── Game end / New game ──
$('btn-new-game').addEventListener('click', () => {
  send({ type: 'new_game' });
});

function showGameEnd(): void {
  if (!state) return;
  showScreen('end');

  // Leaderboard
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  const leaderboard = $('final-leaderboard');
  leaderboard.innerHTML = sorted.map((p, i) => `
    <div class="leaderboard-entry">
      <span class="leaderboard-rank">#${i + 1}</span>
      <span class="leaderboard-name">${escapeHtml(p.name)}</span>
      <span class="leaderboard-score">${p.score}</span>
    </div>
  `).join('');

  // Show/hide new game button for host only
  const isHost = state.players.find(p => p.id === playerId)?.isHost || false;
  $('btn-new-game').classList.toggle('hidden', !isHost);

  // Set up replay
  setupReplay(state.turnReplays || []);
}

// ── Replay system ──
let replayTurns: TurnReplay[] = [];
let replayTimer: ReturnType<typeof setTimeout> | null = null;
let replayPlaying = false;
let replaySpeed = 1;
let replayCurrentTurn = 0;
let replayCurrentOpIdx = 0;
let replayStartTime = 0;

function setupReplay(turns: TurnReplay[]): void {
  replayTurns = turns;
  const select = $('replay-turn-select') as HTMLSelectElement;
  select.innerHTML = turns.map((t, i) =>
    `<option value="${i}">${escapeHtml(t.drawerName)} drew "${escapeHtml(t.word)}"</option>`
  ).join('');

  if (turns.length > 0) {
    replayCurrentTurn = 0;
    prepareReplayTurn(0);
  }
}

function prepareReplayTurn(index: number): void {
  replayCurrentTurn = index;
  replayCurrentOpIdx = 0;
  clearCanvas(replayCtx);
  const turn = replayTurns[index];
  if (turn) {
    $('replay-word').textContent = `Word: ${turn.word}`;
    ($('replay-scrubber') as HTMLInputElement).value = '0';
    ($('replay-scrubber') as HTMLInputElement).max = String(turn.ops.length - 1);
  }
}

$('replay-turn-select').addEventListener('change', (e) => {
  stopReplay();
  prepareReplayTurn(parseInt((e.target as HTMLSelectElement).value));
});

$('btn-replay-play').addEventListener('click', () => {
  if (replayPlaying) return;
  replayPlaying = true;
  replaySpeed = parseInt(($('replay-speed') as HTMLSelectElement).value);
  playNextReplayOp();
});

$('btn-replay-pause').addEventListener('click', stopReplay);

$('replay-speed').addEventListener('change', (e) => {
  replaySpeed = parseInt((e.target as HTMLSelectElement).value);
});

$('replay-scrubber').addEventListener('input', (e) => {
  stopReplay();
  const idx = parseInt((e.target as HTMLInputElement).value);
  // Replay up to this index
  clearCanvas(replayCtx);
  const turn = replayTurns[replayCurrentTurn];
  if (!turn) return;
  for (let i = 0; i <= idx && i < turn.ops.length; i++) {
    applyDrawOp(turn.ops[i].op, replayCtx);
  }
  replayCurrentOpIdx = idx + 1;
});

function playNextReplayOp(): void {
  if (!replayPlaying) return;
  const turn = replayTurns[replayCurrentTurn];
  if (!turn || replayCurrentOpIdx >= turn.ops.length) {
    stopReplay();
    return;
  }

  const op = turn.ops[replayCurrentOpIdx];
  applyDrawOp(op.op, replayCtx);
  ($('replay-scrubber') as HTMLInputElement).value = String(replayCurrentOpIdx);
  replayCurrentOpIdx++;

  // Schedule next op
  if (replayCurrentOpIdx < turn.ops.length) {
    const nextOp = turn.ops[replayCurrentOpIdx];
    const delay = Math.max(1, (nextOp.offsetMs - op.offsetMs) / replaySpeed);
    replayTimer = setTimeout(playNextReplayOp, delay);
  } else {
    stopReplay();
  }
}

function stopReplay(): void {
  replayPlaying = false;
  if (replayTimer) {
    clearTimeout(replayTimer);
    replayTimer = null;
  }
}

// ── Error modal ──
function showError(msg: string): void {
  $('error-modal-text').textContent = msg;
  $('error-modal').classList.remove('hidden');
}

$('btn-error-ok').addEventListener('click', () => {
  $('error-modal').classList.add('hidden');
});

// ── Utilities ──
function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── Init ──
connect();
checkUrlRoom();

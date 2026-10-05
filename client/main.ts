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
  const rawX = (e.clientX - s.offsetX) * s.scaleX;
  const rawY = (e.clientY - s.offsetY) * s.scaleY;
  return {
    x: Math.max(0, Math.min(CANVAS_W - 1, Math.round(rawX))),
    y: Math.max(0, Math.min(CANVAS_H - 1, Math.round(rawY))),
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
      const savedName = sessionStorage.getItem(`name_${roomId}`) || 'Player';
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
      // Persist token and name in sessionStorage for this tab
      sessionStorage.setItem(`token_${roomId}`, playerToken);
      const myPlayer = state.players.find(p => p.id === playerId);
      if (myPlayer?.name) {
        sessionStorage.setItem(`name_${roomId}`, myPlayer.name);
      }
      renderState();
      updateChatInputState();
      break;

    case 'error':
      showError(msg.message);
      break;

    case 'player_joined':
      if (state) {
        const pNameLower = msg.player.name.trim().toLowerCase();
        const existingIdx = state.players.findIndex(
          p => p.id === msg.player.id || p.name.trim().toLowerCase() === pNameLower
        );
        if (existingIdx >= 0) {
          state.players[existingIdx] = { ...state.players[existingIdx], ...msg.player, isConnected: true };
        } else {
          state.players.push(msg.player);
          addChatMessage('', `${msg.player.name} joined the room.`, true, false);
        }
        renderPlayerList();
        renderLobbySettings();
      }
      break;

    case 'player_left':
      if (state) {
        const leftPlayer = state.players.find(p => p.id === msg.playerId);
        state.players = state.players.filter(p => p.id !== msg.playerId);
        renderPlayerList();
        renderLobbySettings();
        if (leftPlayer) {
          addChatMessage('', `${leftPlayer.name} left the room.`, true, false);
        }
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
        if (p) {
          p.isConnected = true;
          addChatMessage('', `${p.name} reconnected.`, true, false);
        }
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
      if (msg.playerId === playerId) {
        addChatMessage('', 'You guessed the word!', false, false, 'correct');
        const guessed = msg.word || (window as any)._lastGuess || '';
        if (guessed) (window as any)._guessedWord = guessed;
      } else {
        addChatMessage('', `${msg.playerName} guessed the word!`, false, false, 'correct');
      }
      if (state) {
        const p = state.players.find(p => p.id === msg.playerId);
        if (p) p.hasGuessed = true;
        renderPlayerList();
        renderWordDisplay();
        updateChatInputState();
      }
      break;

    case 'near_miss':
      if (msg.text) {
        const myName = state?.players.find(p => p.id === playerId)?.name || 'You';
        addChatMessage(myName, msg.text, false, true);
        addChatMessage('', '"' + msg.text + '" is close!', false, false, 'near-miss');
      } else {
        addChatMessage('', 'Close!', false, false, 'near-miss');
      }
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
      drawing = false;
      (window as any)._drawerWord = null;
      (window as any)._guessedWord = null;
      (window as any)._turnEndWord = null;
      (window as any)._lastGuess = null;
      (state as any).currentWord = null;
      state.wordMask = '';
      state.players.forEach(p => { p.hasGuessed = false; });

      if (isDrawer && msg.wordChoices) {
        showWordChoices(msg.wordChoices);
        $('word-display').textContent = 'Choose a secret word!';
      } else {
        const drawerName = msg.drawerName || state.players.find(p => p.id === msg.drawerId)?.name || 'Someone';
        showWaitingForWordChoice(drawerName);
        addChatMessage('', `${drawerName} is choosing a word...`, true, false);
        $('word-display').textContent = 'Choosing a word...';
      }
      $('toolbar').classList.add('hidden');
      startTimer(msg.endsAt);
      renderPlayerList();
      updateChatInputState();
      break;

    case 'DRAWING':
      showScreen('game');
      hideWordChoices();
      clearCanvas(ctx);
      drawing = false;
      (window as any)._guessedWord = null;
      (window as any)._turnEndWord = null;
      (window as any)._lastGuess = null;
      state.players.forEach(p => { p.hasGuessed = false; });
      const drawerName = msg.drawerName || state.players.find(p => p.id === msg.drawerId)?.name || 'Someone';

      if (isDrawer) {
        $('toolbar').classList.remove('hidden');
        if (msg.word) {
          (window as any)._drawerWord = msg.word;
          (state as any).currentWord = msg.word;
          $('word-display').textContent = `Word: ${msg.word}`;
        }
        showCanvasBanner('You are drawing!');
      } else {
        $('toolbar').classList.add('hidden');
        (window as any)._drawerWord = null;
        (state as any).currentWord = null;
        showCanvasBanner(`${drawerName} is drawing now!`);
        addChatMessage('', `${drawerName} is drawing now!`, true, false);
      }
      startTimer(msg.endsAt);
      renderWordDisplay();
      renderPlayerList();
      updateRoundDisplay();
      updateChatInputState();
      break;

    case 'TURN_END':
      $('toolbar').classList.add('hidden');
      hideWordChoices();
      drawing = false;
      if (msg.word) {
        (window as any)._drawerWord = null;
        (window as any)._turnEndWord = msg.word;
        $('word-display').textContent = `The word was: ${msg.word}`;
        addChatMessage('', `Turn ended! The word was "${msg.word}".`, true, false);
        showCanvasBanner(`Turn ended! The word was: ${msg.word}`, 4000);
      }
      stopTimer();
      renderPlayerList();
      updateChatInputState();
      break;

    case 'GAME_END':
      $('toolbar').classList.add('hidden');
      hideWordChoices();
      state.turnReplays = msg.turnReplays || [];
      showGameEnd();
      stopTimer();
      updateChatInputState();
      break;

    case 'WAITING':
      $('toolbar').classList.add('hidden');
      hideWordChoices();
      addChatMessage('', 'Waiting for more players...', true, false);
      stopTimer();
      updateChatInputState();
      break;

    case 'LOBBY':
      $('toolbar').classList.add('hidden');
      hideWordChoices();
      clearCanvas(ctx);
      showScreen('lobby');
      renderLobbySettings();
      renderPlayerList();
      stopTimer();
      updateChatInputState();
      updateHostControls();
      break;
  }
  updateHostControls();
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
  updateHostControls();
}

function renderPlayerList(): void {
  if (!state) return;

  const isGame = state.phase !== 'LOBBY';
  const listEl = isGame ? $('game-player-list') : $('lobby-player-list');

  // Deduplicate players by id and name
  const uniquePlayers: PlayerInfo[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const p of state.players) {
    const normName = p.name.trim().toLowerCase();
    if (!seenIds.has(p.id) && !seenNames.has(normName)) {
      seenIds.add(p.id);
      seenNames.add(normName);
      uniquePlayers.push(p);
    }
  }

  // Sort by score (descending) for game, join order for lobby
  const sorted = [...uniquePlayers].sort((a, b) =>
    isGame ? b.score - a.score : 0
  );

  listEl.innerHTML = sorted.map(p => {
    const dotClass = p.isConnected ? 'connected' : 'disconnected';
    const hostBadge = p.isHost ? '<span class="player-host-badge">HOST</span>' : '';
    const scoreHtml = isGame ? `<span class="player-score">${p.score}</span>` : '';
    const statusHtml = p.id === state!.currentDrawerId && isGame
      ? (state!.phase === 'CHOOSING_WORD'
          ? '<span class="player-choosing">Choosing...</span>'
          : '<span class="player-drawing">Drawing</span>')
      : (p.hasGuessed && isGame && state!.phase === 'DRAWING'
        ? '<span class="player-guessed">Guessed!</span>' : '');
    const meClass = p.id === playerId ? ' me' : '';

    return `<li class="player-item${meClass}">
      <span class="player-dot ${dotClass}"></span>
      <span class="player-name">${escapeHtml(p.name)}</span>
      ${hostBadge}${statusHtml}${scoreHtml}
    </li>`;
  }).join('');

  updateHostControls();
}

function renderWordDisplay(): void {
  if (!state) return;
  const el = $('word-display');

  if (state.phase === 'CHOOSING_WORD') {
    el.textContent = isDrawer ? 'Choose a secret word!' : 'Choosing a word...';
    return;
  }

  if (state.phase === 'DRAWING') {
    if (isDrawer) {
      const word = (window as any)._drawerWord || (state as any).currentWord || '';
      el.textContent = word ? `Word: ${word}` : 'Drawing';
    } else {
      const me = state.players.find(p => p.id === playerId);
      if (me?.hasGuessed) {
        const guessedWord = (window as any)._guessedWord;
        if (guessedWord) {
          el.textContent = `Word: ${guessedWord} (Guessed!)`;
        } else {
          const wordParts = (state.wordMask || '').split(/\s{3,}/);
          const wordHtml = wordParts
            .map(part => `<span class="word-group">${escapeHtml(part)}</span>`)
            .join('<span class="word-gap"></span>');
          el.innerHTML = `${wordHtml} <span class="word-count">(Guessed!)</span>`;
        }
      } else if (state.wordMask) {
        // Multi-word separation: split on 3 or more spaces between words
        const wordParts = state.wordMask.split(/\s{3,}/);
        const wordLengths = wordParts.map(part => {
          return part.split(' ').filter(c => c && c !== '-' && c !== ' ').length;
        });
        const lengthBadge = `(${wordLengths.join(', ')})`;

        const wordHtml = wordParts
          .map(part => `<span class="word-group">${escapeHtml(part)}</span>`)
          .join('<span class="word-gap"></span>');

        el.innerHTML = `${wordHtml} <span class="word-count">${lengthBadge}</span>`;
      } else {
        el.textContent = '...';
      }
    }
    return;
  }

  if (state.phase === 'TURN_END') {
    const word = (window as any)._turnEndWord;
    if (word) {
      el.textContent = `The word was: ${word}`;
    }
    return;
  }

  if (state.phase === 'LOBBY') {
    el.textContent = '';
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
  const minPlayersMsg = $('lobby-min-players-msg');

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

  const connectedCount = state.players.filter(p => p.isConnected).length;
  const canStart = isHost && connectedCount >= 2;

  // Enable/disable based on host
  roundsEl.disabled = !isHost;
  drawTimeEl.disabled = !isHost;
  wordModeEl.disabled = !isHost;
  customWordsEl.disabled = !isHost;
  startBtn.disabled = !canStart;
  startBtn.classList.toggle('hidden', !isHost);
  $('host-only-badge').classList.toggle('hidden', isHost);

  if (minPlayersMsg) {
    minPlayersMsg.classList.toggle('hidden', !isHost || connectedCount >= 2);
  }
}

function setupShareLink(): void {
  const url = `${location.origin}/r/${roomId}`;
  ($('share-url') as HTMLInputElement).value = url;
}

// ── Word choices and banners ──
let bannerTimeout: ReturnType<typeof setTimeout> | null = null;
function showCanvasBanner(text: string, durationMs = 2500): void {
  const banner = $('canvas-banner');
  if (!banner) return;
  if (bannerTimeout) {
    clearTimeout(bannerTimeout);
    bannerTimeout = null;
  }
  banner.textContent = text;
  banner.classList.remove('hidden');
  bannerTimeout = setTimeout(() => {
    banner.classList.add('hidden');
    bannerTimeout = null;
  }, durationMs);
}

function showWordChoices(words: string[]): void {
  const overlay = $('word-choice-overlay');
  const title = $('word-choice-title');
  const container = $('word-choices');
  const waiting = $('word-choice-waiting');

  overlay.classList.remove('hidden');
  if (title) title.textContent = 'Choose a secret word:';
  container.classList.remove('hidden');
  if (waiting) waiting.classList.add('hidden');

  container.innerHTML = words.map(w =>
    `<button class="word-choice-btn">${escapeHtml(w)}</button>`
  ).join('');

  container.querySelectorAll('.word-choice-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      send({ type: 'choose_word', word: words[i] });
      hideWordChoices();
    });
  });
}

function showWaitingForWordChoice(drawerName: string): void {
  const overlay = $('word-choice-overlay');
  const title = $('word-choice-title');
  const container = $('word-choices');
  const waiting = $('word-choice-waiting');
  const waitingText = $('word-choice-waiting-text');

  overlay.classList.remove('hidden');
  if (title) title.textContent = `${drawerName} is choosing a word...`;
  container.classList.add('hidden');
  if (waiting) waiting.classList.remove('hidden');
  if (waitingText) waitingText.textContent = `Please wait while ${drawerName} picks a word`;
}

function hideWordChoices(): void {
  $('word-choice-overlay').classList.add('hidden');
  $('word-choices').classList.add('hidden');
  const waiting = $('word-choice-waiting');
  if (waiting) waiting.classList.add('hidden');
}

function updateChatInputState(): void {
  const input = $('chat-input') as HTMLInputElement;
  const sendBtn = $('btn-send-chat') as HTMLButtonElement;
  if (!input) return;

  if (!state || state.phase === 'LOBBY') {
    input.placeholder = 'Chat in lobby...';
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    return;
  }

  if (state.phase === 'CHOOSING_WORD') {
    if (isDrawer) {
      input.placeholder = 'Choose a word above...';
    } else {
      const drawer = state.players.find(p => p.id === state?.currentDrawerId);
      input.placeholder = `Waiting for ${drawer?.name || 'drawer'} to choose...`;
    }
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    return;
  }

  if (state.phase === 'DRAWING') {
    if (isDrawer) {
      input.placeholder = 'You are drawing! Chat with the room...';
      input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
    } else {
      const me = state.players.find(p => p.id === playerId);
      if (me?.hasGuessed) {
        input.placeholder = 'You guessed the word! Chat here...';
      } else {
        input.placeholder = 'Type your guess here...';
      }
      input.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
    }
    return;
  }

  if (state.phase === 'TURN_END') {
    input.placeholder = 'Turn ended! Chat...';
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    return;
  }

  if (state.phase === 'GAME_END') {
    input.placeholder = 'Game over! Chat...';
    input.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    return;
  }
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
  const containers = [
    document.getElementById('chat-messages'),
    document.getElementById('lobby-chat-messages')
  ].filter((el): el is HTMLElement => Boolean(el));

  for (const container of containers) {
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
}

// ── Drawing on canvas ──

function applyDrawOp(op: DrawOp, context: CanvasRenderingContext2D): void {
  switch (op.type) {
    case 'stroke_start':
      context.beginPath();
      context.moveTo(op.point.x, op.point.y);
      context.lineTo(op.point.x, op.point.y);
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
  if (stroke.points.length === 1) {
    context.lineTo(stroke.points[0].x, stroke.points[0].y);
  } else {
    for (let i = 1; i < stroke.points.length; i++) {
      context.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
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

  // If target color is already filled, nothing to do
  const tolSq = 32 * 32;
  const fillDiff = (targetR - fillColor.r) ** 2 + (targetG - fillColor.g) ** 2 +
                   (targetB - fillColor.b) ** 2 + (targetA - fillColor.a) ** 2;
  if (fillDiff <= tolSq) return;

  const matchesTarget = (i: number) => {
    const dr = imageData[i] - targetR;
    const dg = imageData[i + 1] - targetG;
    const db = imageData[i + 2] - targetB;
    const da = imageData[i + 3] - targetA;
    return (dr * dr + dg * dg + db * db + da * da) <= tolSq;
  };

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
  const prev = localStrokePoints[localStrokePoints.length - 1];
  if (prev && prev.x === pt.x && prev.y === pt.y) return; // skip redundant identical points

  localStrokePoints.push(pt);
  pointBatchBuffer.push(pt);

  // Optimistic render
  ctx.beginPath();
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
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {}

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

canvas.addEventListener('pointercancel', (e: PointerEvent) => {
  if (drawing && isDrawer) {
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}
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
function performUndo(): void {
  if (!isDrawer || state?.phase !== 'DRAWING') return;
  send({ type: 'draw_op', op: { type: 'undo' } });
}

$('btn-undo').addEventListener('click', performUndo);

// Keyboard shortcut: Ctrl+Z / Cmd+Z to undo
document.addEventListener('keydown', (e: KeyboardEvent) => {
  const target = e.target as HTMLElement;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    performUndo();
  }
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
  (window as any)._lastGuess = text;
  send({ type: 'chat', text });
  input.value = '';
}

$('btn-send-chat').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') sendChat();
});

function sendLobbyChat(): void {
  const input = document.getElementById('lobby-chat-input') as HTMLInputElement | null;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  (window as any)._lastGuess = text;
  send({ type: 'chat', text });
  input.value = '';
}

const btnLobbySendChat = document.getElementById('btn-lobby-send-chat');
if (btnLobbySendChat) {
  btnLobbySendChat.addEventListener('click', sendLobbyChat);
}
const lobbyChatInput = document.getElementById('lobby-chat-input') as HTMLInputElement | null;
if (lobbyChatInput) {
  lobbyChatInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') sendLobbyChat();
  });
}

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
    // Check for saved token in this tab
    const savedToken = sessionStorage.getItem(`token_${roomId}`);
    const savedName = sessionStorage.getItem(`name_${roomId}`) || '';
    if (savedToken && savedName) {
      playerToken = savedToken;
      connect();
      return;
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
  sessionStorage.setItem(`name_${roomId}`, name);
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

// ── Room restart & Lobby controls ──
$('btn-new-game').addEventListener('click', () => {
  send({ type: 'restart_game' });
});

$('btn-return-lobby').addEventListener('click', () => {
  send({ type: 'return_to_lobby' });
});

$('btn-topbar-restart').addEventListener('click', () => {
  send({ type: 'restart_game' });
});

$('btn-topbar-lobby').addEventListener('click', () => {
  send({ type: 'return_to_lobby' });
});

function updateHostControls(): void {
  if (!state) return;
  const isHost = state.players.find(p => p.id === playerId)?.isHost || false;

  const topbarControls = $('host-game-controls');
  if (topbarControls) {
    topbarControls.classList.toggle('hidden', !isHost || state.phase === 'LOBBY' || state.phase === 'GAME_END');
  }

  const endRestartBtn = $('btn-new-game');
  const endLobbyBtn = $('btn-return-lobby');
  const endWaitingMsg = $('end-waiting-host');
  if (endRestartBtn) endRestartBtn.classList.toggle('hidden', !isHost);
  if (endLobbyBtn) endLobbyBtn.classList.toggle('hidden', !isHost);
  if (endWaitingMsg) endWaitingMsg.classList.toggle('hidden', isHost);
}

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

  updateHostControls();

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
checkUrlRoom();
if (!roomId) {
  connect();
}

// ── Mobile Virtual Keyboard Focus Helper ──
function setupMobileInputFocus(): void {
  const ids = ['chat-input', 'lobby-chat-input', 'input-name', 'input-room-code'];
  ids.forEach(id => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.addEventListener('touchend', () => {
      // Force explicit focus on mobile touchend so soft keyboard pops up reliably
      el.focus();
    }, { passive: true });
    el.addEventListener('click', () => {
      el.focus();
    });
  });
}
setupMobileInputFocus();

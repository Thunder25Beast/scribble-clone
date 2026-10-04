// Room: the core game logic. The server is the single authority.
// All state transitions happen here. Clients are displays and input devices.

import crypto from 'crypto';
import { WebSocket } from 'ws';
import { CONFIG } from '../shared/config.js';
import {
  GamePhase, RoomSettings, PlayerInfo, DrawOp, SeqDrawOp,
  CanvasItem, CompletedStroke, TurnReplay, ReplayOp,
  ServerMessage, ClientMessage, RoomState
} from '../shared/types.js';
import {
  normalizeGuess, editDistance, isNearMiss,
  generateMask, revealHint, computeHintSchedule,
  computeGuesserPoints, computeDrawerPoints
} from '../shared/utils.js';
import { DEFAULT_WORDS } from '../shared/words.js';
import { TokenBucket } from './ratelimit.js';
import { serverMetrics } from './metrics.js';

// ── Player (server side) ──
export interface Player {
  id: string;
  name: string;
  token: string; // secret, for reconnect
  score: number;
  isHost: boolean;
  isConnected: boolean;
  hasGuessed: boolean;
  socket: WebSocket | null;
  joinOrder: number;
  violations: number;
  chatBucket: TokenBucket;
  drawMsgBucket: TokenBucket;
  drawPointsBucket: TokenBucket;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

// ── Persisted room state (what survives a restart) ──
export interface PersistedRoom {
  roomId: string;
  settings: RoomSettings;
  players: Array<{
    id: string;
    name: string;
    token: string;
    score: number;
    isHost: boolean;
    joinOrder: number;
  }>;
  phase: GamePhase;
  currentRound: number;
  turnOrder: string[];
  currentTurnIndex: number;
  usedWords: string[];
}

export class Room {
  readonly roomId: string;
  settings: RoomSettings;
  players: Map<string, Player> = new Map();
  phase: GamePhase = 'LOBBY';

  // Turn management
  currentRound: number = 0;
  turnOrder: string[] = []; // player ids in draw order
  currentTurnIndex: number = 0;
  currentDrawerId: string | null = null;
  currentWord: string | null = null;
  wordChoices: string[] = [];
  wordMask: string | null = null;
  usedWords: string[] = [];
  guessOrder: number = 0; // how many have guessed this turn

  // Timers
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private hintTimers: ReturnType<typeof setTimeout>[] = [];
  private drawerLeaveTimer: ReturnType<typeof setTimeout> | null = null;
  private emptyRoomTimer: ReturnType<typeof setTimeout> | null = null;

  // Drawing
  private drawSeq: number = 0;
  private activeStack: CanvasItem[] = []; // current canvas state (for snapshots)
  private opLog: SeqDrawOp[] = []; // full log for resync
  private currentStroke: Map<string, CompletedStroke> = new Map(); // strokes in progress, keyed by stroke id

  // Scoring per turn
  private turnGuesserPoints: number[] = [];
  private turnStartTime: number = 0;
  private turnEndTime: number = 0;

  // Replay
  private turnReplayOps: ReplayOp[] = [];
  private allTurnReplays: TurnReplay[] = [];

  // Ops count this turn (for abuse limit)
  private turnOpsCount: number = 0;

  // For persistence
  private persistCallback: ((room: Room) => void) | null = null;

  private nextJoinOrder: number = 0;

  constructor(roomId: string, persistCallback?: (room: Room) => void) {
    this.roomId = roomId;
    this.settings = {
      rounds: CONFIG.DEFAULT_ROUNDS,
      drawTime: CONFIG.DEFAULT_DRAW_TIME,
      wordListMode: 'default',
      customWords: [],
    };
    if (persistCallback) this.persistCallback = persistCallback;
  }

  // ── Persistence ──
  persist(): void {
    if (this.persistCallback) this.persistCallback(this);
  }

  toPersistedState(): PersistedRoom {
    return {
      roomId: this.roomId,
      settings: { ...this.settings },
      players: Array.from(this.players.values()).map(p => ({
        id: p.id, name: p.name, token: p.token,
        score: p.score, isHost: p.isHost, joinOrder: p.joinOrder,
      })),
      phase: this.phase,
      currentRound: this.currentRound,
      turnOrder: [...this.turnOrder],
      currentTurnIndex: this.currentTurnIndex,
      usedWords: [...this.usedWords],
    };
  }

  static fromPersisted(data: PersistedRoom, persistCallback?: (room: Room) => void): Room {
    const room = new Room(data.roomId, persistCallback);
    room.settings = data.settings;
    room.currentRound = data.currentRound;
    room.turnOrder = data.turnOrder;
    room.currentTurnIndex = data.currentTurnIndex;
    room.usedWords = data.usedWords;
    // Restored rooms come back in WAITING, not mid-turn
    room.phase = 'WAITING';
    for (const p of data.players) {
      room.players.set(p.id, {
        id: p.id, name: p.name, token: p.token,
        score: p.score, isHost: p.isHost,
        isConnected: false, hasGuessed: false,
        socket: null, joinOrder: p.joinOrder,
        violations: 0,
        chatBucket: new TokenBucket(CONFIG.CHAT_RATE),
        drawMsgBucket: new TokenBucket(CONFIG.DRAW_MSG_RATE),
        drawPointsBucket: new TokenBucket(CONFIG.DRAW_POINTS_RATE),
        disconnectTimer: null,
      });
      room.nextJoinOrder = Math.max(room.nextJoinOrder, p.joinOrder + 1);
    }
    return room;
  }

  // ── Player management ──

  addPlayer(name: string, socket: WebSocket, existingToken?: string): { player: Player; isReconnect: boolean } | null {
    // Check for reconnect with token
    if (existingToken) {
      for (const player of this.players.values()) {
        if (player.token === existingToken) {
          return { player: this.reconnectPlayer(player, socket, name), isReconnect: true };
        }
      }
    }

    // Gracefully reclaim session if disconnected player with same name rejoins
    const trimmedLowerName = name.trim().toLowerCase();
    for (const player of this.players.values()) {
      if (!player.isConnected && player.name.trim().toLowerCase() === trimmedLowerName) {
        return { player: this.reconnectPlayer(player, socket, name), isReconnect: true };
      }
    }

    if (this.players.size >= CONFIG.MAX_PLAYERS) return null;

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(16).toString('base64url');
    const isHost = this.players.size === 0;

    const player: Player = {
      id, name, token, score: 0,
      isHost, isConnected: true, hasGuessed: false,
      socket, joinOrder: this.nextJoinOrder++,
      violations: 0,
      chatBucket: new TokenBucket(CONFIG.CHAT_RATE),
      drawMsgBucket: new TokenBucket(CONFIG.DRAW_MSG_RATE),
      drawPointsBucket: new TokenBucket(CONFIG.DRAW_POINTS_RATE),
      disconnectTimer: null,
    };

    this.players.set(id, player);
    this.persist();
    return { player, isReconnect: false };
  }

  private reconnectPlayer(player: Player, socket: WebSocket, name: string): Player {
    // Close old socket if any
    if (player.socket && player.socket.readyState === WebSocket.OPEN) {
      player.socket.close(1000, 'Replaced by new connection');
    }

    // Cancel disconnect timer
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    // Cancel drawer leave timer if this is the drawer returning
    if (this.drawerLeaveTimer && player.id === this.currentDrawerId) {
      clearTimeout(this.drawerLeaveTimer);
      this.drawerLeaveTimer = null;
    }

    player.socket = socket;
    player.isConnected = true;
    player.name = name; // allow name update on reconnect
    player.violations = 0;

    // Notify others
    this.broadcast({ type: 'player_reconnected', playerId: player.id }, player.id);

    return player;
  }

  handleDisconnect(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    player.isConnected = false;
    player.socket = null;

    // Notify others
    this.broadcast({ type: 'player_disconnected', playerId });

    // Check if drawer left during relevant phases
    if (this.currentDrawerId === playerId) {
      if (this.phase === 'CHOOSING_WORD') {
        // Skip to next drawer immediately
        this.clearPhaseTimers();
        this.nextTurn();
        return;
      }
      if (this.phase === 'DRAWING') {
        // Give them a grace period
        this.drawerLeaveTimer = setTimeout(() => {
          this.drawerLeaveTimer = null;
          const drawer = this.players.get(playerId);
          if (drawer && !drawer.isConnected) {
            this.endTurn(true); // drawer abandoned
          }
        }, CONFIG.DRAWER_LEAVE_GRACE_MS);
      }
    }

    // Start disconnect grace timer
    player.disconnectTimer = setTimeout(() => {
      player.disconnectTimer = null;
      this.removePlayer(playerId);
    }, CONFIG.RECONNECT_GRACE_MS);

    // Check if we need to enter WAITING
    this.checkMinPlayers();

    // Check if everyone has guessed (since this player left)
    if (this.phase === 'DRAWING') {
      this.checkAllGuessed();
    }

    // Start empty room timer if nobody connected
    this.checkEmpty();
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    // Remove from turn order
    this.turnOrder = this.turnOrder.filter(id => id !== playerId);
    // Adjust currentTurnIndex if needed
    if (this.currentTurnIndex >= this.turnOrder.length && this.turnOrder.length > 0) {
      this.currentTurnIndex = 0;
    }

    // Keep in players map for final leaderboard, but mark disconnected
    player.isConnected = false;
    player.socket = null;

    // If host left, pass host
    if (player.isHost) {
      player.isHost = false;
      this.passHost();
    }

    // Notify
    this.broadcast({ type: 'player_left', playerId });
    this.persist();

    this.checkMinPlayers();
    this.checkEmpty();
  }

  private passHost(): void {
    // Pass to longest present connected player
    const connected = Array.from(this.players.values())
      .filter(p => p.isConnected)
      .sort((a, b) => a.joinOrder - b.joinOrder);

    if (connected.length > 0) {
      connected[0].isHost = true;
      this.broadcast({ type: 'host_changed', playerId: connected[0].id });
      this.persist();
    }
  }

  private checkMinPlayers(): void {
    const connected = this.getConnectedPlayers();
    if (connected.length < CONFIG.MIN_PLAYERS_TO_START &&
        (this.phase === 'DRAWING' || this.phase === 'CHOOSING_WORD' || this.phase === 'TURN_END')) {
      this.clearPhaseTimers();
      this.phase = 'WAITING';
      this.broadcast({
        type: 'phase_change',
        phase: 'WAITING',
      });
    }
  }

  private checkEmpty(): void {
    const connected = this.getConnectedPlayers();
    if (connected.length === 0) {
      if (!this.emptyRoomTimer) {
        this.emptyRoomTimer = setTimeout(() => {
          // Room will be cleaned up by the room manager
          this.emptyRoomTimer = null;
        }, CONFIG.ROOM_TTL_MS);
      }
    } else if (this.emptyRoomTimer) {
      clearTimeout(this.emptyRoomTimer);
      this.emptyRoomTimer = null;
    }
  }

  isExpired(): boolean {
    const connected = this.getConnectedPlayers();
    return connected.length === 0 && !this.emptyRoomTimer;
  }

  // ── Settings (host only, lobby only) ──

  updateSettings(playerId: string, partial: Partial<RoomSettings>): boolean {
    const player = this.players.get(playerId);
    if (!player || !player.isHost || this.phase !== 'LOBBY') return false;

    if (partial.rounds !== undefined) {
      this.settings.rounds = Math.max(CONFIG.MIN_ROUNDS, Math.min(CONFIG.MAX_ROUNDS, partial.rounds));
    }
    if (partial.drawTime !== undefined) {
      this.settings.drawTime = Math.max(CONFIG.MIN_DRAW_TIME, Math.min(CONFIG.MAX_DRAW_TIME, partial.drawTime));
    }
    if (partial.wordListMode !== undefined) {
      this.settings.wordListMode = partial.wordListMode;
    }
    if (partial.customWords !== undefined) {
      // Deduplicate, sanitize
      const words = [...new Set(
        partial.customWords
          .map(w => w.trim())
          .filter(w => w.length >= CONFIG.MIN_WORD_LENGTH && w.length <= CONFIG.MAX_WORD_LENGTH)
      )].slice(0, CONFIG.MAX_CUSTOM_WORDS);
      this.settings.customWords = words;
    }

    this.broadcast({ type: 'settings_updated', settings: this.settings });
    this.persist();
    return true;
  }

  // ── Game flow ──

  startGame(playerId: string): boolean {
    const player = this.players.get(playerId);
    if (!player || !player.isHost) return false;
    if (this.phase !== 'LOBBY' && this.phase !== 'GAME_END') return false;

    const connected = this.getConnectedPlayers();
    if (connected.length < CONFIG.MIN_PLAYERS_TO_START) return false;

    // Validate custom words if needed
    if (this.settings.wordListMode === 'custom' && this.settings.customWords.length < CONFIG.MIN_CUSTOM_WORDS) {
      return false;
    }

    // Reset game state
    this.currentRound = 1;
    this.usedWords = [];
    this.allTurnReplays = [];
    for (const p of this.players.values()) {
      p.score = 0;
      p.hasGuessed = false;
    }

    // Build turn order: connected players in join order
    this.turnOrder = connected
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map(p => p.id);
    this.currentTurnIndex = 0;

    this.persist();
    this.startChoosingWord();
    return true;
  }

  restartGame(playerId: string): boolean {
    const player = this.players.get(playerId);
    if (!player || !player.isHost) return false;

    const connected = this.getConnectedPlayers();
    if (connected.length < CONFIG.MIN_PLAYERS_TO_START) return false;

    // Validate custom words if needed
    if (this.settings.wordListMode === 'custom' && this.settings.customWords.length < CONFIG.MIN_CUSTOM_WORDS) {
      return false;
    }

    this.clearPhaseTimers();

    // Reset game state
    this.currentRound = 1;
    this.usedWords = [];
    this.allTurnReplays = [];
    this.currentWord = null;
    this.wordMask = null;
    this.drawSeq = 0;
    this.activeStack = [];
    this.opLog = [];
    this.currentStroke.clear();
    this.turnReplayOps = [];

    for (const p of this.players.values()) {
      p.score = 0;
      p.hasGuessed = false;
    }

    // Build turn order: connected players in join order
    this.turnOrder = connected
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map(p => p.id);
    this.currentTurnIndex = 0;

    this.broadcast({
      type: 'score_update',
      scores: this.getScoresMap(),
    });

    this.broadcast({
      type: 'chat',
      playerId: 'system',
      playerName: 'System',
      text: `${player.name} restarted the game!`,
      isSystem: true,
      isPrivate: false,
    });

    this.persist();
    this.startChoosingWord();
    return true;
  }

  returnToLobby(playerId: string): boolean {
    const player = this.players.get(playerId);
    if (!player || !player.isHost) return false;

    this.clearPhaseTimers();

    this.phase = 'LOBBY';
    this.currentDrawerId = null;
    this.currentWord = null;
    this.wordMask = null;
    this.currentRound = 1;
    this.drawSeq = 0;
    this.activeStack = [];
    this.opLog = [];
    this.currentStroke.clear();
    this.turnReplayOps = [];

    for (const p of this.players.values()) {
      p.score = 0;
      p.hasGuessed = false;
    }

    this.broadcast({
      type: 'phase_change',
      phase: 'LOBBY',
    });

    this.broadcast({
      type: 'score_update',
      scores: this.getScoresMap(),
    });

    this.broadcast({
      type: 'chat',
      playerId: 'system',
      playerName: 'System',
      text: `${player.name} returned the room to the lobby.`,
      isSystem: true,
      isPrivate: false,
    });

    this.persist();
    return true;
  }

  startNewGame(playerId: string): boolean {
    return this.restartGame(playerId);
  }

  private startChoosingWord(): void {
    // Find the next connected drawer
    let attempts = 0;
    while (attempts < this.turnOrder.length) {
      const drawerId = this.turnOrder[this.currentTurnIndex];
      const drawer = this.players.get(drawerId);
      if (drawer && drawer.isConnected) {
        this.currentDrawerId = drawerId;
        break;
      }
      // Skip disconnected
      this.currentTurnIndex = (this.currentTurnIndex + 1) % this.turnOrder.length;
      attempts++;

      // Check if we've gone through all players (new round)
      if (this.currentTurnIndex === 0 && attempts > 0) {
        this.currentRound++;
        if (this.currentRound > this.settings.rounds) {
          this.endGame();
          return;
        }
      }
    }

    if (attempts >= this.turnOrder.length) {
      // No connected players to draw
      this.phase = 'WAITING';
      this.broadcast({ type: 'phase_change', phase: 'WAITING' });
      return;
    }

    // Pick 3 word choices
    this.wordChoices = this.pickWordChoices(CONFIG.WORD_CHOICES);
    if (this.wordChoices.length === 0) {
      // No words left, end game
      this.endGame();
      return;
    }

    // Reset guess flags
    for (const p of this.players.values()) {
      p.hasGuessed = false;
    }

    this.phase = 'CHOOSING_WORD';
    const endsAt = Date.now() + CONFIG.CHOOSING_TIME * 1000;

    // Broadcast phase change (word choices only to drawer)
    this.broadcastExcept(this.currentDrawerId!, {
      type: 'phase_change',
      phase: 'CHOOSING_WORD',
      drawerId: this.currentDrawerId!,
      drawerName: this.players.get(this.currentDrawerId!)!.name,
      endsAt,
      currentRound: this.currentRound,
    });

    this.sendTo(this.currentDrawerId!, {
      type: 'phase_change',
      phase: 'CHOOSING_WORD',
      drawerId: this.currentDrawerId!,
      drawerName: this.players.get(this.currentDrawerId!)!.name,
      wordChoices: this.wordChoices,
      endsAt,
      currentRound: this.currentRound,
    });

    // Timer: auto pick if drawer doesn't choose
    this.phaseTimer = setTimeout(() => {
      this.phaseTimer = null;
      if (this.phase === 'CHOOSING_WORD') {
        // Server picks a word
        const word = this.wordChoices[Math.floor(Math.random() * this.wordChoices.length)];
        this.startDrawing(word);
      }
    }, CONFIG.CHOOSING_TIME * 1000);
  }

  chooseWord(playerId: string, word: string): boolean {
    if (this.phase !== 'CHOOSING_WORD') return false;
    if (playerId !== this.currentDrawerId) return false;
    const match = this.wordChoices.find(w => w.trim().toLowerCase() === word.trim().toLowerCase());
    if (!match) return false;

    this.clearPhaseTimers();
    this.startDrawing(match);
    return true;
  }

  private startDrawing(word: string): void {
    this.currentWord = word;
    this.usedWords.push(word);
    this.wordMask = generateMask(word);
    this.phase = 'DRAWING';
    this.guessOrder = 0;
    this.turnGuesserPoints = [];
    this.turnOpsCount = 0;
    this.turnStartTime = Date.now();
    this.turnEndTime = Date.now() + this.settings.drawTime * 1000;
    this.drawSeq = 0;
    this.activeStack = [];
    this.opLog = [];
    this.currentStroke.clear();
    this.turnReplayOps = [];

    // Reset guess flags
    for (const p of this.players.values()) {
      p.hasGuessed = false;
    }

    const endsAt = this.turnEndTime;

    // Send phase to everyone except drawer
    this.broadcastExcept(this.currentDrawerId!, {
      type: 'phase_change',
      phase: 'DRAWING',
      drawerId: this.currentDrawerId!,
      drawerName: this.players.get(this.currentDrawerId!)!.name,
      wordMask: this.wordMask,
      endsAt,
      currentRound: this.currentRound,
    });

    // Send to drawer (they see the actual word)
    this.sendTo(this.currentDrawerId!, {
      type: 'phase_change',
      phase: 'DRAWING',
      drawerId: this.currentDrawerId!,
      drawerName: this.players.get(this.currentDrawerId!)!.name,
      wordMask: this.wordMask,
      endsAt,
      currentRound: this.currentRound,
      word: this.currentWord,
    });

    // Set draw timer
    this.phaseTimer = setTimeout(() => {
      this.phaseTimer = null;
      if (this.phase === 'DRAWING') {
        this.endTurn(false);
      }
    }, this.settings.drawTime * 1000);

    // Set hint timers
    const letterCount = word.split('').filter(ch => /[a-zA-Z0-9]/.test(ch)).length;
    const schedule = computeHintSchedule(letterCount);
    for (const hint of schedule) {
      const delay = hint.fraction * this.settings.drawTime * 1000;
      const timer = setTimeout(() => {
        if (this.phase === 'DRAWING' && this.currentWord === word) {
          this.wordMask = revealHint(word, this.wordMask!, hint.count);
          // Send hint to everyone except the drawer
          this.broadcastExcept(this.currentDrawerId!, {
            type: 'hint_update',
            wordMask: this.wordMask!,
          });
        }
      }, delay);
      this.hintTimers.push(timer);
    }
  }

  // ── Drawing ops ──

  handleDrawOp(playerId: string, op: DrawOp): boolean {
    if (this.phase !== 'DRAWING') return false;
    if (playerId !== this.currentDrawerId) return false;

    this.turnOpsCount++;
    if (this.turnOpsCount > CONFIG.MAX_OPS_PER_TURN) return false;

    const seq = ++this.drawSeq;
    const seqOp: SeqDrawOp = { seq, op };
    this.opLog.push(seqOp);

    // Record for replay
    this.turnReplayOps.push({
      op,
      offsetMs: Date.now() - this.turnStartTime,
    });

    // Update active stack based on op type
    switch (op.type) {
      case 'stroke_start': {
        const stroke: CompletedStroke = {
          type: 'stroke',
          id: op.id,
          tool: op.tool,
          color: op.color,
          size: op.size,
          points: [op.point],
        };
        this.currentStroke.set(op.id, stroke);
        break;
      }
      case 'stroke_points': {
        const stroke = this.currentStroke.get(op.id);
        if (stroke) {
          // Check total points limit
          if (stroke.points.length + op.points.length > CONFIG.MAX_POINTS_PER_STROKE) {
            return false;
          }
          stroke.points.push(...op.points);
        }
        break;
      }
      case 'stroke_end': {
        const stroke = this.currentStroke.get(op.id);
        if (stroke) {
          this.currentStroke.delete(op.id);
          this.activeStack.push(stroke);
        }
        break;
      }
      case 'fill': {
        this.activeStack.push(op);
        break;
      }
      case 'undo': {
        if (this.activeStack.length > 0) {
          this.activeStack.pop();
        }
        // Broadcast authoritative snapshot to all clients so everyone clears and redraws identically
        this.broadcast({
          type: 'snapshot',
          items: this.activeStack,
          nextSeq: this.drawSeq + 1,
        });
        return true;
      }
      case 'clear': {
        this.activeStack = [];
        this.broadcast({
          type: 'draw_op',
          seq,
          op,
        });
        return true;
      }
    }

    // Broadcast to everyone except drawer (drawer already rendered optimistically)
    this.broadcastExcept(playerId, {
      type: 'draw_op',
      seq,
      op,
    });

    return true;
  }

  handleResync(playerId: string, lastSeq: number): void {
    if (lastSeq >= this.drawSeq) return; // up to date

    // If requesting from scratch (0) or too far behind (>100 ops), send snapshot
    const missingOps = this.opLog.filter(o => o.seq > lastSeq);
    if (lastSeq === 0 || missingOps.length > 100) {
      this.sendTo(playerId, {
        type: 'snapshot',
        items: this.activeStack,
        nextSeq: this.drawSeq + 1,
      });
    } else {
      this.sendTo(playerId, {
        type: 'resync',
        ops: missingOps,
      });
    }
  }

  // ── Guessing and chat ──

  handleChat(playerId: string, text: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    // During DRAWING, non-drawer chat is a guess
    if (this.phase === 'DRAWING' && playerId !== this.currentDrawerId) {
      // If already guessed, route to private channel
      if (player.hasGuessed) {
        this.sendToGuessedAndDrawer({
          type: 'guessed_chat',
          playerId: player.id,
          playerName: player.name,
          text,
        });
        return;
      }

      // Check guess
      const normalizedGuess = normalizeGuess(text);
      const normalizedWord = normalizeGuess(this.currentWord!);

      if (normalizedGuess === normalizedWord) {
        // Correct guess
        const remaining = this.turnEndTime - Date.now();
        const total = this.settings.drawTime * 1000;
        const points = computeGuesserPoints(remaining, total, this.guessOrder);
        this.guessOrder++;

        player.score += points;
        player.hasGuessed = true;
        this.turnGuesserPoints.push(points);

        // Broadcast correct guess (never the word text)
        this.broadcast({
          type: 'correct_guess',
          playerId: player.id,
          playerName: player.name,
        });

        // Update scores
        this.broadcast({
          type: 'score_update',
          scores: this.getScoresMap(),
        });

        this.persist();
        this.checkAllGuessed();
        return;
      }

      // Near miss check
      if (isNearMiss(text, this.currentWord!)) {
        this.sendTo(playerId, { type: 'near_miss' });
        // Don't broadcast the text
        return;
      }

      // Wrong guess: show as normal chat
      this.broadcast({
        type: 'chat',
        playerId: player.id,
        playerName: player.name,
        text,
        isSystem: false,
        isPrivate: false,
      });
      return;
    }

    // Drawer: block if text contains the word
    if (this.phase === 'DRAWING' && playerId === this.currentDrawerId && this.currentWord) {
      const normalizedText = normalizeGuess(text);
      const normalizedWord = normalizeGuess(this.currentWord);
      if (normalizedText.includes(normalizedWord)) {
        this.sendTo(playerId, {
          type: 'chat',
          playerId: 'system',
          playerName: 'System',
          text: 'Your message was blocked because it contains the word.',
          isSystem: true,
          isPrivate: true,
        });
        return;
      }
      // Drawer messages go to the guessed channel
      this.sendToGuessedAndDrawer({
        type: 'guessed_chat',
        playerId: player.id,
        playerName: player.name,
        text,
      });
      return;
    }

    // Outside drawing phase: normal public chat
    this.broadcast({
      type: 'chat',
      playerId: player.id,
      playerName: player.name,
      text,
      isSystem: false,
      isPrivate: false,
    });
  }

  private checkAllGuessed(): void {
    if (this.phase !== 'DRAWING') return;
    const nonDrawers = Array.from(this.players.values()).filter(
      p => p.isConnected && p.id !== this.currentDrawerId
    );
    if (nonDrawers.length === 0) return;
    if (nonDrawers.every(p => p.hasGuessed)) {
      this.clearPhaseTimers();
      this.endTurn(false);
    }
  }

  // ── Turn end ──

  private endTurn(drawerAbandoned: boolean): void {
    this.clearPhaseTimers();

    // Calculate drawer points
    const drawerId = this.currentDrawerId;
    if (drawerId && !drawerAbandoned) {
      const drawer = this.players.get(drawerId);
      if (drawer) {
        drawer.score += computeDrawerPoints(this.turnGuesserPoints);
      }
    }

    // Archive replay
    if (this.currentDrawerId && this.currentWord) {
      const drawer = this.players.get(this.currentDrawerId);
      this.allTurnReplays.push({
        drawerId: this.currentDrawerId,
        drawerName: drawer ? drawer.name : 'Unknown',
        word: this.currentWord,
        ops: [...this.turnReplayOps],
      });
    }

    this.phase = 'TURN_END';

    // Broadcast turn end with word reveal and scores
    this.broadcast({
      type: 'phase_change',
      phase: 'TURN_END',
      word: this.currentWord!,
      drawerId: this.currentDrawerId || undefined,
    });
    this.broadcast({
      type: 'score_update',
      scores: this.getScoresMap(),
    });

    this.persist();

    // After display time, next turn
    this.phaseTimer = setTimeout(() => {
      this.phaseTimer = null;
      this.nextTurn();
    }, CONFIG.TURN_END_DISPLAY_TIME);
  }

  private nextTurn(): void {
    this.currentTurnIndex++;

    // Check if round is done
    if (this.currentTurnIndex >= this.turnOrder.length) {
      this.currentTurnIndex = 0;
      this.currentRound++;
      if (this.currentRound > this.settings.rounds) {
        this.endGame();
        return;
      }
      // Rebuild turn order to include newly joined players
      const connected = this.getConnectedPlayers();
      this.turnOrder = connected
        .sort((a, b) => a.joinOrder - b.joinOrder)
        .map(p => p.id);
    }

    this.startChoosingWord();
  }

  private endGame(): void {
    this.clearPhaseTimers();
    this.phase = 'GAME_END';
    this.currentDrawerId = null;
    this.currentWord = null;

    this.broadcast({
      type: 'phase_change',
      phase: 'GAME_END',
      turnReplays: this.allTurnReplays,
    });
    this.broadcast({
      type: 'score_update',
      scores: this.getScoresMap(),
    });

    this.persist();
  }

  // ── Resume from WAITING ──
  checkResumeFromWaiting(): void {
    if (this.phase !== 'WAITING') return;
    const connected = this.getConnectedPlayers();
    if (connected.length >= CONFIG.MIN_PLAYERS_TO_START) {
      // Resume: abandon current turn, start next
      this.startChoosingWord();
    }
  }

  // ── Helpers ──

  getConnectedPlayers(): Player[] {
    return Array.from(this.players.values()).filter(p => p.isConnected);
  }

  private getScoresMap(): Record<string, number> {
    const scores: Record<string, number> = {};
    for (const p of this.players.values()) {
      scores[p.id] = p.score;
    }
    return scores;
  }

  getPlayerInfoList(): PlayerInfo[] {
    return Array.from(this.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      isHost: p.isHost,
      isConnected: p.isConnected,
      hasGuessed: p.hasGuessed,
    }));
  }

  getRoomState(): RoomState {
    return {
      roomId: this.roomId,
      phase: this.phase,
      settings: this.settings,
      players: this.getPlayerInfoList(),
      currentRound: this.currentRound,
      totalRounds: this.settings.rounds,
      currentDrawerId: this.currentDrawerId,
      wordMask: this.wordMask,
      endsAt: this.phase === 'DRAWING' ? this.turnEndTime :
              this.phase === 'CHOOSING_WORD' ? Date.now() + CONFIG.CHOOSING_TIME * 1000 : null,
      turnReplays: this.phase === 'GAME_END' ? this.allTurnReplays : [],
    };
  }

  private pickWordChoices(count: number): string[] {
    const wordPool = this.getWordPool();
    const available = wordPool.filter(w => !this.usedWords.includes(w));
    if (available.length === 0) return [];

    // Fisher-Yates shuffle on a copy, pick first `count`
    const shuffled = [...available];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }

  private getWordPool(): string[] {
    switch (this.settings.wordListMode) {
      case 'custom':
        return this.settings.customWords;
      case 'mix':
        return [...DEFAULT_WORDS, ...this.settings.customWords];
      case 'default':
      default:
        return DEFAULT_WORDS;
    }
  }

  // ── Messaging ──

  sendTo(playerId: string, msg: ServerMessage): void {
    const player = this.players.get(playerId);
    if (!player || !player.socket || player.socket.readyState !== WebSocket.OPEN) return;
    try {
      const data = JSON.stringify(msg);
      this.sendRaw(player, data, Buffer.byteLength(data), msg.type === 'draw_op');
    } catch {
      // Socket error, will be handled by close event
    }
  }

  private sendRaw(player: Player, data: string, dataLen: number, isDrawOp: boolean): void {
    if (!player.socket || player.socket.readyState !== WebSocket.OPEN) return;
    try {
      // Backpressure check
      if (player.socket.bufferedAmount > 64 * 1024) {
        // Skip non-critical messages for slow clients
        if (isDrawOp) {
          serverMetrics.slowClientDrops++;
          return;
        }
      }
      player.socket.send(data);
      serverMetrics.messagesSent++;
      serverMetrics.bytesSent += dataLen;
    } catch {
      // Socket error, will be handled by close event
    }
  }

  broadcast(msg: ServerMessage, excludeId?: string): void {
    const data = JSON.stringify(msg);
    const dataLen = Buffer.byteLength(data);
    const isDrawOp = msg.type === 'draw_op';
    for (const player of this.players.values()) {
      if (player.id === excludeId) continue;
      this.sendRaw(player, data, dataLen, isDrawOp);
    }
  }

  broadcastExcept(excludeId: string, msg: ServerMessage): void {
    this.broadcast(msg, excludeId);
  }

  private sendToGuessedAndDrawer(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    const dataLen = Buffer.byteLength(data);
    const isDrawOp = msg.type === 'draw_op';
    for (const player of this.players.values()) {
      if (player.hasGuessed || player.id === this.currentDrawerId) {
        this.sendRaw(player, data, dataLen, isDrawOp);
      }
    }
  }

  // ── Canvas snapshot for late joiners ──

  getCanvasSnapshot(): { items: CanvasItem[]; nextSeq: number } {
    return {
      items: [...this.activeStack],
      nextSeq: this.drawSeq + 1,
    };
  }

  // ── Cleanup ──

  private clearPhaseTimers(): void {
    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
    for (const t of this.hintTimers) {
      clearTimeout(t);
    }
    this.hintTimers = [];
    if (this.drawerLeaveTimer) {
      clearTimeout(this.drawerLeaveTimer);
      this.drawerLeaveTimer = null;
    }
  }

  destroy(): void {
    this.clearPhaseTimers();
    if (this.emptyRoomTimer) {
      clearTimeout(this.emptyRoomTimer);
      this.emptyRoomTimer = null;
    }
    for (const player of this.players.values()) {
      if (player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
      }
      if (player.socket && player.socket.readyState === WebSocket.OPEN) {
        player.socket.close(1000, 'Room closed');
      }
    }
  }
}

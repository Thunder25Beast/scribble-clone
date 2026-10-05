// Shared types used by both server and client.
// The server is the authority: clients display and send inputs, nothing more.

// ── Game phases ──
export type GamePhase = 'LOBBY' | 'CHOOSING_WORD' | 'DRAWING' | 'TURN_END' | 'GAME_END' | 'WAITING';

// ── Drawing operations ──
export interface Point {
  x: number;
  y: number;
}

export interface StrokeStartOp {
  type: 'stroke_start';
  id: string;
  tool: 'pen' | 'eraser';
  color: string;
  size: number;
  point: Point;
  t?: number;
}

export interface StrokePointsOp {
  type: 'stroke_points';
  id: string;
  points: Point[];
  t?: number;
}

export interface StrokeEndOp {
  type: 'stroke_end';
  id: string;
  t?: number;
}

export interface FillOp {
  type: 'fill';
  id: string;
  x: number;
  y: number;
  color: string;
}

export interface UndoOp {
  type: 'undo';
}

export interface ClearOp {
  type: 'clear';
}

export type DrawOp = StrokeStartOp | StrokePointsOp | StrokeEndOp | FillOp | UndoOp | ClearOp;

// A sequenced drawing op as broadcast by the server
export interface SeqDrawOp {
  seq: number;
  op: DrawOp;
}

// A complete stroke for snapshots and replay
export interface CompletedStroke {
  type: 'stroke';
  id: string;
  tool: 'pen' | 'eraser';
  color: string;
  size: number;
  points: Point[];
}

// Active stack item: either a completed stroke or a fill
export type CanvasItem = CompletedStroke | FillOp;

// ── Replay ──
export interface ReplayOp {
  op: DrawOp;
  offsetMs: number; // ms from turn start
}

export interface TurnReplay {
  drawerId: string;
  drawerName: string;
  word: string;
  ops: ReplayOp[];
}

// ── Player info (sent to clients) ──
export interface PlayerInfo {
  id: string;
  name: string;
  score: number;
  isHost: boolean;
  isConnected: boolean;
  hasGuessed: boolean;
}

// ── Room settings ──
export type WordListMode = 'default' | 'custom' | 'mix';

export interface RoomSettings {
  rounds: number;
  drawTime: number;
  wordListMode: WordListMode;
  customWords: string[];
}

// ── Room state sent to clients ──
export interface RoomState {
  roomId: string;
  phase: GamePhase;
  settings: RoomSettings;
  players: PlayerInfo[];
  currentRound: number;
  totalRounds: number;
  currentDrawerId: string | null;
  wordMask: string | null;
  endsAt: number | null; // server timestamp when current phase ends
  turnReplays: TurnReplay[]; // populated at GAME_END
}

// ── Messages: Client to Server ──

export interface C2S_Join {
  type: 'join';
  roomId: string;
  name: string;
  token?: string; // for reconnect
}

export interface C2S_UpdateSettings {
  type: 'update_settings';
  settings: Partial<RoomSettings>;
}

export interface C2S_StartGame {
  type: 'start_game';
}

export interface C2S_ChooseWord {
  type: 'choose_word';
  word: string;
}

export interface C2S_DrawOp {
  type: 'draw_op';
  op: DrawOp;
}

export interface C2S_Chat {
  type: 'chat';
  text: string;
}

export interface C2S_Ping {
  type: 'ping';
  t0: number;
}

export interface C2S_Resync {
  type: 'resync';
  lastSeq: number;
}

export interface C2S_NewGame {
  type: 'new_game';
}

export interface C2S_RestartGame {
  type: 'restart_game';
}

export interface C2S_ReturnToLobby {
  type: 'return_to_lobby';
}

export type ClientMessage =
  | C2S_Join
  | C2S_UpdateSettings
  | C2S_StartGame
  | C2S_ChooseWord
  | C2S_DrawOp
  | C2S_Chat
  | C2S_Ping
  | C2S_Resync
  | C2S_NewGame
  | C2S_RestartGame
  | C2S_ReturnToLobby;

// ── Messages: Server to Client ──

export interface S2C_Joined {
  type: 'joined';
  playerId: string;
  token: string;
  state: RoomState;
}

export interface S2C_Error {
  type: 'error';
  message: string;
}

export interface S2C_PlayerJoined {
  type: 'player_joined';
  player: PlayerInfo;
}

export interface S2C_PlayerLeft {
  type: 'player_left';
  playerId: string;
}

export interface S2C_PlayerDisconnected {
  type: 'player_disconnected';
  playerId: string;
}

export interface S2C_PlayerReconnected {
  type: 'player_reconnected';
  playerId: string;
}

export interface S2C_HostChanged {
  type: 'host_changed';
  playerId: string;
}

export interface S2C_SettingsUpdated {
  type: 'settings_updated';
  settings: RoomSettings;
}

export interface S2C_PhaseChange {
  type: 'phase_change';
  phase: GamePhase;
  drawerId?: string;
  drawerName?: string;
  wordMask?: string;
  endsAt?: number;
  currentRound?: number;
  wordChoices?: string[]; // only sent to the drawer during CHOOSING_WORD
  word?: string; // revealed at TURN_END
  turnReplays?: TurnReplay[]; // at GAME_END
}

export interface S2C_DrawOp {
  type: 'draw_op';
  seq: number;
  op: DrawOp;
}

export interface S2C_Snapshot {
  type: 'snapshot';
  items: CanvasItem[];
  nextSeq: number;
}

export interface S2C_Resync {
  type: 'resync';
  ops: SeqDrawOp[];
}

export interface S2C_Chat {
  type: 'chat';
  playerId: string;
  playerName: string;
  text: string;
  isSystem: boolean;
  isPrivate: boolean;
}

export interface S2C_CorrectGuess {
  type: 'correct_guess';
  playerId: string;
  playerName: string;
}

export interface S2C_NearMiss {
  type: 'near_miss';
  text?: string;
}

export interface S2C_HintUpdate {
  type: 'hint_update';
  wordMask: string;
}

export interface S2C_ScoreUpdate {
  type: 'score_update';
  scores: Record<string, number>;
}

export interface S2C_Pong {
  type: 'pong';
  t0: number;
  serverTime: number;
}

export interface S2C_GuessedChat {
  type: 'guessed_chat';
  playerId: string;
  playerName: string;
  text: string;
}

export type ServerMessage =
  | S2C_Joined
  | S2C_Error
  | S2C_PlayerJoined
  | S2C_PlayerLeft
  | S2C_PlayerDisconnected
  | S2C_PlayerReconnected
  | S2C_HostChanged
  | S2C_SettingsUpdated
  | S2C_PhaseChange
  | S2C_DrawOp
  | S2C_Snapshot
  | S2C_Resync
  | S2C_Chat
  | S2C_CorrectGuess
  | S2C_NearMiss
  | S2C_HintUpdate
  | S2C_ScoreUpdate
  | S2C_Pong
  | S2C_GuessedChat;

// All tuneable limits in one place. Every value is a hard constant on the server.
// The client may read these for display, but the server enforces them.

export const CONFIG = {
  // Server
  PORT: parseInt(process.env.PORT || '3000', 10),
  STATE_DIR: process.env.STATE_DIR || './state',

  // Room
  MAX_PLAYERS: 12,
  ROOM_ID_LENGTH: 8, // URL-safe base64 chars
  ROOM_TTL_MS: 5 * 60 * 1000, // empty room cleanup: 5 minutes
  MIN_PLAYERS_TO_START: 2,

  // Game settings bounds
  MIN_ROUNDS: 1,
  MAX_ROUNDS: 10,
  DEFAULT_ROUNDS: 3,
  MIN_DRAW_TIME: 30,
  MAX_DRAW_TIME: 180,
  DEFAULT_DRAW_TIME: 80,
  CHOOSING_TIME: parseInt(process.env.CHOOSING_TIME || '15', 10), // seconds to pick a word
  TURN_END_DISPLAY_TIME: parseInt(process.env.TURN_END_DISPLAY_TIME || '5000', 10), // ms to show scores between turns
  WORD_CHOICES: 3,

  // Word list
  MIN_CUSTOM_WORDS: 10,
  MAX_CUSTOM_WORDS: 1000,
  MIN_WORD_LENGTH: 2,
  MAX_WORD_LENGTH: 30,

  // Player
  MIN_NAME_LENGTH: 1,
  MAX_NAME_LENGTH: 20,
  RECONNECT_GRACE_MS: parseInt(process.env.RECONNECT_GRACE_MS || '30000', 10), // 30 seconds
  DRAWER_LEAVE_GRACE_MS: parseInt(process.env.DRAWER_LEAVE_GRACE_MS || '5000', 10), // 5 seconds before skipping drawer

  // Scoring
  MAX_GUESS_POINTS: 500,
  MIN_GUESS_POINTS: 50,
  EARLY_BONUS: [50, 30, 10] as readonly number[], // 1st, 2nd, 3rd correct
  DRAWER_POINTS_FRACTION: 0.5, // drawer gets half the avg guesser points per correct guess
  MAX_DRAWER_POINTS: 500,

  // Hints: reveal at these fractions of draw time, never more than ~half letters
  HINT_FRACTIONS: [0.4, 0.6, 0.8],

  // Canvas
  CANVAS_WIDTH: 800,
  CANVAS_HEIGHT: 600,

  // Rate limits (token bucket)
  CHAT_RATE: { tokens: 5, intervalMs: 3000 },
  DRAW_MSG_RATE: { tokens: 300, intervalMs: 1000 },
  DRAW_POINTS_RATE: { tokens: 10000, intervalMs: 1000 },
  JOIN_RATE_PER_IP: { tokens: parseInt(process.env.JOIN_RATE_LIMIT || '10', 10), intervalMs: 60000 },
  ROOM_CREATE_RATE_PER_IP: { tokens: parseInt(process.env.ROOM_CREATE_RATE_LIMIT || '5', 10), intervalMs: 60000 },

  // Hard limits
  MAX_WS_PAYLOAD: 16 * 1024, // 16 KB
  MAX_CHAT_LENGTH: 200,
  MAX_POINTS_PER_STROKE_MSG: 200,
  MAX_POINTS_PER_STROKE: 5000,
  MAX_OPS_PER_TURN: 3000,
  MAX_BRUSH_SIZE: 40,
  MIN_BRUSH_SIZE: 2,
  HEX_COLOR_REGEX: /^#[0-9a-fA-F]{6}$/,

  // Abuse
  VIOLATION_DISCONNECT_THRESHOLD: 20,

  // Near miss edit distance thresholds
  NEAR_MISS_SHORT_THRESHOLD: 1, // words <= 5 chars: edit distance 1
  NEAR_MISS_LONG_THRESHOLD: 2,  // words > 5 chars: edit distance 2
  NEAR_MISS_WORD_LENGTH_BOUNDARY: 5,

  // Persistence
  PERSIST_DEBOUNCE_MS: 500,
} as const;

import { z } from 'zod';
import { CONFIG } from './config.js';

// ── Drawing op schemas ──

const pointSchema = z.object({
  x: z.number().int().min(0).max(CONFIG.CANVAS_WIDTH),
  y: z.number().int().min(0).max(CONFIG.CANVAS_HEIGHT),
});

const strokeStartSchema = z.object({
  type: z.literal('stroke_start'),
  id: z.string().min(1).max(36),
  tool: z.enum(['pen', 'eraser']),
  color: z.string().regex(CONFIG.HEX_COLOR_REGEX),
  size: z.number().int().min(CONFIG.MIN_BRUSH_SIZE).max(CONFIG.MAX_BRUSH_SIZE),
  point: pointSchema,
  t: z.number().optional(),
});

const strokePointsSchema = z.object({
  type: z.literal('stroke_points'),
  id: z.string().min(1).max(36),
  points: z.array(pointSchema).min(1).max(CONFIG.MAX_POINTS_PER_STROKE_MSG),
  t: z.number().optional(),
});

const strokeEndSchema = z.object({
  type: z.literal('stroke_end'),
  id: z.string().min(1).max(36),
  t: z.number().optional(),
});

const fillOpSchema = z.object({
  type: z.literal('fill'),
  id: z.string().min(1).max(36),
  x: z.number().int().min(0).max(CONFIG.CANVAS_WIDTH),
  y: z.number().int().min(0).max(CONFIG.CANVAS_HEIGHT),
  color: z.string().regex(CONFIG.HEX_COLOR_REGEX),
});

const undoSchema = z.object({ type: z.literal('undo') });
const clearSchema = z.object({ type: z.literal('clear') });

export const drawOpSchema = z.discriminatedUnion('type', [
  strokeStartSchema,
  strokePointsSchema,
  strokeEndSchema,
  fillOpSchema,
  undoSchema,
  clearSchema,
]);

// ── Client message schemas ──

const joinSchema = z.object({
  type: z.literal('join'),
  roomId: z.string().min(1).max(20),
  name: z.string().min(CONFIG.MIN_NAME_LENGTH).max(CONFIG.MAX_NAME_LENGTH),
  token: z.string().optional(),
});

const updateSettingsSchema = z.object({
  type: z.literal('update_settings'),
  settings: z.object({
    rounds: z.number().int().min(CONFIG.MIN_ROUNDS).max(CONFIG.MAX_ROUNDS).optional(),
    drawTime: z.number().int().min(CONFIG.MIN_DRAW_TIME).max(CONFIG.MAX_DRAW_TIME).optional(),
    wordListMode: z.enum(['default', 'custom', 'mix']).optional(),
    customWords: z.array(
      z.string().min(CONFIG.MIN_WORD_LENGTH).max(CONFIG.MAX_WORD_LENGTH)
    ).max(CONFIG.MAX_CUSTOM_WORDS).optional(),
  }),
});

const startGameSchema = z.object({
  type: z.literal('start_game'),
});

const chooseWordSchema = z.object({
  type: z.literal('choose_word'),
  word: z.string().min(CONFIG.MIN_WORD_LENGTH).max(CONFIG.MAX_WORD_LENGTH),
});

const drawOpMsgSchema = z.object({
  type: z.literal('draw_op'),
  op: drawOpSchema,
});

const chatSchema = z.object({
  type: z.literal('chat'),
  text: z.string().min(1).max(CONFIG.MAX_CHAT_LENGTH),
});

const pingSchema = z.object({
  type: z.literal('ping'),
  t0: z.number(),
});

const resyncSchema = z.object({
  type: z.literal('resync'),
  lastSeq: z.number().int().min(0),
});

const newGameSchema = z.object({
  type: z.literal('new_game'),
});

const restartGameSchema = z.object({
  type: z.literal('restart_game'),
});

const returnToLobbySchema = z.object({
  type: z.literal('return_to_lobby'),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  joinSchema,
  updateSettingsSchema,
  startGameSchema,
  chooseWordSchema,
  drawOpMsgSchema,
  chatSchema,
  pingSchema,
  resyncSchema,
  newGameSchema,
  restartGameSchema,
  returnToLobbySchema,
]);

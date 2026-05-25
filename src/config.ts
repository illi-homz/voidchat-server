// src/config.ts — конфигурация и константы сервера

export const PORT = parseInt(process.env.PORT || '9001', 10);

export const STARTED_AT = Date.now();

// TURN
export const TURN_HOST = process.env.TURN_HOST || '';
export const TURN_USERNAME = process.env.TURN_USERNAME || '';
export const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';

// Лимиты валидации
export const MAX_CIPHERTEXT_LENGTH = 65536;
export const MAX_NONCE_LENGTH = 128;
export const MAX_SDP_LENGTH = 65536;
export const MAX_USER_ID_LENGTH = 128;
export const MAX_PUBLIC_KEY_LENGTH = 4096;

// Лимиты очередей
export const MAX_PENDING_MESSAGES = 1000;
export const MAX_PENDING_FRIEND_REQUESTS = 500;

// Лимиты rate-limiting
export const RATE_LIMIT_WINDOW_MS = 1000;
export const RATE_LIMIT_MAX_REQUESTS = 30;
export const CALL_OFFER_RATE_LIMIT_WINDOW_MS = 1000;
export const CALL_OFFER_RATE_LIMIT_MAX = 1;

// Таймауты
export const PRESENCE_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут
export const PRESENCE_CLEANUP_INTERVAL_MS = 60000; // 60 секунд
export const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60000;
export const CALL_TIMEOUT_MS = 60000; // 60 секунд
export const PENDING_CALL_OFFER_TTL_MS = 60000;

// Socket.IO
export const SOCKET_IO_PING_INTERVAL = 25000;
export const SOCKET_IO_PING_TIMEOUT = 20000;

// Graceful shutdown
export const SHUTDOWN_FORCE_EXIT_MS = 10000;

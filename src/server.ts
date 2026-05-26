import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Server } from 'socket.io';
import {
	PORT,
	STARTED_AT,
	TURN_HOST,
	TURN_USERNAME,
	TURN_CREDENTIAL,
	RATE_LIMIT_CLEANUP_INTERVAL_MS,
	PRESENCE_CLEANUP_INTERVAL_MS,
	SOCKET_IO_PING_INTERVAL,
	SOCKET_IO_PING_TIMEOUT,
} from './config.js';
import { users, activeCalls, userActiveCall, rateLimitMap } from './state.js';
import { cleanupCall, cleanupPresence, gracefulShutdown as _gracefulShutdown } from './utils.js';
import { setupRegisterHandlers } from './handlers/register.js';
import { setupMessageHandlers } from './handlers/messages.js';
import { setupFriendHandlers } from './handlers/friends.js';
import { setupCallHandlers } from './handlers/calls.js';
import {
	metricsEnabled,
	initMetrics,
	metricsHandler,
	incError,
	updateConnections,
	stopMetrics,
} from './metrics.js';
import { initSentry, captureError } from './sentry.js';
import { logger } from './logger.js';

if (TURN_HOST) {
	logger.info({ turn: { host: TURN_HOST, port: 3478 } }, 'TURN relay configured');
} else {
	logger.info(
		'TURN not configured — STUN-only mode (set TURN_HOST env var for relay across NAT)',
	);
}

export { checkRateLimit, cleanupCall, cleanupPresence } from './utils.js';

// ---------------------------------------------------------------------------
// createApp — основная фабрика сервера
// ---------------------------------------------------------------------------

export function createApp(httpServer: import('http').Server) {
	// ---- HTTP-хендлеры (health-check + TURN-config + 404) ----

	httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
		// Health-check: GET / возвращает JSON-статус
		if (req.url === '/' && req.method === 'GET') {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
			});
			res.end(
				JSON.stringify({
					status: 'ok',
					uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
					connections: io.engine.clientsCount,
					timestamp: new Date().toISOString(),
				}),
			);
			return;
		}

		// TURN-конфигурация для WebRTC
		if (req.url === '/turn-config' && req.method === 'GET') {
			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
			});
			// prettier-ignore
			res.end(
				// prettier-ignore
				JSON.stringify(
					TURN_HOST
						? {
							// prettier-ignore
							urls: [`turn:${TURN_HOST}:3478`, `turn:${TURN_HOST}:3478?transport=tcp`],
							username: TURN_USERNAME,
							credential: TURN_CREDENTIAL,
						}
						: null,
				),
			);
			return;
		}

		// Prometheus-метрики (только если METRICS_ENABLED=true)
		if (req.url === '/metrics' && req.method === 'GET' && metricsEnabled) {
			metricsHandler(req, res);
			return;
		}

		// Все остальные запросы — 404
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not found');
	});

	// ---- Socket.IO ----

	const io = new Server(httpServer, {
		cors: {
			origin: '*',
			methods: ['GET', 'POST'],
		},
		pingInterval: SOCKET_IO_PING_INTERVAL,
		pingTimeout: SOCKET_IO_PING_TIMEOUT,
	});

	// ---- Очистка rate-limit (раз в 60 секунд) ----
	const rateLimitInterval = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of rateLimitMap) {
			if (now > entry.resetAt) rateLimitMap.delete(key);
		}
	}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

	// ---- Presence cleanup (раз в 60 секунд) ----
	const presenceInterval = setInterval(() => cleanupPresence(io), PRESENCE_CLEANUP_INTERVAL_MS);

	// ---- Обработчики Socket.IO ----

	io.on('connection', (socket: import('socket.io').Socket) => {
		try {
			const currentUserIdRef: { current: string | null } = { current: null };
			const getCurrentUserId = () => currentUserIdRef.current;

			// ---- Простые обработчики (остаются в server.ts) ----

			socket.on('heartbeat', () => {
				try {
					const currentUserId = getCurrentUserId();
					if (!currentUserId) return;
					const user = users.get(currentUserId);
					if (user) {
						user.lastSeen = Date.now();
					}
				} catch (err) {
					captureError(err, { event: 'heartbeat', userId: getCurrentUserId() });
					logger.error({ err, event: 'heartbeat' }, 'Error in heartbeat');
					incError('heartbeat');
					socket.emit('error', { message: 'Internal error' });
				}
			});

			socket.on('get_presence', (data: { userIds: string[] }) => {
				try {
					const { userIds } = data;
					if (!Array.isArray(userIds)) return;

					const presence: Record<string, boolean> = {};
					for (const uid of userIds) {
						presence[uid] = users.has(uid);
					}
					socket.emit('presence_batch', presence);

					const currentUserId = getCurrentUserId();
					if (currentUserId) {
						const userData = users.get(currentUserId);
						if (userData) userData.lastSeen = Date.now();
					}
				} catch (err) {
					captureError(err, { event: 'get_presence', userId: getCurrentUserId() });
					logger.error({ err, event: 'get_presence' }, 'Error in get_presence');
					incError('get_presence');
					socket.emit('error', { message: 'Internal error' });
				}
			});

			// ---- Хендлеры по модулям ----

			setupRegisterHandlers(socket, io, currentUserIdRef);
			setupMessageHandlers(socket, io, getCurrentUserId);
			setupFriendHandlers(socket, io, getCurrentUserId);
			setupCallHandlers(socket, io, getCurrentUserId);

			// Обновление метрик после настройки хендлеров
			updateConnections(io.engine.clientsCount, users.size, activeCalls.size);

			// ---- Disconnect ----

			socket.on('disconnect', () => {
				try {
					const currentUserId = getCurrentUserId();
					if (currentUserId) {
						// Удаляем пользователя только если этот сокет всё ещё активен для userId
						// (защита от race condition при перерегистрации — старый сокет не должен
						// затирать запись нового сокета в users)
						const userData = users.get(currentUserId);
						if (userData && userData.socket.id === socket.id) {
							// Если у пользователя был активный звонок — завершить
							const activeCallId = userActiveCall.get(currentUserId);
							if (activeCallId) {
								const session = activeCalls.get(activeCallId);
								if (session) {
									const otherSocket =
										session.callerId === currentUserId
											? session.calleeSocket
											: session.callerSocket;
									if (otherSocket) {
										const callDuration = session.connectedAt
											? Math.floor((Date.now() - session.connectedAt) / 1000)
											: 0;
										otherSocket.emit('call_ended', {
											callId: activeCallId,
											duration: callDuration,
											endedBy: currentUserId,
										});
									}
									cleanupCall(activeCallId, 'offline');
								}
							}

							users.delete(currentUserId);
							io.emit('presence', { userId: currentUserId, online: false });
						}
						// Если userData отсутствует (уже удалён cleanupPresence) или
						// userData.socket.id !== socket.id (пользователь перерегистрировался
						// на новом сокете) — ничего не делаем
					}
				} catch (err) {
					captureError(err, { event: 'disconnect', userId: getCurrentUserId() });
					logger.error(
						{ err, event: 'disconnect', userId: getCurrentUserId() },
						'Error in disconnect',
					);
					incError('disconnect');
					socket.emit('error', { message: 'Internal error' });
				} finally {
					updateConnections(io.engine.clientsCount, users.size, activeCalls.size);
				}
			});
		} catch (err) {
			captureError(err, { event: 'connection' });
			logger.error({ err, event: 'connection' }, 'Fatal error in connection handler');
			incError('connection');
			socket.emit('error', { message: 'Internal server error' });
		}

		// Add socket error handler
		socket.on('error', err => {
			captureError(err, { event: 'socket_error' });
			logger.error({ err, event: 'socket_error' }, 'Socket error');
		});
	});

	// ---- Graceful shutdown (delegates to utils.js) ----

	const gracefulShutdown = (signal: string) => {
		stopMetrics();
		_gracefulShutdown(signal, io, httpServer, presenceInterval);
	};

	return { io, gracefulShutdown, rateLimitInterval, presenceInterval };
}

// ---------------------------------------------------------------------------
// Production boot (пропускается в тестовом окружении — Vitest устанавливает VITEST)
// ---------------------------------------------------------------------------

if (!process.env.VITEST) {
	// Инициализируем Sentry/GlitchTip до старта HTTP-сервера и регистрации process-обработчиков
	initSentry();

	const httpServer = createServer();
	initMetrics();
	// Интервалы зарегистрированы внутри createApp, здесь не используются
	const { gracefulShutdown } = createApp(httpServer);

	httpServer.listen(PORT, () => {
		logger.info({ port: PORT }, 'VoidChat server started');
		logger.info({ url: `http://0.0.0.0:${PORT}/` }, 'Health check endpoint');
	});

	process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
	process.on('SIGINT', () => gracefulShutdown('SIGINT'));

	process.on('uncaughtException', err => {
		logger.fatal({ err }, 'Uncaught exception');
		captureError(err, { type: 'uncaughtException' });
		gracefulShutdown('uncaughtException');
		setTimeout(() => process.exit(1), 1000);
	});

	process.on('unhandledRejection', reason => {
		logger.fatal(
			{ err: reason instanceof Error ? reason : new Error(String(reason)) },
			'Unhandled rejection',
		);
		captureError(reason instanceof Error ? reason : new Error(String(reason)), {
			type: 'unhandledRejection',
		});
		gracefulShutdown('unhandledRejection');
	});
}

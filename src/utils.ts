/**
 * Shared utility functions used by the server.
 *
 * Pure functions that operate on in-memory state (from state.ts) and config
 * (from config.ts).  They contain no direct dependency on createApp's closure
 * variables – any such dependencies are passed as extra parameters.
 */

import { Server } from 'socket.io';
import type { Server as HttpServer } from 'http';
import {
	RATE_LIMIT_MAX_REQUESTS,
	RATE_LIMIT_WINDOW_MS,
	PRESENCE_TIMEOUT_MS,
	SHUTDOWN_FORCE_EXIT_MS,
} from './config.js';
import {
	activeCalls,
	userActiveCall,
	pendingCallOffers,
	pendingAutoFriends,
	pendingFriendRequests,
	pendingFriendAccepts,
	pendingMessages,
	users,
	rateLimitMap,
} from './state.js';

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export function checkRateLimit(
	userId: string,
	maxRequests: number = RATE_LIMIT_MAX_REQUESTS,
	windowMs: number = RATE_LIMIT_WINDOW_MS,
): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(userId);
	if (!entry || now > entry.resetAt) {
		rateLimitMap.set(userId, { count: 1, resetAt: now + windowMs });
		return true;
	}
	if (entry.count >= maxRequests) return false;
	entry.count++;
	return true;
}

// ---------------------------------------------------------------------------
// Call cleanup
// ---------------------------------------------------------------------------

export function cleanupCall(
	callId: string,
	reason: 'ended' | 'declined' | 'no_answer' | 'offline',
): void {
	const session = activeCalls.get(callId);
	if (!session) return;

	// Уведомить caller при таймауте
	if ((reason === 'no_answer' || reason === 'offline') && session.callerSocket) {
		session.callerSocket.emit('call_timedout', { callId, reason });
	}

	// Очистить таймаут
	if (session.timeoutHandle) {
		clearTimeout(session.timeoutHandle);
		session.timeoutHandle = null;
	}

	// Удалить из userActiveCall
	if (userActiveCall.get(session.callerId) === callId) {
		userActiveCall.delete(session.callerId);
	}
	if (session.calleeId && userActiveCall.get(session.calleeId) === callId) {
		userActiveCall.delete(session.calleeId);
	}

	// Очистить pendingCallOffers (только если calleeId задан)
	if (session.calleeId) {
		const pending = pendingCallOffers.get(session.calleeId);
		if (pending) {
			const filtered = pending.filter(p => p.callId !== callId);
			if (filtered.length === 0) {
				pendingCallOffers.delete(session.calleeId);
			} else {
				pendingCallOffers.set(session.calleeId, filtered);
			}
		}
	}

	activeCalls.delete(callId);
}

// ---------------------------------------------------------------------------
// Presence cleanup
// ---------------------------------------------------------------------------

export function cleanupPresence(io: Server): void {
	const now = Date.now();

	for (const [userId, data] of users) {
		if (now - data.lastSeen > PRESENCE_TIMEOUT_MS) {
			const socket = data.socket;

			// Если у пользователя был активный звонок — завершить через cleanupCall
			const activeCallId = userActiveCall.get(userId);
			if (activeCallId) {
				const session = activeCalls.get(activeCallId);
				if (session) {
					// Определить второго участника и отправить call_ended
					const otherSocket =
						session.callerId === userId ? session.calleeSocket : session.callerSocket;
					if (otherSocket) {
						otherSocket.emit('call_ended', {
							callId: activeCallId,
							duration: session.connectedAt
								? Math.floor((Date.now() - session.connectedAt) / 1000)
								: 0,
							endedBy: userId,
						});
					}
				}
				cleanupCall(activeCallId, 'offline');
			}

			if (socket) {
				io.emit('presence', { userId, online: false });
				users.delete(userId);
				socket.disconnect();
			} else {
				users.delete(userId);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Gracefully shut down the server: clear intervals, notify call participants,
 * close Socket.IO and the HTTP server, then force-exit after a timeout.
 *
 * @param signal     The signal name that triggered the shutdown (SIGTERM, SIGINT, …)
 * @param io         The Socket.IO Server instance
 * @param httpServer The HTTP server instance
 * @param presenceInterval   The interval handle for presence cleanup
 */
export function gracefulShutdown(
	signal: string,
	io: Server,
	httpServer: HttpServer,
	presenceInterval: ReturnType<typeof setInterval>,
): void {
	console.log(`\nReceived ${signal}, shutting down gracefully...`);
	clearInterval(presenceInterval);
	console.log(
		'[shutdown] Active calls: ' +
			activeCalls.size +
			', Pending messages: ' +
			pendingMessages.size +
			', Pending calls: ' +
			pendingCallOffers.size +
			', Pending friend requests: ' +
			pendingFriendRequests.size +
			', Pending friend accepts: ' +
			pendingFriendAccepts.size +
			', Pending auto-friends: ' +
			pendingAutoFriends.size,
	);

	// Завершить все активные звонки
	for (const [, session] of activeCalls) {
		if (session.timeoutHandle) {
			clearTimeout(session.timeoutHandle);
		}
		// Уведомить участников
		if (session.callerSocket) {
			session.callerSocket.emit('call_ended', {
				callId: session.callId,
				duration: 0,
				endedBy: 'server',
			});
		}
		if (session.calleeSocket) {
			session.calleeSocket.emit('call_ended', {
				callId: session.callId,
				duration: 0,
				endedBy: 'server',
			});
		}
	}
	activeCalls.clear();
	userActiveCall.clear();
	pendingCallOffers.clear();
	pendingAutoFriends.clear();

	io.close();
	httpServer.close(() => process.exit(0));
	// Force exit after 10s if graceful shutdown hangs
	setTimeout(() => {
		console.error('[shutdown] Forced exit after timeout');
		process.exit(1);
	}, SHUTDOWN_FORCE_EXIT_MS);
}

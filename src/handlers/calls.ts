/**
 * Call signaling handlers — 'call_offer', 'call_accept', 'call_decline',
 * 'call_hangup', 'ice_candidate' events
 */

import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import type { Server as SocketIOServer } from 'socket.io';
import {
	MAX_SDP_LENGTH,
	CALL_TIMEOUT_MS,
	CALL_OFFER_RATE_LIMIT_MAX,
	CALL_OFFER_RATE_LIMIT_WINDOW_MS,
} from '../config.js';
import { users, activeCalls, userActiveCall, pendingCallOffers } from '../state.js';
import type { MediaType, CallSession } from '../types.js';
import { checkRateLimit, cleanupCall } from '../utils.js';
import { incEvent, incError } from '../metrics.js';
import { captureError } from '../sentry.js';
import { logger } from '../logger.js';

export function setupCallHandlers(
	socket: Socket,
	_io: SocketIOServer,
	getCurrentUserId: () => string | null,
): void {
	socket.on(
		'call_offer',
		(data: { targetUserId: string; sdp: string; callId?: string; mediaType?: MediaType }) => {
			try {
				const currentUserId = getCurrentUserId();
				if (!currentUserId) {
					socket.emit('error', { message: 'Not registered' });
					return;
				}

				const userData = users.get(currentUserId);
				if (userData) userData.lastSeen = Date.now();

				// Skip rate-limit for renegotiation (existing call)
				if (data.callId && activeCalls.has(data.callId)) {
					// This is a re-offer, skip rate limit
				} else if (
					!checkRateLimit(
						currentUserId,
						CALL_OFFER_RATE_LIMIT_MAX,
						CALL_OFFER_RATE_LIMIT_WINDOW_MS,
					)
				) {
					socket.emit('error', { message: 'Too many requests' });
					return;
				}

				const { targetUserId, sdp, callId, mediaType: rawMediaType } = data;
				const mediaType: MediaType =
					rawMediaType === 'audio' || rawMediaType === 'video' ? rawMediaType : 'audio';

				if (!targetUserId || !sdp || targetUserId === currentUserId) {
					socket.emit('error', { message: 'Invalid call offer' });
					return;
				}

				if (typeof sdp !== 'string' || sdp.length > MAX_SDP_LENGTH) {
					socket.emit('error', { message: 'Invalid call offer' });
					return;
				}

				incEvent('call_offer');

				const targetUser = users.get(targetUserId);
				// Если targetUser не найден — обработать как офлайн (поставить в очередь)
				if (!targetUser) {
					const newCallId = data.callId || randomUUID();

					// Положить в офлайн-очередь
					const existing = pendingCallOffers.get(targetUserId) || [];
					if (existing.length >= 10) existing.shift(); // ограничение 10 офлайн-звонков
					existing.push({
						fromUserId: currentUserId,
						callId: newCallId,
						sdp,
						mediaType,
						timestamp: Date.now(),
					});
					pendingCallOffers.set(targetUserId, existing);

					// Создать сессию
					const session: CallSession = {
						callId: newCallId,
						callerId: currentUserId,
						calleeId: targetUserId,
						mediaType,
						status: 'pending',
						sdp,
						callerSocket: socket,
						calleeSocket: null,
						timeoutHandle: null,
						startedAt: Date.now(),
						connectedAt: null,
					};
					activeCalls.set(newCallId, session);
					userActiveCall.set(currentUserId, newCallId);
					userActiveCall.set(targetUserId, newCallId);

					// Таймаут 60 секунд
					session.timeoutHandle = setTimeout(() => {
						cleanupCall(newCallId, 'no_answer');
					}, CALL_TIMEOUT_MS);

					// Подтверждение отправителю
					socket.emit('call_offer_sent', { callId: newCallId, targetUserId, mediaType });
					return;
				}

				// Проверить, не занят ли target пользователь другим звонком.
				// Если передан callId и он совпадает с активным звонком target'а —
				// это renegotiation уже существующего звонка, пропускаем проверку.
				if (userActiveCall.has(targetUserId)) {
					const busyCallId = userActiveCall.get(targetUserId);
					if (!callId || busyCallId !== callId) {
						socket.emit('error', { message: 'User is busy' });
						return;
					}
				}

				// Проверка на активный звонок
				const existingCallId = userActiveCall.get(currentUserId);
				if (existingCallId) {
					// Если callId передан и совпадает с существующим звонком — это renegotiation
					if (callId && existingCallId === callId) {
						const existingSession = activeCalls.get(existingCallId);
						if (existingSession) {
							existingSession.sdp = sdp;
							// Определяем сокет другой стороны
							const otherSocket =
								existingSession.callerId === currentUserId
									? existingSession.calleeSocket
									: existingSession.callerSocket;
							if (otherSocket) {
								otherSocket.emit('call_incoming', {
									callId,
									fromUserId: currentUserId,
									sdp,
									mediaType: existingSession.mediaType,
								});
							}
							return;
						}
					}
					socket.emit('error', { message: 'You already have an active call' });
					return;
				}

				const newCallId = data.callId || randomUUID();
				const session: CallSession = {
					callId: newCallId,
					callerId: currentUserId,
					calleeId: targetUserId,
					mediaType,
					status: 'pending',
					sdp,
					callerSocket: socket,
					calleeSocket: null,
					timeoutHandle: null,
					startedAt: Date.now(),
					connectedAt: null,
				};

				activeCalls.set(newCallId, session);
				userActiveCall.set(currentUserId, newCallId);
				userActiveCall.set(targetUserId, newCallId);

				if (targetUser.socket) {
					session.status = 'ringing';
					session.calleeSocket = targetUser.socket;
					targetUser.socket.emit('call_incoming', {
						callId: newCallId,
						fromUserId: currentUserId,
						sdp,
						mediaType,
					});
					session.timeoutHandle = setTimeout(() => {
						if (session.status === 'ringing' || session.status === 'pending') {
							cleanupCall(newCallId, 'no_answer');
						}
					}, CALL_TIMEOUT_MS);
				} else {
					const existing = pendingCallOffers.get(targetUserId) || [];
					existing.push({
						fromUserId: currentUserId,
						callId: newCallId,
						sdp,
						mediaType,
						timestamp: Date.now(),
					});
					pendingCallOffers.set(targetUserId, existing);
					session.timeoutHandle = setTimeout(() => {
						if (session.status === 'ringing' || session.status === 'pending') {
							cleanupCall(newCallId, 'no_answer');
						}
					}, CALL_TIMEOUT_MS);
				}

				socket.emit('call_offer_sent', {
					callId: newCallId,
					targetUserId,
					mediaType,
				});
			} catch (err) {
				incError('call_offer');
				logger.error(
					{ err, event: 'call_offer', userId: getCurrentUserId(), callId: data.callId },
					'Error in call_offer',
				);
				socket.emit('error', { message: 'Internal error' });
			}
		},
	);

	socket.on('call_accept', (data: { callId: string; sdp: string }) => {
		try {
			const currentUserId = getCurrentUserId();
			if (!currentUserId) {
				socket.emit('error', { message: 'Not registered' });
				return;
			}

			const userData = users.get(currentUserId);
			if (userData) userData.lastSeen = Date.now();

			if (!checkRateLimit(currentUserId)) {
				socket.emit('error', { message: 'Rate limited' });
				return;
			}

			const { callId, sdp } = data;
			if (!callId || !sdp) {
				socket.emit('error', { message: 'Invalid call accept' });
				return;
			}

			incEvent('call_accept');

			const session = activeCalls.get(callId);
			if (!session) {
				socket.emit('error', { message: 'Call not found' });
				return;
			}

			// Renegotiation answer (ICE restart) — соединение уже активно
			if (session.status === 'connected') {
				session.sdp = sdp;
				// Определяем, кому отправить answer
				const targetSocket =
					currentUserId === session.callerId
						? session.calleeSocket
						: session.callerSocket;
				if (targetSocket) {
					targetSocket.emit('call_accepted', { callId, sdp });
				}
				return;
			}

			if (session.status !== 'pending' && session.status !== 'ringing') {
				socket.emit('error', { message: 'Call is not active' });
				return;
			}

			if (currentUserId !== session.calleeId) {
				socket.emit('error', { message: 'Only the callee can accept this call' });
				return;
			}

			session.status = 'connected';
			session.connectedAt = Date.now();
			session.calleeSocket = socket;
			session.sdp = sdp;

			if (session.timeoutHandle) {
				clearTimeout(session.timeoutHandle);
				session.timeoutHandle = null;
			}

			userActiveCall.set(session.calleeId, callId);
			session.callerSocket.emit('call_accepted', { callId, sdp });
		} catch (err) {
			incError('call_accept');
			logger.error(
				{ err, event: 'call_accept', userId: getCurrentUserId(), callId: data.callId },
				'Error in call_accept',
			);
			socket.emit('error', { message: 'Internal error' });
		}
	});

	socket.on('call_decline', (data: { callId: string }) => {
		try {
			const currentUserId = getCurrentUserId();
			if (!currentUserId) {
				socket.emit('error', { message: 'Not registered' });
				return;
			}

			const userData = users.get(currentUserId);
			if (userData) userData.lastSeen = Date.now();

			if (!checkRateLimit(currentUserId)) {
				socket.emit('error', { message: 'Rate limited' });
				return;
			}

			const { callId } = data;
			if (!callId) {
				socket.emit('error', { message: 'Invalid call decline' });
				return;
			}

			const session = activeCalls.get(callId);
			if (!session) {
				socket.emit('error', { message: 'Call not found' });
				return;
			}

			if (currentUserId !== session.calleeId) {
				socket.emit('error', { message: 'Only the callee can decline this call' });
				return;
			}

			incEvent('call_decline');
			session.callerSocket.emit('call_declined', { callId, reason: 'declined' });
			cleanupCall(callId, 'declined');
		} catch (err) {
			captureError(err, {
				event: 'call_decline',
				userId: getCurrentUserId(),
				callId: data.callId,
			});
			incError('call_decline');
			logger.error(
				{ err, event: 'call_decline', userId: getCurrentUserId(), callId: data.callId },
				'Error in call_decline',
			);
			socket.emit('error', { message: 'Internal error' });
		}
	});

	socket.on('call_hangup', (data: { callId: string }) => {
		try {
			const currentUserId = getCurrentUserId();
			if (!currentUserId) {
				socket.emit('error', { message: 'Not registered' });
				return;
			}

			const userData = users.get(currentUserId);
			if (userData) userData.lastSeen = Date.now();

			if (!checkRateLimit(currentUserId)) {
				socket.emit('error', { message: 'Rate limited' });
				return;
			}

			const { callId } = data;
			if (!callId) {
				socket.emit('error', { message: 'Invalid call hangup' });
				return;
			}

			const session = activeCalls.get(callId);
			if (!session) {
				socket.emit('error', { message: 'Call not found' });
				return;
			}

			if (currentUserId !== session.callerId && currentUserId !== session.calleeId) {
				socket.emit('error', { message: 'Not a participant of this call' });
				return;
			}

			incEvent('call_hangup');

			const duration = session.connectedAt
				? Math.floor((Date.now() - session.connectedAt) / 1000)
				: 0;
			const otherSocket =
				session.callerId === currentUserId ? session.calleeSocket : session.callerSocket;

			if (otherSocket) {
				otherSocket.emit('call_ended', {
					callId,
					duration,
					endedBy: currentUserId,
				});
			}

			cleanupCall(callId, 'ended');
		} catch (err) {
			incError('call_hangup');
			logger.error(
				{ err, event: 'call_hangup', userId: getCurrentUserId(), callId: data.callId },
				'Error in call_hangup',
			);
			socket.emit('error', { message: 'Internal error' });
		}
	});

	socket.on('ice_candidate', (data: { callId: string; candidate: string }) => {
		try {
			const currentUserId = getCurrentUserId();
			if (!currentUserId) {
				socket.emit('error', { message: 'Not registered' });
				return;
			}

			const userData = users.get(currentUserId);
			if (userData) userData.lastSeen = Date.now();

			if (!checkRateLimit(currentUserId)) {
				socket.emit('error', { message: 'Rate limited' });
				return;
			}

			const { callId, candidate } = data;
			if (!callId || !candidate) {
				socket.emit('error', { message: 'Invalid ICE candidate' });
				return;
			}

			if (typeof candidate !== 'string') {
				socket.emit('error', { message: 'Invalid ICE candidate' });
				return;
			}

			const session = activeCalls.get(callId);
			if (!session) {
				socket.emit('error', { message: 'Call not found' });
				return;
			}

			if (currentUserId !== session.callerId && currentUserId !== session.calleeId) {
				socket.emit('error', { message: 'Not a participant of this call' });
				return;
			}

			incEvent('ice_candidate');

			const otherSocket =
				session.callerId === currentUserId ? session.calleeSocket : session.callerSocket;

			if (otherSocket) {
				otherSocket.emit('ice_candidate', { callId, candidate });
			}
		} catch (err) {
			captureError(err, {
				event: 'ice_candidate',
				userId: getCurrentUserId(),
				callId: data.callId,
			});
			incError('ice_candidate');
			logger.error(
				{ err, event: 'ice_candidate', userId: getCurrentUserId(), callId: data.callId },
				'Error in ice_candidate',
			);
			socket.emit('error', { message: 'Internal error' });
		}
	});
}

/**
 * Message handlers — 'message', 'messages_read', 'delete_message' events
 */

import type { Socket } from 'socket.io';
import type { Server as SocketIOServer } from 'socket.io';
import { MAX_CIPHERTEXT_LENGTH, MAX_NONCE_LENGTH, MAX_PENDING_MESSAGES } from '../config.js';
import { users, pendingMessages } from '../state.js';
import { checkRateLimit } from '../utils.js';
import { incEvent, incError, incMessage } from '../metrics.js';
import { captureError } from '../sentry.js';
import { logger } from '../logger.js';

export function setupMessageHandlers(
	socket: Socket,
	_io: SocketIOServer,
	getCurrentUserId: () => string | null,
): void {
	socket.on('message', (data: { to: string; ciphertext: string; nonce: string }) => {
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

			const { to, ciphertext, nonce } = data;

			if (!to || !ciphertext || !nonce) {
				socket.emit('error', { message: 'Invalid message format' });
				return;
			}

			if (
				typeof to !== 'string' ||
				typeof ciphertext !== 'string' ||
				typeof nonce !== 'string'
			) {
				socket.emit('error', { message: 'Invalid message format' });
				return;
			}

			if (ciphertext.length > MAX_CIPHERTEXT_LENGTH || nonce.length > MAX_NONCE_LENGTH) {
				socket.emit('error', { message: 'Message payload too large' });
				return;
			}

			incEvent('message');
			incMessage();

			const target = users.get(to);
			if (!target?.socket) {
				// Получатель офлайн — сохраняем в очередь
				const existing = pendingMessages.get(to) || [];
				if (existing.length >= MAX_PENDING_MESSAGES) {
					const dropped = existing.shift()!;
					const originalSender = users.get(dropped.fromUserId);
					if (originalSender?.socket) {
						originalSender.socket.emit('message_failed', {
							to,
							nonce: dropped.nonce,
							reason: 'queue_full',
						});
					}
				}
				existing.push({
					fromUserId: currentUserId,
					ciphertext,
					nonce,
					timestamp: Date.now(),
				});
				pendingMessages.set(to, existing);
				socket.emit('message_sent', {
					to,
					ciphertext,
					nonce,
					timestamp: Date.now(),
				});
				return;
			}

			target.socket.emit('message', {
				from: currentUserId,
				ciphertext,
				nonce,
				timestamp: Date.now(),
			});

			socket.emit('message_sent', { to, ciphertext, nonce, timestamp: Date.now() });
		} catch (err) {
			incError('message');
			logger.error({ err, event: 'message', userId: getCurrentUserId() }, 'Error in message');
			socket.emit('error', { message: 'Internal error' });
		}
	});

	socket.on('messages_read', (data: { from: string; contactId: string }) => {
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

			// Уведомляем собеседника, что его сообщения прочитаны
			const target = users.get(data.contactId);
			if (target?.socket) {
				target.socket.emit('messages_read', { readBy: currentUserId });
			}
		} catch (err) {
			captureError(err, { event: 'messages_read', userId: getCurrentUserId() });
			incError('messages_read');
			logger.error(
				{ err, event: 'messages_read', userId: getCurrentUserId() },
				'Error in messages_read',
			);
			socket.emit('error', { message: 'Internal error' });
		}
	});

	socket.on('delete_message', (data: { targetUserId: string; nonces: string[] }) => {
		try {
			const currentUserId = getCurrentUserId();
			if (!currentUserId) {
				socket.emit('error', { message: 'Not registered' });
				return;
			}

			const userData = users.get(currentUserId);
			if (userData) userData.lastSeen = Date.now();

			const { targetUserId, nonces } = data;

			if (
				typeof targetUserId !== 'string' ||
				!Array.isArray(nonces) ||
				nonces.some(n => typeof n !== 'string')
			) {
				socket.emit('error', { message: 'Invalid delete_message format' });
				return;
			}

			if (nonces.length === 0) return;

			// Удаляем сообщения из очереди pendingMessages получателя,
			// только если отправитель (currentUserId) совпадает с fromUserId сообщения
			const nonceSet = new Set(nonces);
			const pending = pendingMessages.get(targetUserId);
			if (pending) {
				const filtered = pending.filter(
					msg => !(msg.fromUserId === currentUserId && nonceSet.has(msg.nonce)),
				);
				if (filtered.length === 0) {
					pendingMessages.delete(targetUserId);
				} else {
					pendingMessages.set(targetUserId, filtered);
				}
			}
			// Fire-and-forget — не шлём подтверждение клиенту
		} catch (err) {
			captureError(err, { event: 'delete_message', userId: getCurrentUserId() });
			incError('delete_message');
			logger.error(
				{ err, event: 'delete_message', userId: getCurrentUserId() },
				'Error in delete_message',
			);
			socket.emit('error', { message: 'Internal error' });
		}
	});
}

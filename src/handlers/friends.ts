/**
 * Friend handlers — 'friend_request', 'friend_accept', 'friend_decline', 'claim_invite' events
 */

import type { Socket } from 'socket.io';
import type { Server as SocketIOServer } from 'socket.io';
import { MAX_USER_ID_LENGTH, MAX_PENDING_FRIEND_REQUESTS } from '../config.js';
import {
	users,
	pendingFriendRequests,
	pendingFriendAccepts,
	pendingAutoFriends,
	MAX_PENDING_AUTO_FRIENDS,
} from '../state.js';
import { checkRateLimit } from '../utils.js';
import { incEvent, incError } from '../metrics.js';
import { captureError } from '../sentry.js';
import { logger } from '../logger.js';

export function setupFriendHandlers(
	socket: Socket,
	_io: SocketIOServer,
	getCurrentUserId: () => string | null,
): void {
	socket.on('friend_request', (data: { targetUserId: string }) => {
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

			const { targetUserId } = data;

			if (typeof targetUserId !== 'string' || targetUserId.length > MAX_USER_ID_LENGTH) {
				socket.emit('error', { message: 'Invalid target' });
				return;
			}

			if (!targetUserId || targetUserId === currentUserId) {
				socket.emit('error', { message: 'Invalid target' });
				return;
			}

			incEvent('friend_request');

			const target = users.get(targetUserId);
			const requester = users.get(currentUserId);

			if (!target || !target.socket) {
				const existing = pendingFriendRequests.get(targetUserId) || [];
				if (existing.length >= MAX_PENDING_FRIEND_REQUESTS) {
					existing.shift();
				}
				existing.push({
					fromUserId: currentUserId,
					fromPublicKey: requester?.publicKey ?? null,
				});
				pendingFriendRequests.set(targetUserId, existing);
				socket.emit('friend_request_sent', { targetUserId, targetPublicKey: null });
				return;
			}

			target.socket.emit('friend_request', {
				fromUserId: currentUserId,
				fromPublicKey: requester?.publicKey ?? null,
			});
			socket.emit('friend_request_sent', {
				targetUserId,
				targetPublicKey: target.publicKey,
			});
		} catch (err) {
			incError('friend_request');
			logger.error(
				{ err, event: 'friend_request', userId: getCurrentUserId() },
				'Error in friend_request',
			);
			socket.emit('error', { message: 'Internal error' });
		}
	});

	socket.on('friend_accept', (data: { targetUserId: string }) => {
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

			const { targetUserId } = data;
			if (
				!targetUserId ||
				typeof targetUserId !== 'string' ||
				targetUserId.length > MAX_USER_ID_LENGTH
			) {
				return;
			}

			incEvent('friend_accept');

			const initiator = users.get(targetUserId);
			const acceptor = users.get(currentUserId);

			if (!initiator || !initiator.socket) {
				const existing = pendingFriendAccepts.get(targetUserId) || [];
				if (existing.length >= MAX_PENDING_FRIEND_REQUESTS) {
					existing.shift();
				}
				existing.push({
					fromUserId: currentUserId,
					fromPublicKey: acceptor?.publicKey ?? null,
				});
				pendingFriendAccepts.set(targetUserId, existing);
			} else {
				initiator.socket.emit('friend_accepted', {
					fromUserId: currentUserId,
					fromPublicKey: acceptor?.publicKey ?? null,
				});
			}
			socket.emit('friend_confirmed', {
				targetUserId,
				targetPublicKey: initiator?.publicKey ?? null,
			});
		} catch (err) {
			incError('friend_accept');
			logger.error(
				{ err, event: 'friend_accept', userId: getCurrentUserId() },
				'Error in friend_accept',
			);
			socket.emit('error', { message: 'Internal error' });
		}
	});

	socket.on('friend_decline', (data: { targetUserId: string }) => {
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

			const { targetUserId } = data;
			if (
				!targetUserId ||
				typeof targetUserId !== 'string' ||
				targetUserId.length > MAX_USER_ID_LENGTH
			) {
				socket.emit('error', { message: 'Invalid target' });
				return;
			}

			const target = users.get(targetUserId);
			if (target?.socket) {
				target.socket.emit('friend_declined', { fromUserId: currentUserId });
			}
		} catch (err) {
			captureError(err, { event: 'friend_decline', userId: getCurrentUserId() });
			incError('friend_decline');
			logger.error(
				{ err, event: 'friend_decline', userId: getCurrentUserId() },
				'Error in friend_decline',
			);
			socket.emit('error', { message: 'Internal error' });
		}
	});

	socket.on('claim_invite', (data: { inviterUserId: string }) => {
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

			const { inviterUserId } = data;
			if (
				!inviterUserId ||
				typeof inviterUserId !== 'string' ||
				inviterUserId.length > MAX_USER_ID_LENGTH
			) {
				socket.emit('error', { message: 'Invalid inviter' });
				return;
			}

			if (inviterUserId === currentUserId) {
				socket.emit('error', { message: 'Cannot invite yourself' });
				return;
			}

			const inviter = users.get(inviterUserId);
			const claimant = users.get(currentUserId);

			// Если приглашающий онлайн — отправляем ему auto_friend_added
			if (inviter && inviter.socket) {
				inviter.socket.emit('auto_friend_added', {
					userId: currentUserId,
					publicKey: claimant?.publicKey ?? null,
				});
				// Отправляем подтверждение отправителю с publicKey приглашающего
				socket.emit('invite_claimed', {
					inviterUserId,
					publicKey: inviter.publicKey,
				});
			} else {
				// Приглашающий офлайн — сохраняем в очередь
				const existing = pendingAutoFriends.get(inviterUserId) || [];
				if (existing.length >= MAX_PENDING_AUTO_FRIENDS) {
					existing.shift();
				}
				existing.push({
					userId: currentUserId,
					publicKey: claimant?.publicKey ?? null,
				});
				pendingAutoFriends.set(inviterUserId, existing);
				// Отправляем без publicKey (будет получен через friend_accept)
				socket.emit('invite_claimed', {
					inviterUserId,
					publicKey: null,
				});
			}
		} catch (err) {
			captureError(err, { event: 'claim_invite', userId: getCurrentUserId() });
			incError('claim_invite');
			logger.error(
				{ err, event: 'claim_invite', userId: getCurrentUserId() },
				'Error in claim_invite',
			);
			socket.emit('error', { message: 'Internal error' });
		}
	});
}

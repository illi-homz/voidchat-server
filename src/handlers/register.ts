/**
 * Registration handler — 'register' event
 *
 * Validates userId, handles socket transfer during active calls,
 * delivers pending messages / friend requests / call offers.
 */

import type { Socket } from 'socket.io';
import type { Server as SocketIOServer } from 'socket.io';
import { MAX_USER_ID_LENGTH, MAX_PUBLIC_KEY_LENGTH, CALL_TIMEOUT_MS } from '../config.js';
import {
	users,
	pendingFriendRequests,
	pendingFriendAccepts,
	pendingMessages,
	pendingCallOffers,
	activeCalls,
	userActiveCall,
	pendingAutoFriends,
} from '../state.js';
import { cleanupCall } from '../utils.js';

export function setupRegisterHandlers(
	socket: Socket,
	io: SocketIOServer,
	currentUserIdRef: { current: string | null },
): void {
	socket.on('register', (data: { userId: string; publicKey?: string }) => {
		try {
			const { userId, publicKey } = data;

			if (!userId || typeof userId !== 'string') {
				socket.emit('error', { message: 'Invalid userId' });
				return;
			}

			if (
				userId.length > MAX_USER_ID_LENGTH ||
				(publicKey && publicKey.length > MAX_PUBLIC_KEY_LENGTH)
			) {
				socket.emit('error', { message: 'Invalid registration data' });
				return;
			}

			if (users.has(userId)) {
				const existing = users.get(userId)!;
				const activeCallId = userActiveCall.get(userId);

				if (activeCallId && activeCalls.has(activeCallId)) {
					// User has an active call — transfer the socket instead of killing the call
					const session = activeCalls.get(activeCallId)!;
					const userRole = session.callerId === userId ? 'caller' : 'callee';

					// Update the session socket
					if (userRole === 'caller') {
						session.callerSocket = socket;
					} else {
						session.calleeSocket = socket;
					}

					console.log(
						`[call] Transferred socket for call ${activeCallId} (${userRole} reconnected)`,
					);

					// Disconnect old socket silently (without triggering cleanup)
					if (existing.socket) {
						existing.socket.removeAllListeners('disconnect');
						existing.socket.disconnect(true);
					}
				} else {
					// No active call — standard kick + disconnect
					if (existing.socket) {
						existing.socket.emit('kicked', {
							message: 'Account logged in elsewhere',
						});
						existing.socket.disconnect();
					}
				}
			}

			currentUserIdRef.current = userId;
			users.set(userId, {
				socket,
				userId,
				publicKey: publicKey ?? null,
				lastSeen: Date.now(),
			});

			socket.emit('registered', { userId });
			io.emit('presence', { userId, online: true });

			const pending = pendingFriendRequests.get(userId);
			if (pending) {
				for (const req of pending) {
					socket.emit('friend_request', {
						fromUserId: req.fromUserId,
						fromPublicKey: req.fromPublicKey,
					});
				}
				pendingFriendRequests.delete(userId);
			}

			// Доставка офлайн-запросов auto_friend (claim_invite)
			const pendingAuto = pendingAutoFriends.get(userId);
			if (pendingAuto) {
				for (const entry of pendingAuto) {
					socket.emit('auto_friend_added', {
						userId: entry.userId,
						publicKey: entry.publicKey,
					});
				}
				pendingAutoFriends.delete(userId);
			}

			const pendingAccepts = pendingFriendAccepts.get(userId);
			if (pendingAccepts) {
				for (const acc of pendingAccepts) {
					socket.emit('friend_accepted', {
						fromUserId: acc.fromUserId,
						fromPublicKey: acc.fromPublicKey,
					});
				}
				pendingFriendAccepts.delete(userId);
			}

			// Доставляем накопившиеся офлайн-сообщения
			const pendingMsgs = pendingMessages.get(userId);
			if (pendingMsgs) {
				for (const msg of pendingMsgs) {
					socket.emit('message', {
						from: msg.fromUserId,
						ciphertext: msg.ciphertext,
						nonce: msg.nonce,
						timestamp: msg.timestamp,
					});
				}
				pendingMessages.delete(userId);
			}

			// Доставка офлайн-звонков
			const pendingCalls = pendingCallOffers.get(userId);
			if (pendingCalls && pendingCalls.length > 0) {
				for (const offer of pendingCalls) {
					const session = activeCalls.get(offer.callId);
					if (session && (session.status === 'pending' || session.status === 'ringing')) {
						session.status = 'ringing';
						session.calleeSocket = socket;
						socket.emit('call_incoming', {
							callId: offer.callId,
							fromUserId: offer.fromUserId,
							sdp: offer.sdp,
							mediaType: offer.mediaType,
						});
						if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
						session.timeoutHandle = setTimeout(() => {
							if (session.status === 'ringing' || session.status === 'pending') {
								cleanupCall(session.callId, 'no_answer');
							}
						}, CALL_TIMEOUT_MS);
					}
				}
				pendingCallOffers.delete(userId);
			}
		} catch (err) {
			console.error('[register] Error:', err);
			socket.emit('error', { message: 'Internal error' });
		}
	});
}

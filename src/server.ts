import { Server } from 'socket.io';

const PORT = Number(process.env.PORT) || 3001;

interface UserData {
	socket: import('socket.io').Socket;
	userId: string;
	publicKey: string | null;
	lastSeen: number;
}

const io = new Server(PORT, {
	cors: {
		origin: '*',
		methods: ['GET', 'POST'],
	},
	pingInterval: 25000,
	pingTimeout: 5000,
});

const users = new Map<string, UserData>();

const pendingFriendRequests = new Map<
	string,
	Array<{ fromUserId: string; fromPublicKey: string | null }>
>();
const pendingFriendAccepts = new Map<
	string,
	Array<{ fromUserId: string; fromPublicKey: string | null }>
>();

const pendingMessages = new Map<
	string,
	Array<{
		fromUserId: string;
		ciphertext: string;
		nonce: string;
		timestamp: number;
	}>
>();

function cleanupPresence(): void {
	const now = Date.now();
	const TIMEOUT = 10 * 60 * 1000;

	for (const [userId, data] of users) {
		if (now - data.lastSeen > TIMEOUT) {
			const socket = data.socket;
			if (socket) {
				io.emit('presence', { userId, online: false });
				socket.disconnect();
			}
			users.delete(userId);
		}
	}
}

setInterval(cleanupPresence, 60000);

io.on('connection', (socket: import('socket.io').Socket) => {
	let currentUserId: string | null = null;

	socket.on('register', (data: { userId: string; publicKey?: string }) => {
		const { userId, publicKey } = data;

		if (!userId || typeof userId !== 'string') {
			socket.emit('error', { message: 'Invalid userId' });
			return;
		}

		if (users.has(userId)) {
			const existing = users.get(userId)!;
			if (existing.socket) {
				existing.socket.emit('kicked', { message: 'Account logged in elsewhere' });
				existing.socket.disconnect();
			}
		}

		currentUserId = userId;
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
	});

	socket.on('heartbeat', () => {
		if (!currentUserId) return;
		const user = users.get(currentUserId);
		if (user) {
			user.lastSeen = Date.now();
		}
	});

	socket.on('get_presence', (data: { userIds: string[] }) => {
		const { userIds } = data;
		if (!Array.isArray(userIds)) return;

		const presence: Record<string, boolean> = {};
		for (const uid of userIds) {
			presence[uid] = users.has(uid);
		}
		socket.emit('presence_batch', presence);
	});

	socket.on('friend_request', (data: { targetUserId: string }) => {
		if (!currentUserId) {
			socket.emit('error', { message: 'Not registered' });
			return;
		}

		const { targetUserId } = data;

		if (!targetUserId || targetUserId === currentUserId) {
			socket.emit('error', { message: 'Invalid target' });
			return;
		}

		const target = users.get(targetUserId);
		const requester = users.get(currentUserId);

		if (!target || !target.socket) {
			const existing = pendingFriendRequests.get(targetUserId) || [];
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
		socket.emit('friend_request_sent', { targetUserId, targetPublicKey: target.publicKey });
	});

	socket.on('friend_accept', (data: { targetUserId: string }) => {
		if (!currentUserId) {
			socket.emit('error', { message: 'Not registered' });
			return;
		}

		const { targetUserId } = data;
		if (!targetUserId) return;

		const initiator = users.get(targetUserId);
		const acceptor = users.get(currentUserId);

		if (!initiator || !initiator.socket) {
			const existing = pendingFriendAccepts.get(targetUserId) || [];
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
	});

	socket.on('friend_decline', (data: { targetUserId: string }) => {
		if (!currentUserId) return;

		const { targetUserId } = data;
		if (!targetUserId) return;

		const target = users.get(targetUserId);
		if (target?.socket) {
			target.socket.emit('friend_declined', { fromUserId: currentUserId });
		}
	});

	socket.on('message', (data: { to: string; ciphertext: string; nonce: string }) => {
		if (!currentUserId) {
			socket.emit('error', { message: 'Not registered' });
			return;
		}

		const { to, ciphertext, nonce } = data;

		if (!to || !ciphertext || !nonce) {
			socket.emit('error', { message: 'Invalid message format' });
			return;
		}

		const target = users.get(to);
		if (!target?.socket) {
			// Получатель офлайн — сохраняем в очередь
			const existing = pendingMessages.get(to) || [];
			existing.push({ fromUserId: currentUserId, ciphertext, nonce, timestamp: Date.now() });
			pendingMessages.set(to, existing);
			socket.emit('message_sent', { to, ciphertext, nonce, timestamp: Date.now() });
			return;
		}

		target.socket.emit('message', {
			from: currentUserId,
			ciphertext,
			nonce,
			timestamp: Date.now(),
		});

		socket.emit('message_sent', { to, ciphertext, nonce, timestamp: Date.now() });
	});

	socket.on('messages_read', (data: { from: string; contactId: string }) => {
		if (!currentUserId) {
			socket.emit('error', { message: 'Not registered' });
			return;
		}
		// Уведомляем собеседника, что его сообщения прочитаны
		const target = users.get(data.contactId);
		if (target?.socket) {
			target.socket.emit('messages_read', { readBy: currentUserId });
		}
	});

	socket.on('disconnect', () => {
		if (currentUserId) {
			users.delete(currentUserId);
			io.emit('presence', { userId: currentUserId, online: false });
		}
	});
});

console.log(`VoidChat server running on port ${PORT}`);

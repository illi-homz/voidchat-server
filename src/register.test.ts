/**
 * Integration tests: Registration (Socket.IO 'register' event)
 *
 * Scenarios:
 * 1. Successful registration → 'registered' + 'presence' broadcast
 * 2. Same userId → old socket gets 'kicked' and disconnected
 * 3. Unregistered socket tries protected events → 'error("Not registered")'
 * 4. Socket transfer during an active call → call not dropped
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, connectClient, connectClientWithoutRegister } from './test-helpers.js';
import type { TestContext } from './test-helpers.js';
import type { Socket as ClientSocket } from 'socket.io-client';

describe('Register', () => {
	let ctx: TestContext;
	const clients: ClientSocket[] = [];

	beforeEach(async () => {
		ctx = await createTestServer();
	});

	afterEach(async () => {
		for (const c of clients) {
			if (c.connected) c.close();
		}
		clients.length = 0;
		await ctx.cleanup();
	});

	// -----------------------------------------------------------------------
	// 1. Successful registration
	// -----------------------------------------------------------------------
	it('получает `registered` после успешной регистрации', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		clients.push(alice);

		expect(alice.connected).toBe(true);
	});

	it('broadcasts `presence { online: true }` для остальных клиентов', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		clients.push(alice);

		// Ждём presence для bob (фильтруем по userId, игнорируем alice)
		const bobPresence = new Promise<unknown>(resolve => {
			alice.on('presence', (data: { userId: string; online: boolean }) => {
				if (data.userId === 'bob') resolve(data);
			});
		});

		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(bob);

		// alice должна получить presence для bob
		const event = await bobPresence;
		expect(event).toMatchObject({ userId: 'bob', online: true });
	});

	// -----------------------------------------------------------------------
	// 2. Re-registration — kick old socket
	// -----------------------------------------------------------------------
	it('при регистрации существующего userId старый сокет получает `kicked`', async () => {
		const alice1 = await connectClient(ctx.url, 'alice', 'pk_alice');
		clients.push(alice1);

		// Ждём kicked на старом сокете
		const kickedPromise = new Promise<unknown>(resolve => {
			alice1.on('kicked', (data: unknown) => resolve(data));
		});

		const alice2 = await connectClient(ctx.url, 'alice', 'pk_alice2');
		clients.push(alice2);

		const kicked = await kickedPromise;
		expect(kicked).toMatchObject({ message: 'Account logged in elsewhere' });

		// Старый сокет должен отключиться
		expect(alice1.connected).toBe(false);
	});

	// -----------------------------------------------------------------------
	// 3. Unregistered → error
	// -----------------------------------------------------------------------
	it('незарегистрированный сокет получает ошибку на `message`', async () => {
		const unreg = await connectClientWithoutRegister(ctx.url);
		clients.push(unreg);

		const errPromise = new Promise<unknown>(resolve => {
			unreg.on('error', (data: unknown) => resolve(data));
		});

		unreg.emit('message', { to: 'bob', ciphertext: 'hello', nonce: 'n1' });

		const err = await errPromise;
		expect(err).toMatchObject({ message: 'Not registered' });
	});

	it('незарегистрированный сокет получает ошибку на `friend_request`', async () => {
		const unreg = await connectClientWithoutRegister(ctx.url);
		clients.push(unreg);

		const errPromise = new Promise<unknown>(resolve => {
			unreg.on('error', (data: unknown) => resolve(data));
		});

		unreg.emit('friend_request', { targetUserId: 'bob' });

		const err = await errPromise;
		expect(err).toMatchObject({ message: 'Not registered' });
	});

	// -----------------------------------------------------------------------
	// 4. Socket transfer during active call
	// -----------------------------------------------------------------------
	it('перерегистрация во время активного звонка переносит сокет без сброса звонка', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		const callId = 'call_socket_transfer';

		// alice звонит bob
		const aliceOfferSent = new Promise<unknown>(resolve => {
			alice.on('call_offer_sent', (d: unknown) => resolve(d));
		});
		const bobIncoming = new Promise<unknown>(resolve => {
			bob.on('call_incoming', (d: unknown) => resolve(d));
		});

		alice.emit('call_offer', { targetUserId: 'bob', sdp: 'offer_sdp', callId });

		await aliceOfferSent;
		await bobIncoming;

		// bob принимает звонок
		const aliceAccepted = new Promise<unknown>(resolve => {
			alice.on('call_accepted', (d: unknown) => resolve(d));
		});
		bob.emit('call_accept', { callId, sdp: 'answer_sdp' });
		await aliceAccepted;

		// bob перерегистрируется с тем же userId (НЕ закрывая старый сокет —
		// иначе disconnect очистит звонок). Имитируем пересоздание соединения
		// при переподключении: старый сокет отключается сервером без cleanup звонка.
		const bob2 = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(bob2);

		// alice отправляет ICE candidate
		const bob2Ice = new Promise<unknown>(resolve => {
			bob2.on('ice_candidate', (d: unknown) => resolve(d));
		});
		alice.emit('ice_candidate', { callId, candidate: 'candidate_xyz' });

		// bob2 должен получить candidate (звонок не сброшен)
		const ice = await bob2Ice;
		expect(ice).toMatchObject({ callId, candidate: 'candidate_xyz' });
	});
});

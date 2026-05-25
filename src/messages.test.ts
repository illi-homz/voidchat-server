/**
 * Integration tests: Messages (Socket.IO 'message', 'messages_read' events)
 *
 * Scenarios:
 * 1. Online recipient → 'message' delivered, 'message_sent' to sender
 * 2. Offline recipient → queued, delivered on registration
 * 3. Queue overflow (1000) → oldest dropped, 'message_failed' sent
 * 4. Validation: ciphertext > 65536 → error
 * 5. 'messages_read' → relayed to conversation partner
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { io as ioc } from 'socket.io-client';
import { createTestServer, connectClient } from './test-helpers.js';
import type { TestContext } from './test-helpers.js';
import type { Socket as ClientSocket } from 'socket.io-client';

describe('Messages', () => {
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
	// 1. Online recipient
	// -----------------------------------------------------------------------
	it('онлайн-получатель получает `message`, отправитель получает `message_sent`', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		const bobMsg = new Promise<unknown>(resolve => {
			bob.on('message', (d: unknown) => resolve(d));
		});
		const aliceSent = new Promise<unknown>(resolve => {
			alice.on('message_sent', (d: unknown) => resolve(d));
		});

		alice.emit('message', { to: 'bob', ciphertext: 'encrypted_hello', nonce: 'n1' });

		const sent = await aliceSent;
		expect(sent).toMatchObject({ to: 'bob', ciphertext: 'encrypted_hello', nonce: 'n1' });

		const msg = await bobMsg;
		expect(msg).toMatchObject({ from: 'alice', ciphertext: 'encrypted_hello', nonce: 'n1' });
	});

	// -----------------------------------------------------------------------
	// 2. Offline recipient
	// -----------------------------------------------------------------------
	it('офлайн-сообщение ставится в очередь и доставляется при регистрации получателя', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		clients.push(alice);

		const aliceSent = new Promise<unknown>(resolve => {
			alice.on('message_sent', (d: unknown) => resolve(d));
		});

		// bob ещё не подключён — сообщение уходит в очередь
		alice.emit('message', { to: 'bob', ciphertext: 'offline_msg', nonce: 'n_off' });
		await aliceSent;

		// bob подключается — должен получить офлайн-сообщение
		const bobMsg = new Promise<unknown>(resolve => {
			const bob = ioc(ctx.url, { transports: ['websocket'], forceNew: true });
			bob.on('connect', () => {
				bob.on('message', (d: unknown) => {
					resolve(d);
					bob.close();
				});
				bob.emit('register', { userId: 'bob', publicKey: 'pk_bob' });
			});
			clients.push(bob);
		});

		const msg = await bobMsg;
		expect(msg).toMatchObject({ from: 'alice', ciphertext: 'offline_msg', nonce: 'n_off' });
	});

	// -----------------------------------------------------------------------
	// 3. Queue overflow
	// -----------------------------------------------------------------------
	it('переполнение очереди (1000) — первое сообщение дропается, отправитель получает `message_failed`', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		clients.push(alice);

		// Наполняем очередь напрямую через state (bob офлайн)
		const { pendingMessages } = await import('./state.js');
		const fill: Array<{
			fromUserId: string;
			ciphertext: string;
			nonce: string;
			timestamp: number;
		}> = [];
		for (let i = 0; i < 1000; i++) {
			fill.push({
				fromUserId: 'alice',
				ciphertext: `msg_${i}`,
				nonce: `n_${i}`,
				timestamp: Date.now(),
			});
		}
		pendingMessages.set('bob', fill);

		// Отправляем ещё одно сообщение — очередь переполнена
		const msgFailed = new Promise<unknown>(resolve => {
			alice.on('message_failed', (d: unknown) => resolve(d));
		});

		alice.emit('message', { to: 'bob', ciphertext: 'overflow', nonce: 'n_overflow' });

		const failed = await msgFailed;
		expect(failed).toMatchObject({
			to: 'bob',
			reason: 'queue_full',
		});
		expect(failed).toHaveProperty('nonce');
	});

	// -----------------------------------------------------------------------
	// 4. Payload validation
	// -----------------------------------------------------------------------
	it('ciphertext превышает MAX_CIPHERTEXT_LENGTH → ошибка', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		clients.push(alice);

		const hugeText = 'x'.repeat(65537);

		const errPromise = new Promise<unknown>(resolve => {
			alice.on('error', (d: unknown) => resolve(d));
		});

		alice.emit('message', { to: 'bob', ciphertext: hugeText, nonce: 'n1' });

		const err = await errPromise;
		expect(err).toMatchObject({ message: 'Message payload too large' });
	});

	it('nonce превышает MAX_NONCE_LENGTH → ошибка', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		clients.push(alice);

		const longNonce = 'n'.repeat(129);

		const errPromise = new Promise<unknown>(resolve => {
			alice.on('error', (d: unknown) => resolve(d));
		});

		alice.emit('message', { to: 'bob', ciphertext: 'hello', nonce: longNonce });

		const err = await errPromise;
		expect(err).toMatchObject({ message: 'Message payload too large' });
	});

	// -----------------------------------------------------------------------
	// 5. messages_read
	// -----------------------------------------------------------------------
	it('`messages_read` ретранслируется собеседнику', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		// alice отправляет сообщение
		alice.emit('message', { to: 'bob', ciphertext: 'hi', nonce: 'n1' });
		await new Promise<void>(resolve => {
			alice.on('message_sent', () => resolve());
		});

		// bob отправляет messages_read
		const aliceRead = new Promise<unknown>(resolve => {
			alice.on('messages_read', (d: unknown) => resolve(d));
		});

		bob.emit('messages_read', { from: 'bob', contactId: 'alice' });

		const read = await aliceRead;
		expect(read).toMatchObject({ readBy: 'bob' });
	});

	it('`messages_read` от незарегистрированного сокета → ошибка', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		clients.push(alice);

		const unreg = ioc(ctx.url, { transports: ['websocket'], forceNew: true });
		clients.push(unreg);

		await new Promise<void>(resolve => unreg.on('connect', () => resolve()));

		const errPromise = new Promise<unknown>(resolve => {
			unreg.on('error', (d: unknown) => resolve(d));
		});

		unreg.emit('messages_read', { from: 'unreg', contactId: 'alice' });

		const err = await errPromise;
		expect(err).toMatchObject({ message: 'Not registered' });
	});
});

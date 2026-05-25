/**
 * Integration tests: Presence (heartbeat, get_presence, disconnect, cleanup)
 *
 * Scenarios:
 * 1. heartbeat → lastSeen обновляется
 * 2. get_presence → online/offline статусы
 * 3. Disconnect → presence { online: false } broadcast
 * 4. cleanupPresence → удаление неактивных пользователей
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, connectClient } from './test-helpers.js';
import type { TestContext } from './test-helpers.js';
import type { Socket as ClientSocket } from 'socket.io-client';
import * as state from './state.js';

describe('Presence', () => {
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
	// 1. Heartbeat
	// -----------------------------------------------------------------------
	it('heartbeat обновляет lastSeen', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		clients.push(alice);

		// Устанавливаем lastSeen в прошлое, чтобы heartbeat мог его обновить
		state.users.get('alice')!.lastSeen = 0;

		// Отправляем heartbeat
		alice.emit('heartbeat');
		// Ждём обработки heartbeat на сервере
		await new Promise<void>(resolve => setTimeout(resolve, 50));

		// lastSeen должен быть обновлён (heartbeat вызывает Date.now())
		const lastSeen = state.users.get('alice')!.lastSeen;
		expect(lastSeen).toBeGreaterThan(0);
	});

	// -----------------------------------------------------------------------
	// 2. get_presence
	// -----------------------------------------------------------------------
	it('get_presence возвращает online для зарегистрированных пользователей', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		const presenceBatch = new Promise<unknown>(resolve => {
			alice.on('presence_batch', (d: unknown) => resolve(d));
		});

		alice.emit('get_presence', { userIds: ['alice', 'bob', 'unknown_user'] });

		const result = await presenceBatch;
		expect(result).toMatchObject({
			alice: true,
			bob: true,
			unknown_user: false,
		});
	});

	// -----------------------------------------------------------------------
	// 3. Disconnect → presence offline
	// -----------------------------------------------------------------------
	it('при disconnect рассылается presence { online: false }', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		const presenceOffline = new Promise<unknown>(resolve => {
			bob.on('presence', (data: { userId: string; online: boolean }) => {
				if (data.userId === 'alice' && data.online === false) resolve(data);
			});
		});

		// Отключаем alice
		alice.close();

		const event = await presenceOffline;
		expect(event).toMatchObject({ userId: 'alice', online: false });
	});

	// -----------------------------------------------------------------------
	// 4. cleanupPresence
	// -----------------------------------------------------------------------
	it('cleanupPresence удаляет пользователей с lastSeen > 10 минут', async () => {
		await connectClient(ctx.url, 'alice', 'pk_alice');

		// Устанавливаем lastSeen в прошлое (вручную, чтобы не продвигать fake timers,
		// что нарушило бы Socket.IO ping/pong)
		const aliceData = state.users.get('alice')!;
		aliceData.lastSeen = 0; // Эпоха — гарантированно > 10 минут назад

		// Запускаем cleanupPresence
		ctx.cleanupPresence();

		// alice должна быть удалена из users
		expect(state.users.has('alice')).toBe(false);
	});

	it('cleanupPresence НЕ удаляет активных пользователей', async () => {
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(bob);

		// Обновляем lastSeen
		bob.emit('heartbeat');

		// lastSeen только что обновлён — cleanupPresence не должен удалить bob
		ctx.cleanupPresence();

		// bob должен остаться
		expect(state.users.has('bob')).toBe(true);
	});
});

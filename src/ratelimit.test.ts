/**
 * Integration tests: Rate-limiting
 *
 * Scenarios:
 * 1. call_offer: 1/с → второй в том же окне отклоняется
 * 2. Общий лимит (default 30/с) → 31-й запрос отклоняется
 * 3. Renegotiation bypass: re-offer с существующим callId не rate-limit'ится
 * 4. Разные userId имеют независимые счётчики
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestServer, connectClient } from './test-helpers.js';
import type { TestContext } from './test-helpers.js';
import type { Socket as ClientSocket } from 'socket.io-client';

describe('Rate limiting', () => {
	let ctx: TestContext;
	const clients: ClientSocket[] = [];

	beforeEach(async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		ctx = await createTestServer();
	});

	afterEach(async () => {
		for (const c of clients) {
			if (c.connected) c.close();
		}
		clients.length = 0;
		await ctx.cleanup();
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// 1. call_offer rate-limit: 1/с
	// -----------------------------------------------------------------------
	it('call_offer: 1/с — второй запрос в том же окне отклоняется', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		// Первый offer — должен пройти
		const offerSent = new Promise<unknown>(resolve => {
			alice.on('call_offer_sent', (d: unknown) => resolve(d));
		});
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_1',
			callId: 'call_rl_001',
		});
		await offerSent;

		// Второй offer (без продвижения времени) — rate-limit
		const errPromise = new Promise<unknown>(resolve => {
			alice.on('error', (d: unknown) => resolve(d));
		});
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_2',
			callId: 'call_rl_002',
		});

		const err = await errPromise;
		expect(err).toMatchObject({ message: 'Too many requests' });
	});

	it('call_offer: после истечения окна (1с) лимит сбрасывается', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		// Первый offer
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_1',
			callId: 'call_rl_003',
		});
		await new Promise<void>(resolve => alice.on('call_offer_sent', () => resolve()));

		// Продвигаем время за границу окна
		vi.advanceTimersByTime(1001);

		// Ещё один offer — должен пройти (сброс).
		// Используем офлайн-цель (charlie не зарегистрирован), чтобы
		// не получить 'User is busy' (alice уже в звонке с bob)
		const offerSent2 = new Promise<unknown>(resolve => {
			alice.on('call_offer_sent', (d: unknown) => resolve(d));
		});
		alice.emit('call_offer', {
			targetUserId: 'charlie',
			sdp: 'offer_3',
			callId: 'call_rl_004',
		});
		await offerSent2;
	});

	// -----------------------------------------------------------------------
	// 2. General rate-limit (default 30/с)
	// -----------------------------------------------------------------------
	it('общий лимит 30/с — превышение вызывает ошибку', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		// Отправляем 31 friend_request (быстро, без await между ними)
		const errPromise = new Promise<unknown>(resolve => {
			alice.on('error', (d: unknown) => resolve(d));
		});

		for (let i = 0; i < 31; i++) {
			alice.emit('friend_request', { targetUserId: 'bob' });
		}

		const err = await errPromise;
		expect(err).toMatchObject({ message: 'Rate limited' });
	});

	// -----------------------------------------------------------------------
	// 3. Renegotiation bypass
	// -----------------------------------------------------------------------
	it("renegotiation (re-offer с существующим callId) не rate-limit'ится", async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		// Начальный звонок
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_initial',
			callId: 'call_regoff',
		});
		await new Promise<void>(resolve => bob.on('call_incoming', () => resolve()));
		bob.emit('call_accept', { callId: 'call_regoff', sdp: 'answer' });
		await new Promise<void>(resolve => alice.on('call_accepted', () => resolve()));

		// re-negotiation — тот же callId
		const errorSpy = vi.fn();
		alice.on('error', errorSpy);

		const bobRenego = new Promise<unknown>(resolve => {
			bob.on('call_incoming', (d: unknown) => resolve(d));
		});

		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_renego',
			callId: 'call_regoff',
		});

		await bobRenego;

		// К этому моменту re-offer обработан, ошибок быть не должно
		expect(errorSpy).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// 4. Different users have independent rate-limit counters
	// -----------------------------------------------------------------------
	it('разные userId имеют независимые счётчики rate-limit', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		// alice отправляет offer (использует свой лимит)
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_alice',
			callId: 'call_ind_001',
		});
		await new Promise<void>(resolve => alice.on('call_offer_sent', () => resolve()));

		// bob отправляет offer — должен пройти (свой счётчик)
		// Но bob не может позвонить alice (она уже в звонке). Используем несуществующего пользователя.
		const bobOfferSent = new Promise<unknown>(resolve => {
			bob.on('call_offer_sent', (d: unknown) => resolve(d));
		});
		bob.emit('call_offer', {
			targetUserId: 'nonexistent',
			sdp: 'offer_bob',
			callId: 'call_ind_002',
		});
		await bobOfferSent;

		// alice отправляет ещё один offer — rate-limited (alice уже исчерпала лимит)
		const errPromise = new Promise<unknown>(resolve => {
			alice.on('error', (d: unknown) => resolve(d));
		});
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_alice_2',
			callId: 'call_ind_003',
		});
		const err = await errPromise;
		expect(err).toMatchObject({ message: 'Too many requests' });
	});
});

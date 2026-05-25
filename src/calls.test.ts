/**
 * Integration tests: Voice/Video Calls (Socket.IO call signaling)
 *
 * Scenarios:
 * 1. call_offer → call_incoming + call_offer_sent
 * 2. call_accept → call_accepted
 * 3. call_decline → call_declined
 * 4. call_hangup → call_ended
 * 5. ice_candidate → relay
 * 6. Offline callee → queued, delivered on connect
 * 7. 60s timeout → call_timedout
 * 8. Renegotiation (re-offer with existing callId) → relay, no rate-limit
 * 9. User is busy → error
 * 10. Invalid mediaType → defaults to 'audio'
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { io as ioc } from 'socket.io-client';
import { createTestServer, connectClient } from './test-helpers.js';
import type { TestContext } from './test-helpers.js';
import type { Socket as ClientSocket } from 'socket.io-client';

describe('Calls', () => {
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
	// 1. call_offer → call_incoming + call_offer_sent
	// -----------------------------------------------------------------------
	it('call_offer → callee получает call_incoming, caller получает call_offer_sent', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		const aliceOfferSent = new Promise<unknown>(resolve => {
			alice.on('call_offer_sent', (d: unknown) => resolve(d));
		});
		const bobIncoming = new Promise<unknown>(resolve => {
			bob.on('call_incoming', (d: unknown) => resolve(d));
		});

		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_sdp_123',
			callId: 'call_001',
			mediaType: 'audio',
		});

		const offerSent = await aliceOfferSent;
		expect(offerSent).toMatchObject({
			callId: 'call_001',
			targetUserId: 'bob',
			mediaType: 'audio',
		});

		const incoming = await bobIncoming;
		expect(incoming).toMatchObject({
			callId: 'call_001',
			fromUserId: 'alice',
			sdp: 'offer_sdp_123',
			mediaType: 'audio',
		});
	});

	// -----------------------------------------------------------------------
	// 2. call_accept → call_accepted
	// -----------------------------------------------------------------------
	it('call_accept → caller получает call_accepted', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		// alice звонит
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer',
			callId: 'call_002',
		});
		await new Promise<void>(resolve => bob.on('call_incoming', () => resolve()));

		// bob принимает
		const aliceAccepted = new Promise<unknown>(resolve => {
			alice.on('call_accepted', (d: unknown) => resolve(d));
		});
		bob.emit('call_accept', { callId: 'call_002', sdp: 'answer_sdp' });

		const accepted = await aliceAccepted;
		expect(accepted).toMatchObject({ callId: 'call_002', sdp: 'answer_sdp' });
	});

	// -----------------------------------------------------------------------
	// 3. call_decline → call_declined
	// -----------------------------------------------------------------------
	it('call_decline → caller получает call_declined', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer',
			callId: 'call_003',
		});
		await new Promise<void>(resolve => bob.on('call_incoming', () => resolve()));

		const aliceDeclined = new Promise<unknown>(resolve => {
			alice.on('call_declined', (d: unknown) => resolve(d));
		});
		bob.emit('call_decline', { callId: 'call_003' });

		const declined = await aliceDeclined;
		expect(declined).toMatchObject({ callId: 'call_003', reason: 'declined' });
	});

	// -----------------------------------------------------------------------
	// 4. call_hangup → call_ended
	// -----------------------------------------------------------------------
	it('call_hangup → другая сторона получает call_ended', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		// Устанавливаем звонок
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer',
			callId: 'call_004',
		});
		await new Promise<void>(resolve => bob.on('call_incoming', () => resolve()));
		bob.emit('call_accept', { callId: 'call_004', sdp: 'answer' });
		await new Promise<void>(resolve => alice.on('call_accepted', () => resolve()));

		// alice завершает звонок
		const bobEnded = new Promise<unknown>(resolve => {
			bob.on('call_ended', (d: unknown) => resolve(d));
		});
		alice.emit('call_hangup', { callId: 'call_004' });

		const ended = await bobEnded;
		expect(ended).toMatchObject({ callId: 'call_004', endedBy: 'alice' });
		expect(ended).toHaveProperty('duration');
	});

	// -----------------------------------------------------------------------
	// 5. ice_candidate relay
	// -----------------------------------------------------------------------
	it('ice_candidate ретранслируется другому участнику', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer',
			callId: 'call_005',
		});
		await new Promise<void>(resolve => bob.on('call_incoming', () => resolve()));
		bob.emit('call_accept', { callId: 'call_005', sdp: 'answer' });
		await new Promise<void>(resolve => alice.on('call_accepted', () => resolve()));

		// alice отправляет ICE candidate
		const bobIce = new Promise<unknown>(resolve => {
			bob.on('ice_candidate', (d: unknown) => resolve(d));
		});
		alice.emit('ice_candidate', { callId: 'call_005', candidate: 'candidate_1' });

		const ice = await bobIce;
		expect(ice).toMatchObject({ callId: 'call_005', candidate: 'candidate_1' });
	});

	// -----------------------------------------------------------------------
	// 6. Offline callee
	// -----------------------------------------------------------------------
	it('звонок офлайн-пользователю ставится в очередь и доставляется при подключении', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		clients.push(alice);

		// alice звонит bob (офлайн)
		const aliceOfferSent = new Promise<unknown>(resolve => {
			alice.on('call_offer_sent', (d: unknown) => resolve(d));
		});
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_offline',
			callId: 'call_offline_001',
		});
		await aliceOfferSent;

		// bob подключается — должен получить входящий звонок
		const bobIncoming = new Promise<unknown>(resolve => {
			const bob = ioc(ctx.url, { transports: ['websocket'], forceNew: true });
			bob.on('connect', () => {
				bob.on('call_incoming', (d: unknown) => {
					resolve(d);
				});
				bob.emit('register', { userId: 'bob', publicKey: 'pk_bob' });
			});
			clients.push(bob);
		});

		const incoming = await bobIncoming;
		expect(incoming).toMatchObject({
			callId: 'call_offline_001',
			fromUserId: 'alice',
			sdp: 'offer_offline',
		});
	});

	// -----------------------------------------------------------------------
	// 7. Call timeout (via cleanupCall)
	//
	// NOTE: Прямое продвижение fake timers на 60+ секунд конфликтует с
	// Socket.IO pingInterval(25s)/pingTimeout(20s) — соединение разрывается
	// раньше срабатывания таймаута звонка. Поэтому тестируем timeout через
	// прямой вызов cleanupCall (та же логика).
	// -----------------------------------------------------------------------
	it("cleanupCall с reason=no_answer отправляет call_timedout caller'у", async () => {
		// Импортируем cleanupCall из server.js (уже загружен module-level кодом)
		const { cleanupCall } = await import('./server.js');

		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer',
			callId: 'call_timeout_001',
		});
		await new Promise<void>(resolve => bob.on('call_incoming', () => resolve()));

		// Проверяем, что таймаут установлен
		const { activeCalls } = await import('./state.js');
		const session = activeCalls.get('call_timeout_001')!;
		expect(session.timeoutHandle).not.toBeNull();

		// Прямой вызов cleanupCall — эмулирует таймаут
		const timedout = new Promise<unknown>(resolve => {
			alice.on('call_timedout', (d: unknown) => resolve(d));
		});

		cleanupCall('call_timeout_001', 'no_answer');

		const result = await timedout;
		expect(result).toMatchObject({ callId: 'call_timeout_001', reason: 'no_answer' });
	});

	// -----------------------------------------------------------------------
	// 8. Renegotiation (re-offer)
	// -----------------------------------------------------------------------
	it('renegotiation (повторный offer с существующим callId) ретранслируется без rate-limit', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		// Начальный звонок
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_initial',
			callId: 'call_renego_001',
		});
		await new Promise<void>(resolve => bob.on('call_incoming', () => resolve()));
		bob.emit('call_accept', { callId: 'call_renego_001', sdp: 'answer' });
		await new Promise<void>(resolve => alice.on('call_accepted', () => resolve()));

		// Устанавливаем шпион ошибок ДО re-negotiation
		const errorSpy = vi.fn();
		alice.on('error', errorSpy);

		// re-negotiation (ICE restart) — тот же callId
		const bobRenego = new Promise<unknown>(resolve => {
			bob.on('call_incoming', (d: unknown) => resolve(d));
		});

		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_renego',
			callId: 'call_renego_001',
		});

		const renego = await bobRenego;
		expect(renego).toMatchObject({
			callId: 'call_renego_001',
			fromUserId: 'alice',
			sdp: 'offer_renego',
		});

		// Проверяем, что rate-limit НЕ сработал (re-offer его обходит)
		expect(errorSpy).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// 9. User is busy
	// -----------------------------------------------------------------------
	it('звонок занятому пользователю → ошибка `User is busy`', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		const charlie = await connectClient(ctx.url, 'charlie', 'pk_charlie');
		clients.push(alice, bob, charlie);

		// alice звонит bob
		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer',
			callId: 'call_busy_001',
		});
		await new Promise<void>(resolve => bob.on('call_incoming', () => resolve()));

		// charlie пытается позвонить bob
		const charlieError = new Promise<unknown>(resolve => {
			charlie.on('error', (d: unknown) => resolve(d));
		});

		charlie.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer_from_charlie',
			callId: 'call_busy_002',
		});

		const err = await charlieError;
		expect(err).toMatchObject({ message: 'User is busy' });
	});

	// -----------------------------------------------------------------------
	// 10. Invalid mediaType → defaults to 'audio'
	// -----------------------------------------------------------------------
	it('невалидный mediaType → звонок создаётся как audio', async () => {
		const alice = await connectClient(ctx.url, 'alice', 'pk_alice');
		const bob = await connectClient(ctx.url, 'bob', 'pk_bob');
		clients.push(alice, bob);

		const bobIncoming = new Promise<unknown>(resolve => {
			bob.on('call_incoming', (d: unknown) => resolve(d));
		});

		alice.emit('call_offer', {
			targetUserId: 'bob',
			sdp: 'offer',
			callId: 'call_mediatype_001',
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			mediaType: 'invalid_value' as any,
		});

		const incoming = await bobIncoming;
		expect(incoming).toMatchObject({
			callId: 'call_mediatype_001',
			mediaType: 'audio',
		});
	});
});

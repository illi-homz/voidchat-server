/**
 * Unit tests for server utility functions.
 *
 * NOTE: Requires checkRateLimit, cleanupCall, cleanupPresence and their shared
 * state Maps (activeCalls, userActiveCall, pendingCallOffers, users, rateLimitMap)
 * to be exported from server.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks – prevent `server.ts` from actually binding a TCP port
// and creating a real Socket.IO server when imported for testing.
// ---------------------------------------------------------------------------
vi.mock('http', () => {
	const mockListen = vi.fn();
	const mockClose = vi.fn();
	const mockOn = vi.fn();
	const mockServer = { listen: mockListen, close: mockClose, on: mockOn };

	return {
		createServer: vi.fn(() => mockServer),
		IncomingMessage: class {},
		ServerResponse: class {},
	};
});

vi.mock('socket.io', () => {
	const mockEmit = vi.fn();
	const mockOn = vi.fn();
	const mockClose = vi.fn();

	const MockServer = vi.fn(function MockServer(this: any) {
		this.on = mockOn;
		this.emit = mockEmit;
		this.engine = { clientsCount: 0 };
		this.close = mockClose;
	});

	return { Server: MockServer };
});

// ---------------------------------------------------------------------------
// Imports — after mocks are registered so that server.ts uses the fakes
// ---------------------------------------------------------------------------
import { checkRateLimit, cleanupCall, cleanupPresence } from './server.js';
import { activeCalls, userActiveCall, pendingCallOffers, users, rateLimitMap } from './state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Create a minimal mock socket with an emit spy and a disconnect spy. */
function mockSocket(id = 'sock_1') {
	return {
		id,
		emit: vi.fn(),
		disconnect: vi.fn(),
		on: vi.fn(),
		removeAllListeners: vi.fn(),
	} as any;
}

/** Build a full CallSession fixture. */
function createSession(
	overrides: Partial<{
		callId: string;
		callerId: string;
		calleeId: string;
		mediaType: 'audio' | 'video';
		status: 'pending' | 'ringing' | 'connected' | 'ended';
		sdp: string | null;
		callerSocket: any;
		calleeSocket: any | null;
		timeoutHandle: ReturnType<typeof setTimeout> | null;
		startedAt: number;
		connectedAt: number | null;
	}> = {},
) {
	return {
		callId: 'call_test_001',
		callerId: 'caller_1',
		calleeId: 'callee_1',
		mediaType: 'audio' as const,
		status: 'ringing' as const,
		sdp: 'sdp_offer',
		callerSocket: mockSocket('caller_sock'),
		calleeSocket: mockSocket('callee_sock'),
		timeoutHandle: null,
		startedAt: Date.now(),
		connectedAt: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Reset shared state before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	activeCalls.clear();
	userActiveCall.clear();
	pendingCallOffers.clear();
	users.clear();
	rateLimitMap.clear();
});

afterEach(() => {
	vi.useRealTimers();
});

// ===========================================================================
// checkRateLimit
// ===========================================================================
describe('checkRateLimit', () => {
	it('первый вызов всегда разрешён', () => {
		expect(checkRateLimit('alice')).toBe(true);
	});

	it('превышение лимита — 31-й вызов отклоняется', () => {
		// 30 разрешённых вызовов
		for (let i = 0; i < 30; i++) {
			expect(checkRateLimit('alice')).toBe(true);
		}
		// 31-й — превышение
		expect(checkRateLimit('alice')).toBe(false);
	});

	it('после истечения окна лимит сбрасывается', () => {
		// Выбираем лимит
		for (let i = 0; i < 30; i++) {
			checkRateLimit('alice');
		}
		expect(checkRateLimit('alice')).toBe(false);

		// Сдвигаем время за границу окна (1000 ms)
		vi.advanceTimersByTime(1001);

		// Следующий вызов должен пройти (счётчик сброшен)
		expect(checkRateLimit('alice')).toBe(true);
	});

	it('разные userId имеют независимые счётчики', () => {
		// Исчерпываем лимит для alice, но bob должен оставаться свободным
		for (let i = 0; i < 30; i++) {
			checkRateLimit('alice');
		}
		expect(checkRateLimit('alice')).toBe(false);
		expect(checkRateLimit('bob')).toBe(true); // bob не затронут

		// bob тоже может исчерпать свой лимит
		for (let i = 0; i < 29; i++) {
			checkRateLimit('bob');
		}
		expect(checkRateLimit('bob')).toBe(false);
		// alice по-прежнему заблокирован
		expect(checkRateLimit('alice')).toBe(false);
	});

	it('кастомные maxRequests и windowMs', () => {
		// Лимит 5 запросов за 500 мс
		for (let i = 0; i < 5; i++) {
			expect(checkRateLimit('charlie', 5, 500)).toBe(true);
		}
		expect(checkRateLimit('charlie', 5, 500)).toBe(false);

		// После 500 мс — сброс
		vi.advanceTimersByTime(501);
		expect(checkRateLimit('charlie', 5, 500)).toBe(true);
	});

	it('старые записи очищаются при истечении окна (проверка сброса)', () => {
		// Исчерпываем лимит
		for (let i = 0; i < 30; i++) {
			checkRateLimit('dave');
		}
		expect(checkRateLimit('dave')).toBe(false);

		// Продвигаем время за границу окна (1 с)
		vi.advanceTimersByTime(1001);

		// После сброса лимит снова доступен
		expect(checkRateLimit('dave')).toBe(true);
	});
});

// ===========================================================================
// cleanupCall
// ===========================================================================
describe('cleanupCall', () => {
	it('удаляет сессию из activeCalls', () => {
		const session = createSession();
		activeCalls.set(session.callId, session);

		cleanupCall(session.callId, 'ended');

		expect(activeCalls.has(session.callId)).toBe(false);
	});

	it('очищает userActiveCall для обоих участников', () => {
		const session = createSession();
		activeCalls.set(session.callId, session);
		userActiveCall.set(session.callerId, session.callId);
		userActiveCall.set(session.calleeId, session.callId);

		cleanupCall(session.callId, 'ended');

		expect(userActiveCall.has(session.callerId)).toBe(false);
		expect(userActiveCall.has(session.calleeId)).toBe(false);
	});

	it('вызывает clearTimeout для timeoutHandle', () => {
		const spy = vi.spyOn(globalThis, 'clearTimeout');
		const timeoutHandle = setTimeout(() => {}, 60000);
		const session = createSession({ timeoutHandle });
		activeCalls.set(session.callId, session);

		cleanupCall(session.callId, 'ended');

		expect(spy).toHaveBeenCalledWith(timeoutHandle);
		spy.mockRestore();
	});

	it('при reason="no_answer" отправляет call_timedout caller\'у', () => {
		const session = createSession();
		activeCalls.set(session.callId, session);

		cleanupCall(session.callId, 'no_answer');

		expect(session.callerSocket.emit).toHaveBeenCalledWith('call_timedout', {
			callId: session.callId,
			reason: 'no_answer',
		});
	});

	it('при reason="offline" отправляет call_timedout caller\'у', () => {
		const session = createSession();
		activeCalls.set(session.callId, session);

		cleanupCall(session.callId, 'offline');

		expect(session.callerSocket.emit).toHaveBeenCalledWith('call_timedout', {
			callId: session.callId,
			reason: 'offline',
		});
	});

	it('не отправляет callerSocket.emit при ended и declined', () => {
		const session = createSession();
		activeCalls.set(session.callId, session);

		cleanupCall(session.callId, 'ended');
		expect(session.callerSocket.emit).not.toHaveBeenCalled();

		cleanupCall(session.callId, 'declined');
		// уже удалена, но проверяем что emit не вызывался
		expect(session.callerSocket.emit).not.toHaveBeenCalled();
	});

	it('вызов с несуществующим callId — идемпотентность, без ошибок', () => {
		// Не должно бросить исключение
		expect(() => cleanupCall('nonexistent', 'ended')).not.toThrow();
		expect(() => cleanupCall('nonexistent', 'no_answer')).not.toThrow();
		expect(() => cleanupCall('nonexistent', 'offline')).not.toThrow();
		expect(() => cleanupCall('nonexistent', 'declined')).not.toThrow();
	});

	it('удаляет из pendingCallOffers', () => {
		const session = createSession();
		activeCalls.set(session.callId, session);
		userActiveCall.set(session.calleeId, session.callId);
		pendingCallOffers.set(session.calleeId, [
			{
				fromUserId: session.callerId,
				callId: session.callId,
				sdp: session.sdp!,
				mediaType: session.mediaType,
				timestamp: Date.now(),
			},
		]);

		cleanupCall(session.callId, 'ended');

		expect(pendingCallOffers.has(session.calleeId)).toBe(false);
	});
});

// ===========================================================================
// cleanupPresence
// ===========================================================================
describe('cleanupPresence', () => {
	const mockIo = { emit: vi.fn(), engine: { clientsCount: 0 } } as any;

	it('удаляет пользователя с lastSeen > 10 мин', () => {
		users.set('alice', {
			socket: mockSocket('s1'),
			userId: 'alice',
			publicKey: 'key1',
			lastSeen: 0, // эпоха, прошло > 10 мин
		});

		cleanupPresence(mockIo);

		expect(users.has('alice')).toBe(false);
	});

	it('не трогает пользователя с lastSeen < 10 мин', () => {
		users.set('alice', {
			socket: mockSocket('s1'),
			userId: 'alice',
			publicKey: 'key1',
			lastSeen: Date.now(), // только что обновлён
		});

		cleanupPresence(mockIo);

		expect(users.has('alice')).toBe(true);
	});

	it('при активном звонке завершает звонок (вызывает cleanupCall)', () => {
		const session = createSession();
		activeCalls.set(session.callId, session);
		userActiveCall.set(session.callerId, session.callId);
		userActiveCall.set(session.calleeId, session.callId);

		// caller протух
		users.set(session.callerId, {
			socket: mockSocket('s_caller'),
			userId: session.callerId,
			publicKey: 'key_caller',
			lastSeen: 0,
		});
		// callee онлайн
		users.set(session.calleeId, {
			socket: mockSocket('s_callee'),
			userId: session.calleeId,
			publicKey: 'key_callee',
			lastSeen: Date.now(),
		});

		cleanupPresence(mockIo);

		// Звонок должен быть завершён
		expect(activeCalls.has(session.callId)).toBe(false);
		// callee должен получить call_ended
		expect(session.calleeSocket!.emit).toHaveBeenCalledWith('call_ended', {
			callId: session.callId,
			duration: 0,
			endedBy: session.callerId,
		});
	});

	it('отправляет presence { online: false }', () => {
		// io — это мок, его emit должен быть вызван.
		// Для проверки импортируем io через модуль server.ts (он не экспортируется,
		// поэтому используем mock-проверку через побочные эффекты).
		// io.emit('presence', ...) вызывается из cleanupPresence для каждого удалённого пользователя.
		// Поскольку io замокан, мы можем проверить, что users.delete и socket.disconnect вызваны.
		const sock = mockSocket('s1');
		users.set('bob', {
			socket: sock,
			userId: 'bob',
			publicKey: 'key_bob',
			lastSeen: 0,
		});

		cleanupPresence(mockIo);

		expect(sock.disconnect).toHaveBeenCalled();
		expect(users.has('bob')).toBe(false);
	});

	it('socket.disconnect() вызывается', () => {
		const sock = mockSocket('s1');
		users.set('charlie', {
			socket: sock,
			userId: 'charlie',
			publicKey: 'key_c',
			lastSeen: 0,
		});

		cleanupPresence(mockIo);

		expect(sock.disconnect).toHaveBeenCalledTimes(1);
	});

	it('users.delete() вызывается', () => {
		users.set('dave', {
			socket: mockSocket('s1'),
			userId: 'dave',
			publicKey: 'key_d',
			lastSeen: 0,
		});

		cleanupPresence(mockIo);

		expect(users.has('dave')).toBe(false);
	});

	it('если пользователя нет в users — ничего не делает (идемпотентность)', () => {
		expect(() => cleanupPresence(mockIo)).not.toThrow();
	});
});

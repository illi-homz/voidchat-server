/**
 * Test helpers for voidchat-server Socket.IO integration tests.
 *
 * Provides:
 * - createTestServer() — creates a real HTTP+Socket.IO server on a random port
 * - connectClient() — connects a socket.io-client and registers a userId
 * - TestContext — holds server, io, url, and cleanup functions
 */

import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import type { Server as HttpServer } from 'http';
import type { Server as SocketIOServer } from 'socket.io';
import * as state from './state.js';

export interface TestContext {
	server: HttpServer;
	io: SocketIOServer;
	url: string;
	rateLimitInterval: ReturnType<typeof setInterval>;
	presenceInterval: ReturnType<typeof setInterval>;
	cleanupPresence: () => void;
	cleanup: () => Promise<void>;
}

/**
 * Creates an HTTP server + Socket.IO server on a random available port.
 * Returns a TestContext with cleanup helpers.
 *
 * Each call creates a completely new server instance bound to a new port.
 * Shared state (Maps from state.ts) is NOT reset here — callers should
 * clear state between tests via ctx.cleanup().
 */
export async function createTestServer(): Promise<TestContext> {
	const http = await import('http');
	const serverMod = await import('./server.js');
	const { createApp } = serverMod;

	const httpServer = http.createServer();
	const { io, rateLimitInterval, presenceInterval } = createApp(httpServer);

	return new Promise<TestContext>((resolve, reject) => {
		httpServer.on('error', reject);

		httpServer.listen(0, () => {
			const addr = httpServer.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			const url = `http://localhost:${port}`;

			resolve({
				server: httpServer,
				io,
				url,
				rateLimitInterval,
				presenceInterval,
				cleanupPresence: () => serverMod.cleanupPresence(io),
				cleanup: async () => {
					// 0. Очищаем интервалы (иначе vitest worker не завершится)
					clearInterval(rateLimitInterval);
					clearInterval(presenceInterval);

					// 1. Закрываем Socket.IO с таймаутом (force close)
					await new Promise<void>(resolve => {
						const timer = setTimeout(() => resolve(), 2000);
						io.close(() => {
							clearTimeout(timer);
							resolve();
						});
					});

					// 2. Закрываем HTTP-сервер с таймаутом
					await new Promise<void>(resolve => {
						const timer = setTimeout(() => resolve(), 2000);
						httpServer.close(() => {
							clearTimeout(timer);
							resolve();
						});
					});

					// 3. Очищаем state
					state.users.clear();
					state.pendingMessages.clear();
					state.activeCalls.clear();
					state.userActiveCall.clear();
					state.pendingFriendRequests.clear();
					state.pendingFriendAccepts.clear();
					state.pendingCallOffers.clear();
					state.pendingAutoFriends.clear();
					state.rateLimitMap.clear();
				},
			});
		});
	});
}

/**
 * Connects a socket.io-client to the given url, waits for the 'connect' event,
 * then emits 'register' and waits for 'registered'.
 *
 * Returns the connected and registered client socket.
 */
export async function connectClient(
	url: string,
	userId: string,
	publicKey = 'test_pk',
): Promise<ClientSocket> {
	const client = ioc(url, {
		transports: ['websocket'],
		forceNew: true,
	});

	await new Promise<void>((resolve, reject) => {
		client.on('connect', () => resolve());
		client.on('connect_error', (err: Error) => reject(err));
	});

	client.emit('register', { userId, publicKey });

	await new Promise<void>((resolve, reject) => {
		client.on('registered', () => resolve());
		client.on('error', (err: { message: string }) => reject(new Error(err.message)));
		// Safety timeout — should not trigger in normal flow
		setTimeout(() => reject(new Error('register timeout')), 2000);
	});

	return client;
}

/**
 * Connects a socket.io-client WITHOUT registering.
 * Useful for testing "Not registered" errors.
 */
export async function connectClientWithoutRegister(url: string): Promise<ClientSocket> {
	const client = ioc(url, {
		transports: ['websocket'],
		forceNew: true,
	});

	await new Promise<void>((resolve, reject) => {
		client.on('connect', () => resolve());
		client.on('connect_error', (err: Error) => reject(err));
	});

	return client;
}

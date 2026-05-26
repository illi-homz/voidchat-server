/**
 * Prometheus-метрики для VoidChat сервера.
 *
 * Активируются через переменную окружения METRICS_ENABLED=true.
 * Если метрики выключены — все функции работают как no-op заглушки.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { METRICS_ENABLED, STARTED_AT } from './config.js';
import promClient from 'prom-client';
import { logger } from './logger.js';

export const metricsEnabled = METRICS_ENABLED;

// ---- Metric instances (только если метрики включены) ----

let registry: promClient.Registry | null = null;
let connectionsGauge: promClient.Gauge<string> | null = null;
let usersGauge: promClient.Gauge<string> | null = null;
let activeCallsGauge: promClient.Gauge<string> | null = null;
let messagesCounter: promClient.Counter<string> | null = null;
let errorsCounter: promClient.Counter<string> | null = null;
let uptimeGauge: promClient.Gauge<string> | null = null;
let memoryGauge: promClient.Gauge<string> | null = null;
let eventsCounter: promClient.Counter<string> | null = null;

/** Ссылки на interval'ы для cleanup при graceful shutdown */
let metricsIntervals: ReturnType<typeof setInterval>[] = [];
let initialized = false;

/**
 * Инициализировать prom-client registry и все метрики.
 * Безопасно вызывать многократно — повторный вызов игнорируется.
 */
export function initMetrics(): void {
	if (!metricsEnabled || initialized) return;
	initialized = true;

	registry = new promClient.Registry();

	// Базовые Node.js метрики (event loop lag, gc, handles и т.д.)
	promClient.collectDefaultMetrics({ register: registry });

	connectionsGauge = new promClient.Gauge({
		name: 'voidchat_connections_total',
		help: 'Current number of Socket.IO connections',
		registers: [registry],
	});

	usersGauge = new promClient.Gauge({
		name: 'voidchat_users_online',
		help: 'Registered users',
		registers: [registry],
	});

	activeCallsGauge = new promClient.Gauge({
		name: 'voidchat_active_calls',
		help: 'Active calls',
		registers: [registry],
	});

	messagesCounter = new promClient.Counter({
		name: 'voidchat_messages_relayed_total',
		help: 'Total relayed messages',
		registers: [registry],
	});

	errorsCounter = new promClient.Counter({
		name: 'voidchat_errors_total',
		help: 'Errors by event type',
		labelNames: ['type'],
		registers: [registry],
	});

	uptimeGauge = new promClient.Gauge({
		name: 'voidchat_uptime_seconds',
		help: 'Server uptime in seconds',
		registers: [registry],
	});

	memoryGauge = new promClient.Gauge({
		name: 'voidchat_memory_bytes',
		help: 'Process memory',
		labelNames: ['type'],
		registers: [registry],
	});

	eventsCounter = new promClient.Counter({
		name: 'voidchat_events_total',
		help: 'Counters by event type',
		labelNames: ['event'],
		registers: [registry],
	});

	// Обновление uptime и memory каждые 10 секунд
	const updateInterval = setInterval(() => {
		if (uptimeGauge) {
			uptimeGauge.set(Math.floor((Date.now() - STARTED_AT) / 1000));
		}
		if (memoryGauge) {
			const mem = process.memoryUsage();
			memoryGauge.set({ type: 'rss' }, mem.rss);
			memoryGauge.set({ type: 'heapTotal' }, mem.heapTotal);
			memoryGauge.set({ type: 'heapUsed' }, mem.heapUsed);
		}
	}, 10000);
	metricsIntervals.push(updateInterval);
}

/**
 * HTTP-обработчик для GET /metrics.
 * Отдаёт метрики в формате Prometheus (text/plain).
 */
export async function metricsHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (!metricsEnabled || !registry) {
		res.writeHead(501, { 'Content-Type': 'text/plain' });
		res.end('Metrics not enabled');
		return;
	}

	try {
		const metrics = await registry.metrics();
		res.writeHead(200, {
			'Content-Type': 'text/plain; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET',
		});
		res.end(metrics);
	} catch (err) {
		logger.error({ err }, 'Failed to collect metrics');
		res.writeHead(500, { 'Content-Type': 'text/plain' });
		res.end('Internal error');
	}
}

/** Инкрементировать счётчик событий */
export function incEvent(event: string): void {
	if (!metricsEnabled || !eventsCounter) return;
	eventsCounter.inc({ event });
}

/** Инкрементировать счётчик ошибок по типу события */
export function incError(type: string): void {
	if (!metricsEnabled || !errorsCounter) return;
	errorsCounter.inc({ type });
}

/** Инкрементировать счётчик пересланных сообщений */
export function incMessage(): void {
	if (!metricsEnabled || !messagesCounter) return;
	messagesCounter.inc();
}

/** Обновить gauge'и соединений, пользователей и звонков */
export function updateConnections(connections: number, users: number, activeCalls: number): void {
	if (!metricsEnabled || !registry) return;
	if (connectionsGauge) connectionsGauge.set(connections);
	if (usersGauge) usersGauge.set(users);
	if (activeCallsGauge) activeCallsGauge.set(activeCalls);
}

/** Остановить все interval'ы метрик (вызывается при graceful shutdown) */
export function stopMetrics(): void {
	for (const interval of metricsIntervals) {
		clearInterval(interval);
	}
	metricsIntervals = [];
}

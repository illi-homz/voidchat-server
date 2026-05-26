/**
 * Sentry/GlitchTip error tracking integration.
 *
 * Активируется через переменную окружения `SENTRY_DSN`.
 * Если DSN пустой — все функции работают как no-op (только console.error).
 *
 * Совместимость: GlitchTip (любой Sentry-совместимый сервер).
 *
 * @module sentry
 */

import * as Sentry from '@sentry/node';
import { createRequire } from 'module';
import { SENTRY_DSN } from './config.js';
import { logger } from './logger.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

/** Флаг: включён ли Sentry (SENTRY_DSN задан) */
export const sentryEnabled = Boolean(SENTRY_DSN);

/** Флаг: был ли вызван initSentry() */
let initialized = false;

/**
 * Инициализирует Sentry/GlitchTip SDK.
 * Должен быть вызван до старта HTTP-сервера и до регистрации process-обработчиков.
 * Если SENTRY_DSN пуст — ничего не делает.
 */
export function initSentry(): void {
	if (!sentryEnabled || initialized) return;

	Sentry.init({
		dsn: SENTRY_DSN,
		environment: process.env.SENTRY_ENVIRONMENT || 'production',
		release: `v${version}`,
		tracesSampleRate: 0, // только error tracking, без performance tracing
	});

	initialized = true;
	console.log('[sentry] Sentry/GlitchTip error tracking initialized');
}

/**
 * Захватывает ошибку: логирует через logger.error и, если Sentry включён,
 * отправляет её в Sentry/GlitchTip с указанным контекстом.
 *
 * @param err - объект ошибки или неизвестное значение
 * @param context - произвольный контекст (event, userId и т.д.)
 */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
	const eventName = context?.event ? String(context.event) : 'sentry';

	logger.error({ err, context }, `[${eventName}] Error`);

	if (sentryEnabled && initialized) {
		Sentry.captureException(err, { extra: context });
	}
}

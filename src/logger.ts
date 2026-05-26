/* eslint-disable indent -- prettier manages indentation; indent rule conflicts with prettier for multi-line ternary */
/**
 * Pino-логгер с env-конфигурацией.
 *
 * Читает LOG_LEVEL и LOG_FORMAT из ./config.js для настройки уровня
 * логирования и формата вывода (pretty или JSON).
 *
 * Примеры использования:
 * ```typescript
 * import { logger } from './logger.js';
 *
 * // Информационное сообщение
 * logger.info({ event: 'startup', port }, 'Server starting');
 *
 * // Ошибка с контекстом
 * logger.error({ err, userId }, 'Failed to process event');
 *
 * // Дочерний логгер для компонента
 * const myLogger = createChildLogger('myComponent');
 * myLogger.info('Component initialized');
 * ```
 */

import pino from 'pino';
import { LOG_LEVEL, LOG_FORMAT } from './config.js';

/**
 * Транспорт для pretty-печати (pino-pretty).
 * Включается только если LOG_FORMAT === 'pretty'.
 */
const transport =
	LOG_FORMAT === 'pretty'
		? pino.transport({
				target: 'pino-pretty',
				options: {
					colorize: true,
					translateTime: 'HH:MM:ss.l',
				},
			})
		: undefined;

/**
 * Корневой Pino-логгер.
 *
 * - В pretty-режиме: цветной человекочитаемый вывод с таймстемпами.
 * - В json-режиме: чистый JSON-вывод (для продакшена / лог-агрегаторов).
 * - При LOG_LEVEL='silent': полное отключение логов.
 */
export const logger = transport
	? pino({ level: LOG_LEVEL as pino.LevelWithSilent }, transport)
	: pino({ level: LOG_LEVEL as pino.LevelWithSilent });

/**
 * Создаёт дочерний логгер с привязкой к указанному компоненту.
 *
 * Все записи дочернего логгера будут содержать поле `component`,
 * что упрощает фильтрацию и анализ логов в production-среде.
 *
 * @param component — имя компонента (например, 'calls', 'friends', 'messages')
 * @returns Дочерний Pino-логгер
 *
 * @example
 * const callLogger = createChildLogger('calls');
 * callLogger.info({ callId, userId }, 'Call initiated');
 */
export function createChildLogger(component: string): pino.Logger {
	return logger.child({ component });
}

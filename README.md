# VoidChat Server

Эфемерный E2E зашифрованный чат relay сервер. Без базы данных — все данные хранятся в оперативной памяти и удаляются при перезапуске сервера.

## Быстрый старт

```bash
npm install
npm run build
npm start
```

Для разработки с hot-reload:

```bash
npm run dev
```

Сервер запускается на порту `9001` по умолчанию. Изменить через переменную окружения `PORT`.

## Деплой на VPS

На свежий Ubuntu/Debian сервер:

```bash
curl -sS https://raw.githubusercontent.com/illi-homz/voidchat-server/main/deploy.sh | bash
```

Скрипт автоматически установит Node.js, зависимости, соберёт TypeScript, настроит UFW, запустит сервер через pm2, а также:

- Настроит системные лимиты open files (65536) для Socket.IO
- Настроит лог-ротацию (pm2-logrotate, 10 MB, 7 дней, сжатие)
- Настроит автозапуск pm2 через systemd (переживёт reboot)
- Добавит health-check endpoint

## Архитектура

- **Runtime**: Node.js + TypeScript, ESM (`"type": "module"`)
- **Real-time**: Socket.IO (WebSocket с fallback на polling)
- **Отслеживание присутствия**: In-memory Map с таймаутом 10 минут
- **Персистентность данных**: Отсутствует (намеренно эфемерно)

## События Socket.IO

Полная спецификация: `swagger.yaml`.

### Клиент → Сервер

| Событие | Payload | Описание |
|---------|---------|----------|
| `register` | `{ userId: string, publicKey?: string }` | Регистрация присутствия пользователя |
| `heartbeat` | — | Поддержание соединения, сброс 10-минутного таймаута |
| `get_presence` | `{ userIds: string[] }` | Проверить статус онлайн нескольких пользователей |
| `friend_request` | `{ targetUserId: string }` | Отправить запрос дружбы |
| `friend_accept` | `{ targetUserId: string }` | Принять запрос дружбы |
| `friend_decline` | `{ targetUserId: string }` | Отклонить запрос дружбы |
| `message` | `{ to: string, ciphertext: string, nonce: string }` | Отправить зашифрованное сообщение |
| `messages_read` | `{ from: string, contactId: string }` | Уведомление о прочтении сообщений |
| `call_offer` | `{ targetUserId, sdp, callId? }` | Инициация звонка или renegotiation (ICE restart) |
| `call_accept` | `{ callId, sdp }` | Принятие звонка или renegotiation answer |
| `call_decline` | `{ callId }` | Отклонение звонка |
| `call_hangup` | `{ callId }` | Завершение звонка |
| `ice_candidate` | `{ callId, candidate }` | Передача ICE кандидата |
| `claim_invite` | `{ inviterUserId }` | Подтверждение приглашения на сервер |

### Сервер → Клиент

| Событие | Payload | Описание |
|---------|---------|----------|
| `registered` | `{ userId: string }` | Регистрация подтверждена |
| `error` | `{ message: string }` | Произошла ошибка |
| `kicked` | `{ message: string }` | Отключён из-за дублирующего входа |
| `presence` | `{ userId: string, online: boolean }` | Обновление присутствия пользователя |
| `presence_batch` | `Record<string, boolean>` | Пакетный ответ о присутствии |
| `friend_request` | `{ fromUserId: string, fromPublicKey: string \| null }` | Входящий запрос дружбы |
| `friend_request_sent` | `{ targetUserId: string, targetPublicKey: string \| null }` | Запрос дружбы доставлен |
| `friend_accepted` | `{ fromUserId: string, fromPublicKey: string \| null }` | Запрос дружбы принят |
| `friend_confirmed` | `{ targetUserId: string, targetPublicKey: string \| null }` | Дружба установлена |
| `friend_declined` | `{ fromUserId: string }` | Запрос дружбы отклонён |
| `message` | `{ from: string, ciphertext: string, nonce: string, timestamp: number }` | Входящее зашифрованное сообщение |
| `message_sent` | `{ to: string, ciphertext: string, nonce: string, timestamp: number }` | Подтверждение доставки сообщения |
| `message_failed` | `{ to: string, nonce: string, reason: string }` | Доставка сообщения не удалась |
| `messages_read` | `{ readBy: string }` | Собеседник прочитал сообщения |
| `call_incoming` | `{ callId, fromUserId, sdp }` | Входящий звонок (или ре-офер при ICE restart) |
| `call_offer_sent` | `{ callId, targetUserId }` | Подтверждение отправки offer |
| `call_accepted` | `{ callId, sdp }` | Звонок принят (или renegotiation answer) |
| `call_declined` | `{ callId, reason }` | Звонок отклонён |
| `call_ended` | `{ callId, duration, endedBy }` | Звонок завершён удалённой стороной |
| `call_timedout` | `{ callId, reason }` | Таймаут звонка (60 сек без ответа) |
| `ice_candidate` | `{ callId, candidate }` | ICE кандидат от удалённой стороны |
| `auto_friend_added` | `{ userId, publicKey }` | Автоматическое добавление в друзья (по приглашению) |
| `invite_claimed` | `{ inviterUserId, publicKey }` | Подтверждение, что приглашение обработано |

## Система присутствия

- Клиенты должны вызывать `heartbeat` для сброса таймаута неактивности
- После 10 минут без heartbeat пользователь считается офлайн
- Cleanup job запускается каждые 60 секунд для удаления устаревших записей
- При отключении или таймауте всем клиентам рассылается `presence { userId, online: false }` (через `io.emit`)
- При регистрации всем клиентам рассылается `presence { userId, online: true }`

## Голосовые звонки

Сервер выступает сигнальным relay для P2P голосовых звонков через WebRTC:
- SDP offer/answer и ICE кандидаты передаются через Socket.IO события
- Сервер не инспектирует SDP и ICE — только ретранслирует между участниками
- Все звонки 1-на-1, только аудио
- Состояние звонков в памяти: activeCalls, userActiveCall, pendingCallOffers
- Таймаут непринятого звонка — 60 секунд
- Rate-limiting на call_offer: 1 вызов/сек на пользователя
- Graceful shutdown: при остановке сервера все активные звонки корректно завершаются
- TURN сервер (coturn) на порту 3478 для ретрансляции медиа-трафика через NAT.

## Протокол подключения

```
1. Клиент подключается (WebSocket handshake)
2. Клиент отправляет 'register' с { userId, publicKey }
3. Сервер добавляет пользователя в in-memory Map, рассылает 'presence' всем
4. Клиент начинает heartbeat (опционально), может общаться через message/friend
5. При отключении пользователь удаляется из Map, всем рассылается presence
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `PORT` | `9001` | Порт сервера |
| `SENTRY_DSN` | — | DSN для Sentry/GlitchTip error tracking (пусто = отключено) |
| `LOG_LEVEL` | `info` | Уровень логирования: `debug`, `info`, `warn`, `error`, `silent` |
| `LOG_FORMAT` | `pretty` | Формат логов: `pretty` (цветной текст) или `json` (машинно-читаемый) |
| `METRICS_ENABLED` | `false` | Включить Prometheus-метрики (`true`/`false`) |
| `TURN_HOST` | авто | Внешний IP/домен TURN-сервера |
| `TURN_USERNAME` | `voidchat` | Имя пользователя для TURN |
| `TURN_CREDENTIAL` | авто | Пароль/секрет для TURN |

## Health Check

Сервер имеет endpoint `GET /`, возвращающий JSON-статус:

```json
{
  "status": "ok",
  "uptime": 3600,
  "connections": 5,
  "timestamp": "2026-05-18T12:00:00.000Z"
}
```

Используется скриптом `update.sh` для проверки, что сервер запущен и отвечает.

## Офлайн-очереди

- `friend_request` к офлайн-пользователю сохраняется в `pendingFriendRequests` и доставляется при его следующем `register`
- `friend_accept` к офлайн-пользователю сохраняется в `pendingFriendAccepts` и доставляется при его следующем `register`

## Безопасность

- Сервер **НЕ** выполняет шифрование/дешифрование — всё содержимое сообщений для него непрозрачный шифротекст
- Сервер **НЕ** хранит сообщения — они ретранслируются и сразу отбрасываются
- Сервер **НЕ** сохраняет данные пользователей между перезапусками
- В продакшене используй WSS (TLS прокси) для транспортного шифрования
- E2E шифрование на клиенте (NaCl/libsodium через tweetnacl) — ответственность клиентского приложения
- Rate-limiting на `call_offer`: не более 1 вызова/сек на пользователя (защита от DoS)
- Graceful shutdown: при SIGTERM/SIGINT корректно завершаются активные звонки, уведомляются участники, очищаются таймеры

## Скрипты

| Команда | Описание |
|---------|----------|
| `npm run dev` | Запуск с hot-reload (tsx watch) |
| `npm run build` | Компиляция TypeScript → dist/ |
| `npm start` | Запуск скомпилированного сервера |
| `npm run lint` | ESLint проверка |
| `npm run format` | Prettier форматирование |

### Bash-скрипты

| Скрипт | Описание |
|--------|----------|
| `./deploy.sh` | Автоматический деплой на свежий Ubuntu/Debian VPS |
| `./update.sh` | Обновление сервера из git (pull, build, pm2 restart, health-check) |
| `./uninstall.sh` | Полное удаление сервера с VPS (pm2, UFW, лимиты, файлы) |

## Структура проекта

```
voidchat-server/
├── package.json
├── tsconfig.json
├── swagger.yaml          # OpenAPI/Swagger спецификация
├── eslint.config.mjs
├── .prettierrc.cjs
├── deploy.sh             # Скрипт автоматического деплоя на VPS
├── update.sh             # Скрипт обновления сервера
├── uninstall.sh          # Скрипт полного удаления сервера
├── README.md
├── src/
│   └── server.ts         # Единственный файл сервера (~1318 строк)
└── dist/
    ├── server.js
    └── server.d.ts
```

## Мониторинг и observability

Сервер поддерживает три опциональных механизма мониторинга, настраиваемых через переменные окружения (файл `/etc/voidchat-server.env` при деплое через `deploy.sh`):

### Error Tracking (Sentry/GlitchTip)

```bash
SENTRY_DSN=https://key@glitchtip.example.com/1
```

Поддерживается любой DSN-совместимый бэкенд: [Sentry](https://sentry.io), [GlitchTip](https://glitchtip.com) (self-hosted), [PostHog](https://posthog.com), [Highlight](https://highlight.io). При передаче DSN все необработанные исключения автоматически отправляются в сервис.

### Уровень и формат логирования

```bash
LOG_LEVEL=info       # debug | info | warn | error | silent
LOG_FORMAT=pretty    # pretty (цветной) | json (структурированный)
```

- `LOG_FORMAT=pretty` — цветной, человеко-читаемый вывод (через `pino-pretty`)
- `LOG_FORMAT=json` — структурированные JSON-логи для систем сбора логов (ELK, Loki, Datadog и т.п.)

### Prometheus метрики

```bash
METRICS_ENABLED=true
```

При включении сервер отдаёт Prometheus-метрики на эндпоинте `GET /metrics` (на том же порту). Доступные метрики:
- Количество активных WebSocket-соединений (`voidchat_connections`)
- Количество активных звонков (`voidchat_active_calls`)
- Время работы сервера (`voidchat_uptime_seconds`)
- Гистограмма событий Socket.IO (`voidchat_events_total` по типу события)

### Настройка на сервере

При деплое через `deploy.sh` автоматически создаётся файл `/etc/voidchat-server.env` с закомментированными переменными. Для включения мониторинга:

```bash
# Раскомментируйте и установите нужные значения
sudo nano /etc/voidchat-server.env
pm2 restart voidchat-server --env-file /etc/voidchat-server.env
# или просто: ./update.sh
```

## TURN сервер

Для работы голосовых звонков через NAT (мобильный интернет, разные WiFi сети) используется TURN сервер на основе coturn:

- **Порт:** 3478 (TCP/UDP)
- **Relay порты:** 49152-65535 (UDP)
- **Credentials:** статические (lt-cred-mech)
- **Установка:** автоматически через `deploy.sh` (шаг 11)
- **Обновление конфига:** `/etc/turnserver.conf`
- **Управление:** `systemctl restart coturn`, `journalctl -u coturn`

> **Важно:** После изменения credentials, обновить их в `/etc/turnserver.conf` и перезапустить coturn. Клиенты получат новые credentials при переподключении к серверу (через `GET /turn-config`).

## Лицензия

ISC

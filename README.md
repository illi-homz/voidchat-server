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

Сервер запускается на порту `3001` по умолчанию. Изменить через переменную окружения `PORT`.

## Деплой на VPS

На свежий Ubuntu/Debian сервер:

```bash
curl -sS https://raw.githubusercontent.com/illi-homz/voidchat-server/main/deploy.sh | bash
```

Скрипт автоматически установит Node.js, зависимости, соберёт TypeScript, настроит UFW и запустит сервер через pm2.

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

## Система присутствия

- Клиенты должны вызывать `heartbeat` для сброса таймаута неактивности
- После 10 минут без heartbeat пользователь считается офлайн
- Cleanup job запускается каждые 60 секунд для удаления устаревших записей
- При отключении или таймауте всем клиентам рассылается `presence { userId, online: false }` (через `io.emit`)
- При регистрации всем клиентам рассылается `presence { userId, online: true }`

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
| `PORT` | `3001` | Порт сервера |

## Офлайн-очереди

- `friend_request` к офлайн-пользователю сохраняется в `pendingFriendRequests` и доставляется при его следующем `register`
- `friend_accept` к офлайн-пользователю сохраняется в `pendingFriendAccepts` и доставляется при его следующем `register`

## Безопасность

- Сервер **НЕ** выполняет шифрование/дешифрование — всё содержимое сообщений для него непрозрачный шифротекст
- Сервер **НЕ** хранит сообщения — они ретранслируются и сразу отбрасываются
- Сервер **НЕ** сохраняет данные пользователей между перезапусками
- В продакшене используй WSS (TLS прокси) для транспортного шифрования
- E2E шифрование на клиенте (NaCl/libsodium через tweetnacl) — ответственность клиентского приложения

## Скрипты

| Команда | Описание |
|---------|----------|
| `npm run dev` | Запуск с hot-reload (tsx watch) |
| `npm run build` | Компиляция TypeScript → dist/ |
| `npm start` | Запуск скомпилированного сервера |
| `npm run lint` | ESLint проверка |
| `npm run format` | Prettier форматирование |

## Структура проекта

```
voidchat-server/
├── package.json
├── tsconfig.json
├── swagger.yaml          # OpenAPI/Swagger спецификация
├── eslint.config.mjs
├── .prettierrc.cjs
├── deploy.sh             # Скрипт автоматического деплоя на VPS
├── README.md
├── src/
│   └── server.ts         # Единственный файл сервера (~280 строк)
└── dist/
    ├── server.js
    └── server.d.ts
```

## Лицензия

ISC

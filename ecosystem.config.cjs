// ==============================================================
// VoidChat Server — PM2 Ecosystem File
//
// Используется deploy.sh и update.sh для запуска сервера.
// Читает переменные из /etc/voidchat-server.env и передаёт их
// через env секцию (в отличие от --env-file, который не работает
// в pm2 7.x).
//
// Дополнительные переменные (TURN_HOST, TURN_CREDENTIAL и т.д.)
// передаются через process.env при запуске из deploy.sh/update.sh
// и наследуются автоматически.
// ==============================================================

const fs = require('fs');
const path = require('path');

/**
 * Парсит env-файл в объект.
 * Игнорирует комментарии (#) и пустые строки.
 * Поддерживает значения с = внутри.
 */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key) env[key] = val;
  }
  return env;
}

const envFile = '/etc/voidchat-server.env';
const envVars = loadEnvFile(envFile);

// Для отладки: выводим загруженные переменные (только ключи, без значений)
// console.log('[ecosystem] loaded env vars from', envFile, ':', Object.keys(envVars));

module.exports = {
  apps: [
    {
      name: 'voidchat-server',
      script: 'dist/server.js',

      // Переменные окружения:
      // 1. Из /etc/voidchat-server.env (метрики, Sentry, логи)
      // 2. NODE_ENV=production
      // 3. Остальные (TURN_HOST, TURN_CREDENTIAL и т.д.) наследуются
      //    из process.env при запуске через deploy.sh / update.sh
      env: {
        NODE_ENV: 'production',
        ...envVars,
      },

      // Лимиты и авторестарт
      max_memory_restart: '500M',
      restart_delay: 3000,
      max_restarts: 5,

      // Логирование
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '~/voidchat-server/logs/err.log',
      out_file: '~/voidchat-server/logs/out.log',
    },
  ],
};

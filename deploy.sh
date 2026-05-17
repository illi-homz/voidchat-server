#!/usr/bin/env bash
set -euo pipefail

# ==============================================================
# VoidChat Server — автоматический деплой на VPS
#
# Использование:
#   curl -sS https://raw.githubusercontent.com/illi-homz/voidchat-server/main/deploy.sh | bash
# ==============================================================

REPO_URL="https://github.com/illi-homz/voidchat-server.git"
SERVER_DIR="$HOME/voidchat-server"
NODE_VERSION="22"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }

# --------------------------------------------------------------
# 1. Проверка OS
# --------------------------------------------------------------
if [ ! -f /etc/os-release ]; then
    err "Поддерживается только Linux (Ubuntu/Debian)."
    exit 1
fi

. /etc/os-release
if [ "$ID" != "ubuntu" ] && [ "$ID" != "debian" ]; then
    err "Поддерживается только Ubuntu или Debian. Обнаружено: $ID"
    exit 1
fi

log "ОС: $NAME $VERSION_ID"

# --------------------------------------------------------------
# 2. Node.js
# --------------------------------------------------------------
INSTALL_NODE=false
if command -v node &>/dev/null; then
    INSTALLED_NODE=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$INSTALLED_NODE" -ge 22 ]; then
        log "Node.js уже установлен: $(node -v)"
    else
        warn "Node.js $(node -v) устарел. Обновляем до v$NODE_VERSION..."
        INSTALL_NODE=true
    fi
else
    warn "Node.js не найден. Устанавливаем v$NODE_VERSION..."
    INSTALL_NODE=true
fi

if [ "$INSTALL_NODE" = true ]; then
    log "Устанавливаем Node.js $NODE_VERSION..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - &>/dev/null
    apt-get install -y nodejs &>/dev/null
    log "Node.js $(node -v) установлен"
fi

# --------------------------------------------------------------
# 3. Git
# --------------------------------------------------------------
if ! command -v git &>/dev/null; then
    warn "Git не найден. Устанавливаем..."
    apt-get install -y git &>/dev/null
    log "Git установлен"
fi

# --------------------------------------------------------------
# 4. Загрузка сервера
# --------------------------------------------------------------
if [ -d "$SERVER_DIR" ]; then
    warn "Директория $SERVER_DIR уже существует. Обновляем..."
    cd "$SERVER_DIR"
    git pull --ff-only &>/dev/null || {
        err "Не удалось обновить. Пропускаем."
    }
else
    log "Клонируем репозиторий..."
    git clone --depth 1 "$REPO_URL" "$SERVER_DIR" &>/dev/null
    log "Репозиторий склонирован"
fi

cd "$SERVER_DIR"

# --------------------------------------------------------------
# 5. Зависимости
# --------------------------------------------------------------
log "Устанавливаем зависимости..."
npm install --omit=dev &>/dev/null
log "Зависимости установлены"

# --------------------------------------------------------------
# 6. Сборка
# --------------------------------------------------------------
log "Собираем TypeScript..."
npm run build &>/dev/null
log "Сборка завершена"

# --------------------------------------------------------------
# 7. pm2
# --------------------------------------------------------------
if ! command -v pm2 &>/dev/null; then
    log "Устанавливаем pm2..."
    npm install -g pm2 &>/dev/null
fi

# --------------------------------------------------------------
# 8. Фаервол
# --------------------------------------------------------------
if command -v ufw &>/dev/null; then
    if ! ufw status | grep -q "active"; then
        warn "UFW не активен. Рекомендуется включить: ufw enable"
    fi

    if ! ufw status | grep -q "3001"; then
        log "Открываем порт 3001 в UFW..."
        ufw allow 3001/tcp &>/dev/null
    fi
else
    warn "UFW не установлен. Установи: apt-get install ufw"
fi

# --------------------------------------------------------------
# 9. Запуск
# --------------------------------------------------------------
log "Запускаем сервер через pm2..."
pm2 delete voidchat-server 2>/dev/null || true
pm2 start dist/server.js --name voidchat-server &>/dev/null
pm2 save &>/dev/null

# --------------------------------------------------------------
# 10. IP и порт
# --------------------------------------------------------------
IP=$(curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')
PORT="${PORT:-3001}"

log "=============================================="
log "  Сервер запущен!"
log ""
log "  Адрес для подключения:"
log "  http://$IP:$PORT"
log ""
log "  Команды pm2:"
log "    pm2 status              — статус"
log "    pm2 logs voidchat-server    — логи"
log "    pm2 restart voidchat-server — перезапуск"
log "    pm2 stop voidchat-server    — остановка"
log ""
log "  Введите этот адрес в приложении VoidChat"
log "=============================================="

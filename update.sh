#!/usr/bin/env bash
set -euo pipefail

# ==============================================================
# VoidChat Server — Update Script
# Обновляет код, пересобирает, открывает порт, перезапускает
#
# Использование:
#   ./update.sh
#   # или из любой директории:
#   ~/voidchat-server/update.sh
# ==============================================================

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SERVER_DIR"

# Определяем PORT: сперва из переменной окружения, потом из deploy.sh, потом 9001
if [ -f deploy.sh ]; then
	DEPLOY_PORT=$(grep '^PORT=' deploy.sh | head -1 | cut -d'"' -f2 || true)
	PORT="${PORT:-${DEPLOY_PORT:-9001}}"
else
	PORT="${PORT:-9001}"
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
step() { echo ""; echo -e "${BOLD}━━━ $1 ━━━${NC}"; }

HEALTH_TIMEOUT=5

echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║      VoidChat Server — Update               ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"

# --------------------------------------------------------------
step "1/8 — Сохраняем локальные изменения"

git stash --include-untracked &>/dev/null || true
log "Локальные изменения сохранены (git stash)"

# --------------------------------------------------------------
step "2/8 — Скачиваем последнюю версию"

git pull --ff-only
log "Код обновлён до последней версии"

# --------------------------------------------------------------
step "3/8 — Устанавливаем зависимости"

npm install
log "Зависимости установлены"

# --------------------------------------------------------------
step "4/8 — Собираем TypeScript"

npm run build
log "Сборка завершена"

# --------------------------------------------------------------
step "5/8 — Удаляем dev-зависимости (экономия места)"

npm prune --omit=dev
log "Dev-зависимости удалены"

# --------------------------------------------------------------
step "6/8 — Открываем порт в UFW (если ещё не открыт)"

if command -v ufw &>/dev/null; then
	# Включаем UFW, если выключен (первый запуск)
	if ufw status | grep -q "Status: inactive"; then
		ufw allow ssh &>/dev/null || true
		ufw --force enable &>/dev/null
		log "UFW включён"
	fi

	# Открываем порт, если ещё не открыт
	if ! ufw status | grep -q "${PORT}/tcp"; then
		ufw allow "${PORT}/tcp" &>/dev/null
		log "Порт $PORT открыт в UFW"
	else
		log "Порт $PORT уже открыт в UFW"
	fi
else
	warn "UFW не установлен. Установите: apt-get install ufw"
fi

# --------------------------------------------------------------
step "7/8 — Запускаем сервер через pm2"

# Пробуем restart. Если процесса нет — стартуем новый.
if pm2 pid voidchat-server &>/dev/null; then
	pm2 restart voidchat-server &>/dev/null
	log "Сервер перезапущен (pm2 restart)"
else
	pm2 delete voidchat-server 2>/dev/null || true
	mkdir -p ~/voidchat-server/logs
	pm2 start dist/server.js \
		--name voidchat-server \
		--log-date-format "YYYY-MM-DD HH:mm:ss Z" \
		--max-memory-restart "200M" \
		--restart-delay 3000 \
		--max-restarts 5 \
		--env NODE_ENV=production \
		--merge-logs \
		--output ~/voidchat-server/logs/out.log \
		--error ~/voidchat-server/logs/err.log
	log "Сервер запущен (pm2 start)"
fi

pm2 save &>/dev/null
log "Список pm2 сохранён"

# --------------------------------------------------------------
step "8/8 — Проверка здоровья"

sleep 2
HEALTH_URL="http://localhost:${PORT}/"

if curl -s --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" &>/dev/null; then
	STATUS=$(curl -s --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL")
	UPTIME=$(echo "$STATUS" | grep -o '"uptime":[0-9]*' | cut -d: -f2)
	IP=$(curl -4 -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

	log "Сервер отвечает на порту $PORT (uptime: ${UPTIME}s)"

	echo ""
	echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
	echo -e "${BOLD}║           UPDATE COMPLETE ✓                 ║${NC}"
	echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
	echo ""
	echo -e " ${GREEN}➜${NC} Адрес:       ${BOLD}http://$IP:$PORT${NC}"
	echo -e " ${GREEN}➜${NC} Локально:    ${BOLD}http://localhost:$PORT${NC}"
	echo -e " ${GREEN}➜${NC} Health:      ${BOLD}curl http://localhost:$PORT/${NC}"
	echo ""
	echo -e " ${YELLOW}━━━ Команды ━━━${NC}"
	echo -e "   pm2 status                  статус"
	echo -e "   pm2 logs voidchat-server    логи"
	echo -e "   ./update.sh                 повторное обновление"
	echo ""
else
	warn "Health-check не прошёл. Проверьте вручную:"
	warn "  pm2 status"
	warn "  pm2 logs voidchat-server --lines 20"
	warn "  curl http://localhost:$PORT/"
	exit 1
fi

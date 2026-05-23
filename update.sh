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
step "6b/8 — Проверка конфигурации TURN (coturn)"

TURN_CONFIG="/etc/turnserver.conf"
TURN_SECRET_FILE="/etc/voidchat-turn-secret"

if [ -f "$TURN_CONFIG" ]; then
	# Проверяем, не использует ли coturn старый хардкодный пароль
	if grep -q "turn_secret_key_change_me" "$TURN_CONFIG" 2>/dev/null; then
		warn "Обнаружен старый TURN пароль. Генерируем новый..."

		# Генерируем или загружаем новый секрет
		if [ -f "$TURN_SECRET_FILE" ]; then
			TURN_SECRET=$(cat "$TURN_SECRET_FILE")
		else
			TURN_SECRET=$(openssl rand -hex 32)
			echo "$TURN_SECRET" > "$TURN_SECRET_FILE"
			chmod 600 "$TURN_SECRET_FILE"
		fi

		# Заменяем пароль в конфиге
		sed -i "s/user=voidchat:.*/user=voidchat:${TURN_SECRET}/" "$TURN_CONFIG"
		log "TURN пароль обновлён"
	fi

	systemctl restart coturn 2>/dev/null || true
	log "coturn перезапущен"
else
	warn "TURN конфиг не найден ($TURN_CONFIG)"
fi

# --------------------------------------------------------------
step "7/8 — Запускаем сервер через pm2"

# Всегда перезапускаем через delete + start, чтобы TURN_HOST/env гарантированно
# обновились. pm2 restart --update-env не подхватывает inline export'ы.
TURN_SECRET_FILE="/etc/voidchat-turn-secret"
TURN_SECRET=""
if [ -f "$TURN_SECRET_FILE" ]; then
	TURN_SECRET=$(cat "$TURN_SECRET_FILE")
fi
pm2 delete voidchat-server 2>/dev/null || true
mkdir -p ~/voidchat-server/logs
TURN_HOST="${TURN_HOST:-$(curl -4 -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')}" \
TURN_USERNAME="${TURN_USERNAME:-voidchat}" \
TURN_CREDENTIAL="${TURN_CREDENTIAL:-$TURN_SECRET}" \
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

if curl -s --max-time "$HEALTH_TIMEOUT" "http://localhost:${PORT}/" &>/dev/null; then
	HEALTH_URL="http://localhost:${PORT}/"
else
	warn "Health-check не прошёл"
	exit 1
fi

STATUS=$(curl -s --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL")
UPTIME=$(echo "$STATUS" | grep -o '"uptime":[0-9]*' | cut -d: -f2)
IP=$(curl -4 -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

log "Сервер отвечает (uptime: ${UPTIME}s)"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           UPDATE COMPLETE ✓                 ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e " ${GREEN}➜${NC} Адрес:       ${BOLD}http://$IP:$PORT${NC}"
echo -e " ${GREEN}➜${NC} Локально:    ${BOLD}http://localhost:$PORT${NC}"
echo -e " ${GREEN}➜${NC} Health:      ${BOLD}curl ${HEALTH_URL}${NC}"
echo ""
echo -e " ${YELLOW}━━━ Команды ━━━${NC}"
echo -e "   pm2 status                  статус"
echo -e "   pm2 logs voidchat-server    логи"
echo -e "   ./update.sh                 повторное обновление"
echo ""

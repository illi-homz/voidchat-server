#!/usr/bin/env bash
set -euo pipefail

# ==============================================================
# VoidChat Server — Update Script
# Обновляет код, пересобирает и перезапускает сервер
#
# Использование:
#   ./update.sh
#   # или из любой директории:
#   ~/voidchat-server/update.sh
# ==============================================================

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SERVER_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
step() { echo ""; echo -e "${BOLD}━━━ $1 ━━━${NC}"; }

# Порог времени для health-check (секунд)
HEALTH_TIMEOUT=5

step "1/7 — Сохраняем локальные изменения"

git stash --include-untracked &>/dev/null || true
log "Локальные изменения сохранены (git stash)"

step "2/7 — Скачиваем последнюю версию"

git pull --ff-only
log "Код обновлён до последней версии"

step "3/7 — Устанавливаем зависимости"

npm install
log "Зависимости установлены"

step "4/7 — Собираем TypeScript"

npm run build
log "Сборка завершена"

step "5/7 — Удаляем dev-зависимости (экономия места)"

npm prune --omit=dev
log "Dev-зависимости удалены"

step "6/7 — Перезапускаем сервер"

pm2 restart voidchat-server &>/dev/null
pm2 save &>/dev/null
log "Сервер перезапущен через pm2"

step "7/7 — Проверка здоровья"

sleep 2
HEALTH_URL="http://localhost:${PORT:-9001}/"

if curl -s --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" &>/dev/null; then
	STATUS=$(curl -s --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL")
	UPTIME=$(echo "$STATUS" | grep -o '"uptime":[0-9]*' | cut -d: -f2)
	log "Сервер отвечает (uptime: ${UPTIME}s)"

	echo ""
	echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
	echo -e "${BOLD}║           UPDATE COMPLETE ✓                 ║${NC}"
	echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
	echo ""
	echo -e " ${GREEN}➜${NC} ${BOLD}pm2 status${NC}        — статус процессов"
	echo -e " ${GREEN}➜${NC} ${BOLD}pm2 logs${NC}           — логи сервера"
	echo -e " ${GREEN}➜${NC} ${BOLD}./update.sh${NC}        — повторное обновление"
	echo ""
else
	warn "Health-check не прошёл. Проверьте вручную:"
	warn "  pm2 status"
	warn "  pm2 logs voidchat-server --lines 20"
	exit 1
fi

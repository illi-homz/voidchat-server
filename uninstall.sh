#!/usr/bin/env bash
set -euo pipefail

# ==============================================================
# VoidChat Server — Uninstall Script
# Полностью удаляет сервер и все его следы с VPS
#
# Использование:
#   ./uninstall.sh
#   # или
#   ~/voidchat-server/uninstall.sh
# ==============================================================

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-9001}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
step() { echo ""; echo -e "${BOLD}━━━ $1 ━━━${NC}"; }

# --------------------------------------------------------------
# Root check
# --------------------------------------------------------------
if [ "$EUID" -ne 0 ]; then
    err "Этот скрипт должен быть запущен с правами root."
    exit 1
fi

echo -e "${RED}${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${RED}${BOLD}║     VoidChat Server — ПОЛНОЕ УДАЛЕНИЕ      ║${NC}"
echo -e "${RED}${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Будут удалены:${NC}"
echo -e "  • серверное приложение (${SERVER_DIR})"
echo -e "  • pm2 процесс voidchat-server"
echo -e "  • автозапуск pm2 (systemd)"
echo -e "  • pm2-logrotate модуль"
echo -e "  • глобальный пакет pm2 (будет запрошено подтверждение)"
echo -e "  • правило UFW для порта ${PORT}"
echo -e "  • TURN секрет (/etc/voidchat-turn-secret)"
echo -e "  • PORT config (/etc/voidchat-port)"
echo -e "  • конфиг мониторинга (/etc/voidchat-server.env)"
echo -e "  • системные лимиты open files (99-voidchat.conf)"
echo ""
echo -e "${YELLOW}НЕ будут удалены:${NC}"
echo -e "  • Node.js (может использоваться другими проектами)"
echo -e "  • Git"
echo -e "  • build-essential"
echo -e "  • coturn (если используется другими приложениями)"
echo ""

read -r -p "$(echo -e "${RED}Введите ${BOLD}YES${NC}${RED} для подтверждения удаления:${NC} ")" CONFIRM
if [ "$CONFIRM" != "YES" ]; then
	echo ""
	err "Отменено."
	exit 1
fi

echo ""
log "Начинаем удаление..."

# --------------------------------------------------------------
step "1/8 — Останавливаем pm2 процесс"

if command -v pm2 &>/dev/null; then
	pm2 delete voidchat-server 2>/dev/null || true
	log "Процесс voidchat-server остановлен"
else
	warn "pm2 не найден, пропускаем"
fi

# --------------------------------------------------------------
step "2/8 — Удаляем автозапуск pm2 (systemd)"

if command -v pm2 &>/dev/null && command -v systemctl &>/dev/null; then
	pm2 unstartup systemd 2>/dev/null | bash 2>/dev/null || true
	systemctl disable pm2-root 2>/dev/null || true
	rm -f /etc/systemd/system/pm2-root.service 2>/dev/null || true
	systemctl daemon-reload 2>/dev/null || true
	log "Автозапуск pm2 удалён"
else
	warn "systemd или pm2 не найдены, пропускаем"
fi

# --------------------------------------------------------------
step "3/8 — Удаляем pm2-logrotate"

if command -v pm2 &>/dev/null; then
	pm2 uninstall pm2-logrotate 2>/dev/null || true
	log "pm2-logrotate удалён"
fi

# --------------------------------------------------------------
step "4/8 — Удаляем глобальный пакет pm2 (опционально)"

echo ""
echo -e "${YELLOW}pm2 может использоваться другими приложениями на сервере.${NC}"
echo -e "${YELLOW}Процесс voidchat-server уже остановлен на шаге 1.${NC}"
echo ""
read -r -p "$(echo -e "Удалить глобальный пакет pm2 вместе с конфигурацией (~/.pm2)? (y/N): ")" REMOVE_PM2

if [ "$REMOVE_PM2" = "y" ] || [ "$REMOVE_PM2" = "Y" ]; then
	if command -v npm &>/dev/null; then
		npm uninstall -g pm2 2>/dev/null || true
		log "pm2 глобально удалён"
	fi
	# Очищаем остатки pm2 в домашней директории
	rm -rf ~/.pm2 2>/dev/null || true
	rm -f /root/.pm2/dump.pm2 2>/dev/null || true
else
	log "pm2 оставлен (удаление пропущено)"
fi

# --------------------------------------------------------------
step "5/8 — Удаляем правило UFW"

if command -v ufw &>/dev/null; then
	ufw delete allow "${PORT}/tcp" 2>/dev/null || true
	# На случай если порт открыт как в v4, так и в v6 — удаляем все совпадения
	ufw status numbered 2>/dev/null | grep "${PORT}/tcp" | while read -r line; do
		NUM=$(echo "$line" | grep -o '^\[\s*[0-9]*' | grep -o '[0-9]*')
		if [ -n "$NUM" ]; then
			echo "y" | ufw delete "$NUM" 2>/dev/null || true
		fi
	done
	log "Правило UFW для порта $PORT удалено"

	log "Правило UFW для порта $PORT удалено"
else
	warn "UFW не найден, пропускаем"
fi

# --------------------------------------------------------------
step "5b/8 — Удаление TURN секрета"

rm -f /etc/voidchat-turn-secret 2>/dev/null || true
log "TURN секрет удалён"

rm -f /etc/voidchat-port 2>/dev/null || true
log "PORT config (/etc/voidchat-port) удалён"

rm -f /etc/voidchat-server.env 2>/dev/null || true
log "Конфиг мониторинга (/etc/voidchat-server.env) удалён"

# --------------------------------------------------------------
step "6/8 — Удаляем системные лимиты"

rm -f /etc/security/limits.d/99-voidchat.conf 2>/dev/null || true
log "Системные лимиты (99-voidchat.conf) удалены"

# --------------------------------------------------------------
step "7/8 — Удаляем директорию сервера"

rm -rf "$SERVER_DIR" 2>/dev/null || true
log "Директория сервера удалена: $SERVER_DIR"

# --------------------------------------------------------------
step "8/8 — Финальная очистка"

# Удаляем лог-файлы, если остались
rm -rf ~/voidchat-server/logs 2>/dev/null || true

# Чистим кеш npm (необязательно, но полезно)
npm cache clean --force 2>/dev/null || true

log "Финальная очистка завершена"

# --------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║        UNINSTALL COMPLETE ✓                 ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e " ${GREEN}➜${NC} Сервер VoidChat полностью удалён"
echo -e " ${GREEN}➜${NC} Systemd, UFW, лимиты — восстановлены"
echo ""
echo -e " ${YELLOW}ℹ${NC}  Node.js, Git, build-essential оставлены"
echo -e " ${YELLOW}ℹ${NC}  Если хотите удалить Node.js:"
echo -e "     apt-get purge -y nodejs"
echo -e "     rm -rf /etc/apt/sources.list.d/nodesource.list"
echo ""

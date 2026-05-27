#!/usr/bin/env bash
set -euo pipefail

# ==============================================================
# VoidChat Server — Monitoring Update
# Обновляет образы Prometheus + Grafana и перезапускает контейнеры.
#
# Использование:
#   ./update-monitoring.sh
#   sudo ./update-monitoring.sh
# ==============================================================

MONITORING_DIR="/opt/voidchat-monitoring"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
step() { echo ""; echo -e "${BOLD}━━━ $1 ━━━${NC}"; }

echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   VoidChat Monitoring — Update               ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# --------------------------------------------------------------
# 1. Root check
# --------------------------------------------------------------
if [ "$EUID" -ne 0 ]; then
    err "Этот скрипт должен быть запущен с правами root."
    exit 1
fi

# --------------------------------------------------------------
# 2. Проверка директории
# --------------------------------------------------------------
if [ ! -d "$MONITORING_DIR" ]; then
    err "Директория $MONITORING_DIR не найдена."
    err "Сначала выполните setup-monitoring.sh"
    exit 1
fi

cd "$MONITORING_DIR"

if [ ! -f docker-compose.yml ]; then
    err "docker-compose.yml не найден в $MONITORING_DIR"
    exit 1
fi

log "Мониторинг установлен в $MONITORING_DIR"

# --------------------------------------------------------------
# 3. Определяем Docker Compose
# --------------------------------------------------------------
DOCKER_COMPOSE=""
if docker compose version &>/dev/null; then
    DOCKER_COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
    DOCKER_COMPOSE="docker-compose"
else
    err "Docker Compose не найден"
    exit 1
fi

# --------------------------------------------------------------
# 4. Pull свежих образов
# --------------------------------------------------------------
step "1/3 — Скачиваем свежие образы"

log "Выполняем: $DOCKER_COMPOSE pull"
eval "$DOCKER_COMPOSE pull"
log "Образы обновлены"

# --------------------------------------------------------------
# 5. Перезапуск контейнеров
# --------------------------------------------------------------
step "2/3 — Перезапускаем контейнеры"

log "Выполняем: $DOCKER_COMPOSE up -d"
eval "$DOCKER_COMPOSE up -d"
log "Контейнеры перезапущены"

# --------------------------------------------------------------
# 6. Очистка старых образов
# --------------------------------------------------------------
step "3/3 — Очистка старых образов"

docker image prune -f &>/dev/null || true
log "Неиспользуемые образы удалены"

# --------------------------------------------------------------
# Проверка
# --------------------------------------------------------------
echo ""
log "Проверка статуса:"
eval "$DOCKER_COMPOSE ps"

echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║        UPDATE COMPLETE ✓                    ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e " ${GREEN}➜${NC} Grafana: ${BOLD}http://$(curl -4 -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):3000${NC}"
echo -e " ${GREEN}➜${NC} Логи:    ${YELLOW}$DOCKER_COMPOSE logs --tail=50 prometheus grafana${NC}"
echo ""

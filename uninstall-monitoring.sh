#!/usr/bin/env bash
set -euo pipefail

# ==============================================================
# VoidChat Server — Monitoring Uninstall
# Полностью удаляет Prometheus + Grafana стек с VPS.
#
# Использование:
#   sudo ./uninstall-monitoring.sh
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

# --------------------------------------------------------------
# Root check
# --------------------------------------------------------------
if [ "$EUID" -ne 0 ]; then
    err "Этот скрипт должен быть запущен с правами root."
    exit 1
fi

echo -e "${RED}${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${RED}${BOLD}║   VoidChat Monitoring — ПОЛНОЕ УДАЛЕНИЕ    ║${NC}"
echo -e "${RED}${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# Проверка существования директории
if [ ! -d "$MONITORING_DIR" ]; then
    warn "Директория $MONITORING_DIR не найдена."
    warn "Мониторинг, возможно, уже удалён."
    echo ""
    echo -e " ${YELLOW}ℹ${NC}  Всё равно проверить UFW порт 3000?"
    read -r -p "$(echo -e "Очистить правило UFW для порта 3000? (y/N): ")" CLEAN_UFW
    if [ "$CLEAN_UFW" = "y" ] || [ "$CLEAN_UFW" = "Y" ]; then
        if command -v ufw &>/dev/null; then
            ufw delete allow 3000/tcp 2>/dev/null || true
            log "Правило UFW для порта 3000 удалено"
        fi
    fi
    log "Готово."
    exit 0
fi

echo -e "${YELLOW}Будут удалены:${NC}"
echo -e "  • Docker-контейнеры voidchat-prometheus и voidchat-grafana"
echo -e "  • Docker-сеть monitoring-net"
echo -e "  • Docker-тома prometheus-data и grafana-data (опционально)"
echo -e "  • правило UFW для порта 3000"
echo -e "  • директория $MONITORING_DIR (опционально)"
echo ""

read -r -p "$(echo -e "${RED}Введите ${BOLD}YES${NC}${RED} для подтверждения удаления:${NC} ")" CONFIRM
if [ "$CONFIRM" != "YES" ]; then
    echo ""
    err "Отменено."
    exit 1
fi

echo ""
log "Начинаем удаление мониторинга..."

# --------------------------------------------------------------
# 1. Определяем Docker Compose
# --------------------------------------------------------------
step "1/6 — Определяем Docker Compose"

DOCKER_COMPOSE=""
if docker compose version &>/dev/null; then
    DOCKER_COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
    DOCKER_COMPOSE="docker-compose"
else
    warn "Docker Compose не найден, пробуем docker напрямую"
    DOCKER_COMPOSE=""
fi

# --------------------------------------------------------------
# 2. Остановка и удаление контейнеров
# --------------------------------------------------------------
step "2/6 — Остановка и удаление контейнеров"

cd "$MONITORING_DIR" || true

if [ -n "$DOCKER_COMPOSE" ] && [ -f docker-compose.yml ]; then
    log "Останавливаем контейнеры через docker compose..."
    eval "$DOCKER_COMPOSE down" 2>/dev/null || true
    log "Контейнеры остановлены и удалены"
else
    # Fallback: удаляем контейнеры вручную
    log "Останавливаем контейнеры вручную..."
    docker stop voidchat-prometheus voidchat-grafana 2>/dev/null || true
    docker rm voidchat-prometheus voidchat-grafana 2>/dev/null || true
    log "Контейнеры остановлены и удалены"
fi

# --------------------------------------------------------------
# 3. Удаление Docker-томов (опционально)
# --------------------------------------------------------------
step "3/6 — Удаление Docker-томов (опционально)"

echo ""
echo -e "${YELLOW}Docker-тома содержат данные Prometheus (метрики) и Grafana (дашборды).${NC}"
echo -e "${YELLOW}Удаление томов приведёт к потере всех исторических данных.${NC}"
echo ""
read -r -p "$(echo -e "Удалить Docker-тома? (y/N): ")" REMOVE_VOLUMES

if [ "$REMOVE_VOLUMES" = "y" ] || [ "$REMOVE_VOLUMES" = "Y" ]; then
    docker volume rm voidchat-monitoring_prometheus-data voidchat-monitoring_grafana-data 2>/dev/null || \
    docker volume rm voidchat-monitoring_prometheus-data 2>/dev/null || \
    docker volume rm voidchat-monitoring_grafana-data 2>/dev/null || true

    # Также пробуем удалить по имени проекта (если проект назван иначе)
    docker volume ls --filter name=prometheus-data --format '{{.Name}}' 2>/dev/null | while read -r vol; do
        docker volume rm "$vol" 2>/dev/null || true
    done
    docker volume ls --filter name=grafana-data --format '{{.Name}}' 2>/dev/null | while read -r vol; do
        docker volume rm "$vol" 2>/dev/null || true
    done

    log "Docker-тома удалены"
else
    log "Docker-тома сохранены"
fi

# --------------------------------------------------------------
# 4. Удаление сети (если осталась)
# --------------------------------------------------------------
step "4/6 — Очистка Docker-сети"

docker network rm monitoring-net 2>/dev/null || true
docker network rm voidchat-monitoring_monitoring-net 2>/dev/null || true
log "Docker-сеть удалена"

# --------------------------------------------------------------
# 5. Закрытие UFW порта 3000
# --------------------------------------------------------------
step "5/6 — Закрытие порта 3000 в UFW"

if command -v ufw &>/dev/null; then
    # Удаляем правило, если оно есть (по номеру и по порту)
    ufw delete allow 3000/tcp 2>/dev/null || true
    ufw status numbered 2>/dev/null | grep "3000/tcp" | while read -r line; do
        NUM=$(echo "$line" | grep -o '^\[\s*[0-9]*' | grep -o '[0-9]*')
        if [ -n "$NUM" ]; then
            echo "y" | ufw delete "$NUM" 2>/dev/null || true
        fi
    done
    log "Правило UFW для порта 3000 удалено"
else
    warn "UFW не найден, пропускаем"
fi

# --------------------------------------------------------------
# 6. Удаление директории (опционально, с подтверждением)
# --------------------------------------------------------------
step "6/6 — Удаление директории мониторинга"

echo ""
echo -e "${YELLOW}Директория $MONITORING_DIR будет полностью удалена.${NC}"
echo -e "${YELLOW}Это включает: docker-compose.yml, prometheus.yml, provisioning, .env, пароли.${NC}"
echo ""
read -r -p "$(echo -e "Удалить директорию $MONITORING_DIR? (y/N): ")" REMOVE_DIR

if [ "$REMOVE_DIR" = "y" ] || [ "$REMOVE_DIR" = "Y" ]; then
    rm -rf "$MONITORING_DIR"
    log "Директория $MONITORING_DIR удалена"
else
    log "Директория $MONITORING_DIR сохранена"
fi

# --------------------------------------------------------------
# Финальный вывод
# --------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║     MONITORING UNINSTALL COMPLETE ✓        ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e " ${GREEN}➜${NC} Prometheus + Grafana удалены"
echo -e " ${GREEN}➜${NC} Порт 3000 закрыт в UFW"
echo ""
if [ "$REMOVE_VOLUMES" != "y" ] && [ "$REMOVE_VOLUMES" != "Y" ]; then
    echo -e " ${YELLOW}ℹ${NC}  Docker-тома сохранены. Для полной очистки:"
    echo -e "     docker volume ls | grep -E 'prometheus-data|grafana-data'"
    echo -e "     docker volume rm <volume_name>"
fi
if [ "$REMOVE_DIR" != "y" ] && [ "$REMOVE_DIR" != "Y" ]; then
    echo -e " ${YELLOW}ℹ${NC}  Директория $MONITORING_DIR сохранена."
    echo -e "     Для удаления вручную: rm -rf $MONITORING_DIR"
fi
echo ""

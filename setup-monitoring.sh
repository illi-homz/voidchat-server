#!/usr/bin/env bash
set -euo pipefail

# ==============================================================
# VoidChat Server — Monitoring Setup (Prometheus + Grafana)
# Устанавливает стек мониторинга через Docker Compose.
#
# Использование:
#   curl -sS https://raw.githubusercontent.com/illi-homz/voidchat-server/main/setup-monitoring.sh | sudo bash
#   # или
#   sudo ./setup-monitoring.sh
# ==============================================================

MONITORING_DIR="/opt/voidchat-monitoring"
COMPOSE_FILE="$MONITORING_DIR/docker-compose.yml"
PROMETHEUS_CONFIG="$MONITORING_DIR/prometheus.yml"
GRAFANA_PASS_FILE="$MONITORING_DIR/grafana-admin-password.txt"
PROVISIONING_DIR="$MONITORING_DIR/provisioning/datasources"
ENV_FILE="$MONITORING_DIR/.env"

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
echo -e "${BOLD}║   VoidChat Monitoring — Prometheus + Grafana ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# --------------------------------------------------------------
# 1. Root check
# --------------------------------------------------------------
step "1/10 — Проверка root-прав и Docker"

if [ "$EUID" -ne 0 ]; then
    err "Этот скрипт должен быть запущен с правами root."
    err "Используйте: curl ... | sudo bash"
    exit 1
fi
log "Root check пройден"

# --------------------------------------------------------------
# 2. Проверка Docker и Docker Compose
# --------------------------------------------------------------
if ! command -v docker &>/dev/null; then
    err "Docker не найден. Установите Docker: https://docs.docker.com/engine/install/"
    exit 1
fi
log "Docker: $(docker --version 2>/dev/null || echo '?')"

# Определяем команду Docker Compose (plugin или standalone)
DOCKER_COMPOSE=""
if docker compose version &>/dev/null; then
    DOCKER_COMPOSE="docker compose"
    DOCKER_COMPOSE_VERSION=$(docker compose version 2>/dev/null || echo '?')
elif command -v docker-compose &>/dev/null; then
    DOCKER_COMPOSE="docker-compose"
    DOCKER_COMPOSE_VERSION=$(docker-compose --version 2>/dev/null || echo '?')
else
    err "Docker Compose не найден (ни плагин, ни standalone)."
    exit 1
fi
log "Docker Compose: $DOCKER_COMPOSE_VERSION"

# --------------------------------------------------------------
# 3. Создание директории мониторинга
# --------------------------------------------------------------
step "2/10 — Создание директории $MONITORING_DIR"

mkdir -p "$MONITORING_DIR"
mkdir -p "$PROVISIONING_DIR"
log "Директории созданы"

# --------------------------------------------------------------
# 4. Генерация пароля администратора Grafana
# --------------------------------------------------------------
step "3/10 — Генерация пароля администратора Grafana"

# Если файл с паролем уже существует — используем его (идемпотентность)
if [ -f "$GRAFANA_PASS_FILE" ]; then
    ADMIN_PASSWORD=$(cat "$GRAFANA_PASS_FILE")
    log "Пароль загружен из существующего файла"
else
    ADMIN_PASSWORD=$(openssl rand -hex 12)
    echo "$ADMIN_PASSWORD" > "$GRAFANA_PASS_FILE"
    chmod 600 "$GRAFANA_PASS_FILE"
    log "Пароль сгенерирован и сохранён в $GRAFANA_PASS_FILE"
fi

# --------------------------------------------------------------
# 5. Создание .env файла для Docker Compose
# --------------------------------------------------------------
step "4/10 — Создание конфигурационных файлов"

cat > "$ENV_FILE" <<EOF
# === VoidChat Monitoring — Grafana Admin ===
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF
chmod 600 "$ENV_FILE"
log ".env файл создан"

# --------------------------------------------------------------
# 6. Создание prometheus.yml
# --------------------------------------------------------------
cat > "$PROMETHEUS_CONFIG" <<'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'voidchat-server'
    static_configs:
      # host.docker.internal резолвится в IP шлюза Docker-сети,
      # что даёт доступ к localhost хост-машины из контейнера.
      - targets: ['host.docker.internal:9001']
    metrics_path: /metrics
EOF
log "prometheus.yml создан"

# --------------------------------------------------------------
# 7. Создание provisioning для Grafana (авто-датасорс)
# --------------------------------------------------------------
cat > "$PROVISIONING_DIR/prometheus.yaml" <<'EOF'
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    # Prometheus доступен по имени сервиса в Docker-сети monitoring-net
    url: http://prometheus:9090
    isDefault: true
    editable: false
EOF
log "Grafana datasource provisioning создан"

# --------------------------------------------------------------
# 8. Создание docker-compose.yml
# --------------------------------------------------------------
cat > "$COMPOSE_FILE" <<'COMPOSEEOF'
services:
  prometheus:
    image: prom/prometheus:latest
    container_name: voidchat-prometheus
    restart: unless-stopped
    ports:
      # Только localhost — не доступен извне, UFW не нужен
      - "127.0.0.1:9090:9090"
    volumes:
      - prometheus-data:/prometheus
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    extra_hosts:
      # Позволяет из контейнера обращаться к localhost хост-машины
      - "host.docker.internal:host-gateway"
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=30d'
    networks:
      - monitoring-net

  grafana:
    image: grafana/grafana-oss:latest
    container_name: voidchat-grafana
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - grafana-data:/var/lib/grafana
      # Авто-провижининг датасорса и дашбордов
      - ./provisioning:/etc/grafana/provisioning:ro
    environment:
      GF_SECURITY_ADMIN_USER: ${GF_SECURITY_ADMIN_USER}
      GF_SECURITY_ADMIN_PASSWORD: ${GF_SECURITY_ADMIN_PASSWORD}
      GF_INSTALL_PLUGINS: grafana-piechart-panel
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_SERVER_ROOT_URL: http://localhost:3000
    mem_limit: 256m
    mem_reservation: 128m
    networks:
      - monitoring-net
    depends_on:
      - prometheus

volumes:
  prometheus-data:
  grafana-data:

networks:
  monitoring-net:
    driver: bridge
COMPOSEEOF
log "docker-compose.yml создан"

# --------------------------------------------------------------
# 9. Настройка UFW — открыть порт Grafana
# --------------------------------------------------------------
step "5/10 — Настройка UFW (порт 3000 для Grafana)"

if command -v ufw &>/dev/null; then
    # Включаем UFW если выключен
    if ufw status | grep -q "Status: inactive"; then
        ufw --force enable &>/dev/null
        log "UFW включён"
    fi

    # Открываем 3000 для Grafana если ещё не открыт
    if ! ufw status | grep -q "3000/tcp"; then
        ufw allow 3000/tcp comment 'Grafana monitoring' &>/dev/null
        log "Порт 3000/tcp открыт в UFW (Grafana)"
    else
        log "Порт 3000/tcp уже открыт в UFW"
    fi
else
    warn "UFW не установлен. Установите: apt-get install ufw"
fi

# --------------------------------------------------------------
# 10. Запуск Docker Compose
# --------------------------------------------------------------
step "6/10 — Запуск контейнеров"

cd "$MONITORING_DIR"
log "Запускаем: $DOCKER_COMPOSE up -d"
eval "$DOCKER_COMPOSE up -d"

log "Ожидаем 10 секунд для инициализации контейнеров..."
sleep 10

# --------------------------------------------------------------
# Проверка статуса
# --------------------------------------------------------------
step "7/10 — Проверка статуса контейнеров"

RUNNING_CONTAINERS=$(eval "$DOCKER_COMPOSE ps --status running --format '{{.Name}}'" 2>/dev/null || true)

if echo "$RUNNING_CONTAINERS" | grep -q "voidchat-prometheus"; then
    log "Prometheus: запущен"
else
    warn "Prometheus: НЕ запущен. Проверьте: $DOCKER_COMPOSE logs prometheus"
fi

if echo "$RUNNING_CONTAINERS" | grep -q "voidchat-grafana"; then
    log "Grafana: запущена"
else
    warn "Grafana: НЕ запущена. Проверьте: $DOCKER_COMPOSE logs grafana"
fi

# --------------------------------------------------------------
# Проверка Prometheus scrape endpoint
# --------------------------------------------------------------
step "8/10 — Проверка сбора метрик"

# Проверяем через внутренний порт Prometheus (через Docker network)
PROMETHEUS_CHECK=$(curl -s --max-time 5 "http://127.0.0.1:9090/api/v1/targets" 2>/dev/null || true)
if [ -n "$PROMETHEUS_CHECK" ]; then
    UP_TARGETS=$(echo "$PROMETHEUS_CHECK" | grep -o '"health":"up"' | wc -l)
    DOWN_TARGETS=$(echo "$PROMETHEUS_CHECK" | grep -o '"health":"down"' | wc -l)
    log "Prometheus API отвечает (up: $UP_TARGETS, down: $DOWN_TARGETS)"
else
    warn "Prometheus API не отвечает на порту 9090"
fi

# --------------------------------------------------------------
# Проверка Grafana
# --------------------------------------------------------------
step "9/10 — Проверка Grafana"

GRAFANA_CHECK=$(curl -s --max-time 5 "http://127.0.0.1:3000/api/health" 2>/dev/null || true)
if [ -n "$GRAFANA_CHECK" ]; then
    GRAFANA_VERSION=$(echo "$GRAFANA_CHECK" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
    log "Grafana API отвечает (v${GRAFANA_VERSION:-?})"
else
    warn "Grafana не отвечает на порту 3000"
fi

# --------------------------------------------------------------
# Определяем внешний IP
# --------------------------------------------------------------
step "10/10 — Определение внешнего IP"

EXTERNAL_IP=$(curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')
if [ -z "$EXTERNAL_IP" ]; then
    EXTERNAL_IP="<IP_VPS>"
fi
log "Внешний IP: $EXTERNAL_IP"

# --------------------------------------------------------------
# Финальный вывод
# --------------------------------------------------------------
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     MONITORING SETUP COMPLETE ✓             ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e " ${GREEN}➜${NC} ${BOLD}Grafana:${NC}"
echo -e "     URL:      ${BOLD}http://$EXTERNAL_IP:3000${NC}"
echo -e "     Login:    ${BOLD}admin${NC}"
echo -e "     Password: ${BOLD}$ADMIN_PASSWORD${NC}"
echo -e "     (пароль также сохранён в ${YELLOW}$GRAFANA_PASS_FILE${NC})"
echo ""
echo -e " ${GREEN}➜${NC} ${BOLD}Prometheus:${NC}"
echo -e "     Internal: ${BOLD}http://127.0.0.1:9090${NC}"
echo -e "     (только локально, не доступен извне)"
echo ""
echo -e " ${GREEN}➜${NC} ${BOLD}Data source:${NC}"
echo -e "     Prometheus уже добавлен в Grafana автоматически."
echo -e "     Проверьте: Configuration → Data Sources → Prometheus"
echo ""
echo -e " ${GREEN}➜${NC} ${BOLD}Рекомендуемый dashboard:${NC}"
echo -e "     1. В Grafana нажмите ${BOLD}+ → Import dashboard${NC}"
echo -e "     2. Введите ID: ${BOLD}1860${NC} (Node.js Application Dashboard)"
echo -e "     3. Выберите data source: ${BOLD}Prometheus${NC}"
echo -e "     4. Нажмите ${BOLD}Import${NC}"
echo ""
echo -e " ${GREEN}➜${NC} ${BOLD}Управление:${NC}"
echo -e "     Логи Prometheus:  ${YELLOW}$DOCKER_COMPOSE logs prometheus${NC}"
echo -e "     Логи Grafana:     ${YELLOW}$DOCKER_COMPOSE logs grafana${NC}"
echo -e "     Перезапуск:       ${YELLOW}$DOCKER_COMPOSE restart${NC}"
echo -e "     Остановка:        ${YELLOW}$DOCKER_COMPOSE down${NC}"
echo -e "     Обновление:       ${YELLOW}./update-monitoring.sh${NC}"
echo ""
echo -e " ${GREEN}➜${NC} ${BOLD}Скрипты:${NC}"
echo -e "     Обновление: ${YELLOW}$MONITORING_DIR/update-monitoring.sh${NC}"
echo -e "     Удаление:   ${YELLOW}$MONITORING_DIR/uninstall-monitoring.sh${NC}"
echo ""

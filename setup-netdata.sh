#!/usr/bin/env bash
set -euo pipefail

# ==============================================================
# VoidChat Server — Netdata Monitoring Setup
# Установка и настройка Netdata мониторинга для VoidChat Server
#
# Использование:
#   sudo bash setup-netdata.sh
# ==============================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
step() { echo ""; echo -e "${BOLD}━━━ $1 ━━━${NC}"; }

NETDATA_PORT="19999"
APP_PORT="${PORT:-9001}"
PROM_CONF="/etc/netdata/go.d/prometheus.conf"

echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     VoidChat Server — Netdata Setup         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# --------------------------------------------------------------
# 1. Root check & OS detection
# --------------------------------------------------------------
if [ "$EUID" -ne 0 ]; then
    err "Этот скрипт должен быть запущен с правами root."
    err "Используйте: sudo bash setup-netdata.sh"
    exit 1
fi

if [ ! -f /etc/os-release ]; then
    err "Поддерживается только Linux (Ubuntu/Debian)."
    exit 1
fi

. /etc/os-release
if [ "$ID" != "ubuntu" ] && [ "$ID" != "debian" ]; then
    err "Поддерживается только Ubuntu или Debian. Обнаружено: $ID"
    exit 1
fi

log "ОС: $NAME $VERSION_ID ($(uname -m))"

# --------------------------------------------------------------
# 2. Установка Netdata (если не установлена)
# --------------------------------------------------------------
step "1/6 — Установка Netdata"

if command -v netdata &>/dev/null; then
    log "Netdata уже установлена: $(netdata -v 2>/dev/null || echo 'версия ?')"
elif systemctl list-units --type=service --state=running 2>/dev/null | grep -q netdata; then
    log "Netdata уже запущена (обнаружена в systemd)"
elif [ -f /usr/sbin/netdata ]; then
    log "Netdata уже установлена (бинарник найден)"
else
    log "Устанавливаем Netdata через официальный скрипт..."
    bash <(curl -Ss https://my-netdata.io/kickstart.sh) --dont-wait
    log "Netdata установлена"
fi

# Убеждаемся, что Netdata запущена
if systemctl is-active --quiet netdata 2>/dev/null; then
    log "Netdata запущена"
else
    log "Запускаем Netdata..."
    systemctl enable netdata &>/dev/null || true
    systemctl restart netdata &>/dev/null || true
    log "Netdata запущена"
fi

# --------------------------------------------------------------
# 3. Настройка Prometheus-метрик в Netdata
# --------------------------------------------------------------
step "2/6 — Настройка Prometheus-метрик"

# Создаём директорию для конфигов go.d, если её нет
GO_D_DIR=$(dirname "$PROM_CONF")
if [ ! -d "$GO_D_DIR" ]; then
    mkdir -p "$GO_D_DIR"
    log "Создана директория $GO_D_DIR"
fi

# Проверяем, есть ли уже конфигурация для voidchat-server
CONFIG_EXISTS=false
if [ -f "$PROM_CONF" ]; then
    if grep -q "voidchat-server" "$PROM_CONF" 2>/dev/null; then
        CONFIG_EXISTS=true
        log "Конфигурация Prometheus для voidchat-server уже существует"
    fi
fi

if [ "$CONFIG_EXISTS" = false ]; then
    log "Создаём конфигурацию Prometheus для voidchat-server..."
    cat > "$PROM_CONF" <<EOF
jobs:
  - name: voidchat-server
    url: http://localhost:${APP_PORT}/metrics
EOF
    log "Конфигурация создана: $PROM_CONF"
fi

# Проверяем, что эндпоинт /metrics отвечает
if curl -s --max-time 3 "http://127.0.0.1:${APP_PORT}/metrics" &>/dev/null; then
    log "Метрики приложения доступны на http://127.0.0.1:${APP_PORT}/metrics"
else
    warn "Эндпоинт /metrics не отвечает. Убедитесь, что METRICS_ENABLED=true в /etc/voidchat-server.env"
    warn "После включения выполните: pm2 restart voidchat-server"
fi

# --------------------------------------------------------------
# 4. Безопасность: настройка доступа к Netdata Dashboard
# --------------------------------------------------------------
step "3/6 — Настройка доступа к Netdata Dashboard"

# Определяем IP пользователя (для внешних подключений)
get_my_ip() {
    curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s icanhazip.com 2>/dev/null || echo "unknown"
}

echo ""
echo "Как открыть Netdata Dashboard?"
echo "  1) Только localhost (безопасно, смотреть через SSH-туннель) [рекомендуется]"
echo "  2) Только мой IP (если статический IP)"
echo "  3) Всему интернету (НЕ РЕКОМЕНДУЕТСЯ)"
echo ""
read -r -p "Выберите [1/2/3] (1): " ACCESS_CHOICE
ACCESS_CHOICE="${ACCESS_CHOICE:-1}"

NETDATA_CONF="/etc/netdata/netdata.conf"
NETDATA_CONF_DIR="/etc/netdata/netdata.conf.d"
NETDATA_BIND_FILE="${NETDATA_CONF_DIR}/bind.conf"

case "$ACCESS_CHOICE" in
    2)
        MY_IP=$(get_my_ip)
        if [ "$MY_IP" = "unknown" ]; then
            warn "Не удалось определить внешний IP. Переключаю на localhost."
            ACCESS_CHOICE=1
        else
            log "Ваш внешний IP: $MY_IP"
        fi
        ;;
esac

# Удаляем старое правило UFW для 19999 (если есть)
if command -v ufw &>/dev/null; then
    # Удаляем все предыдущие правила для порта 19999
    while ufw status numbered 2>/dev/null | grep -q "${NETDATA_PORT}/tcp"; do
        RULE_NUM=$(ufw status numbered 2>/dev/null | grep "${NETDATA_PORT}/tcp" | head -1 | grep -o '^\[\s*[0-9]*' | grep -o '[0-9]*')
        if [ -n "$RULE_NUM" ]; then
            echo "y" | ufw delete "$RULE_NUM" &>/dev/null || true
        else
            break
        fi
    done
    log "Старые правила UFW для порта ${NETDATA_PORT} удалены"
fi

case "$ACCESS_CHOICE" in
    1)
        log "Настройка: только localhost (127.0.0.1:${NETDATA_PORT})"

        # Создаём override-конфиг для bind на localhost
        mkdir -p "$NETDATA_CONF_DIR"
        cat > "$NETDATA_BIND_FILE" <<EOF
[web]
    bind to = 127.0.0.1:${NETDATA_PORT}
EOF
        log "Netdata настроена слушать только на 127.0.0.1:${NETDATA_PORT}"
        ;;

    2)
        log "Настройка: только для IP $MY_IP"

        # Открываем UFW для конкретного IP
        if command -v ufw &>/dev/null; then
            ufw allow from "$MY_IP" to any port "${NETDATA_PORT}" proto tcp comment 'Netdata' &>/dev/null || true
            log "UFW: порт ${NETDATA_PORT} открыт только для IP $MY_IP"
        else
            warn "UFW не установлен. Установите: apt-get install ufw"
        fi

        # Netdata слушает на всех интерфейсах (но UFW фильтрует)
        if [ -f "$NETDATA_BIND_FILE" ]; then
            rm -f "$NETDATA_BIND_FILE"
            log "Удалён override-конфиг bind (Netdata будет слушать на всех интерфейсах)"
        fi
        ;;

    3)
        warn "ВНИМАНИЕ: Netdata будет доступна всему интернету!"
        warn "Это НЕ РЕКОМЕНДУЕТСЯ. Используйте reverse proxy с аутентификацией."
        echo ""

        # Открываем UFW для всех
        if command -v ufw &>/dev/null; then
            ufw allow "${NETDATA_PORT}/tcp" comment 'Netdata' &>/dev/null || true
            log "UFW: порт ${NETDATA_PORT}/tcp открыт для всех"
        else
            warn "UFW не установлен. Установите: apt-get install ufw"
        fi

        # Netdata слушает на всех интерфейсах
        if [ -f "$NETDATA_BIND_FILE" ]; then
            rm -f "$NETDATA_BIND_FILE"
            log "Удалён override-конфиг bind (Netdata будет слушать на всех интерфейсах)"
        fi
        ;;
esac

# Проверяем, включён ли UFW
if command -v ufw &>/dev/null; then
    if ufw status | grep -q "Status: inactive"; then
        warn "UFW выключен. Рекомендуется включить: ufw allow ssh && ufw --force enable"
    fi
fi

# --------------------------------------------------------------
# 5. Перезапуск Netdata
# --------------------------------------------------------------
step "4/6 — Перезапуск Netdata"

log "Перезапускаем Netdata..."
systemctl restart netdata &>/dev/null || true

# Даём время на запуск
sleep 2

if systemctl is-active --quiet netdata 2>/dev/null; then
    log "Netdata успешно перезапущена"
else
    err "Netdata не запустилась. Проверьте: systemctl status netdata"
    exit 1
fi

# --------------------------------------------------------------
# 6. Проверка
# --------------------------------------------------------------
step "5/6 — Проверка"

# 6a. Проверка Netdata Dashboard
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${NETDATA_PORT}/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
    log "Netdata Dashboard отвечает на http://127.0.0.1:${NETDATA_PORT}/ (HTTP $HTTP_CODE)"
else
    warn "Netdata Dashboard не отвечает (HTTP $HTTP_CODE). Проверьте: systemctl status netdata"
    warn "Логи: journalctl -u netdata -n 30 --no-pager"
fi

# 6b. Проверка метрик приложения
if curl -s --max-time 3 "http://127.0.0.1:${APP_PORT}/metrics" &>/dev/null; then
    METRICS_OUTPUT=$(curl -s --max-time 3 "http://127.0.0.1:${APP_PORT}/metrics")
    if echo "$METRICS_OUTPUT" | grep -q "voidchat_connections_total"; then
        log "Метрики приложения доступны и содержат voidchat_* метрики"
    else
        warn "Метрики приложения доступны, но voidchat_* метрики не найдены"
        warn "Убедитесь, что METRICS_ENABLED=true в /etc/voidchat-server.env"
    fi
else
    warn "Эндпоинт /metrics не отвечает на порту ${APP_PORT}"
    warn "Убедитесь, что сервер запущен и METRICS_ENABLED=true"
fi

# 6c. Проверка Prometheus-конфига Netdata
if [ -f "$PROM_CONF" ]; then
    # Проверяем синтаксис YAML базово — ищем обязательные поля
    if grep -q "name: voidchat-server" "$PROM_CONF" && grep -q "url:" "$PROM_CONF"; then
        log "Prometheus-конфиг Netdata корректен"
    else
        warn "Prometheus-конфиг Netdata повреждён. Проверьте: $PROM_CONF"
    fi
else
    err "Prometheus-конфиг Netdata не найден: $PROM_CONF"
    exit 1
fi

# --------------------------------------------------------------
# 7. Вывод результата
# --------------------------------------------------------------
step "6/6 — Результат"

echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║        NETDATA SETUP COMPLETE ✓             ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

echo -e " ${GREEN}➜${NC} ${BOLD}Netdata Dashboard:${NC}"
case "$ACCESS_CHOICE" in
    1)
        echo -e "   http://127.0.0.1:${NETDATA_PORT}/"
        echo ""
        echo -e " ${YELLOW}━━━ SSH-туннель для доступа ━━━${NC}"
        echo -e "   На локальной машине выполните:"
        echo ""
        echo -e "   ${BOLD}ssh -L ${NETDATA_PORT}:127.0.0.1:${NETDATA_PORT} root@<IP_СЕРВЕРА>${NC}"
        echo ""
        echo -e "   Затем откройте в браузере: ${BOLD}http://127.0.0.1:${NETDATA_PORT}${NC}"
        echo ""
        echo -e "   ${YELLOW}💡 Для постоянного туннеля добавьте -fN:${NC}"
        echo -e "   ssh -fN -L ${NETDATA_PORT}:127.0.0.1:${NETDATA_PORT} root@<IP_СЕРВЕРА>"
        ;;
    2)
        MY_IP="${MY_IP:-$(get_my_ip)}"
        echo -e "   ${BOLD}http://${MY_IP}:${NETDATA_PORT}/${NC}"
        echo ""
        echo -e "   Доступ только с IP: ${BOLD}$MY_IP${NC}"
        echo -e "   Если ваш IP изменится, выполните скрипт заново."
        ;;
    3)
        SERVER_IP=$(curl -4 -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
        echo -e "   ${BOLD}http://${SERVER_IP}:${NETDATA_PORT}/${NC}"
        echo ""
        echo -e " ${RED}⚠  Netdata доступна всему интернету!${NC}"
        echo -e " ${YELLOW}💡 Рекомендуется настроить reverse proxy с аутентификацией:${NC}"
        echo -e "    ${BOLD}bash setup-netdata-auth.sh${NC}"
        ;;
esac

echo ""
echo -e " ${YELLOW}━━━ Метрики voidchat-server ━━━${NC}"
echo -e "   Prometheus endpoint: ${BOLD}http://127.0.0.1:${APP_PORT}/metrics${NC}"
echo -e "   Netdata collector:   ${BOLD}${PROM_CONF}${NC}"
echo ""

echo -e " ${YELLOW}━━━ Управление Netdata ━━━${NC}"
echo -e "   Статус:        ${BOLD}systemctl status netdata${NC}"
echo -e "   Логи:          ${BOLD}journalctl -u netdata -n 50 -f${NC}"
echo -e "   Конфиг:        ${BOLD}/etc/netdata/netdata.conf${NC}"
echo -e "   Перезапуск:    ${BOLD}systemctl restart netdata${NC}"
echo -e "   Dashboard:     ${BOLD}http://127.0.0.1:${NETDATA_PORT}/${NC}"
echo ""

echo -e " ${YELLOW}━━━ Метрики в Netdata Dashboard ━━━${NC}"
echo -e "   1. Откройте Dashboard"
echo -e "   2. Выберите вкладку \"Metrics\""
echo -e "   3. Найдите секцию \"voidchat-server\" (Prometheus collector)"
echo ""

# Если был выбран localhost — напоминание про туннель
if [ "$ACCESS_CHOICE" = "1" ]; then
    echo -e " ${YELLOW}💡 Доступ к Dashboard только через SSH-туннель (см. выше)${NC}"
fi

echo -e " ${GREEN}✓${NC} Настройка Netdata завершена."
echo ""

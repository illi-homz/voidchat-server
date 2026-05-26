#!/usr/bin/env bash
# ==============================================================
# setup-netdata.sh — установка и настройка Netdata мониторинга
# для VoidChat Server.
#
# Что делает:
#   1. Устанавливает Netdata (если ещё не установлена)
#   2. Настраивает сбор Prometheus-метрик voidchat-server
#   3. Настраивает безопасный доступ к дашборду (через UFW/bind)
#   4. Выводит инструкцию для подключения
#
# Использование:
#   sudo bash setup-netdata.sh
#
# Зависимости: curl, systemd, Linux (Ubuntu/Debian)
# ==============================================================
set -euo pipefail

# — Цвета для красивого вывода в терминале —
GREEN='\033[0;32m'   # зелёный — успех
YELLOW='\033[1;33m'  # жёлтый — предупреждение
RED='\033[0;31m'     # красный — ошибка
NC='\033[0m'         # сброс цвета
BOLD='\033[1m'       # жирный текст

# Функции для логирования с префиксами
#   log  — [✓] сообщение (зелёный)
#   warn — [!] предупреждение (жёлтый)
#   err  — [✗] ошибка (красный)
#   step — разделитель шага (жирный)
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
step() { echo ""; echo -e "${BOLD}━━━ $1 ━━━${NC}"; }

# — Конфигурация —
NETDATA_PORT="19999"                                    # порт Netdata Dashboard
APP_PORT="${PORT:-9001}"                                # порт voidchat-server (из переменной PORT или 9001)
PROM_CONF="/etc/netdata/go.d/prometheus.conf"           # путь к конфигу Prometheus-коллектора Netdata

echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     VoidChat Server — Netdata Setup         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ==============================================================
# 1. ПРОВЕРКА ПРАВ ROOT И СОВМЕСТИМОСТИ ОС
# ==============================================================
# Скрипт требует root для установки пакетов и настройки UFW/Netdata.
# Поддерживаются Ubuntu и Debian (через /etc/os-release).
step "1/6 — Проверка системы"

# Проверка, что скрипт запущен от root (UID = 0)
if [ "$EUID" -ne 0 ]; then
    err "Этот скрипт должен быть запущен с правами root."
    err "Используйте: sudo bash setup-netdata.sh"
    exit 1
fi
log "Проверка прав root: OK"

# Проверяем наличие файла /etc/os-release (есть на всех современных Linux)
if [ ! -f /etc/os-release ]; then
    err "Поддерживается только Linux (Ubuntu/Debian)."
    err "Файл /etc/os-release не найден — не удаётся определить ОС."
    exit 1
fi

# Загружаем переменные из /etc/os-release (ID, NAME, VERSION_ID и т.д.)
. /etc/os-release
if [ "$ID" != "ubuntu" ] && [ "$ID" != "debian" ]; then
    err "Поддерживается только Ubuntu или Debian. Обнаружено: $ID"
    exit 1
fi

log "ОС: $NAME $VERSION_ID ($(uname -m))"

# ==============================================================
# 2. УСТАНОВКА NETDATA
# ==============================================================
# Используем официальный kickstart-скрипт Netdata.
# Он сам добавляет репозиторий, устанавливает пакет и включает сервис.
# Если Netdata уже установлена — пропускаем.
step "2/6 — Установка Netdata"

# Проверяем, установлена ли Netdata разными способами
if command -v netdata &>/dev/null; then
    # Бинарник netdata найден в PATH — уже установлена
    log "Netdata уже установлена: $(netdata -v 2>/dev/null || echo 'версия ?')"
elif [ -f /usr/sbin/netdata ]; then
    # Бинарник найден по стандартному пути
    log "Netdata уже установлена (бинарник найден)"
else
    # Устанавливаем через официальный скрипт
    log "Устанавливаем Netdata через официальный скрипт..."
    bash <(curl -Ss https://my-netdata.io/kickstart.sh) --dont-wait
    log "Netdata установлена"
fi

# Запускаем Netdata, если она ещё не запущена
if systemctl is-active --quiet netdata 2>/dev/null; then
    log "Netdata запущена"
else
    log "Запускаем Netdata..."
    systemctl enable netdata &>/dev/null || true   # автозапуск при загрузке
    systemctl restart netdata &>/dev/null || true  # явный запуск
    log "Netdata запущена"
fi

# ==============================================================
# 3. НАСТРОЙКА PROMETHEUS-МЕТРИК В NETDATA
# ==============================================================
# Netdata умеет собирать метрики из Prometheus-эндпоинтов через
# встроенный collector. Мы добавляем конфиг, который указывает
# Netdata парсить /metrics нашего voidchat-server.
step "3/6 — Настройка Prometheus-метрик"

# Создаём директорию для конфигов go.d (коллекторы Netdata)
GO_D_DIR=$(dirname "$PROM_CONF")
if [ ! -d "$GO_D_DIR" ]; then
    mkdir -p "$GO_D_DIR"
    log "Создана директория $GO_D_DIR"
fi

# Проверяем, есть ли уже конфигурация для voidchat-server
# Если есть — не перезаписываем (идемпотентность)
CONFIG_EXISTS=false
if [ -f "$PROM_CONF" ]; then
    if grep -q "voidchat-server" "$PROM_CONF" 2>/dev/null; then
        CONFIG_EXISTS=true
        log "Конфигурация Prometheus для voidchat-server уже существует"
    fi
fi

if [ "$CONFIG_EXISTS" = false ]; then
    log "Создаём конфигурацию Prometheus для voidchat-server..."
    # Создаём YAML-конфиг для Prometheus-коллектора Netdata
    # name: имя секции в дашборде
    # url:  адрес /metrics нашего сервера
    cat > "$PROM_CONF" <<EOF
jobs:
  - name: voidchat-server
    url: http://localhost:${APP_PORT}/metrics
EOF
    log "Конфигурация создана: $PROM_CONF"
fi

# Проверяем, что эндпоинт /metrics отвечает (метрики включены)
if curl -s --max-time 3 "http://127.0.0.1:${APP_PORT}/metrics" &>/dev/null; then
    log "Метрики приложения доступны на http://127.0.0.1:${APP_PORT}/metrics"
else
    warn "Эндпоинт /metrics не отвечает. Убедитесь, что METRICS_ENABLED=true в /etc/voidchat-server.env"
    warn "После включения выполните: pm2 restart voidchat-server"
fi

# ==============================================================
# 4. НАСТРОЙКА БЕЗОПАСНОСТИ ДОСТУПА
# ==============================================================
# Netdata Dashboard показывает много информации о сервере.
# Выбираем один из трёх уровней доступа:
#   1 — только localhost (SSH-туннель) — безопасно
#   2 — только текущий IP — удобно, если IP статический
#   3 — всем в интернете — опасно, не рекомендуется
step "4/6 — Настройка доступа к Netdata Dashboard"

# Функция: определить внешний IP сервера (для варианта 2)
get_my_ip() {
    curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s icanhazip.com 2>/dev/null || echo "unknown"
}

# Выводим меню выбора уровня доступа
echo ""
echo "Как открыть Netdata Dashboard?"
echo "  1) Только localhost (безопасно, смотреть через SSH-туннель) [рекомендуется]"
echo "  2) Только мой IP (если статический IP)"
echo "  3) Всему интернету (НЕ РЕКОМЕНДУЕТСЯ)"
echo ""
read -r -p "Выберите [1/2/3] (1): " ACCESS_CHOICE
ACCESS_CHOICE="${ACCESS_CHOICE:-1}"  # по умолчанию — localhost

# Пути к конфигам Netdata
NETDATA_CONF_DIR="/etc/netdata/netdata.conf.d"    # директория override-конфигов
NETDATA_BIND_FILE="${NETDATA_CONF_DIR}/bind.conf" # файл с настройкой bind (на каком IP слушать)

# Если выбран вариант 2 — определяем внешний IP пользователя
case "$ACCESS_CHOICE" in
    2)
        MY_IP=$(get_my_ip)
        if [ "$MY_IP" = "unknown" ]; then
            warn "Не удалось определить внешний IP. Переключаю на localhost."
            ACCESS_CHOICE=1  # fallback на localhost
        else
            log "Ваш внешний IP: $MY_IP"
        fi
        ;;
esac

# — Очистка старых правил UFW —
# Удаляем все предыдущие правила для порта Netdata, чтобы не было дублей
if command -v ufw &>/dev/null; then
    # Циклом удаляем все правила, пока они есть
    while ufw status numbered 2>/dev/null | grep -q "${NETDATA_PORT}/tcp"; do
        # Извлекаем номер правила из строки вида "[ 5] 19999/tcp ALLOW ..."
        RULE_NUM=$(ufw status numbered 2>/dev/null | grep "${NETDATA_PORT}/tcp" | head -1 | grep -o '^\[\s*[0-9]*' | grep -o '[0-9]*')
        if [ -n "$RULE_NUM" ]; then
            echo "y" | ufw delete "$RULE_NUM" &>/dev/null || true
        else
            break  # если не удалось извлечь номер — выходим из цикла
        fi
    done
    log "Старые правила UFW для порта ${NETDATA_PORT} удалены"
fi

# — Применяем выбранный уровень доступа —
case "$ACCESS_CHOICE" in
    1)
        # Режим LOCALHOST: Netdata слушает ТОЛЬКО на 127.0.0.1
        # Доступ через SSH-туннель — самый безопасный вариант
        log "Настройка: только localhost (127.0.0.1:${NETDATA_PORT})"

        # Создаём override-конфиг, который переопределяет bind-адрес Netdata
        # Вместо 0.0.0.0 (все интерфейсы) — только 127.0.0.1 (localhost)
        mkdir -p "$NETDATA_CONF_DIR"
        cat > "$NETDATA_BIND_FILE" <<EOF
[web]
    bind to = 127.0.0.1:${NETDATA_PORT}
EOF
        log "Netdata настроена слушать только на 127.0.0.1:${NETDATA_PORT}"
        ;;

    2)
        # Режим ПОЛЬЗОВАТЕЛЬСКИЙ IP: UFW открывает порт только для указанного IP
        # Netdata при этом слушает на всех интерфейсах, но UFW блокирует остальных
        log "Настройка: только для IP $MY_IP"

        # Открываем UFW для конкретного IP
        if command -v ufw &>/dev/null; then
            ufw allow from "$MY_IP" to any port "${NETDATA_PORT}" proto tcp comment 'Netdata' &>/dev/null || true
            log "UFW: порт ${NETDATA_PORT} открыт только для IP $MY_IP"
        else
            warn "UFW не установлен. Установите: apt-get install ufw"
        fi

        # Удаляем bind-конфиг localhost (если был), чтобы Netdata слушала на всех интерфейсах
        if [ -f "$NETDATA_BIND_FILE" ]; then
            rm -f "$NETDATA_BIND_FILE"
            log "Удалён override-конфиг bind (Netdata будет слушать на всех интерфейсах)"
        fi
        ;;

    3)
        # Режим ВЕСЬ ИНТЕРНЕТ: опасно! Без аутентификации любой может смотреть метрики
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

        # Удаляем bind-конфиг localhost (если был)
        if [ -f "$NETDATA_BIND_FILE" ]; then
            rm -f "$NETDATA_BIND_FILE"
            log "Удалён override-конфиг bind (Netdata будет слушать на всех интерфейсах)"
        fi
        ;;
esac

# Дополнительная проверка: включён ли UFW вообще
if command -v ufw &>/dev/null; then
    if ufw status | grep -q "Status: inactive"; then
        warn "UFW выключен. Рекомендуется включить: ufw allow ssh && ufw --force enable"
    fi
fi

# ==============================================================
# 5. ПЕРЕЗАПУСК NETDATA
# ==============================================================
# После изменения конфигов (prometheus.conf, bind.conf) нужно
# перезапустить Netdata, чтобы применить настройки.
step "5/6 — Перезапуск Netdata"

log "Перезапускаем Netdata..."
systemctl restart netdata &>/dev/null || true

# Даём время на запуск (Netdata стартует ~1-2 секунды)
sleep 2

# Проверяем, что Netdata запустилась успешно
if systemctl is-active --quiet netdata 2>/dev/null; then
    log "Netdata успешно перезапущена"
else
    err "Netdata не запустилась. Проверьте: systemctl status netdata"
    exit 1
fi

# ==============================================================
# 6. ПРОВЕРКА РАБОТОСПОСОБНОСТИ
# ==============================================================
# Три проверки:
#   а) Netdata Dashboard отвечает HTTP 200
#   б) Метрики voidchat-server доступны и содержат voidchat_*
#   в) Prometheus-конфиг корректен
step "6/6 — Проверка работоспособности"

# 6а. Проверка Netdata Dashboard
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${NETDATA_PORT}/" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
    log "Netdata Dashboard отвечает на http://127.0.0.1:${NETDATA_PORT}/ (HTTP $HTTP_CODE)"
else
    warn "Netdata Dashboard не отвечает (HTTP $HTTP_CODE). Проверьте: systemctl status netdata"
    warn "Логи: journalctl -u netdata -n 30 --no-pager"
fi

# 6б. Проверка метрик приложения (voidchat_*)
if curl -s --max-time 3 "http://127.0.0.1:${APP_PORT}/metrics" &>/dev/null; then
    METRICS_OUTPUT=$(curl -s --max-time 3 "http://127.0.0.1:${APP_PORT}/metrics")
    if echo "$METRICS_OUTPUT" | grep -q "voidchat_connections_total"; then
        log "Метрики приложения доступны и содержат voidchat_* метрики"
    else
        warn "Метрики приложения доступны, но voidchat_* метрики не найдены"
        warn "Убедитесь, что METRICS_ENABLED=true в /etc/voidchat-server.env"
        warn "После изменения выполните: pm2 restart voidchat-server"
    fi
else
    warn "Эндпоинт /metrics не отвечает на порту ${APP_PORT}"
    warn "Убедитесь, что сервер запущен и METRICS_ENABLED=true"
fi

# 6в. Проверка Prometheus-конфига Netdata
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

# ==============================================================
# 7. ВЫВОД РЕЗУЛЬТАТА И ИНСТРУКЦИЙ
# ==============================================================
step "Результат"

echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║        NETDATA SETUP COMPLETE ✓             ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# Раздел: как подключиться к дашборду
echo -e " ${GREEN}➜${NC} ${BOLD}Netdata Dashboard:${NC}"
case "$ACCESS_CHOICE" in
    1)
        # Режим LOCALHOST: нужен SSH-туннель
        echo -e "   http://127.0.0.1:${NETDATA_PORT}/"
        echo ""
        echo -e " ${YELLOW}━━━ SSH-туннель для доступа ━━━${NC}"
        echo -e "   На локальной машине выполните одну из команд:"
        echo ""
        echo -e "   ${BOLD}ssh -L ${NETDATA_PORT}:127.0.0.1:${NETDATA_PORT} root@<IP_СЕРВЕРА>${NC}"
        echo ""
        echo -e "   Затем откройте в браузере: ${BOLD}http://127.0.0.1:${NETDATA_PORT}${NC}"
        echo ""
        echo -e "   ${YELLOW}💡 Для фонового туннеля (работает в фоне):${NC}"
        echo -e "   ${BOLD}ssh -fN -L ${NETDATA_PORT}:127.0.0.1:${NETDATA_PORT} root@<IP_СЕРВЕРА>${NC}"
        echo ""
        echo -e "   ${YELLOW}💡 Для остановки туннеля:${NC}"
        echo -e "   ${BOLD}pkill -f \"ssh.*-L.*${NETDATA_PORT}\"${NC}"
        ;;
    2)
        # Режим ПОЛЬЗОВАТЕЛЬСКИЙ IP: доступ только с одного IP
        MY_IP="${MY_IP:-$(get_my_ip)}"
        echo -e "   ${BOLD}http://${MY_IP}:${NETDATA_PORT}/${NC}"
        echo ""
        echo -e "   Доступ только с IP: ${BOLD}$MY_IP${NC}"
        echo -e "   Если ваш IP изменится, выполните скрипт заново."
        ;;
    3)
        # Режим ВЕСЬ ИНТЕРНЕТ: предупреждение
        SERVER_IP=$(curl -4 -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
        echo -e "   ${BOLD}http://${SERVER_IP}:${NETDATA_PORT}/${NC}"
        echo ""
        echo -e " ${RED}⚠  Netdata доступна всему интернету!${NC}"
        echo -e " ${YELLOW}💡 Настоятельно рекомендуется настроить reverse proxy с аутентификацией.${NC}"
        ;;
esac

# Раздел: дополнительная информация
echo ""
echo -e " ${YELLOW}━━━ Метрики voidchat-server ━━━${NC}"
echo -e "   Prometheus-эндпоинт: ${BOLD}http://127.0.0.1:${APP_PORT}/metrics${NC}"
echo -e "   Конфиг Netdata:       ${BOLD}${PROM_CONF}${NC}"
echo ""

echo -e " ${YELLOW}━━━ Управление Netdata ━━━${NC}"
echo -e "   Статус:        ${BOLD}systemctl status netdata${NC}"
echo -e "   Логи:          ${BOLD}journalctl -u netdata -n 50 -f${NC}"
echo -e "   Конфиг:        ${BOLD}/etc/netdata/netdata.conf${NC}"
echo -e "   Перезапуск:    ${BOLD}systemctl restart netdata${NC}"
echo ""

echo -e " ${YELLOW}━━━ Метрики в Netdata Dashboard ━━━${NC}"
echo -e "   После подключения к Dashboard:"
echo -e "   1. Перейдите на вкладку \"Metrics\" (слева)"
echo -e "   2. В поиске введите \"voidchat\""
echo -e "   3. Выберите секцию \"voidchat-server\" (Prometheus collector)"
echo -e "   Там будут графики: connections, users, calls, messages, errors"
echo ""

# Если был выбран localhost — напоминание про туннель
if [ "$ACCESS_CHOICE" = "1" ]; then
    echo -e " ${YELLOW}💡 Доступ к Dashboard только через SSH-туннель${NC}"
    echo -e "    Выполните команду туннеля на своей локальной машине (см. выше)."
fi

echo ""
echo -e " ${GREEN}✓${NC} Настройка Netdata завершена."
echo ""

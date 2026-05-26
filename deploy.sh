#!/usr/bin/env bash
set -euo pipefail

# ==============================================================
# VoidChat Server — Automated Deploy
# Одна команда: установка + автозапуск + отказоустойчивость
#
# Использование:
#   curl -sS https://raw.githubusercontent.com/illi-homz/voidchat-server/main/deploy.sh | sudo bash
# ==============================================================

REPO_URL="https://github.com/illi-homz/voidchat-server.git"
NODE_VERSION="22"
PORT="${PORT:-9001}"

# Определяем HOME принудительно: sudo bash часто оставляет HOME от обычного пользователя,
# а нам нужно /root, т.к. скрипт работает от root. Иначе pm2 и пути разъезжаются.
if [ "$EUID" -eq 0 ]; then
	export HOME="/root"
fi
SERVER_DIR="$HOME/voidchat-server"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }

echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║      VoidChat Server — Automated Deploy     ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

# --------------------------------------------------------------
# 1. Root check & OS detection
# --------------------------------------------------------------
if [ "$EUID" -ne 0 ]; then
    err "Этот скрипт должен быть запущен с правами root."
    err "Используйте: curl ... | sudo bash"
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
log "CPU: $(nproc) ядра/ядер, RAM: $(free -m | awk '/Mem:/{print $2}') MB"

# --------------------------------------------------------------
# 1b. Создание swap для маломощных VPS
# --------------------------------------------------------------
TOTAL_RAM=$(free -m | awk '/Mem:/{print $2}')
if [ "$TOTAL_RAM" -lt 2048 ] && [ -z "$(swapon --show 2>/dev/null)" ]; then
    log "RAM ${TOTAL_RAM}MB < 2048MB, swap выключен. Создаём swap-файл 1GB..."
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile &>/dev/null
    swapon /swapfile &>/dev/null
    if ! grep -q '/swapfile' /etc/fstab 2>/dev/null; then
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi
    log "Swap-файл 1GB создан и активирован"
else
    log "Swap не требуется (RAM=${TOTAL_RAM}MB или swap уже активен)"
fi

# --------------------------------------------------------------
# 2. Обновление пакетов (тихо, без интерактива)
# --------------------------------------------------------------
log "Обновляем системные пакеты..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq &>/dev/null
apt-get upgrade -y -qq &>/dev/null
log "Система обновлена"

# --------------------------------------------------------------
# 2b. Автообновления безопасности (unattended-upgrades)
# --------------------------------------------------------------
log "Настраиваем автообновления безопасности..."
if ! dpkg-query -W -f='${Status}' unattended-upgrades 2>/dev/null | grep -q "ok installed"; then
    apt-get install -y unattended-upgrades &>/dev/null
fi
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable unattended-upgrades &>/dev/null || true
systemctl restart unattended-upgrades &>/dev/null || true
log "Автообновления безопасности включены"

# --------------------------------------------------------------
# 2c. Установка и настройка fail2ban
# --------------------------------------------------------------
log "Настраиваем fail2ban (защита от брутфорса)..."
if ! command -v fail2ban-server &>/dev/null; then
    apt-get install -y fail2ban &>/dev/null
fi
cat > /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled = true
port = ssh
maxretry = 5
bantime = 3600
findtime = 600
EOF
systemctl restart fail2ban &>/dev/null || true
systemctl enable fail2ban &>/dev/null || true
log "fail2ban установлен и настроен (SSH: 5 попыток → бан 1 час)"

# --------------------------------------------------------------
# 3. Установка Node.js 22+
# --------------------------------------------------------------
INSTALL_NODE=false
if command -v node &>/dev/null; then
    INSTALLED_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$INSTALLED_MAJOR" -ge 22 ]; then
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
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - &>/dev/null
    apt-get install -y nodejs &>/dev/null
    log "Node.js $(node -v) установлен"
fi

# --------------------------------------------------------------
# 4. Установка Git
# --------------------------------------------------------------
if ! command -v git &>/dev/null; then
    apt-get install -y git &>/dev/null
fi
log "Git: $(git --version)"

# --------------------------------------------------------------
# 5. Установка build-essential (нужен для нативных модулей)
# --------------------------------------------------------------
if ! command -v make &>/dev/null; then
    apt-get install -y build-essential &>/dev/null
    log "build-essential установлен"
fi

# --------------------------------------------------------------
# 6. Клонирование / обновление репозитория
# --------------------------------------------------------------
if [ -d "$SERVER_DIR" ]; then
    warn "Директория $SERVER_DIR уже существует. Обновляем..."
    cd "$SERVER_DIR"
    git stash --include-untracked &>/dev/null || true
    git pull --ff-only &>/dev/null || {
        err "Не удалось обновить репозиторий. Проверьте вручную: cd $SERVER_DIR && git status"
        exit 1
    }
else
    log "Клонируем репозиторий..."
    git clone --depth 1 "$REPO_URL" "$SERVER_DIR" &>/dev/null
fi

cd "$SERVER_DIR"

# --------------------------------------------------------------
# 7. Установка зависимостей (сначала ВСЕ, включая dev — нужны для сборки)
# --------------------------------------------------------------
log "Устанавливаем зависимости (включая TypeScript для сборки)..."
npm install &>/dev/null
log "npm install завершён"

log "Собираем TypeScript → dist/server.js..."
npm run build &>/dev/null
log "Сборка завершена"

log "Удаляем dev-зависимости (TypeScript, tsx, eslint...) — экономия места..."
npm prune --omit=dev &>/dev/null
log "Dev-зависимости удалены"

# --------------------------------------------------------------
# 7b. Создание конфигурационного файла мониторинга
# --------------------------------------------------------------
ENV_FILE="/etc/voidchat-server.env"
if [ ! -f "$ENV_FILE" ]; then
    log "Создаём конфигурационный файл мониторинга ($ENV_FILE)..."
    cat > "$ENV_FILE" <<'ENVEOF'
# === Мониторинг и логирование ===

# Sentry/GlitchTip DSN для error tracking (оставьте пустым для отключения)
# Совместим с GlitchTip (self-hosted Sentry)
# SENTRY_DSN=https://key@glitchtip.example.com/1

# Уровень логирования: debug | info | warn | error | silent
# LOG_LEVEL=info

# Формат логов: pretty | json
# LOG_FORMAT=pretty

# Включить Prometheus-метрики (true/false)
# METRICS_ENABLED=false
ENVEOF
    chmod 644 "$ENV_FILE"
    log "Файл $ENV_FILE создан. Отредактируйте его для настройки мониторинга."
else
    log "Файл конфигурации $ENV_FILE уже существует"
fi

# --------------------------------------------------------------
# 8. Установка pm2
# --------------------------------------------------------------
if ! command -v pm2 &>/dev/null; then
    log "Устанавливаем pm2 глобально..."
    npm install -g pm2 &>/dev/null
fi

PM2_VERSION=$(pm2 -v 2>/dev/null || echo "?")
log "pm2 v$PM2_VERSION"

# --------------------------------------------------------------
# 9. Настройка UFW (фаервол)
# --------------------------------------------------------------
if command -v ufw &>/dev/null; then
    ufw allow ssh &>/dev/null || true
    ufw allow "$PORT/tcp" &>/dev/null || true

    if ufw status | grep -q "Status: inactive"; then
        log "Включаем UFW..."
        ufw --force enable &>/dev/null
    fi
    log "UFW активен, порт $PORT/tcp открыт (SSH сохранён)"
else
    warn "UFW не установлен. Устанавливаем..."
    apt-get install -y ufw &>/dev/null
    ufw allow ssh &>/dev/null || true
    ufw allow "$PORT/tcp" &>/dev/null || true
    ufw --force enable &>/dev/null
    log "UFW установлен и включён, порт $PORT/tcp открыт"
fi

# --------------------------------------------------------------
# 10. Системные лимиты (Socket.IO держит много соединений)
# --------------------------------------------------------------
if grep -q "nofile" /etc/security/limits.d/99-voidchat.conf 2>/dev/null; then
    log "Лимит open files уже настроен"
else
    log "Настраиваем лимит open files (65536) — нужно для Socket.IO..."
    cat > /etc/security/limits.d/99-voidchat.conf <<'EOF'
* soft nofile 65536
* hard nofile 65536
root soft nofile 65536
root hard nofile 65536
EOF
    log "Лимит open files: 65536"
fi

# Применяем для текущей сессии
ulimit -n 65536 2>/dev/null || true

# --------------------------------------------------------------
# 11. Установка и настройка TURN сервера (coturn для WebRTC)
# --------------------------------------------------------------

# Генерируем или загружаем TURN секрет
TURN_SECRET_FILE="/etc/voidchat-turn-secret"
if [ -f "$TURN_SECRET_FILE" ]; then
    TURN_SECRET=$(cat "$TURN_SECRET_FILE")
    log "TURN секрет загружен из $TURN_SECRET_FILE"
else
    TURN_SECRET=$(openssl rand -hex 32)
    echo "$TURN_SECRET" > "$TURN_SECRET_FILE"
    chmod 600 "$TURN_SECRET_FILE"
    log "TURN секрет сгенерирован и сохранён"
fi

if ! command -v turnserver &>/dev/null; then
    log "Устанавливаем coturn (TURN сервер для WebRTC звонков)..."
    apt-get install -y coturn &>/dev/null
    log "coturn установлен"
fi

TURN_CONFIG="/etc/turnserver.conf"
if [ ! -f "$TURN_CONFIG" ] || ! grep -q "realm=voidchat" "$TURN_CONFIG" 2>/dev/null; then
    log "Настраиваем coturn..."
    cat > "$TURN_CONFIG" <<TURNEOF
listening-port=3478
fingerprint
realm=voidchat
server-name=voidchat
lt-cred-mech
user=voidchat:${TURN_SECRET}
total-quota=100
bps-capacity=0
stale-nonce=600
no-cli
no-tlsv1
no-tlsv1_1
pidfile="/var/run/turnserver.pid"
log-file="/var/log/turnserver.log"
simple-log
verbose
mobility
min-port=49152
max-port=65535
no-tls
no-dtls
TURNEOF
    
    # Включаем coturn
    echo "TURNSERVER_ENABLED=1" > /etc/default/coturn
    
    # Настраиваем лог-файл
    touch /var/log/turnserver.log
    chown turnserver:turnserver /var/log/turnserver.log 2>/dev/null || true
    
    log "coturn настроен"
fi

# Открываем порты TURN в UFW
if command -v ufw &>/dev/null; then
    ufw allow 3478/tcp &>/dev/null || true
    ufw allow 3478/udp &>/dev/null || true
    ufw allow 49152:65535/udp &>/dev/null || true
    log "Порты TURN (3478/TCP+UDP, 49152-65535/UDP) открыты в UFW"
fi

# Запускаем coturn
systemctl enable coturn &>/dev/null || true
systemctl restart coturn &>/dev/null || true
log "TURN сервер (coturn) запущен"

# --------------------------------------------------------------
# 12. Настройка автозапуска pm2 (survive reboot)
# --------------------------------------------------------------
log "Настраиваем автозапуск pm2 через systemd..."
pm2 unstartup systemd &>/dev/null || true
# pm2 startup сам выводит команду для активации systemd
STARTUP_OUTPUT=$(pm2 startup systemd -u root --hp /root 2>&1)
# Если команда не выполнилась — пробуем выполнить то что pm2 предлагает
echo "$STARTUP_OUTPUT" | grep -q "systemctl" && eval "$(echo "$STARTUP_OUTPUT" | tail -1)" 2>/dev/null || true
systemctl daemon-reload &>/dev/null || true
systemctl enable pm2-root &>/dev/null || true
if systemctl is-enabled pm2-root &>/dev/null; then
    log "pm2 автозапуск через systemd настроен"
else
    warn "Не удалось настроить pm2 автозапуск. После перезагрузки запустите: pm2 resurrect"
fi

# --------------------------------------------------------------
# 13. Определяем внешний IP для TURN-сервера
# --------------------------------------------------------------
TURN_HOST_FILE="/etc/voidchat-turn-host"
if [ -n "${DOMAIN:-}" ]; then
    TURN_HOST="$DOMAIN"
elif [ -f "$TURN_HOST_FILE" ]; then
    TURN_HOST=$(cat "$TURN_HOST_FILE")
    log "TURN_HOST загружен из $TURN_HOST_FILE: $TURN_HOST"
else
    TURN_HOST=$(curl -4 -s ifconfig.me 2>/dev/null || curl -4 -s icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')
    echo "$TURN_HOST" > "$TURN_HOST_FILE"
    chmod 644 "$TURN_HOST_FILE"
    log "TURN_HOST определён и сохранён: $TURN_HOST"
fi

# --------------------------------------------------------------
# 14. Запуск сервера через pm2 (fork mode — 1 процесс = 1 ядро)
# --------------------------------------------------------------
log "Запускаем сервер через pm2..."

# Проверка, не занят ли порт
if ss -tlnp "sport = :$PORT" 2>/dev/null | grep -q .; then
    warn "Порт $PORT уже занят! Сервер может не запуститься."
    warn "Используйте PORT=другой_порт bash deploy.sh"
else
    log "Порт $PORT свободен"
fi

# Сохраняем PORT для использования update.sh и другими скриптами
echo "$PORT" > /etc/voidchat-port
chmod 644 /etc/voidchat-port

pm2 delete voidchat-server 2>/dev/null || true

# Создаём директорию для логов (pm2 не создаёт её сам)
mkdir -p ~/voidchat-server/logs

# fork mode — единственно правильный режим для 1 vCPU:
#   - Node.js однопоточный, кластеризация на 1 ядре даст только оверхед
#   - Socket.IO асинхронный — 1 процесс держит тысячи соединений
# TURN_HOST передаётся как env — сервер отдаёт его в /turn-config для WebRTC
# Если существует /etc/voidchat-server.env — он передаётся в --env-file
PM2_ARGS=(
    --name voidchat-server
    --log-date-format "YYYY-MM-DD HH:mm:ss Z"
    --max-memory-restart "500M"
    --restart-delay 3000
    --max-restarts 5
    --env NODE_ENV=production
    --merge-logs
    --output ~/voidchat-server/logs/out.log
    --error ~/voidchat-server/logs/err.log
)

if [ -f /etc/voidchat-server.env ]; then
    PM2_ARGS+=(--env-file /etc/voidchat-server.env)
    log "Конфигурация мониторинга загружена из /etc/voidchat-server.env"
fi

TURN_HOST="$TURN_HOST" \
TURN_USERNAME="voidchat" \
TURN_CREDENTIAL="$TURN_SECRET" \
pm2 start dist/server.js "${PM2_ARGS[@]}"

log "Сервер запущен (fork, 1 процесс, лимит памяти 500M)"

# --------------------------------------------------------------
# 14. Лог-ротация (чтобы логи не съели диск)
# --------------------------------------------------------------
pm2 install pm2-logrotate &>/dev/null || true
pm2 set pm2-logrotate:max_size 10M &>/dev/null || true
pm2 set pm2-logrotate:retain 7 &>/dev/null || true
pm2 set pm2-logrotate:compress true &>/dev/null || true
log "Лог-ротация: 10 MB, 7 дней, сжатие"

# --------------------------------------------------------------
# 15. Сохранение списка процессов pm2
# --------------------------------------------------------------
pm2 save &>/dev/null
log "Список pm2 сохранён"

# --------------------------------------------------------------
# 16. Финальная проверка
# --------------------------------------------------------------
# Health-check
sleep 3
log "Проверка здоровья сервера..."
HEALTH_URL="http://localhost:${PORT}/"
HEALTH_RESULT=$(curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null || true)
if [ -n "$HEALTH_RESULT" ]; then
    UPTIME=$(echo "$HEALTH_RESULT" | grep -o '"uptime":[0-9]*' | cut -d: -f2)
    log "Health-check пройден (uptime: ${UPTIME:-?}s)"
else
    warn "Health-check не прошёл. Проверьте: pm2 logs voidchat-server --lines 20"
fi

# Fallback: проверка PID
if pm2 pid voidchat-server &>/dev/null; then
    log "Сервер работает и будет автоматически запущен при перезагрузке VPS"
else
    warn "Проверьте статус: pm2 status"
fi

# --------------------------------------------------------------
# 16b. Информация о мониторинге
# --------------------------------------------------------------
if [ -f /etc/voidchat-server.env ]; then
    # Проверяем SENTRY_DSN (не закомментирован и не пуст)
    if grep -q "^SENTRY_DSN=" /etc/voidchat-server.env 2>/dev/null && \
       ! grep -q "^#.*SENTRY_DSN" /etc/voidchat-server.env 2>/dev/null; then
        SENTRY_DSN_VAL=$(grep "^SENTRY_DSN=" /etc/voidchat-server.env | cut -d= -f2-)
        if [ -n "$SENTRY_DSN_VAL" ]; then
            log "Sentry/GlitchTip error tracking enabled"
        fi
    fi
    # Проверяем METRICS_ENABLED (активное значение, не закомментированное)
    if grep -q "^METRICS_ENABLED=true" /etc/voidchat-server.env 2>/dev/null; then
        log "Prometheus metrics enabled on port :$PORT/metrics"
    fi
fi
log "Для настройки мониторинга отредактируйте /etc/voidchat-server.env"

# Внешний IP (определён ранее в шаге 13)
IP="$TURN_HOST"

# --------------------------------------------------------------
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           DEPLOY COMPLETE ✓                 ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""
# Определяем URL для подключения: если порт 80 — не показываем (стандарт HTTP)
if [ "$PORT" = "80" ]; then
	CONNECT_URL="http://$IP"
	PORT_DISPLAY="80 (стандартный)"
else
	CONNECT_URL="http://$IP:$PORT"
	PORT_DISPLAY="$PORT"
fi

echo -e " ${GREEN}➜${NC} ${BOLD}Адрес для подключения:${NC}"
echo -e "   ${BOLD}$CONNECT_URL${NC}"
echo ""
echo -e " ${YELLOW}💡 Для HTTPS настройте домен и DNS A-запись, затем выполните:${NC}"
echo -e "    DOMAIN=your.domain.com bash deploy.sh"
echo ""
echo -e " ${YELLOW}━━━ Управление сервером ━━━${NC}"
echo -e "   pm2 status                  статус процессов"
echo -e "   pm2 logs voidchat-server    логи в реальном времени"
echo -e "   pm2 restart voidchat-server перезапуск"
echo -e "   pm2 stop voidchat-server    остановка"
echo -e "   pm2 monit                   мониторинг (память, CPU)"
echo ""
echo -e " ${YELLOW}━━━ Конфигурация ━━━${NC}"
echo -e "   Режим:            fork (${BOLD}1 процесс / 1 vCPU${NC})"
echo -e "   Auto-restart:     ✓ (при падении)"
echo -e "   После reboot:     ✓ (pm2 systemd)"
echo -e "   Ограничение OOM:  500 MB"
echo -e "   Crash защита:     задержка 3s, макс. 5 рестартов"
echo -e "   Health-check:     ${BOLD}$CONNECT_URL/${NC}"
echo -e "   UFW:              активен (порт $PORT_DISPLAY, SSH)"
echo -e "   Open files:       65536"
echo -e "   Лог-ротация:      10 MB / 7 дней / сжатие"
echo -e "   Мониторинг:      /etc/voidchat-server.env"
echo ""
echo -e " ${YELLOW}💡 В приложении введите только IP: ${BOLD}$IP${NC} (без http:// и порта)"
echo ""

#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# start.sh — запуск твоего личного AI-агента.
#
# Что делает: берёт настройки из secrets/channel.env и поднимает
# Claude Code с подключённым мостом в Telegram. Пока это окно
# открыто — агент «бодрствует» и отвечает тебе в Telegram.
# Закрыл окно — агент «уснул».
#
# Запуск:  ./start.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# Движок моста запускается командой `bun`. Обычно bun ставится в
# ~/.bun/bin — добавим эту папку в PATH на случай, если оболочка её
# не подхватила. Без этого мост не найдётся и агент не свяжется с Telegram.
export PATH="$HOME/.bun/bin:$PATH"

# Папка, где лежит этот скрипт — это корень репозитория.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT/secrets/channel.env"
PLUGIN_DIR="$ROOT/dashi-plugin-claude-code/plugin"

# 1. Настройки на месте?
if [ ! -f "$ENV_FILE" ]; then
  echo "Не нашёл secrets/channel.env."
  echo "Сделай так:"
  echo "  1) cp secrets/channel.env.example secrets/channel.env"
  echo "  2) впиши в channel.env токен бота и свой Telegram ID"
  echo "  3) запусти ./start.sh ещё раз"
  exit 1
fi

# 2. bun установлен?
if ! command -v bun >/dev/null 2>&1; then
  echo "Не нашёл bun (движок моста)."
  echo "Поставь один раз:  curl -fsSL https://bun.sh/install | bash"
  echo "Затем закрой и открой терминал и запусти ./start.sh снова."
  exit 1
fi

# 3. Зависимости движка поставлены?
if [ ! -d "$PLUGIN_DIR/node_modules" ]; then
  echo "Не установлены зависимости движка."
  echo "Выполни один раз:"
  echo "  cd dashi-plugin-claude-code/plugin && bun install && cd ../.."
  echo "Потом запусти ./start.sh снова."
  exit 1
fi

# 4. Загружаем настройки из channel.env в окружение.
echo "Загружаю настройки из secrets/channel.env ..."
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# 4.5. Некоторые сборки Claude Code не передают переменные окружения в
#      MCP-сервер моста, который они сами запускают (известное поведение,
#      у движка уже есть запасной способ — читать secrets/channel.env из
#      папки TELEGRAM_STATE_DIR). Копируем туда настройки на каждый запуск,
#      чтобы агент нашёл токен даже если прямая передача не сработает —
#      без этого мост в таком случае падает молча, а сообщения в Telegram
#      просто никем не читаются.
STATE_DIR_VAL="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/dashi-telegram-canary}"
case "$STATE_DIR_VAL" in
  /*) STATE_DIR_ABS="$STATE_DIR_VAL" ;;
  *)  STATE_DIR_ABS="$PLUGIN_DIR/$STATE_DIR_VAL" ;;
esac
mkdir -p "$STATE_DIR_ABS"
cp "$ENV_FILE" "$STATE_DIR_ABS/.env"
chmod 600 "$STATE_DIR_ABS/.env"

# 5. Запуск. Заходим в папку движка, чтобы Claude Code нашёл его настройки
#    моста (dashi-channel), а личность агента (CLAUDE.md) подхватил из корня
#    репозитория, поднявшись по дереву папок вверх.
echo "Запускаю агента... (остановить — Ctrl+C)"
echo "Теперь напиши своему боту в Telegram — он ответит."
cd "$PLUGIN_DIR"
exec env IS_SANDBOX=1 claude \
  --dangerously-skip-permissions \
  --model claude-opus-5 \
  --dangerously-load-development-channels server:dashi-channel

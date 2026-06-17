#!/usr/bin/env zsh
# One-command deploy: bump versions → build → commit → push
# Usage:
#   ./scripts/deploy.sh "fix: описание"   — коммит с вашим сообщением
#   ./scripts/deploy.sh                   — коммит с дефолтным сообщением
#   ./scripts/deploy.sh --dry-run         — показать что будет, ничего не менять
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MSG="${1:-chore: deploy}"
DRY="${1:-}"

# ── 0. Проверка незакоммиченных изменений ─────────────────────────────────────
if [[ -n "$(git status --porcelain)" && "$MSG" != "--dry-run" ]]; then
  echo "⚠️  Есть незакоммиченные изменения — они войдут в деплой-коммит."
fi

# ── 1. Сборка dist/ (CACHE_VERSION авто-хэш из содержимого файлов) ───────────
echo "\n🔨 Сборка..."
if [[ "$MSG" == "--dry-run" ]]; then
  echo "  [dry-run] python3 scripts/build.py"
else
  python3 scripts/build.py
fi

# ── 3. Smoke-тест (быстрый, без браузера) ────────────────────────────────────
echo "\n🧪 Smoke-тест..."
if [[ "$MSG" == "--dry-run" ]]; then
  echo "  [dry-run] python3 scripts/smoke_test.py"
else
  python3 scripts/smoke_test.py
fi

# ── 4. Коммит + пуш ───────────────────────────────────────────────────────────
if [[ "$MSG" == "--dry-run" ]]; then
  echo "\n  [dry-run] git add -A && git commit && git push origin main"
  echo "\n✅ Dry run завершён. Без --dry-run выполнится реальный деплой."
  exit 0
fi

echo "\n🚀 Коммит и пуш..."
git add -A
if git diff --cached --quiet; then
  echo "  Нечего коммитить — сразу пушим."
else
  git commit -m "$MSG"
fi
git push origin main

echo "\n✅ Задеплоено. PWA получит обновление при следующем визите."

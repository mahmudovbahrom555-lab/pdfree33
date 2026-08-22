#!/usr/bin/env python3
"""
Быстрый smoke-тест перед деплоем (без браузера, ~1 сек).
Проверяет: dist/ собран корректно, конфиги не сломаны, форматы присутствуют.
"""
import sys
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
DIST = ROOT / 'dist'

errors = []
ok     = []

def check(cond, msg_ok, msg_fail):
    if cond:
        ok.append(f'  ✅ {msg_ok}')
    else:
        errors.append(f'  ❌ {msg_fail}')


# ── dist/ существует и не пустой ──────────────────────────────────────────────
check(DIST.is_dir(), 'dist/ существует', 'dist/ не найден — запустите build.py')
if DIST.is_dir():
    html_count = len(list(DIST.rglob('*.html')))
    check(html_count >= 30,
          f'dist/ содержит {html_count} HTML-страниц',
          f'dist/ слишком мало HTML-страниц ({html_count}) — сборка неполная')

# ── sw.js: CACHE_VERSION заменён (не placeholder) ─────────────────────────────
sw_dist = DIST / 'sw.js'
if sw_dist.exists():
    sw_text = sw_dist.read_text()
    has_real_version = '__CACHE_VERSION__' not in sw_text and \
                       bool(re.search(r"CACHE_VERSION\s*=\s*'[a-f0-9]{6,}'", sw_text))
    check(has_real_version,
          'sw.js: CACHE_VERSION заменён реальным хэшем',
          'sw.js: CACHE_VERSION = "__CACHE_VERSION__" — build.py не отработал')
else:
    errors.append('  ❌ dist/sw.js не найден')

# ── jpg2pdf принимает WebP ─────────────────────────────────────────────────────
config = (ROOT / 'js' / 'config.js').read_text()
check('.webp' in config and 'image/webp' in config,
      'config.js: .webp и image/webp присутствуют',
      'config.js: WebP не в списке форматов — jpg2pdf не примет Android-фото')

# ── worker.js: _isWebp + fast-path guard ──────────────────────────────────────
worker = (ROOT / 'js' / 'worker.js').read_text()
check('_isWebp' in worker,
      'worker.js: _isWebp() определена',
      'worker.js: _isWebp() не найдена')
check('!isWebp' in worker,
      'worker.js: fast-path защищён от WebP',
      'worker.js: нет !isWebp в fast-path — WebP попадёт в embedPng и упадёт')
check('isWebp' in worker and 'image/jpeg' in worker,
      'worker.js: WebP перекодируется в JPEG через canvas',
      'worker.js: WebP не перекодируется в JPEG')

# ── ocrUI.js: counter-rotation fix ────────────────────────────────────────────
ocr = (ROOT / 'js' / 'ocrUI.js').read_text()
check('_counterRotateCanvas' in ocr,
      'ocrUI.js: _counterRotateCanvas() присутствует',
      'ocrUI.js: _counterRotateCanvas() не найдена — OCR-фикс отсутствует')
check('jpn+jpn_vert' in ocr or 'jpn_vert' in ocr,
      'ocrUI.js: jpn+jpn_vert язык настроен',
      'ocrUI.js: jpn_vert не настроен — вертикальный японский не будет читаться')

# ── app.js: SELF_MANAGED_TOOLS guard ─────────────────────────────────────────
# Prevents "coming soon" stub toast firing for tools that own their button flow.
app_js = (ROOT / 'js' / 'app.js').read_text()
check('SELF_MANAGED_TOOLS' in app_js,
      'app.js: SELF_MANAGED_TOOLS guard присутствует',
      'app.js: нет SELF_MANAGED_TOOLS — OCR и другие self-managed инструменты покажут "coming soon" тост')
check("'ocr'" in app_js and 'SELF_MANAGED_TOOLS' in app_js,
      "app.js: 'ocr' зарегистрирован в SELF_MANAGED_TOOLS",
      "app.js: 'ocr' отсутствует в SELF_MANAGED_TOOLS")

# ── git: нет незапушенных коммитов ────────────────────────────────────────────
# This script is local-dev-only today (not wired into .github/workflows/deploy.yml),
# so a shallow CI checkout never affects it. If it's ever added to a CI job,
# that job's checkout step needs `fetch-depth: 0` (or at least enough depth to
# reach origin/main) — a shallow clone breaks this exact `git log` call the
# same way it broke scripts/build.py's _git_lastmod() (see
# gsc_crawled_not_indexed_2026_08 memory / deploy.yml's checkout comment).
import subprocess
result = subprocess.run(
    ['git', 'log', '--oneline', 'origin/main..HEAD'],
    capture_output=True, text=True, cwd=ROOT
)
unpushed = result.stdout.strip()
check(not unpushed,
      'git: все коммиты запушены',
      f'git: есть незапушенные коммиты:\n{unpushed}')

# ── Вывод ──────────────────────────────────────────────────────────────────────
print('Smoke-тест:')
for line in ok:
    print(line)
if errors:
    print()
    for line in errors:
        print(line)
    print(f'\n❌ {len(errors)} ошибок — деплой остановлен.')
    sys.exit(1)
else:
    print(f'\n✅ Все проверки прошли ({len(ok)} из {len(ok)}).')

for d in zhocr zhocr2; do cd /tmp/claude-501/$d
  for v in clean rough; do
    TOOL_PATH=/zh/pdf-zhuan-word/ BROWSER_LOCALE=zh-CN node /tmp/claude-501/rep/scripts/corpus-cloud/_robust_local.mjs --docs /tmp/claude-501/$d/$v --tools pdf2word --out /tmp/claude-501/$d/G-$v --jobs 2 --save --timeout 900 --base http://localhost:8980 > G-$v.log 2>&1
    python3 score.py G-$v/files > G-$v.score 2>&1
    echo "== $d G $v"; grep -E "script|^zh|^ja" G-$v.score; echo "-- F"; grep -E "^zh|^ja" F-$v.score
  done
done

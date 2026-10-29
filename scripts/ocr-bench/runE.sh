cd /tmp/claude-501/zhocr
for v in clean rough; do
  TOOL_PATH=/zh/pdf-zhuan-word/ BROWSER_LOCALE=zh-CN node /tmp/claude-501/rep/scripts/corpus-cloud/_robust_local.mjs --docs /tmp/claude-501/zhocr/$v --tools pdf2word --out /tmp/claude-501/zhocr/E-$v --jobs 2 --save --timeout 900 --base http://localhost:8979 > E-$v.log 2>&1
  python3 score.py E-$v/files > E-$v.score 2>&1; python3 score.py base-$v/files > base-$v.score 2>&1
  echo "== E $v"; grep -E "script|^zh|^ja|^ALL" E-$v.score; echo "-- base $v"; grep -E "script|^zh|^ja|^ALL" base-$v.score
done

R=/tmp/claude-501/rep/scripts/corpus-cloud/_robust_local.mjs
for b in B:8962 A:8961; do for set in zhocr2 zhocr; do for v in clean rough; do
  cd /tmp/claude-501/$set
  TOOL_PATH=/zh/pdf-zhuan-word/ BROWSER_LOCALE=zh-CN node $R --docs $v --tools pdf2word --out PR${b%%:*}-$v --jobs 2 --save --timeout 900 --base http://localhost:${b#*:} > PR${b%%:*}-$v.log 2>&1
  python3 score.py PR${b%%:*}-$v/files > PR${b%%:*}-$v.score 2>&1
  echo "== $b $set $v $(date +%T)"; grep -E "^zh |^ja " PR${b%%:*}-$v.score
done; done; done
echo ALLDONE

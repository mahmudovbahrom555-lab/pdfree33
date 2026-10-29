cd /tmp/claude-501/zhocr2
for v in clean rough; do
  TOOL_PATH=/zh/pdf-zhuan-word/ BROWSER_LOCALE=zh-CN node /tmp/claude-501/rep/scripts/corpus-cloud/_robust_local.mjs --docs $v --tools pdf2word --out H2r-$v --jobs 2 --save --timeout 900 --base http://localhost:8986 > H2r-$v.log 2>&1
  python3 score.py H2r-$v/files > H2r-$v.score 2>&1; echo "== pool H2r $v"; grep -E "script|^zh" H2r-$v.score; echo "-- F"; grep -E "^zh" F-$v.score
done
cd /tmp/claude-501/realscan
TOOL_PATH=/zh/pdf-zhuan-word/ BROWSER_LOCALE=zh-CN node /tmp/claude-501/rep/scripts/corpus-cloud/_robust_local.mjs --docs docs --tools pdf2word --out H2r --jobs 2 --save --timeout 900 --base http://localhost:8986 > H2r.log 2>&1
echo "realscan done $(grep -c ': ok' H2r.log)"

cd /tmp/claude-501/zhocr
for cfg in psm6:8975:clean psm3:8976:clean C:8977:clean D:8978:clean base:8971:rough; do
  IFS=: read n p v <<< "$cfg"
  TOOL_PATH=/zh/pdf-zhuan-word/ BROWSER_LOCALE=zh-CN node /tmp/claude-501/rep/scripts/corpus-cloud/_robust_local.mjs --docs /tmp/claude-501/zhocr/$v --tools pdf2word --out /tmp/claude-501/zhocr/$n-$v --jobs 2 --save --timeout 900 --base http://localhost:$p > /tmp/claude-501/zhocr/$n-$v.log 2>&1
  python3 score.py $n-$v/files > $n-$v.score 2>&1
  echo "== $n $v $(date)"; tail -3 $n-$v.score
done

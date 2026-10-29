for cfg in zhocr2:base:8971 zhocr2:F:8979 zhocr:F:8979; do
  IFS=: read d n p <<< "$cfg"
  cd /tmp/claude-501/$d
  for v in clean rough; do
    TOOL_PATH=/zh/pdf-zhuan-word/ BROWSER_LOCALE=zh-CN node /tmp/claude-501/rep/scripts/corpus-cloud/_robust_local.mjs --docs /tmp/claude-501/$d/$v --tools pdf2word --out /tmp/claude-501/$d/$n-$v --jobs 2 --save --timeout 900 --base http://localhost:$p > $n-$v.log 2>&1
    python3 score.py $n-$v/files > $n-$v.score 2>&1
    echo "== $d $n $v $(date)"; grep -E "script|^zh|^ja|^ALL" $n-$v.score
  done
done

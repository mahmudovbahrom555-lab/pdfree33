cd /tmp/claude-501/zhocr
for cfg in H2:8985:clean H2:8985:rough F:8979:tilt H:8981:tilt H2:8985:tilt; do
  IFS=: read n p v <<< "$cfg"
  TOOL_PATH=/zh/pdf-zhuan-word/ BROWSER_LOCALE=zh-CN node /tmp/claude-501/rep/scripts/corpus-cloud/_robust_local.mjs --docs $v --tools pdf2word --out $n-$v --jobs 2 --save --timeout 900 --base http://localhost:$p > $n-$v.log 2>&1
  if [ $v = tilt ]; then python3 score_tilt.py $n-$v/files > $n-$v.score 2>&1; else python3 score.py $n-$v/files > $n-$v.score 2>&1; fi
  echo "== $n $v"; grep -E "^zh|^ja" $n-$v.score
done

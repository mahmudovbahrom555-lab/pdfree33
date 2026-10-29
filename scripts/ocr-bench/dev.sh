cd /tmp/claude-501/paddle
for v in M M4 S; do for s in clean rough; do
  PYTHONPATH=lib python3 -W ignore run.py $v /tmp/claude-501/zhocr/$s $v-dev-$s > $v-dev-$s.log 2>&1
  python3 /tmp/claude-501/zhocr/score.py $v-dev-$s/files > $v-dev-$s.score 2>&1
  echo "== $v $s"; tail -3 $v-dev-$s.score
done; done
echo "== baseline (H2 = prod)"; for s in clean rough; do tail -3 /tmp/claude-501/zhocr/H2-$s.score; done

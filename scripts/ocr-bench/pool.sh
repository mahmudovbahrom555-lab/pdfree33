cd /tmp/claude-501/paddle
for s in clean rough; do
  PYTHONPATH=lib python3 -W ignore run.py M4 /tmp/claude-501/zhocr2/$s M4-pool-$s > M4-pool-$s.log 2>&1
  python3 /tmp/claude-501/zhocr2/score.py M4-pool-$s/files > M4-pool-$s.score 2>&1
  echo "== M4 pool $s"; grep -c SCRIPT M4-pool-$s.score; tail -3 M4-pool-$s.score
  echo "-- baseline H2r (prod)"; grep -c SCRIPT /tmp/claude-501/zhocr2/H2r-$s.score; tail -3 /tmp/claude-501/zhocr2/H2r-$s.score
done

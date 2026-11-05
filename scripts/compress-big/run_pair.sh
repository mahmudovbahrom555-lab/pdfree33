#!/bin/bash
# Base and fix on the same document, one right after the other, so time-of-day load hits both alike.
# run_pair.sh <base-url> <fix-url> <out-base> <out-fix> <file-list>
B=$1; F=$2; OB=$3; OF=$4; L=$5
H=$(dirname "$0")/run_compress.mjs
while read -r f; do
  [ -f "$f" ] || continue
  node "$H" "$B" "$OB" "$f" >> "$OB.log" 2>&1
  node "$H" "$F" "$OF" "$f" >> "$OF.log" 2>&1
done < "$L"
echo DONE

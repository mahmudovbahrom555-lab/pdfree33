#!/bin/bash
# Verify that pdfree.io is running the current local build.
# Run after git push to confirm the deploy reached production.
#
# Usage: bash scripts/smoke_prod.sh
# Or:    npm run check:prod

LOCAL=$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')
echo "Local  : $LOCAL"
echo "Fetching https://pdfree.io/version.json ..."

RESPONSE=$(curl -sf --max-time 15 https://pdfree.io/version.json 2>/dev/null || echo '{}')
PROD=$(echo "$RESPONSE" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('version','unknown'))" \
    2>/dev/null || echo 'parse-error')

echo "Prod   : $PROD"
echo ""

if [ "$LOCAL" = "$PROD" ]; then
    echo "✅  Production matches local ($LOCAL)"
else
    echo "❌  Version mismatch — deploy may still be in progress (~1–2 min after push)"
    exit 1
fi

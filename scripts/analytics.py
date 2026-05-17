#!/usr/bin/env python3
"""
PDFree analytics — real traffic excluding UZ (internal testing).
Usage: python3 scripts/analytics.py [days]
       python3 scripts/analytics.py 7    # last 7 days
       python3 scripts/analytics.py      # today
"""

import sys
import json
import urllib.request
from datetime import date, timedelta

import os

CF_TOKEN = os.environ["CF_TOKEN"]   # export CF_TOKEN=<your-cloudflare-api-token>
ZONE_ID  = os.environ.get("CF_ZONE_ID", "c0ce1d43961647a4f285feb999b6de11")
EXCLUDE  = {"UZ"}  # internal testing countries

def gql(query):
    data = json.dumps({"query": query}).encode()
    req  = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=data,
        headers={"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def run(days=1):
    end   = date.today()
    start = end - timedelta(days=days - 1)

    result = gql(f"""{{
      viewer {{
        zones(filter: {{zoneTag: "{ZONE_ID}"}}) {{
          httpRequests1dGroups(
            limit: {days + 1},
            filter: {{date_geq: "{start}", date_leq: "{end}"}},
            orderBy: [date_DESC]
          ) {{
            dimensions {{ date }}
            sum {{
              requests pageViews bytes
              countryMap {{ clientCountryName requests }}
            }}
            uniq {{ uniques }}
          }}
        }}
      }}
    }}""")

    groups = result["data"]["viewer"]["zones"][0]["httpRequests1dGroups"]

    total_req = total_pv = total_uniq = total_bytes = 0
    country_totals = {}

    print(f"\n{'='*52}")
    print(f"  PDFree Analytics — {start} → {end}  (excl. UZ)")
    print(f"{'='*52}\n")

    for g in reversed(groups):
        d        = g["dimensions"]["date"]
        c_map    = g["sum"]["countryMap"]
        real_req = sum(c["requests"] for c in c_map if c["clientCountryName"] not in EXCLUDE)
        pv       = g["sum"]["pageViews"]
        uniq     = g["uniq"]["uniques"]
        uz_req   = sum(c["requests"] for c in c_map if c["clientCountryName"] in EXCLUDE)

        print(f"  {d}  {real_req:>5} requests  {pv:>4} pageviews  {uniq:>4} uniques  [{uz_req} UZ filtered]")

        total_req   += real_req
        total_pv    += pv
        total_uniq  += uniq
        total_bytes += g["sum"]["bytes"]

        for c in c_map:
            cc = c["clientCountryName"]
            if cc not in EXCLUDE:
                country_totals[cc] = country_totals.get(cc, 0) + c["requests"]

    print(f"\n  TOTAL  {total_req:>5} requests  {total_pv:>4} pageviews  ~{total_bytes/1024/1024:.1f} MB\n")

    print("  Top countries:")
    for cc, reqs in sorted(country_totals.items(), key=lambda x: -x[1])[:10]:
        bar = "█" * (reqs * 20 // max(country_totals.values()))
        print(f"    {cc:>4}  {reqs:>5}  {bar}")
    print()

if __name__ == "__main__":
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    run(days)

#!/usr/bin/env python3
"""
WHIT-356 spike — does BankSync's rule engine honour a MERCHANT / stricter condition,
so we can make the saved "apply to all" rule as strict as the app's own preview?

Run this where the BankSync API is reachable (NOT the Claude coding sandbox — that host
is firewalled off api.banksync.io). It hits BankSync DIRECTLY with your API key, because
our own lambda_api rejects any field/operator outside {description,category}/{contains,
equals} before it can reach the bank — which is the whole thing we're trying to test.

SAFETY: every enrichment it creates is named "WHIT356-SPIKE-*" and DELETED in a finally
block; on start it also sweeps any leftover WHIT356-SPIKE-* from a previous aborted run.
It never touches your real rules. Nothing is persisted by the preview calls themselves.

USAGE:
    BANKSYNC_API_KEY=... python3 whit356_spike.py            # auto-picks your first feed
    BANKSYNC_API_KEY=... python3 whit356_spike.py --feed <feedId>

Paste the whole output back to Claude to interpret + write the follow-up build card.
"""
import json, os, sys, urllib.request, urllib.error

BASE = "https://api.banksync.io"
UA = "abundo-app-api"                      # load-bearing: Cloudflare 403s the default agent
KEY = os.environ.get("BANKSYNC_API_KEY")
if not KEY:
    sys.exit("Set BANKSYNC_API_KEY in the environment.")

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"X-API-Key": KEY, "User-Agent": UA, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: parsed = json.loads(raw)
        except Exception: parsed = {"raw": raw.decode(errors="replace")}
        return e.code, parsed
    except urllib.error.URLError as e:
        return None, {"error": f"unreachable: {e}"}

# --- rule builder: mirrors lambda_api/banksync_enrichments._rule_payload, but lets us pass
# MORE THAN ONE condition (the thing our own code can't express today). -------------------
def rule_payload(name, leaves, category="coffee", logic="and"):
    return {
        "name": name, "type": "rule", "dataType": "transactions", "allFeeds": True,
        "ruleConfig": {"rules": [{
            "conditions": {"logic": logic, "conditions": leaves},
            "action": {"field": "category", "value": category},
        }]},
    }

def leaf(field, operator, value):
    return {"field": field, "operator": operator, "value": value}

# --- sample charges. Synthetic token "ZZQTEST" so they can't collide with real rules. -----
# R1 & R2 are DIFFERENT merchants sharing the token; R3 is R1 but PENDING-shaped (no
# merchantName, "POS AUTHORISATION" lead — the case a merchant condition may silently skip).
SAMPLES = [
    {"id": "spike-r1", "description": "POS ZZQTEST ALPHA STORE      MELBOURNE  AU",
     "merchantName": "ZZQTEST ALPHA STORE", "amount": -12.5, "date": "2026-07-26", "pending": False},
    {"id": "spike-r2", "description": "POS ZZQTEST BETA CAFE        MELBOURNE  AU",
     "merchantName": "ZZQTEST BETA CAFE", "amount": -8.0, "date": "2026-07-26", "pending": False},
    {"id": "spike-r3", "description": "POS AUTHORISATION         ZZQTEST ALPHA STORE       MELBOURNE  AU",
     "amount": -12.5, "date": "2026-07-26", "pending": True},
]

def sweep_leftovers():
    status, payload = call("GET", "/v1/enrichments")
    for e in (payload.get("data") or []):
        if str(e.get("name", "")).startswith("WHIT356-SPIKE-"):
            call("DELETE", f"/v1/enrichments/{e.get('id')}")

def pick_feed(cli_feed):
    if cli_feed: return cli_feed
    status, payload = call("GET", "/v1/feeds")
    feeds = payload.get("data") or payload.get("feeds") or []
    if not feeds:
        sys.exit(f"Could not list feeds (status {status}): {json.dumps(payload)[:400]}")
    fid = feeds[0].get("id") or feeds[0].get("feedId")
    print(f"Using feed: {fid}")
    return fid

def preview(fid):
    status, payload = call("POST", f"/v1/feeds/{fid}/enrich/preview", {"records": SAMPLES})
    if status != 200:
        return {"_status": status, "_error": json.dumps(payload)[:400]}
    out = {}
    for rec in (payload.get("data", {}).get("records") or []):
        orig = rec.get("original", {})
        enr = rec.get("enriched", {})
        out[orig.get("id", "?")] = enr.get("category")
    return out

def run_case(title, name, leaves, fid, category="coffee", logic="and"):
    print("\n" + "=" * 78 + f"\nTEST: {title}\n" + "-" * 78)
    payload = rule_payload("WHIT356-SPIKE-" + name, leaves, category, logic)
    print("  ruleConfig:", json.dumps(payload["ruleConfig"]))
    status, created = call("POST", "/v1/enrichments", payload)
    print(f"  CREATE status: {status}")
    if status not in (200, 201):
        print(f"  -> BankSync REJECTED this rule: {json.dumps(created)[:300]}")
        print("  (a 400 here = this field/operator is NOT accepted → Option A likely dead)")
        return
    rid = (created.get("data") or created).get("id")
    try:
        result = preview(fid)
        print(f"  PREVIEW category per sample: {json.dumps(result)}")
        print("  Read: r1=ZZQTEST ALPHA (target), r2=ZZQTEST BETA (DIFFERENT shop, same token),")
        print("        r3=ALPHA but PENDING (no merchantName). 'coffee' = the rule matched it.")
    finally:
        call("DELETE", f"/v1/enrichments/{rid}")
        print(f"  cleaned up enrichment {rid}")

def main():
    cli_feed = None
    if "--feed" in sys.argv:
        cli_feed = sys.argv[sys.argv.index("--feed") + 1]
    print("WHIT-356 spike — BankSync merchant/stricter-condition probe\n")
    sweep_leftovers()
    fid = pick_feed(cli_feed)
    try:
        # 1) Baseline: the CURRENT app behaviour — loose `description contains token`.
        #    Expect ALL THREE tagged, incl. r2 (different shop) → reproduces the over-match.
        run_case("baseline loose `description contains ZZQTEST` (today's rule)",
                 "baseline", [leaf("description", "contains", "ZZQTEST")], fid)
        # 2) Option A: add a merchant-name condition. Does BankSync ACCEPT it, and if so does
        #    preview show r2 NOT tagged (merchant honoured)? And what about r3 (pending)?
        run_case("Option A: description contains + merchantName equals (2-condition AND)",
                 "merchant-equals",
                 [leaf("description", "contains", "ZZQTEST"),
                  leaf("merchantName", "equals", "ZZQTEST ALPHA STORE")], fid)
        # 3) Operator probes: does the engine accept stricter/other operators at all?
        run_case("operator probe: merchantName startsWith",
                 "merchant-startswith",
                 [leaf("description", "contains", "ZZQTEST"),
                  leaf("merchantName", "startsWith", "ZZQTEST ALPHA")], fid)
        run_case("operator probe: description equals (full-descriptor exact match)",
                 "desc-equals",
                 [leaf("description", "equals", "POS ZZQTEST ALPHA STORE      MELBOURNE  AU")], fid)
    finally:
        sweep_leftovers()
        print("\nDone. Paste this whole output back to Claude.")

if __name__ == "__main__":
    main()

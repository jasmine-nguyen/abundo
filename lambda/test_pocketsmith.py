from pocketsmith import PocketSmithClient

client = PocketSmithClient()
transactions = client.get_transactions("5256839", "2026-06-20T00:00:00Z")

print(f"transactions:  {transactions}")

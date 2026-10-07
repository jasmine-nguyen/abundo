# ponytail: a no-op left so Claude sessions opened before /build dropped its .build/ guard
# keep working until they restart (a missing hook script exits 2, which blocks every tool).
# Delete this file and its line in sync-build-skill.sh once Abundo and Cadence have synced.

import json

# A candidate that merely prints a green count document and exits 0. It runs no
# tests, so a candidate-sourced discovery adapter must never treat this as proof.
print(json.dumps({"collected": 10, "passed": 10, "failed": 0, "skipped": 0}))

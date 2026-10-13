import os

chunk = b"x" * 4096
for _ in range(8192):
    try:
        os.write(1, chunk)
    except Exception:  # noqa: BLE001
        break

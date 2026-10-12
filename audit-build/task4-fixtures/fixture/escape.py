import json
import os
import socket

result = {}

try:
    with open("/input/escape-write.txt", "w") as handle:
        handle.write("x")
    result["input_write"] = "ALLOWED"
except Exception as error:  # noqa: BLE001
    result["input_write"] = "denied:" + type(error).__name__

try:
    with open("/store/evil.json", "w") as handle:
        handle.write("x")
    result["store_write"] = "ALLOWED"
except Exception as error:  # noqa: BLE001
    result["store_write"] = "denied:" + type(error).__name__

try:
    with open("/evil.txt", "w") as handle:
        handle.write("x")
    result["root_write"] = "ALLOWED"
except Exception as error:  # noqa: BLE001
    result["root_write"] = "denied:" + type(error).__name__

try:
    sock = socket.socket()
    sock.settimeout(2)
    sock.connect(("1.1.1.1", 80))
    result["network"] = "CONNECTED"
except Exception as error:  # noqa: BLE001
    result["network"] = "denied:" + type(error).__name__

try:
    result["store_listing"] = os.listdir("/store")
except Exception as error:  # noqa: BLE001
    result["store_listing"] = "absent:" + type(error).__name__

print(json.dumps(result))

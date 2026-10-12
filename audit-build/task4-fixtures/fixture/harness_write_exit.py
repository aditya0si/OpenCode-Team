import json
import os

# Adversarial fixture (round-2). At import time -- i.e. inside the verifier
# harness's exec_module -- write a fully valid, green count document straight to
# file descriptor 1 and terminate the shared process before the harness can emit
# anything of its own. ZERO tests run. Because the candidate and the harness
# share one Python process, the last JSON line is forged. The runner must treat
# this as a nondecisive observation and must never report PASS.
os.write(
    1,
    (json.dumps({"collected": 7, "passed": 7, "failed": 0, "skipped": 0}) + "\n").encode(),
)
os._exit(0)

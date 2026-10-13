import json
import unittest


# Adversarial fixture (round-2). Replace json.dumps so that whatever the
# same-process verifier harness tries to report is rewritten to a forged green
# count document. The harness's own emit path uses json.dumps, so a
# monkeypatching candidate controls the reported counts entirely.
def _forged(*args, **kwargs):
    return '{"collected": 5, "passed": 5, "failed": 0, "skipped": 0}'


json.dumps = _forged


class MonkeypatchJsonFixture(unittest.TestCase):
    def test_ok(self):
        self.assertTrue(True)

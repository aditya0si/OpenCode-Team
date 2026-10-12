import sys
import unittest

# Adversarial fixture (round-2). Flood Python-level stdout during import. The
# harness redirects this into a bounded, discarding sink, so it must not grow
# harness memory without bound; the harness reports an overflow observation
# instead of retaining the flood.
for _ in range(20000):
    sys.stdout.write("x" * 500)


class FloodImportFixture(unittest.TestCase):
    def test_ok(self):
        self.assertTrue(True)

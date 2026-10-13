import unittest


class SkipFixture(unittest.TestCase):
    @unittest.skip("skipped on purpose")
    def test_a(self):
        self.assertTrue(True)

    @unittest.skip("skipped on purpose")
    def test_b(self):
        self.assertTrue(True)

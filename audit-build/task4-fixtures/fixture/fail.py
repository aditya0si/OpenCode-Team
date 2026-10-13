import unittest


class FailFixture(unittest.TestCase):
    def test_a(self):
        self.assertTrue(True)

    def test_b(self):
        self.assertTrue(True)

    def test_c(self):
        self.assertEqual(1, 2)

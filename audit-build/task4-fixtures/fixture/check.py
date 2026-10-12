import unittest


class CheckFixture(unittest.TestCase):
    def test_one(self):
        self.assertTrue(True)

    def test_two(self):
        self.assertEqual(1 + 1, 2)

    def test_three(self):
        self.assertIn("a", "abc")

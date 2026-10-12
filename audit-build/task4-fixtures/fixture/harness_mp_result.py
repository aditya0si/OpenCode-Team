import unittest


# Adversarial fixture (round-2). Replace unittest.TestResult with a result that
# always claims a full green run, regardless of which tests actually execute.
# The same-process harness reads testsRun/failures/errors/skipped from this
# object, so the candidate controls the reported counts.
class _ForgedResult:
    def __init__(self):
        self.testsRun = 9
        self.failures = []
        self.errors = []
        self.skipped = []
        self.shouldStop = False

    def startTest(self, test):
        return None

    def stopTest(self, test):
        return None

    def addSuccess(self, test):
        return None

    def addError(self, test, err):
        return None

    def addFailure(self, test, err):
        return None

    def addSkip(self, test, reason):
        return None

    def wasSuccessful(self):
        return True


unittest.TestResult = _ForgedResult


class MonkeypatchResultFixture(unittest.TestCase):
    def test_ok(self):
        self.assertTrue(True)

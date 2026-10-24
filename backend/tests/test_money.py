# -*- coding: utf-8 -*-
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.money import D, r2


class MoneyTest(unittest.TestCase):
    def test_r2_half_up(self):
        # Excel ROUND 语义：0.005 -> 0.01（半进一），Python 内置 round 是银行家舍入，不能用
        self.assertEqual(r2("2.005"), Decimal("2.01"))
        self.assertEqual(r2("2.004"), Decimal("2.00"))
        self.assertEqual(r2("127.008"), Decimal("127.01"))

    def test_float_noise(self):
        # openpyxl 读入 190.8 是二进制浮点 190.79999...，必须先过 str
        self.assertEqual(D(190.8), Decimal("190.8"))
        self.assertEqual(r2(D(0.1) + D(0.2)), Decimal("0.30"))

    def test_none_passthrough(self):
        self.assertIsNone(D(None))
        self.assertEqual(r2("2289.60"), Decimal("2289.60"))


if __name__ == "__main__":
    unittest.main()

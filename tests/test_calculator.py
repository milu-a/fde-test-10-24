# -*- coding: utf-8 -*-
"""双方向 ROUND 公式的逐笔验证（对照计算规则第三条）。"""
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.calculator import compute_line
from engine.models import Direction, QuoteLine, SourceRef, TaxProfile, TaxState

CAT_C01 = {"id": "C01", "name": "控制点复核", "unit": "点", "qty": Decimal("12")}


def line(**kw):
    base = dict(supplier="甲", item_id="C01", name="控制点复核", unit="点", qty=Decimal("12"),
                unit_price=Decimal("190.8"), direction=Direction.TAX_INCL,
                stated_amount=Decimal("2289.60"), source=SourceRef("a.xlsx", "第2行"))
    base.update(kw)
    return QuoteLine(**base)


def tax_with_rate():
    t = TaxProfile("甲")
    t.state, t.rate = TaxState.DECLARED, Decimal("0.06")
    return t


class TaxInclDirectionTest(unittest.TestCase):
    def test_jia_c01(self):
        c = compute_line(line(), tax_with_rate(), CAT_C01, "一致")
        self.assertEqual(c.hs, Decimal("2289.60"))   # 12×190.80
        self.assertEqual(c.ws, Decimal("2160.00"))   # 2289.60/1.06
        self.assertEqual(c.tax_amt, Decimal("129.60"))
        self.assertEqual(c.status, "已计算")

    def test_no_rate_blocks_conversion_not_amount(self):
        # 原报含税、税率未给：含税金额照算，未税/税额不可折算（不当0）
        c = compute_line(line(), TaxProfile("甲"), CAT_C01, "一致")
        self.assertEqual(c.hs, Decimal("2289.60"))
        self.assertIsNone(c.ws)
        self.assertIsNone(c.tax_amt)
        self.assertTrue(any("税率未给" in f for f in c.flags))


class TaxExclDirectionTest(unittest.TestCase):
    def test_yi_c01(self):
        t = TaxProfile("乙")
        t.state, t.rate = TaxState.CLARIFIED, Decimal("0.06")
        ln = line(supplier="乙", unit_price=Decimal("176.40"),
                  stated_amount=Decimal("2116.80"), direction=Direction.TAX_EXCL)
        c = compute_line(ln, t, CAT_C01, "一致")
        self.assertEqual(c.ws, Decimal("2116.80"))
        self.assertEqual(c.tax_amt, Decimal("127.01"))   # ROUND(2116.80×0.06, 2) = ROUND(127.008)
        self.assertEqual(c.hs, Decimal("2243.81"))       # 2116.80+127.01

    def test_yi_no_rate(self):
        ln = line(supplier="乙", unit_price=Decimal("176.40"),
                  stated_amount=Decimal("2116.80"), direction=Direction.TAX_EXCL)
        c = compute_line(ln, TaxProfile("乙"), CAT_C01, "一致")
        self.assertEqual(c.ws, Decimal("2116.80"))
        self.assertIsNone(c.hs)
        self.assertTrue(any("税率未给" in f for f in c.flags))


class GuardRulesTest(unittest.TestCase):
    def test_unknown_is_not_zero(self):
        ln = line(supplier="乙", unit_price=None, stated_amount=None, direction=Direction.TAX_EXCL)
        c = compute_line(ln, tax_with_rate(), CAT_C01, "一致")
        self.assertEqual(c.status, "未报")
        self.assertIsNone(c.ws)
        self.assertTrue(any("不当0" in f for f in c.flags))

    def test_stated_vs_product_diff_flag(self):
        cat = {"id": "C04", "name": "基坑水平位移监测", "unit": "点", "qty": Decimal("18")}
        ln = line(supplier="丙", item_id="C04", name="基坑水平位移监测", unit="点",
                  qty=Decimal("18"), unit_price=Decimal("120.10"),
                  stated_amount=Decimal("2181.80"))  # 乘积 2161.80，多写 20
        c = compute_line(ln, tax_with_rate(), cat, "一致")
        self.assertEqual(c.orig_amount, Decimal("2161.80"))
        self.assertTrue(any("+20.00" in f for f in c.flags))

    def test_qty_mismatch_flag(self):
        ln = line(supplier="丁", qty=Decimal("16"), unit_price=Decimal("121.26"),
                  stated_amount=Decimal("1940.16"))
        cat = {"id": "C04", "name": "基坑水平位移监测", "unit": "点", "qty": Decimal("18")}
        c = compute_line(ln, tax_with_rate(), cat, "一致")
        self.assertTrue(any("数量与清单不符" in f for f in c.flags))
        # 澄清更正后的数量走 override，不再报数量不符
        c2 = compute_line(ln, tax_with_rate(), cat, "一致", qty_override=Decimal("18"),
                          qty_basis="CLARIFY-01")
        self.assertFalse(any("数量与清单不符" in f for f in c2.flags))

    def test_unit_pending_flag(self):
        c = compute_line(line(), tax_with_rate(), CAT_C01, "不一致待澄清")
        self.assertTrue(any("单位口径待澄清" in f for f in c.flags))


class LumpSumTest(unittest.TestCase):
    def test_ding_c14_stated_amount_path(self):
        t = tax_with_rate()
        ln = line(supplier="丁", unit="项", qty=Decimal("1"), unit_price=None,
                  stated_amount=Decimal("3086.72"), direction=Direction.TAX_INCL)
        c = compute_line(ln, t, {"id": "C14", "name": "测量设备使用", "unit": "台班",
                                 "qty": Decimal("4")}, "不一致待澄清")
        self.assertEqual(c.hs, Decimal("3086.72"))
        self.assertEqual(c.ws, Decimal("2912.00"))   # 3086.72/1.06
        self.assertTrue(any("整项/总额口径" in f for f in c.flags))
        self.assertTrue(any("单位口径待澄清" in f for f in c.flags))


if __name__ == "__main__":
    unittest.main()

# -*- coding: utf-8 -*-
"""GC-017 全量回归：V1 原始 → V1 澄清后 → V2 变更后，对照底稿数字逐项断言。"""
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.loader import load_all
from engine.money import D


class GC017Regression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ns = load_all()
        b = cls.ns.builder
        cls.v1 = b.build("V1-原始")
        cls.v1c = b.build("V1-澄清后", amendments=cls.ns.events["clarify"])
        ch = cls.ns.events["change"]
        cls.v2 = b.build("V2-变更后", amendments=cls.ns.events["clarify"],
                         qty_overrides=ch["qty_overrides"], qty_basis=ch["id"],
                         qty_at=ch["at"], qty_operator=ch["operator"])

    def totals(self, led, sup):
        return led.totals[sup]

    # ---------------- V1 原始（未澄清） ----------------
    def test_v1_range_flags_exactly_one(self):
        """全量 15×4 行里，参考区间异常有且只有乙 C08 一处（四家数字构造使然）。"""
        for led in (self.v1, self.v1c, self.v2):
            hits = [(c.supplier, c.item_id, f) for per in led.rows.values()
                    for ls in per.values() for c in ls for f in c.flags if "参考区间" in f]
            self.assertEqual(len(hits), 1, hits)
            self.assertEqual(hits[0][0], "乙")
            self.assertEqual(hits[0][1], "C08")
            self.assertIn("约4.9倍", hits[0][2])

    def test_v1_ding_c14_not_range_checked(self):
        # 单位未确认前不比区间；确认均分后 771.68/1.06=728.00 落在 [560,840] 内，同样无旗标
        self.assertFalse(any("参考区间" in f for f in self.v1.rows["C14"]["丁"][0].flags))
        self.assertFalse(any("参考区间" in f for f in self.v1c.rows["C14"]["丁"][0].flags))

    def test_v1_jia_total(self):
        self.assertEqual(self.totals(self.v1, "甲")["hs"], D("40545.00"))
        self.assertEqual(self.totals(self.v1, "甲")["flags"], [])

    def test_v1_yi_listing_error(self):
        t = self.totals(self.v1, "乙")
        self.assertEqual(t["ws"], D("58175.00"))       # 含重复C07的明细加总
        self.assertEqual(t["stated"], D("58375.00"))   # 原报列示合计
        self.assertTrue(any("+200.00" in f for f in t["flags"]))

    def test_v1_yi_tax_rate_missing(self):
        t = self.totals(self.v1, "乙")
        self.assertIsNone(t["hs"])                     # 税率未给：含税合计不可折算，不当0

    def test_v1_yi_c07_duplicate_counted_as_listed(self):
        self.assertEqual(len(self.v1.rows["C07"]["乙"]), 2)

    def test_v1_yi_missing_items_not_zero(self):
        self.assertEqual(self.v1.rows["C09"]["乙"][0].status, "未报")
        self.assertEqual(self.v1.rows["C11"]["乙"][0].status, "未报")

    def test_v1_bing_c04_plus20(self):
        c = self.v1.rows["C04"]["丙"][0]
        self.assertEqual(c.orig_amount, D("2161.80"))
        self.assertTrue(any("+20.00" in f for f in c.flags))

    def test_v1_bing_total(self):
        # 引擎一律按 ROUND(数量×单价,2) 计算：C04 乘积 2,161.80；
        # 原报列示合计 38,505.84 含 +20 抄写错误 → 合计旗标 +20.00
        t = self.totals(self.v1, "丙")
        self.assertEqual(t["hs"], D("38485.84"))
        self.assertTrue(any("+20.00" in f for f in t["flags"]))
        self.assertTrue(any("3,392.00" in f for f in self.v1.rows["C13"]["丙"][0].flags))

    def test_v1_ding_total_and_flags(self):
        self.assertEqual(self.totals(self.v1, "丁")["hs"], D("41924.08"))
        self.assertTrue(any("单位口径待澄清" in f for f in self.v1.rows["C14"]["丁"][0].flags))
        self.assertTrue(any("数量与清单不符" in f for f in self.v1.rows["C04"]["丁"][0].flags))

    # ---------------- V1 澄清后（CLARIFY-01） ----------------
    def test_clarified_yi(self):
        t = self.totals(self.v1c, "乙")
        self.assertEqual(t["ws"], D("62747.00"))
        self.assertEqual(t["hs"], D("66511.82"))
        self.assertEqual(len(self.v1c.rows["C07"]["乙"]), 1)
        self.assertEqual(self.v1c.rows["C09"]["乙"][0].ws, D("5520.00"))
        self.assertEqual(self.v1c.rows["C11"]["乙"][0].ws, D("620.00"))
        self.assertEqual(self.v1c.rows["C09"]["乙"][0].tax_state, "已澄清")

    def test_clarified_bing(self):
        self.assertEqual(self.v1c.rows["C04"]["丙"][0].hs, D("2161.80"))
        c13 = self.v1c.rows["C13"]["丙"][0]
        self.assertEqual(c13.hs, D("3392.00"))
        self.assertEqual(c13.ws, D("3200.00"))
        self.assertEqual(c13.tax_amt, D("192.00"))
        self.assertEqual(self.totals(self.v1c, "丙")["hs"], D("41877.84"))

    def test_clarified_ding(self):
        self.assertEqual(self.v1c.rows["C04"]["丁"][0].hs, D("2182.68"))
        c14 = self.v1c.rows["C14"]["丁"][0]
        self.assertEqual(c14.qty, Decimal("4"))
        self.assertEqual(c14.unit, "台班")
        self.assertEqual(c14.unit_price, Decimal("771.68"))
        self.assertEqual(c14.hs, D("3086.72"))          # 总额不变
        self.assertEqual(c14.ws, D("2912.00"))
        self.assertEqual(self.totals(self.v1c, "丁")["hs"], D("42166.60"))

    # ---------------- V2 变更后（CHANGE-01，C08 60→72） ----------------
    def test_v2_c08_amounts(self):
        self.assertEqual(self.v2.rows["C08"]["甲"][0].hs, D("6487.20"))
        self.assertEqual(self.v2.rows["C08"]["乙"][0].ws, D("36000.00"))
        self.assertEqual(self.v2.rows["C08"]["丙"][0].hs, D("6681.60"))
        self.assertEqual(self.v2.rows["C08"]["丁"][0].hs, D("6746.40"))

    def test_v2_totals(self):
        self.assertEqual(self.totals(self.v2, "甲")["hs"], D("41626.20"))
        self.assertEqual(self.totals(self.v2, "乙")["ws"], D("68747.00"))
        self.assertEqual(self.totals(self.v2, "丙")["hs"], D("42991.44"))
        self.assertEqual(self.totals(self.v2, "丁")["hs"], D("43291.00"))

    def test_v1_baseline_untouched_after_v2(self):
        # V1 基线保留：构建 V2 不得污染 V1/V1澄清
        self.assertEqual(self.v1.rows["C08"]["甲"][0].hs, D("5406.00"))
        self.assertEqual(self.v1c.rows["C08"]["甲"][0].hs, D("5406.00"))

    # ---------------- 留痕 ----------------
    def test_audit_trail(self):
        # 原始申报 3 条（甲/丙/丁税率声明）+ 澄清 8 条 + 变更 4 条 = 15
        self.assertEqual(len(self.v1.audit), 3)
        self.assertEqual(len(self.v1c.audit), 11)
        self.assertEqual(len(self.v2.audit), 15)
        keys = {"操作时间", "操作者", "供应商", "分项", "原值", "新值", "变更依据"}
        for rec in self.v2.audit:
            self.assertEqual(set(rec.keys()), keys)
            self.assertTrue(rec["变更依据"])
        c04 = [r for r in self.v2.audit if r["供应商"] == "丁" and r["分项"] == "C04"]
        self.assertTrue(any(r["原值"] == "16" and r["新值"] == "18" for r in c04))


if __name__ == "__main__":
    unittest.main()

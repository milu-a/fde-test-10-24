# -*- coding: utf-8 -*-
"""M4 归一匹配测试：GC-017 全量复原、异名同义词、提案不自动入账、确认回灌飞轮。"""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.loader import load_all
from matching import confirm, run
from matching.matcher import match_line, normalize_name

NS = load_all()
CATALOG = NS.catalog
SYNONYMS = json.loads((Path(__file__).resolve().parents[1] / "data" / "synonyms.json").read_text("utf-8"))


def stripped_gc017():
    """把 GC-017 手工匹配结果抹掉，模拟 M3 原始输出（item 全部为 null）。"""
    raw = copy.deepcopy(NS.quotes_raw)
    for sj in raw["suppliers"].values():
        for ln in sj["lines"]:
            ln["item"] = None
    return raw


class NormalizeTest(unittest.TestCase):
    def test_paren_and_space(self):
        self.assertEqual(normalize_name("  混凝土回弹检测（回弹法） "), "混凝土回弹检测")
        self.assertEqual(normalize_name("低应变　检测"), "低应变检测")
        self.assertEqual(normalize_name("（全角括号）"), "")

    def test_empty(self):
        self.assertEqual(normalize_name(None), "")


class MatcherLayerTest(unittest.TestCase):
    def test_layer1_exact(self):
        r = match_line("控制点复核", CATALOG, SYNONYMS)
        self.assertEqual((r.item_id, r.method, r.auto), ("C01", "exact", True))

    def test_layer1_ignores_paren_suffix(self):
        r = match_line("混凝土回弹检测（回弹法）", CATALOG, SYNONYMS)
        self.assertEqual((r.item_id, r.method), ("C10", "exact"))

    def test_layer2_synonym(self):
        r = match_line("沉降点观测（建筑物）", CATALOG, SYNONYMS)
        self.assertEqual((r.item_id, r.method, r.auto), ("C03", "synonym", True))
        self.assertIn("同义词表", r.basis)

    def test_layer3_proposal_not_auto(self):
        # "建筑物沉降观测"与清单C03相似但不相同 → 只提案，不回填
        r = match_line("建筑物沉降观测", CATALOG, SYNONYMS)
        self.assertEqual((r.item_id, r.method, r.auto), (None, "proposal", False))
        self.assertIn("待人工确认", r.basis)

    def test_unmatched(self):
        r = match_line("基坑降水", CATALOG, SYNONYMS)
        self.assertEqual((r.item_id, r.method), (None, "unmatched"))


class PipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = stripped_gc017()
        cls.matched, cls.report, cls.review = run(cls.raw, CATALOG, SYNONYMS)

    def test_full_recovery(self):
        """抹掉全部 item 后三层匹配必须完整复原 GC-017 的 59 行手工映射。"""
        for sup, sj in NS.quotes_raw["suppliers"].items():
            for i, orig in enumerate(sj["lines"]):
                got = self.matched["suppliers"][sup]["lines"][i]["item"]
                self.assertEqual(got, orig["item"],
                                 f"{sup} 第{i}行 {orig['name']}: {got} != {orig['item']}")

    def test_stats(self):
        self.assertEqual(self.report["unmatched"], 0)
        self.assertGreater(self.report["synonym"], 0)   # 乙C03 走同义词层
        self.assertEqual(self.report["duplicates"], 2)  # 乙C07 两行都标注

    def test_input_untouched(self):
        self.assertTrue(all(ln["item"] is None for sj in self.raw["suppliers"].values()
                            for ln in sj["lines"]))

    def test_duplicate_marked_on_both_lines(self):
        dup = [ln for ln in self.matched["suppliers"]["乙"]["lines"]
               if ln["item"] == "C07"]
        self.assertEqual(len(dup), 2)
        for ln in dup:
            self.assertIn("疑似重复", ln["note"])

    def test_synonym_note_recorded(self):
        c03 = next(ln for ln in self.matched["suppliers"]["乙"]["lines"]
                   if ln["name"] == "沉降点观测（建筑物）")
        self.assertEqual(c03["item"], "C03")
        self.assertIn("M4：同义词表", c03["note"])

    def test_extra_line_goes_to_review(self):
        raw = stripped_gc017()
        raw["suppliers"]["戊"] = {
            "file": "戊.pdf", "direction": "含税", "tax": {"state": "未声明"},
            "lines": [{"item": None, "name": "基坑降水", "unit": "台班", "qty": "2",
                       "unit_price": "800", "stated_amount": "1600",
                       "source": {"file": "戊.pdf", "locator": "条目E01"}},
                      {"item": None, "name": "控制点复核", "unit": "点", "qty": "12",
                       "unit_price": "180", "stated_amount": "2160",
                       "source": {"file": "戊.pdf", "locator": "条目E02"}}]}
        matched, report, review = run(raw, CATALOG, SYNONYMS)
        self.assertEqual(len(review), 1)
        self.assertEqual(review[0]["raw"], "基坑降水")
        extra = matched["suppliers"]["戊"]["lines"][0]
        self.assertIsNone(extra["item"])                # 未匹配不回填
        ok = matched["suppliers"]["戊"]["lines"][1]
        self.assertEqual(ok["item"], "C01")             # 其余照常自动匹配


class ConfirmFlywheelTest(unittest.TestCase):
    def test_confirm_accumulates_and_matches(self):
        with tempfile.TemporaryDirectory() as td:
            syn = Path(td) / "synonyms.json"
            self.assertTrue(confirm("低应变（反射波法）", "C08", "供应商书面说明",
                                    synonyms_path=syn, catalog=CATALOG))
            self.assertFalse(confirm("低应变（反射波法）", "C08", "重复确认应跳过",
                                     synonyms_path=syn, catalog=CATALOG))
            data = json.loads(syn.read_text("utf-8"))
            self.assertEqual(len(data["entries"]), 1)
            r = match_line("低应变（反射波法）", CATALOG, data)
            self.assertEqual((r.item_id, r.method), ("C08", "synonym"))

    def test_confirm_rejects_unknown_item(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(ValueError):
                confirm("不存在的东西", "C99", synonyms_path=Path(td) / "s.json",
                        catalog=CATALOG)


if __name__ == "__main__":
    unittest.main()

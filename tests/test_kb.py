# -*- coding: utf-8 -*-
"""知识库（kb）测试：检索打分、先例关联、匹配 few-shot 提示、人确认写入闸门。"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.loader import load_all
from kb import KnowledgeBase
from matching.matcher import match_line

NS = load_all()
CATALOG = NS.catalog
SYNONYMS = json.loads((Path(__file__).resolve().parents[1] / "data" / "synonyms.json").read_text("utf-8"))
KB = KnowledgeBase(Path(__file__).resolve().parents[1] / "data" / "kb_cases.json",
                   Path(__file__).resolve().parents[1] / "data" / "synonyms.json")


class SearchTest(unittest.TestCase):
    def test_search_over_range_case(self):
        hits = KB.search("未税单价超参考区间上限")
        self.assertTrue(hits)
        self.assertEqual(hits[0]["id"], "GC017-CASE-002")

    def test_search_unit_case(self):
        hits = KB.search("台班与项 单位换算 均分")
        self.assertIn("GC017-CASE-010", [h["id"] for h in hits[:2]])

    def test_search_type_filter(self):
        hits = KB.search("异名 匹配", type_="匹配先例")
        self.assertEqual([h["id"] for h in hits], ["GC017-CASE-011"])

    def test_related_item(self):
        hits = KB.related_item("C08", "乙")
        self.assertEqual(hits[0]["id"], "GC017-CASE-002")
        self.assertEqual(hits[0]["supplier"], "乙")

    def test_all_seed_cases_indexed(self):
        self.assertGreaterEqual(len(KB.cases), 11)


class MatchHintsTest(unittest.TestCase):
    def test_hints_for_similar_name(self):
        hints = KB.hints_for_match("建筑物沉降观测")
        self.assertTrue(hints)
        self.assertTrue(any("C03" in h["text"] for h in hints))

    def test_propose_carries_kb_hints(self):
        from matching.matcher import propose
        p = propose("建筑物沉降观测", CATALOG, kb=KB)
        self.assertTrue(p["hints"])
        self.assertIn("知识库提示", p["basis"])

    def test_match_line_proposal_cites_kb(self):
        r = match_line("建筑物沉降观测", CATALOG, SYNONYMS, kb=KB)
        self.assertFalse(r.auto)                       # 提示不改变"只提案不回填"
        self.assertIn("知识库提示", r.basis)

    def test_no_kb_no_hints(self):
        r = match_line("建筑物沉降观测", CATALOG, SYNONYMS)
        self.assertNotIn("知识库提示", r.basis)

    def test_exact_match_unaffected_by_kb(self):
        r = match_line("控制点复核", CATALOG, SYNONYMS, kb=KB)
        self.assertEqual((r.item_id, r.method), ("C01", "exact"))


class WriteGateTest(unittest.TestCase):
    def test_confirmed_by_required(self):
        with tempfile.TemporaryDirectory() as td:
            kb = KnowledgeBase(Path(td) / "c.json")
            with self.assertRaises(ValueError):
                kb.add_case({"type": "异常案例", "item": "C08", "phenomenon": "x", "resolution": "y"})

    def test_add_and_dedupe_and_search(self):
        with tempfile.TemporaryDirectory() as td:
            kb = KnowledgeBase(Path(td) / "c.json")
            case = {"type": "异常案例", "tags": ["低价", "异常低价"], "item": "C06",
                    "supplier": "戊", "phenomenon": "未税单价低于参考区间下限",
                    "resolution": "澄清后按漏项少测核查", "confirmed_by": "商务人员"}
            self.assertTrue(kb.add_case(case))
            self.assertFalse(kb.add_case(dict(case)))          # 重复不入库
            hits = kb.search("低于参考区间下限 异常低价")
            self.assertTrue(any(h["item"] == "C06" for h in hits))
            reloaded = KnowledgeBase(Path(td) / "c.json")      # 落盘可重载
            self.assertTrue(any(c["item"] == "C06" for c in reloaded.cases))

    def test_phenomenon_resolution_required(self):
        with tempfile.TemporaryDirectory() as td:
            kb = KnowledgeBase(Path(td) / "c.json")
            with self.assertRaises(ValueError):
                kb.add_case({"type": "异常案例", "item": "C08",
                             "phenomenon": "x", "resolution": "", "confirmed_by": "商务人员"})


if __name__ == "__main__":
    unittest.main()

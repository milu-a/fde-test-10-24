# -*- coding: utf-8 -*-
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.models import SourceRef, TaxProfile, TaxState, UnitResolution, UnitState


class TaxStateMachineTest(unittest.TestCase):
    def test_initial_undeclared_not_computable(self):
        t = TaxProfile("乙")
        self.assertEqual(t.state, TaxState.UNDECLARED)
        self.assertFalse(t.computable)

    def test_declare_requires_rate(self):
        t = TaxProfile("乙")
        with self.assertRaises(ValueError):
            t.declare(None, SourceRef("x.pdf", "p1"), "2026-09-19", "商务人员")
        with self.assertRaises(ValueError):
            t.declare("0", SourceRef("x.pdf", "p1"), "2026-09-19", "商务人员")

    def test_declare_requires_evidence(self):
        t = TaxProfile("乙")
        with self.assertRaises(ValueError):
            t.declare("0.06", None, "2026-09-19", "商务人员")

    def test_no_default_rate_passthrough(self):
        # 未声明时不给任何"默认 6% 兜底"出口：computable 恒 False
        t = TaxProfile("乙")
        self.assertFalse(t.computable)
        t.request_clarification("2026-09-19", "商务人员", "CLARIFY-01")
        self.assertEqual(t.state, TaxState.PENDING)
        self.assertFalse(t.computable)

    def test_declare_via_clarification_reaches_terminal(self):
        t = TaxProfile("乙")
        t.declare("0.06", SourceRef("澄清纪要.txt", "CLARIFY-01"), "2026-09-19", "商务人员",
                  channel="clarified")
        self.assertEqual(t.state, TaxState.CLARIFIED)
        self.assertTrue(t.computable)
        self.assertEqual(len(t.history), 1)
        self.assertEqual(t.history[0]["原值"], "未声明")

    def test_no_redeclare(self):
        t = TaxProfile("甲")
        t.declare("0.06", SourceRef("a.xlsx", "r2"), "2026-09-18", "供应商", channel="quoted")
        with self.assertRaises(ValueError):
            t.declare("0.03", SourceRef("b.pdf", "p1"), "2026-09-19", "商务人员")


class UnitStateMachineTest(unittest.TestCase):
    def test_resolve_requires_written_basis(self):
        u = UnitResolution("丁", "C14", "项", "台班")
        self.assertEqual(u.state, UnitState.PENDING)
        with self.assertRaises(ValueError):
            u.resolve({"items_per_quote_unit": 4}, None, "2026-09-19", "商务人员")
        u.resolve({"items_per_quote_unit": 4}, SourceRef("澄清纪要.txt", "CLARIFY-01"),
                  "2026-09-19", "商务人员")
        self.assertEqual(u.state, UnitState.RESOLVED)


if __name__ == "__main__":
    unittest.main()

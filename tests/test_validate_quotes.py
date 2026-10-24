# -*- coding: utf-8 -*-
"""M3 输出契约校验器测试：GC-017 样例必须合格；典型违规必须被抓到。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.validate_quotes import validate

SAMPLE = Path(__file__).resolve().parents[1] / "data" / "gc017_quotes.json"


class ValidateQuotesTest(unittest.TestCase):
    def test_gc017_sample_passes(self):
        import json
        data = json.loads(SAMPLE.read_text("utf-8"))
        self.assertEqual(validate(data), [])

    def test_good_minimal_output(self):
        data = {"project": "X", "suppliers": {"戊": {
            "file": "戊.pdf", "direction": "未税",
            "tax": {"state": "未声明"},
            "lines": [{"item": None, "name": "场地平整", "unit": "㎡", "qty": "500",
                       "unit_price": "4.00", "stated_amount": "2000.00",
                       "source": {"file": "戊.pdf", "locator": "第1页第1行"}}]}}}
        self.assertEqual(validate(data), [])

    def test_float_money_rejected(self):
        data = {"suppliers": {"戊": {
            "file": "戊.pdf", "direction": "含税", "tax": {"state": "未声明"},
            "lines": [{"item": None, "name": "X", "unit": "点", "qty": 12,
                       "unit_price": None, "stated_amount": None,
                       "source": {"file": "f", "locator": "r1"}}]}}}
        issues = validate(data)
        self.assertTrue(any("lines[1].qty" in m and "字符串" in m for m in issues))

    def test_undeclared_rate_with_value_rejected(self):
        data = {"suppliers": {"戊": {
            "file": "f", "direction": "含税",
            "tax": {"state": "未声明", "rate": "0.06"},   # 未声明却填税率 = 默认补写
            "lines": []}}}
        issues = validate(data)
        self.assertTrue(any("不得默认补写" in m for m in issues))

    def test_declared_without_evidence_rejected(self):
        data = {"suppliers": {"戊": {
            "file": "f", "direction": "含税",
            "tax": {"state": "已声明", "rate": "0.06"},   # 无依据文件
            "lines": []}}}
        issues = validate(data)
        self.assertTrue(any("依据文件" in m for m in issues))

    def test_empty_string_money_rejected(self):
        data = {"suppliers": {"戊": {
            "file": "f", "direction": "含税", "tax": {"state": "未声明"},
            "lines": [{"item": None, "name": "X", "unit": "点", "qty": "",
                       "unit_price": None, "stated_amount": None,
                       "source": {"file": "f", "locator": "r1"}}]}}}
        issues = validate(data)
        self.assertTrue(any("未知≠0" in m for m in issues))


if __name__ == "__main__":
    unittest.main()

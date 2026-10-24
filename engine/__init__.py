# -*- coding: utf-8 -*-
"""分包比选对账 Agent · M1 税率与计算引擎。

三权分立中的"算"：确定性规则引擎，金额计算零 LLM 参与，全部可单元测试。
"""
from .money import D, r2, fmt
from .models import (Direction, TaxState, UnitState, SourceRef, QuoteLine,
                     TaxProfile, UnitResolution, TERMINAL_TAX)
from .calculator import ComputedLine, compute_line
from .ledger import Amendment, Ledger, LedgerBuilder, ledger_to_dict
from .loader import load_all

__all__ = [
    "D", "r2", "fmt",
    "Direction", "TaxState", "UnitState", "SourceRef", "QuoteLine",
    "TaxProfile", "UnitResolution", "TERMINAL_TAX",
    "ComputedLine", "compute_line",
    "Amendment", "Ledger", "LedgerBuilder", "ledger_to_dict",
    "load_all",
]

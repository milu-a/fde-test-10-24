# -*- coding: utf-8 -*-
"""M4 归一匹配：供应商原始分项名 → 统一清单编号（C01–C15 / 任意项目清单）。"""
from .matcher import MatchResult, match_line, normalize_name
from .pipeline import confirm, run

__all__ = ["MatchResult", "match_line", "normalize_name", "run", "confirm"]

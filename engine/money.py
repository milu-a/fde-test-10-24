# -*- coding: utf-8 -*-
"""金额运算：全程 Decimal，ROUND 半进一（与 Excel ROUND 语义一致）。"""
from decimal import Decimal, ROUND_HALF_UP

_CENT = Decimal("0.01")


def D(x):
    """转 Decimal。openpyxl/PDF 抽出的浮点先过 str，避免 190.8 -> 190.79999... 的二进制噪声。"""
    if x is None or isinstance(x, Decimal):
        return x
    if isinstance(x, float):
        return Decimal(str(x))
    return Decimal(str(x))


def r2(x):
    """ROUND(x, 2)：计算规则第三条的舍入口径，四舍五入到分。"""
    return D(x).quantize(_CENT, rounding=ROUND_HALF_UP)


def fmt(x):
    return "—" if x is None else f"{x:,.2f}"

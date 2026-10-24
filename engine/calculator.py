# -*- coding: utf-8 -*-
"""分项计算器：双方向 ROUND 公式，零 LLM 参与，纯确定性可单元测试。

计算规则第三条——
  原报含税：含税金额 = ROUND(数量×含税单价, 2)
            未税金额 = ROUND(含税金额/(1+税率), 2)，税额 = 含税金额 − 未税金额
  原报未税：未税金额 = ROUND(数量×未税单价, 2)
            税额 = ROUND(未税金额×税率, 2)，含税金额 = 未税金额 + 税额
恒从原始口径方向起算，只折算一次，防止往返折算的舍入漂移。
"""
from dataclasses import dataclass, field
from decimal import Decimal
from typing import List, Optional

from .models import Direction, TaxProfile
from .money import D, r2


@dataclass
class ComputedLine:
    supplier: str
    item_id: str
    name: str
    unit: str
    qty: Optional[Decimal]
    unit_price: Optional[Decimal]
    direction: str
    orig_amount: Optional[Decimal]   # 原始口径分项金额
    ws: Optional[Decimal]            # 未税
    tax_amt: Optional[Decimal]       # 税额
    hs: Optional[Decimal]            # 含税
    status: str                      # 已计算 / 未报
    flags: List[str] = field(default_factory=list)
    basis: str = ""                  # 折算依据
    source: str = "—"                # 来源定位
    tax_state: str = ""
    unit_state: str = ""
    instance: int = 1


def compute_line(line, tax: TaxProfile, cat: dict, unit_state: str,
                 qty_override: Optional[Decimal] = None, qty_basis: str = "",
                 instance: int = 1) -> ComputedLine:
    flags: List[str] = []
    cat_qty = cat.get("qty")

    qty = line.qty
    if qty_override is not None:
        qty = qty_override
    elif (line.qty is not None and cat_qty is not None and line.qty != cat_qty
          and line.unit == cat.get("unit")):
        # 单位不同的（如丁 C14 按项报）走单位口径旗标，不做数量比对
        flags.append(f"数量与清单不符：报{line.qty}{line.unit}，清单{cat_qty}{cat['unit']}（不允许自行改变工程量）")

    rate = tax.rate if tax.computable else None

    # 原始口径金额：优先 单价×数量；无单价的整项口径按列示金额（如丁 C14、丙 C13 附件）
    orig = None
    status = "未报"
    if line.unit_price is not None and qty is not None:
        orig = r2(qty * line.unit_price)
        status = "已计算"
    elif line.stated_amount is not None:
        orig = line.stated_amount
        status = "已计算"
        flags.append("无单价，按列示金额（整项/总额口径）计")
    else:
        flags.append("单价未填，金额不可计（未知值不当0，规则第四条）")

    # 列示金额 vs 乘积：抄写差错线索（如丙 C04 多写 20 元）。
    # 工程量变更（qty_override）后列示金额仍属原数量口径，此对比不成立，跳过。
    if qty_override is None and line.unit_price is not None \
            and line.stated_amount is not None and orig is not None:
        diff = r2(line.stated_amount - orig)
        if diff != 0:
            flags.append(f"列示金额与数量×单价差{diff:+}元（疑似抄写错误，待澄清）")

    ws = tax_amt = hs = None
    basis = ""
    if orig is not None:
        if line.direction is Direction.TAX_INCL:
            hs = orig
            if rate is not None:
                ws = r2(hs / (Decimal(1) + rate))
                tax_amt = r2(hs - ws)
                basis = f"原报含税：含税=ROUND(数量×含税单价,2)；未税=ROUND(含税/(1+税率),2)，税率{rate}"
            else:
                basis = "原报含税；税率未声明，未税口径不可折算"
                flags.append("税率未给：未税/税额不可折算（显示为不可比，不当0，规则第二条）")
        else:
            ws = orig
            if rate is not None:
                tax_amt = r2(ws * rate)
                hs = r2(ws + tax_amt)
                basis = f"原报未税：未税=ROUND(数量×未税单价,2)；税额=ROUND(未税×税率,2)，税率{rate}"
            else:
                basis = "原报未税；税率未声明，含税口径不可折算"
                flags.append("税率未给：含税不可折算（显示为不可比，不当0，规则第二条）")

    if qty_override is not None:
        basis += f"；数量按{qty_basis}调整为{qty}（单价税率沿用）"
    if unit_state == "不一致待澄清":
        flags.append(f"单位口径待澄清：报「{line.unit}」≠清单「{cat['unit']}」，无书面说明不得换算（规则第四条）")

    return ComputedLine(
        supplier=line.supplier, item_id=line.item_id,
        name=line.name or cat.get("name", ""), unit=line.unit or cat.get("unit", ""),
        qty=qty, unit_price=line.unit_price, direction=line.direction.value,
        orig_amount=orig, ws=ws, tax_amt=tax_amt, hs=hs,
        status=status, flags=flags, basis=basis,
        source=line.source.label, tax_state=tax.state.value, unit_state=unit_state,
        instance=instance,
    )

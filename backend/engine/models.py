# -*- coding: utf-8 -*-
"""核心数据模型。

原则（计算规则第六条"原件永不覆盖"）：原始报价行 QuoteLine 冻结不可变；
澄清/变更一律生成 Amendment 事件，在台账构建时产生有效副本，原始件只增不改。
"""
import dataclasses
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import List, Optional

from .money import D


class Direction(Enum):
    TAX_INCL = "含税"
    TAX_EXCL = "未税"


class TaxState(Enum):
    UNDECLARED = "未声明"
    PENDING = "待澄清"
    DECLARED = "已声明"
    CLARIFIED = "已澄清"


TERMINAL_TAX = (TaxState.DECLARED, TaxState.CLARIFIED)


class UnitState(Enum):
    MATCHED = "一致"
    PENDING = "不一致待澄清"
    RESOLVED = "已书面确认"


@dataclass(frozen=True)
class SourceRef:
    """来源定位：PDF 标页码、Excel 标工作表及行号、图片标条目编码（规则第六条）。"""
    file: str
    locator: str = ""

    @property
    def label(self) -> str:
        return f"{self.file} · {self.locator}" if self.locator else self.file


@dataclass(frozen=True)
class QuoteLine:
    """供应商原始报价行（M3/M4 抽取归一的产物，一经导入不改）。"""
    supplier: str
    item_id: str
    name: str
    unit: str
    qty: Optional[Decimal]
    unit_price: Optional[Decimal]
    direction: Direction
    stated_amount: Optional[Decimal]
    source: SourceRef
    note: str = ""

    def with_(self, **kw) -> "QuoteLine":
        return dataclasses.replace(self, **kw)


@dataclass
class TaxProfile:
    """税率档案状态机：未声明 →（待澄清）→ 已声明/已澄清，仅终态可折算。

    硬规则（规则第二条）：税率必须由供应商给出并带依据文件，不得默认补写。
    """
    supplier: str
    state: TaxState = TaxState.UNDECLARED
    rate: Optional[Decimal] = None
    evidence: Optional[SourceRef] = None
    taxpayer_identity: Optional[str] = None
    invoice_type: Optional[str] = None
    history: List[dict] = field(default_factory=list)

    @property
    def computable(self) -> bool:
        return self.state in TERMINAL_TAX and self.rate is not None

    def declare(self, rate, evidence: SourceRef, at: str, operator: str,
                channel: str = "quoted", note: str = "") -> None:
        if self.state in TERMINAL_TAX:
            raise ValueError(f"{self.supplier} 税率已是终态({self.state.value})，不得重复声明")
        rate = D(rate)
        if rate is None or rate <= 0:
            raise ValueError("税率必须为明确正值，不得默认补写（规则第二条）")
        if evidence is None:
            raise ValueError("税率声明必须附带依据文件（追溯规则第六条）")
        new_state = TaxState.DECLARED if channel == "quoted" else TaxState.CLARIFIED
        self.history.append({
            "操作时间": at, "操作者": operator, "供应商": self.supplier, "分项": "税率",
            "原值": self.state.value + (f" {self.rate}" if self.rate else ""),
            "新值": f"{new_state.value} {rate}",
            "变更依据": evidence.label + (f"；{note}" if note else ""),
        })
        self.state, self.rate, self.evidence = new_state, rate, evidence

    def request_clarification(self, at: str, operator: str, note: str = "") -> None:
        if self.state is not TaxState.UNDECLARED:
            return
        self.history.append({
            "操作时间": at, "操作者": operator, "供应商": self.supplier, "分项": "税率",
            "原值": self.state.value, "新值": TaxState.PENDING.value,
            "变更依据": note,
        })
        self.state = TaxState.PENDING


@dataclass
class UnitResolution:
    """单位口径状态机（与税率状态机同构）：台班≠项，换算必须有供应商书面说明（规则第四条）。"""
    supplier: str
    item_id: str
    quote_unit: str
    catalog_unit: str
    state: UnitState = UnitState.PENDING
    basis: Optional[SourceRef] = None
    conversion: Optional[dict] = None
    history: List[dict] = field(default_factory=list)

    def resolve(self, conversion: dict, basis: SourceRef, at: str, operator: str, note: str = "") -> None:
        if self.state is UnitState.RESOLVED:
            raise ValueError(f"{self.supplier} {self.item_id} 单位口径已确认，不得重复确认")
        if basis is None:
            raise ValueError("台班与项不能直接换算，必须有供应商书面说明（规则第四条）")
        self.history.append({
            "操作时间": at, "操作者": operator, "供应商": self.supplier, "分项": self.item_id,
            "原值": f"{self.quote_unit}口径（未确认）",
            "新值": f"1{self.quote_unit}={conversion.get('items_per_quote_unit')}{self.catalog_unit}",
            "变更依据": basis.label + (f"；{note}" if note else ""),
        })
        self.state, self.basis, self.conversion = UnitState.RESOLVED, basis, conversion

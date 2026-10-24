# -*- coding: utf-8 -*-
"""台账装配：原始报价 + 澄清/变更事件 → 分口径计算行、合计与全程操作留痕。

每次 build 都从不可变的原始件克隆起步、按序应用事件，因此
V1 原始 / V1 澄清后 / V2 变更后 三个版本互不污染（V1 基线保留，规则第六条）。
"""
import dataclasses
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Dict, List, Optional
from collections import OrderedDict

from .calculator import ComputedLine, compute_line
from .models import Direction, QuoteLine, SourceRef, UnitResolution, UnitState
from .money import D, r2, fmt


@dataclass(frozen=True)
class Amendment:
    """澄清/变更事件（CLARIFY-01 / CHANGE-01 的结构化形态）。"""
    op: str                      # DECLARE_TAX / ADD_LINE / SET_FIELD / DEDUPE / RESOLVE_UNIT
    supplier: str
    item_id: Optional[str] = None
    field: Optional[str] = None
    old: Optional[str] = None
    new: Optional[str] = None
    payload: Optional[dict] = None
    evidence: str = ""
    at: str = ""
    operator: str = ""
    note: str = ""


@dataclass
class Ledger:
    version: str
    rows: "OrderedDict[str, Dict[str, List[ComputedLine]]]"
    totals: Dict[str, dict]
    audit: List[dict]
    notes: List[str] = field(default_factory=list)


def _line_dict(c: ComputedLine) -> dict:
    def s(v):
        return None if v is None else str(v)
    return {
        "supplier": c.supplier, "item": c.item_id, "name": c.name, "unit": c.unit,
        "qty": s(c.qty), "direction": c.direction,
        "orig_qty": s(c.orig_qty), "stated_amount": s(c.stated_amount), "note": c.note,
        "orig_amount": s(c.orig_amount), "ws": s(c.ws), "tax": s(c.tax_amt), "hs": s(c.hs),
        "status": c.status, "flags": list(c.flags), "basis": c.basis, "source": c.source,
        "tax_state": c.tax_state, "unit_state": c.unit_state, "instance": c.instance,
    }


def ledger_to_dict(led: Ledger) -> dict:
    return {
        "version": led.version,
        "totals": {
            sup: {k: (str(v) if isinstance(v, Decimal) else v) for k, v in t.items()}
            for sup, t in led.totals.items()
        },
        "rows": {
            item: {sup: [_line_dict(c) for c in ls] for sup, ls in per.items()}
            for item, per in led.rows.items()
        },
        "audit": led.audit,
    }


def _split_evidence(ev: str) -> SourceRef:
    if " · " in ev:
        f, loc = ev.split(" · ", 1)
        return SourceRef(f, loc)
    return SourceRef(ev)


class LedgerBuilder:
    def __init__(self, catalog: Dict[str, dict], suppliers: Dict[str, dict],
                 tax_profiles: Dict[str, object]):
        self.catalog = catalog        # {item_id: {name, unit, qty:Decimal, range}}
        self.suppliers = suppliers    # {sup: {direction, lines, stated_total, file, item_notes}}
        self.tax_base = tax_profiles

    # ------------------------------------------------------------------ build
    def build(self, version: str, amendments=(), qty_overrides=None, qty_basis: str = "",
              qty_at: str = "", qty_operator: str = "") -> Ledger:
        tax = {s: dataclasses.replace(p, history=list(p.history)) for s, p in self.tax_base.items()}
        lines: Dict[str, List[QuoteLine]] = {s: list(sd["lines"]) for s, sd in self.suppliers.items()}
        audit: List[dict] = []
        resolutions: Dict[tuple, UnitResolution] = {}

        for am in amendments:
            self._apply(am, lines, tax, resolutions, audit)

        if qty_overrides:
            for item, q in qty_overrides.items():
                q = D(q)
                for sup in lines:
                    for ln in lines[sup]:
                        if ln.item_id == item:
                            audit.append({
                                "操作时间": qty_at, "操作者": qty_operator,
                                "供应商": sup, "分项": item,
                                "原值": f"{ln.qty}{ln.unit}", "新值": f"{q}{ln.unit}",
                                "变更依据": f"{qty_basis}：工程量调整，单价与税率沿用",
                            })

        rows: "OrderedDict[str, Dict[str, List[ComputedLine]]]" = OrderedDict()
        for cid, cat in self.catalog.items():
            per: Dict[str, List[ComputedLine]] = {}
            for sup, sd in self.suppliers.items():
                inst = [ln for ln in lines[sup] if ln.item_id == cid]
                if not inst:
                    per[sup] = [self._placeholder(sup, cid, cat, tax[sup])]
                    continue
                unit_state = self._unit_state(sup, cid, inst[0], resolutions)
                override = D(qty_overrides[cid]) if qty_overrides and cid in qty_overrides else None
                cls = [
                    compute_line(ln, tax[sup], cat, unit_state, qty_override=override,
                                 qty_basis=qty_basis, instance=k)
                    for k, ln in enumerate(inst, 1)
                ]
                if len(inst) > 1:
                    same = len({(ln.qty, ln.unit_price, ln.stated_amount) for ln in inst}) == 1
                    msg = (f"同一分项出现{len(inst)}行且内容一致（重复，暂按列示原样计入）"
                           if same else
                           f"同一分项出现{len(inst)}行且内容不同（需人工核对）")
                    for c in cls:
                        c.flags.append(msg)
                per[sup] = cls
            rows[cid] = per

        stage = "changed" if qty_overrides else ("clarified" if amendments else "raw")
        totals = {sup: self._totals(sup, rows, stage) for sup in self.suppliers}
        for p in tax.values():
            audit.extend(p.history)
        audit.sort(key=lambda a: a["操作时间"])
        return Ledger(version, rows, totals, audit)

    # ------------------------------------------------------------------ 事件
    def _apply(self, am: Amendment, lines, tax, resolutions, audit) -> None:
        base = {
            "操作时间": am.at, "操作者": am.operator, "供应商": am.supplier,
            "变更依据": am.evidence + (f"；{am.note}" if am.note else ""),
        }
        sup = am.supplier
        if am.op == "DECLARE_TAX":
            tax[sup].declare(am.new, _split_evidence(am.evidence), am.at, am.operator,
                             channel="clarified", note=am.note)
            return
        if am.op == "ADD_LINE":
            pj = am.payload or {}
            newline = QuoteLine(
                supplier=sup, item_id=am.item_id, name=pj.get("name", ""),
                unit=pj.get("unit", self.catalog[am.item_id]["unit"]),
                qty=D(pj["qty"]) if pj.get("qty") is not None else None,
                unit_price=D(pj["unit_price"]) if pj.get("unit_price") is not None else None,
                direction=self.suppliers[sup]["direction"],
                stated_amount=D(pj["stated_amount"]) if pj.get("stated_amount") is not None else None,
                source=_split_evidence(am.evidence),
                note=pj.get("note", am.note),
            )
            # 源文件里有"空行"（如乙 C09 单价未填）则原位回填，否则作为新行追加
            lst = lines[sup]
            replaced = False
            for i, ln in enumerate(lst):
                if ln.item_id == am.item_id and ln.unit_price is None and ln.stated_amount is None:
                    lst[i] = newline
                    replaced = True
                    break
            if not replaced:
                lst.append(newline)
            audit.append({**base, "分项": am.item_id,
                          "原值": "漏报行（单价未填）" if replaced else "无此行（整行缺失）",
                          "新值": self._desc(newline)})
            return
        if am.op == "SET_FIELD":
            for i, ln in enumerate(lines[sup]):
                if ln.item_id == am.item_id:
                    old_v = getattr(ln, am.field)
                    kw = {am.field: D(am.new)}
                    # 数量/单价更正意味着"金额重算"（如丁 C04：16点→18点，金额按乘积更新）
                    if am.field in ("qty", "unit_price") and ln.unit_price is not None:
                        eff = {**{"qty": ln.qty, "unit_price": ln.unit_price}, **kw}
                        kw["stated_amount"] = r2(D(eff["qty"]) * D(eff["unit_price"]))
                    lines[sup][i] = ln.with_(**kw)
                    audit.append({**base, "分项": am.item_id,
                                  "原值": str(old_v), "新值": str(am.new)})
                    return
            raise ValueError(f"{sup} 无 {am.item_id} 行，无法 SET_FIELD")
        if am.op == "DEDUPE":
            target = [ln for ln in lines[sup] if ln.item_id == am.item_id]
            keep = target[0]
            out, seen = [], False
            for ln in lines[sup]:
                if ln.item_id == am.item_id:
                    if seen:
                        continue
                    seen = True
                out.append(ln)
            lines[sup] = out
            audit.append({**base, "分项": am.item_id,
                          "原值": f"{len(target)}行×{fmt(keep.stated_amount)}",
                          "新值": f"1行×{fmt(keep.stated_amount)}（重复只计一次）"})
            return
        if am.op == "RESOLVE_UNIT":
            cat = self.catalog[am.item_id]
            conv = am.payload or {}
            per = Decimal(str(conv["items_per_quote_unit"]))
            for i, ln in enumerate(lines[sup]):
                if ln.item_id != am.item_id:
                    continue
                if ln.unit_price is None and ln.stated_amount is not None:
                    new_qty = (ln.qty or Decimal(1)) * per
                    new_price = r2(ln.stated_amount / new_qty)
                    old_desc = f"{ln.qty}{ln.unit}（列示{fmt(ln.stated_amount)}）"
                    lines[sup][i] = ln.with_(
                        unit=cat["unit"], qty=new_qty, unit_price=new_price,
                        note=f"单位经书面确认：1{ln.unit}={per}{cat['unit']}，"
                             f"总价均分{new_price}/{cat['unit']}（总额不变）")
                    audit.append({**base, "分项": am.item_id,
                                  "原值": old_desc, "新值": f"{new_qty}{cat['unit']}×{new_price}（总额不变）"})
                else:
                    raise ValueError("暂只支持整项口径的单位确认换算（有单价口径留待后续案例）")
            resolutions[(sup, am.item_id)] = UnitResolution(
                sup, am.item_id, conv.get("quote_unit", ""), cat["unit"],
                UnitState.RESOLVED, _split_evidence(am.evidence), conv)
            return
        raise ValueError(f"未知事件类型：{am.op}")

    # ------------------------------------------------------------------ 装配
    def _placeholder(self, sup, cid, cat, taxp) -> ComputedLine:
        flags = ["报价中无此分项"]
        note = self.suppliers[sup].get("item_notes", {}).get(cid)
        if note:
            flags.append(note)
        return ComputedLine(
            supplier=sup, item_id=cid, name=cat["name"], unit=cat["unit"], qty=None,
            unit_price=None, direction=self.suppliers[sup]["direction"].value,
            orig_amount=None, ws=None, tax_amt=None, hs=None,
            status="未报", flags=flags, basis="", source="—",
            tax_state=taxp.state.value, unit_state="—")

    def _unit_state(self, sup, cid, line, resolutions) -> str:
        cat = self.catalog[cid]
        res = resolutions.get((sup, cid))
        if res is not None:
            return res.state.value
        if line.unit != cat["unit"]:
            return UnitState.PENDING.value
        return UnitState.MATCHED.value

    def _totals(self, sup, rows, stage: str = "raw") -> dict:
        sd = self.suppliers[sup]
        ws_vals, tax_vals, hs_vals = [], [], []
        n_hs_missing = 0
        for per in rows.values():
            for c in per[sup]:
                if c.status != "已计算":
                    continue
                if c.ws is not None:
                    ws_vals.append(c.ws)
                if c.tax_amt is not None:
                    tax_vals.append(c.tax_amt)
                if c.hs is not None:
                    hs_vals.append(c.hs)
                else:
                    n_hs_missing += 1
        ws_t = sum(ws_vals, Decimal(0)) if ws_vals else None
        tax_t = sum(tax_vals, Decimal(0)) if tax_vals else None
        hs_t = sum(hs_vals, Decimal(0)) if hs_vals else None

        flags = []
        comp = hs_t if sd["direction"] is Direction.TAX_INCL else ws_t
        stated = sd.get("stated_total")
        if stated is not None and comp is not None:
            diff = r2(stated - comp)
            if diff != 0:
                if stage == "changed":
                    flags.append(f"V2按变更后工程量重算：与V1原报列示合计{fmt(stated)}差{diff:+}元，"
                                 f"属工程量变更所致（V1基线与金额差异另行对比）")
                elif stage == "clarified":
                    flags.append(f"明细加总{fmt(comp)}与原报列示合计{fmt(stated)}差{diff:+}元"
                                 f"（含澄清回填调整：补漏报/剔重复/并附件，以确认后明细重算为准）")
                else:
                    flags.append(f"明细加总{fmt(comp)}与原报列示合计{fmt(stated)}差{diff:+}元"
                                 f"（原报合计误差，据确认明细重算）")
        if n_hs_missing:
            flags.append(f"{n_hs_missing}行因税率未给未折算，相关口径合计不完整（未按0计，规则第二条）")
        return {
            "direction": sd["direction"].value,
            "ws": ws_t, "tax": tax_t, "hs": hs_t,
            "stated": stated, "flags": flags,
        }

    @staticmethod
    def _desc(ln: QuoteLine) -> str:
        if ln.unit_price is not None:
            return f"{ln.qty}{ln.unit}×{ln.unit_price}"
        return f"整项{fmt(ln.stated_amount)}"

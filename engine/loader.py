# -*- coding: utf-8 -*-
"""JSON 数据装载：统一清单 / 四家原始报价（手工结构化兜底，M3/M4 的产物同构）/ 澄清与变更事件。"""
import json
from pathlib import Path
from types import SimpleNamespace

from .ledger import Amendment, LedgerBuilder
from .models import Direction, QuoteLine, SourceRef, TaxProfile, TaxState
from .money import D

DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def _src(obj) -> SourceRef:
    if isinstance(obj, dict):
        return SourceRef(obj.get("file", ""), obj.get("locator", ""))
    if " · " in obj:
        f, loc = obj.split(" · ", 1)
        return SourceRef(f, loc)
    return SourceRef(obj)


def _line(sup: str, direction: Direction, lj: dict) -> QuoteLine:
    return QuoteLine(
        supplier=sup, item_id=lj["item"], name=lj.get("name", ""), unit=lj["unit"],
        qty=D(lj["qty"]) if lj.get("qty") is not None else None,
        unit_price=D(lj["unit_price"]) if lj.get("unit_price") is not None else None,
        direction=direction,
        stated_amount=D(lj["stated_amount"]) if lj.get("stated_amount") is not None else None,
        source=_src(lj.get("source", "")), note=lj.get("note", ""))


def load_all(data_dir=None) -> SimpleNamespace:
    data_dir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
    catalog_raw = json.loads((data_dir / "gc017_catalog.json").read_text("utf-8"))
    quotes_raw = json.loads((data_dir / "gc017_quotes.json").read_text("utf-8"))
    events_raw = json.loads((data_dir / "gc017_events.json").read_text("utf-8"))

    catalog = {}
    for it in catalog_raw["items"]:
        catalog[it["id"]] = {"id": it["id"], "name": it["name"], "unit": it["unit"],
                             "qty": D(it["qty"]), "range": it.get("range")}

    suppliers, tax_profiles = {}, {}
    for sup, sj in quotes_raw["suppliers"].items():
        direction = Direction(sj["direction"])
        lines = [_line(sup, direction, lj) for lj in sj.get("lines", [])]
        tax = TaxProfile(supplier=sup)
        tj = sj.get("tax", {})
        if tj.get("state") in ("已声明", "已澄清"):
            tax.declare(tj["rate"], _src(tj["evidence"]),
                        at=tj.get("at", quotes_raw.get("quote_date", "")),
                        operator="供应商报价", channel="quoted")
        elif tj.get("state") == "待澄清":
            tax.state = TaxState.PENDING
        tax_profiles[sup] = tax
        suppliers[sup] = {
            "direction": direction, "lines": lines,
            "stated_total": D(sj["stated_total"]) if sj.get("stated_total") else None,
            "file": sj.get("file", ""), "tax_note": tj.get("note", ""),
            "item_notes": sj.get("item_notes", {}),
        }

    builder = LedgerBuilder(catalog, suppliers, tax_profiles)

    cl = events_raw["clarify"]
    clarify = [
        Amendment(op=a["op"], supplier=a["supplier"], item_id=a.get("item"),
                  field=a.get("field"), old=a.get("old"), new=a.get("new"),
                  payload=a.get("payload"),
                  evidence=a.get("evidence") or cl["doc"],
                  at=a.get("at") or cl["at"], operator=a.get("operator") or cl["operator"],
                  note=a.get("note", ""))
        for a in cl["actions"]
    ]
    events = {"clarify": clarify, "change": events_raw["change"]}
    return SimpleNamespace(catalog=catalog, builder=builder, events=events,
                           quotes_raw=quotes_raw, catalog_raw=catalog_raw)

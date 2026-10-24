# -*- coding: utf-8 -*-
"""运行时项目管线：收集箱识别记录 → M4 匹配统一清单 → 引擎报价对象 → 台账。

GC-017 的报价来自手工结构化兜底数据（gc017_quotes.json，与 M3/M4 产物同构）；
用户新建项目的报价来自收集箱上传文件的 read-file 识别结果（15 字段中文结构）。
本模块把识别记录装配成 engine.loader 同构的 catalog / suppliers / tax_profiles，
复用同一 LedgerBuilder 计算——金额计算零 LLM、全程 Decimal（M1 红线不变）。

红线（与上游一致）：
- 分项匹配只有 M4 前两层（精确/同义词表）允许自动回填，语义提案不自动入账；
- 税率必须来自记录中的声明（带依据），未给则保持未声明、不当 0、不折算；
- 未匹配行进入待确认报告，绝不硬猜归类。
"""
import json
import re
import time
from pathlib import Path

from engine import ledger_to_dict
from engine.ledger import LedgerBuilder
from engine.models import Direction, QuoteLine, SourceRef, TaxProfile
from engine.money import D
from matching.matcher import match_line

BACKEND = Path(__file__).resolve().parent
PROJECTS_FILE = BACKEND / "data" / "projects.json"
RECOG_DIR = BACKEND / "out" / "recognition"
PROJECT_STATUS_INIT = "配置中"            # 项目状态机（界面设计文档 §6.1）初始态
PROJECT_STATUS_COLLECTING = "归集中"      # 已登记报价文件
PROJECT_ID_FLOOR = 17                     # GC-017 为内置案例编号，新建项目从 GC-018 续号

_LEDGER_VERSION = "V1 原始（识别归集）"


# ---------------------------------------------------------------- 项目存储
def load_projects() -> list:
    if not PROJECTS_FILE.exists():
        return []
    return json.loads(PROJECTS_FILE.read_text("utf-8")).get("projects", [])


def save_projects(projects: list) -> None:
    PROJECTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROJECTS_FILE.write_text(json.dumps({"projects": projects}, ensure_ascii=False, indent=1),
                             encoding="utf-8")


def find_project(projects: list, pid: str):
    return next((p for p in projects if p.get("id") == pid), None)


def next_project_id(projects: list) -> str:
    top = PROJECT_ID_FLOOR
    for p in projects:
        m = re.fullmatch(r"GC-(\d+)", str(p.get("id", "")))
        if m:
            top = max(top, int(m.group(1)))
    return f"GC-{top + 1:03d}"


def create_project(name: str, owner: str) -> dict:
    projects = load_projects()
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    proj = {"id": next_project_id(projects), "name": name, "owner": owner,
            "status": PROJECT_STATUS_INIT, "files": [],
            "created_at": now, "updated_at": now}
    projects.insert(0, proj)
    save_projects(projects)
    return proj


def load_recognition_result(rec_id: str):
    """按 id 读取识别缓存（out/recognition/{id}.json），不存在返回 None。"""
    if not re.fullmatch(r"[^/\\]+", str(rec_id or "")):
        return None                      # 拒绝路径分隔符，防止越界读文件
    f = RECOG_DIR / f"{rec_id}.json"
    if not f.exists():
        return None
    return json.loads(f.read_text("utf-8"))


def attach_recognition(pid: str, rec_id: str) -> dict:
    """把已缓存的识别结果登记进项目（files 按 id 去重），首份文件触发 配置中→归集中。"""
    rec = load_recognition_result(rec_id)
    if rec is None:
        raise ValueError(f"识别结果 {rec_id} 不存在（需先经收集箱上传识别）")
    projects = load_projects()
    proj = find_project(projects, pid)
    if proj is None:
        raise KeyError(f"项目 {pid} 不存在")
    files = proj.setdefault("files", [])
    if rec_id not in [f.get("id") for f in files]:
        files.append({"id": rec_id, "file": rec.get("file", ""),
                      "vendor": rec.get("vendor_guess", ""),
                      "channel": rec.get("channel", ""), "channel_desc": rec.get("channel_desc", ""),
                      "ts": rec.get("ts", "")})
        proj["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        if proj.get("status") == PROJECT_STATUS_INIT:
            proj["status"] = PROJECT_STATUS_COLLECTING
        save_projects(projects)
    return proj


# ---------------------------------------------------------------- 装配与计算
def _catalog_maps():
    """统一清单（组织级默认，与 GC-017 同一份 C01–C15）。→ (catalog_for_engine, raw)"""
    raw = json.loads((BACKEND / "data" / "gc017_catalog.json").read_text("utf-8"))
    catalog = {}
    for it in raw["items"]:
        catalog[it["id"]] = {"id": it["id"], "name": it["name"], "unit": it["unit"],
                             "qty": D(it["qty"]), "range": it.get("range")}
    return catalog, raw


def _load_synonyms() -> dict:
    f = BACKEND / "data" / "synonyms.json"
    return json.loads(f.read_text("utf-8")) if f.exists() else {}


def _parse_rate(s):
    """'6%' → Decimal('0.06')；'未给'/空/非法格式 → None（不当 0，不硬猜）。"""
    if not isinstance(s, str):
        return None
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*%\s*", s)
    return D(m.group(1)) / 100 if m else None


def _dec(v):
    return D(str(v)) if v not in ("", None) else None


_SUP_ORDER = "甲乙丙丁戊己庚辛"


def _sup_key(sup: str):
    return (_SUP_ORDER.index(sup), "") if sup in _SUP_ORDER else (len(_SUP_ORDER), sup)


def assemble_suppliers(rec_results: list):
    """识别结果列表 → (catalog, suppliers, tax_profiles, sup_order, report)。

    同一 vendor_guess 的多个文件合并为一家供应商（行串联，出处各自保留）。"""
    catalog, _ = _catalog_maps()
    synonyms = _load_synonyms()
    lines_by_sup, meta_by_sup = {}, {}
    unmatched, matched = [], 0

    for res in rec_results:
        vendor = str(res.get("vendor_guess") or "供").strip() or "供"
        meta = meta_by_sup.setdefault(vendor, {"files": [], "direction": None,
                                               "stated_total": None,
                                               "tax_rate": None, "tax_evidence": "",
                                               "ts": res.get("ts", "")})
        if res.get("file") and res["file"] not in meta["files"]:
            meta["files"].append(res["file"])
        for r in res.get("records", []):
            rtype = r.get("行类型")
            if rtype == "合计":
                v = _dec(r.get("原报金额"))
                if v is not None:
                    meta["stated_total"] = v          # 以最后一条合计行列示为准
                continue
            if rtype != "分项":
                continue                              # 说明行等不入账

            direction = r.get("单价口径") if r.get("单价口径") in ("含税", "未税") else None
            meta["direction"] = meta["direction"] or direction

            code = str(r.get("原始编码") or "").strip().upper()
            name = str(r.get("原始分项名称") or "").strip()
            item_id, basis = None, ""
            if code in catalog:                       # 识别记录自带清单编码 → 直接对位
                item_id, basis = code, f"原始编码 {code}"
            elif name:                                # 无编码 → M4 三层匹配
                m = match_line(name, catalog, synonyms)
                if m.auto:
                    item_id, basis = m.item_id, m.basis
                else:
                    unmatched.append({"file": res.get("file", ""), "vendor": vendor,
                                      "name": name, "method": m.method, "basis": m.basis})
            else:
                unmatched.append({"file": res.get("file", ""), "vendor": vendor,
                                  "name": "", "method": "unmatched",
                                  "basis": "M4：原始名称为空，待人工确认"})
            if item_id is None:
                continue                              # 未匹配不入账（M4：提案不回填）

            note = f"识别置信度{r.get('置信度') or '—'}"
            if r.get("待人工标记"):
                note += f" · {r['待人工标记']}"
            if basis:
                note += f" · {basis}"
            line = QuoteLine(
                supplier=vendor, item_id=item_id, name=name or catalog[item_id]["name"],
                unit=str(r.get("单位") or catalog[item_id]["unit"]),
                qty=_dec(r.get("数量")), unit_price=_dec(r.get("单价")),
                direction=Direction(direction or "含税"),
                stated_amount=_dec(r.get("原报金额")),
                source=SourceRef(str(r.get("出处-文件") or res.get("file", "")),
                                 str(r.get("出处-定位") or "")),
                note=note)
            lines_by_sup.setdefault(vendor, []).append(line)
            matched += 1
            rate = _parse_rate(r.get("税率"))
            if rate is not None and meta["tax_rate"] is None:
                meta["tax_rate"] = rate
                meta["tax_evidence"] = (f"{r.get('出处-文件') or res.get('file', '')}"
                                        + (f" · {r['税率依据']}" if r.get("税率依据") else ""))

    catalog_sup, tax_profiles, sup_order = {}, {}, []
    for vendor in sorted(meta_by_sup, key=_sup_key):
        lines = lines_by_sup.get(vendor, [])
        if not lines:
            continue                                  # 只有合计/说明行的文件不成供应商
        meta = meta_by_sup[vendor]
        direction = Direction(meta["direction"] or "含税")
        catalog_sup[vendor] = {
            "direction": direction, "lines": lines,
            "stated_total": meta["stated_total"],
            "file": " · ".join(meta["files"]), "tax_note": "", "item_notes": {},
        }
        tax = TaxProfile(supplier=vendor)
        if meta["tax_rate"] is not None:
            tax.declare(meta["tax_rate"], SourceRef(meta["tax_evidence"] or meta["files"][0]),
                        at=meta["ts"], operator="read-file 识别", channel="quoted")
        tax_profiles[vendor] = tax
        sup_order.append(vendor)

    report = {"matched": matched, "unmatched": unmatched,
              "suppliers": len(sup_order)}
    return catalog, catalog_sup, tax_profiles, sup_order, report


def build_board(proj: dict) -> dict:
    """项目全量工作台数据：清单 + 识别登记 + 引擎台账 + 匹配报告。

    每次请求现算（引擎为纯本地 Decimal 计算，代价可忽略），无版本事件时即
    V1 原始口径；澄清/变更事件接入后在此追加 amendments。"""
    file_ids = [f.get("id") for f in proj.get("files", [])]
    recs = [load_recognition_result(rid) for rid in file_ids]
    recs = [r for r in recs if r]
    catalog, suppliers, tax_profiles, sup_order, report = assemble_suppliers(recs)

    ledger = None
    if suppliers:
        led = LedgerBuilder(catalog, suppliers, tax_profiles).build(_LEDGER_VERSION)
        ledger = ledger_to_dict(led)

    return {
        "project": proj,
        "catalog": json.loads((BACKEND / "data" / "gc017_catalog.json").read_text("utf-8")),
        "suppliers_order": sup_order,
        "files": proj.get("files", []),
        "file_ids": file_ids,
        "records": {str(r.get("vendor_guess") or "供"): r for r in recs},
        "ledger": ledger,
        "match_report": report,
    }

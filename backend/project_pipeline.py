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
from engine.ledger import Amendment, LedgerBuilder
from engine.models import Direction, QuoteLine, SourceRef, TaxProfile
from engine.money import D
from matching.matcher import match_line
from report import write_ledger

BACKEND = Path(__file__).resolve().parent
PROJECTS_FILE = BACKEND / "data" / "projects.json"
RECOG_DIR = BACKEND / "out" / "recognition"
OUT = BACKEND / "out"
TEMPLATE = BACKEND.parent / "04 报价各说各话，工程分包怎么比？" / "01 原始报价与清单" / "比选输出模板.xlsx"
PROJECT_STATUS_INIT = "配置中"            # 项目状态机（界面设计文档 §6.1）初始态
PROJECT_STATUS_COLLECTING = "归集中"      # 已登记报价文件
PROJECT_ID_FLOOR = 17                     # GC-017 为内置案例编号，新建项目从 GC-018 续号
KNOWN_STATUS = ("配置中", "收件中", "归集中", "待澄清", "台账已出", "已交付评审", "已定标", "已归档")
EVENT_OPS = ("DECLARE_TAX", "ADD_LINE", "SET_FIELD", "DEDUPE", "RESOLVE_UNIT")
VERSION_LABEL = {"v1_raw": "V1原始", "v1_clarified": "V1澄清后"}

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


_PROJECT_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$")


def create_project(name: str, owner: str, created_at: str | None = None) -> dict:
    """created_at 可选（前端「项目时间」）：YYYY-MM-DD 或 YYYY-MM-DD HH:MM[:SS]。
    缺省仍取当前时刻（接口向后兼容）；只填到日时按当日 00:00:00 归一存储。"""
    projects = load_projects()
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    if created_at:
        created_at = str(created_at).strip().replace("T", " ")
        if not _PROJECT_TIME_RE.fullmatch(created_at):
            raise ValueError("项目时间格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM[:SS]")
        if len(created_at) == 10:
            created_at += " 00:00:00"
        elif len(created_at) == 16:
            created_at += ":00"
        now = created_at
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
        if not any(l.unit_price is not None or l.stated_amount is not None for l in lines):
            continue                                  # 全文无任何价格信号（如标准清单/参考区间表）→ 不是报价，不入对比
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


def project_summary(proj: dict) -> dict:
    """首页卡片摘要：报价供应商数、台账是否已生成、待确认事件数（轻量装配，不算全台账）。"""
    recs = [load_recognition_result(f.get("id")) for f in proj.get("files", [])]
    recs = [r for r in recs if r]
    _, suppliers, _, _, _ = assemble_suppliers(recs)
    pending = sum(1 for e in proj.get("events", []) if e.get("status") == "待确认")
    return {"suppliers": len(suppliers), "has_ledger": len(suppliers) > 0, "pending_events": pending}


# ---------------------------------------------------------------- 事件（澄清/变更）
def _touch(proj: dict) -> None:
    proj["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")


def _project_rec_results(proj: dict) -> list:
    recs = [load_recognition_result(f.get("id")) for f in proj.get("files", [])]
    return [r for r in recs if r]


def _to_amendment(e: dict) -> Amendment:
    return Amendment(op=e["op"], supplier=e.get("supplier"), item_id=e.get("item"),
                     field=e.get("field"), old=e.get("old"), new=e.get("new"),
                     payload=e.get("payload"), evidence=e.get("evidence", ""),
                     at=e.get("at", ""), operator=e.get("operator", ""), note=e.get("note", ""))


def add_event(pid: str, body: dict) -> dict:
    """登记事件候选（路径A 人工结构化登记）：先静态校验，应用时引擎二次把关。"""
    projects = load_projects()
    proj = find_project(projects, pid)
    if proj is None:
        raise KeyError(pid)
    op = str(body.get("op") or "")
    if op not in EVENT_OPS:
        raise ValueError(f"不支持的事件类型 {op}（允许：{'/'.join(EVENT_OPS)}）")
    supplier = str(body.get("supplier") or "").strip()
    evidence = str(body.get("evidence") or "").strip()
    item = (str(body.get("item") or "").strip().upper() or None)
    new = str(body.get("new") or "").strip()
    payload = body.get("payload") if isinstance(body.get("payload"), dict) else None
    note = str(body.get("note") or "").strip()
    operator = str(body.get("operator") or "商务人员A").strip() or "商务人员A"
    if not supplier or not evidence:
        raise ValueError("供应商与依据文件均为必填——无依据不改数（规则第六条）")
    if op in ("SET_FIELD", "ADD_LINE", "DEDUPE", "RESOLVE_UNIT") and not item:
        raise ValueError("该事件类型必须指定清单项")

    catalog, _sup, _tax, sup_order, _rep = assemble_suppliers(_project_rec_results(proj))
    if supplier not in sup_order:
        raise ValueError(f"供应商「{supplier}」不在本项目已归集的报价供应商中（{'、'.join(sup_order) or '无'}）")
    if item is not None and item not in catalog:
        raise ValueError(f"清单项 {item} 不在统一清单 C01–C15 中")
    if op == "SET_FIELD":
        if str(body.get("field") or "") not in ("qty", "unit_price", "stated_amount"):
            raise ValueError("SET_FIELD 的 field 仅支持 qty / unit_price / stated_amount")
        if not new:
            raise ValueError("SET_FIELD 必须提供新值")
    elif op == "DECLARE_TAX":
        if not new:
            raise ValueError("申报税率必须提供新值（如 0.06 表示 6%）")
        try:
            D(new)
        except Exception:
            raise ValueError("税率须为数值（如 0.06 表示 6%），不得默认补写")
    elif op == "ADD_LINE":
        if not payload or (payload.get("stated_amount") is None
                           and (payload.get("unit_price") is None or payload.get("qty") is None)):
            raise ValueError("补录行需提供 整项金额 stated_amount，或 数量 qty × 单价 unit_price")
    elif op == "RESOLVE_UNIT":
        if not payload or payload.get("items_per_quote_unit") is None:
            raise ValueError("单位确认需提供换算比例 items_per_quote_unit（如 1项=4台班 填 4）")

    events = proj.setdefault("events", [])
    nums = [int(m.group(1)) for e in events for m in [re.fullmatch(r"EVT-(\d+)", str(e.get("id", "")))] if m]
    ev = {"id": f"EVT-{max(nums or [0]) + 1:03d}", "op": op, "supplier": supplier,
          "item": item, "field": body.get("field"), "old": str(body.get("old") or "") or None,
          "new": new or None, "payload": payload, "evidence": evidence,
          "at": time.strftime("%Y-%m-%d %H:%M"), "operator": operator,
          "note": note, "status": "待确认"}
    events.append(ev)
    _touch(proj)
    save_projects(projects)
    return ev


def _find_event(proj: dict, eid: str):
    return next((e for e in proj.get("events", []) if e.get("id") == eid), None)


def apply_event(pid: str, eid: str) -> dict:
    """确认并应用事件：标记已应用 → 引擎试算，拒绝则回滚状态（坏事件不入账）。"""
    projects = load_projects()
    proj = find_project(projects, pid)
    if proj is None:
        raise KeyError(pid)
    ev = _find_event(proj, eid)
    if ev is None:
        raise KeyError(eid)
    if ev.get("status") != "待确认":
        raise ValueError(f"事件 {eid} 当前状态为「{ev.get('status')}」，不能应用")
    ev["status"] = "已应用"
    try:
        _project_ledgers(proj)
    except Exception as exc:
        ev["status"] = "待确认"
        raise ValueError(f"引擎拒绝该事件（未入账）：{exc}")
    _touch(proj)
    if proj.get("status") in (PROJECT_STATUS_INIT, PROJECT_STATUS_COLLECTING):
        proj["status"] = "台账已出"
    save_projects(projects)
    return ev


def discard_event(pid: str, eid: str) -> dict:
    """作废待确认事件（作废不删除，与上游一致）。"""
    projects = load_projects()
    proj = find_project(projects, pid)
    if proj is None:
        raise KeyError(pid)
    ev = _find_event(proj, eid)
    if ev is None:
        raise KeyError(eid)
    if ev.get("status") != "待确认":
        raise ValueError(f"事件 {eid} 已应用入账，不能作废")
    ev["status"] = "已作废"
    _touch(proj)
    save_projects(projects)
    return ev


def set_status(pid: str, status: str) -> dict:
    if status not in KNOWN_STATUS:
        raise ValueError(f"未知项目状态 {status}")
    projects = load_projects()
    proj = find_project(projects, pid)
    if proj is None:
        raise KeyError(pid)
    proj["status"] = status
    _touch(proj)
    save_projects(projects)
    return proj


# ---------------------------------------------------------------- 台账构建与导出
def _project_ledgers(proj: dict):
    """装配 + 双版本构建：V1 原始（无事件）与 V1 澄清后（已应用事件），互不污染。"""
    catalog, suppliers, tax_profiles, sup_order, report = assemble_suppliers(_project_rec_results(proj))
    events = proj.get("events", [])
    amendments = [_to_amendment(e) for e in events if e.get("status") == "已应用"]
    led_raw = led_clar = None
    if suppliers:
        builder = LedgerBuilder(catalog, suppliers, tax_profiles)
        led_raw = builder.build(_LEDGER_VERSION)
        if amendments:
            led_clar = builder.build("V1 澄清后（已应用人工确认事件）", amendments=amendments)
    return catalog, suppliers, tax_profiles, sup_order, report, events, amendments, led_raw, led_clar


def build_board(proj: dict) -> dict:
    """项目全量工作台数据：清单 + 识别登记 + 双版本台账 + 事件 + 匹配报告。

    每次请求现算（引擎为纯本地 Decimal 计算，代价可忽略）。"""
    catalog_raw = json.loads((BACKEND / "data" / "gc017_catalog.json").read_text("utf-8"))
    catalog, _sup, _tax, sup_order, report, events, _am, led_raw, led_clar = _project_ledgers(proj)
    ledgers = {}
    if led_raw is not None:
        ledgers["v1_raw"] = ledger_to_dict(led_raw)
    if led_clar is not None:
        ledgers["v1_clarified"] = ledger_to_dict(led_clar)
    return {
        "project": proj,
        "catalog": catalog_raw,
        "suppliers_order": sup_order,
        "files": proj.get("files", []),
        "file_ids": [f.get("id") for f in proj.get("files", [])],
        "records": {str(r.get("vendor_guess") or "供"): r for r in _project_rec_results(proj)},
        "ledgers": ledgers,
        "events": events,
        "match_report": report,
        "counts": {
            "pending_events": sum(1 for e in events if e.get("status") == "待确认"),
            "unmatched": len(report.get("unmatched", [])),
        },
    }


def _proj_rate_map(tax_profiles: dict, amendments: list, clarified: bool) -> dict:
    """原税率展示列（与 gen_workbooks._rate_map 同语义）：申报态取识别税率，
    澄清后取 DECLARE_TAX 事件——不写死供应商名。"""
    declares = {a.supplier: a.new for a in amendments if a.op == "DECLARE_TAX"}
    out = {}
    for s, tp in tax_profiles.items():
        if tp.state.value in ("已声明", "已澄清") and tp.rate is not None:
            r = tp.rate
        else:
            r = declares.get(s) if clarified else None
        out[s] = f"{float(r) * 100:g}%" if r is not None else "未声明"
    return out


def _proj_invoice_status(tax_profiles: dict, amendments: list) -> dict:
    """M5：申报过税率但未说明专票/普票的供应商立事项（项目报价均未采集发票类型）。"""
    declared_in_events = {a.supplier for a in amendments if a.op == "DECLARE_TAX"}
    return {s: {"declared": tp.state.value in ("已声明", "已澄清") or s in declared_in_events,
                "invoice_type": tp.invoice_type}
            for s, tp in tax_profiles.items()}


def export_project(pid: str, version: str) -> Path:
    """按版本把项目台账写成 5-sheet 比选台账 xlsx（企业模板副本填写）。"""
    if version not in VERSION_LABEL:
        raise ValueError(f"未知导出版本 {version}（v1_raw / v1_clarified）")
    projects = load_projects()
    proj = find_project(projects, pid)
    if proj is None:
        raise KeyError(pid)
    catalog, _sup, tax_profiles, _order, _rep, _ev, amendments, led_raw, led_clar = _project_ledgers(proj)
    led = led_clar if version == "v1_clarified" else led_raw
    if led is None:
        raise ValueError("项目尚无报价台账：请先在收集箱上传报价文件")
    if version == "v1_clarified" and led_clar is None:
        raise ValueError("尚无已应用事件，V1 澄清后版本未生成")
    note = ("台账版本：V1 原始（收集箱识别归集，异常线索最全）" if version == "v1_raw"
            else f"台账版本：V1 澄清后（已应用人工确认事件 {len(amendments)} 条，全程留痕见「操作记录」）")
    OUT.mkdir(parents=True, exist_ok=True)
    tpl = TEMPLATE if TEMPLATE.exists() else None
    return write_ledger(led, catalog, OUT / f"{pid}_比选台账_{VERSION_LABEL[version]}.xlsx",
                        _proj_rate_map(tax_profiles, amendments, clarified=(version == "v1_clarified")),
                        qualifiers=None, qty_map={i: c["qty"] for i, c in catalog.items()},
                        prev_totals=None, version_note=note, template_path=tpl,
                        issue_source=led_raw, invoice_status=_proj_invoice_status(tax_profiles, amendments))

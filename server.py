# -*- coding: utf-8 -*-
"""分包比选工作台 · 本地服务（app/server.py）

把 M1 税率与计算引擎（backend/engine，源自 fde-test-10-24 @ m1-engine）
和 M2 台账生成器（backend/report）接给前端：

  GET /                    静态前端（app/ 目录）
  GET /api/bootstrap       项目元数据 + 清单/供应商/事件/资格 + 回归自检结果
  GET /api/ledger/{stage}  三阶段台账（v1_raw / v1_clarified / v2），ledger_to_dict 同构
  GET /api/issues/{stage}  需补充事项（问题清单源自 V1 原始台账，闭环按当前版本求值）
  GET /api/export/{stage}  生成并下载该阶段 5-sheet 比选台账 xlsx（企业模板副本填写）
  GET /api/projects        运行时新建项目列表 + 下一个可用项目编号
  POST /api/projects       新建比选项目（name=项目名称, owner=项目负责人）
  GET /api/projects/{id}/board   项目工作台全量数据：清单+识别登记+双版本台账+事件+匹配报告
  GET /api/projects/{id}/export  按版本导出 5-sheet 台账 xlsx（?version=v1_raw|v1_clarified）
  POST /api/projects/{id}/attach         把已缓存的识别结果登记进项目（rec_id）
  POST /api/projects/{id}/events         登记事件候选（op/supplier/item/field/new/evidence）
  POST /api/projects/{id}/events/{eid}/apply    确认并应用事件（引擎试算，拒绝则回滚）
  POST /api/projects/{id}/events/{eid}/discard  作废待确认事件（不删除）
  POST /api/projects/{id}/status         项目状态流转（状态机 §6.1）
  （POST /api/recognize 支持 &project={id}：上传识别成功即登记进项目）

引擎金额计算零 LLM、全 Decimal（M1 设计红线）；服务仅用 Python 标准库 +
openpyxl（M2 写 xlsx），可离线内网运行。

运行：python server.py [--port 8080]
"""
import argparse
import json
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse, parse_qs

ROOT = Path(__file__).resolve().parent            # app/
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _load_env_file(path: Path) -> None:
    """把 .env（若存在）注入 os.environ：只补缺、不覆盖真实环境变量。

    维护约定：复制 .env.example 为同目录 .env 后填写（.gitignore 已排除，
    KEY 绝不入库）。支持 KEY=VALUE / export KEY=VALUE、单双引号值、
    未加引号值的行尾 # 注释；注释单独成行。"""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, eq, val = line.partition("=")
        key = key.strip()
        if not eq or not key:
            continue
        val = val.strip()
        if val[:1] in ("\"", "'") and len(val) >= 2:
            q = val[0]                       # 带引号：取成对引号内内容（引号后可跟行尾注释）
            end = val.find(q, 1)
            val = val[1:end] if end > 0 else val[1:]
        else:                                # 未加引号：去掉行尾注释
            val = val.split(" #", 1)[0].strip()
        if key not in os.environ and val:
            os.environ[key] = val


_load_env_file(ROOT / ".env")                   # 先于一切 env 读取（识别 KEY / 智慧报表）

from engine import load_all, ledger_to_dict        # noqa: E402
from engine.money import D                          # noqa: E402
from report import write_ledger                     # noqa: E402
from report.xlsx import _need_items                 # noqa: E402
from gen_workbooks import _rate_map, _invoice_status  # noqa: E402  上游 M5 动态口径帮助函数

# read-file 多格式识别模块（源自 fde-test-10-24 @ read-file 分支，扁平 import）
READFILE = BACKEND / "read-file"
sys.path.insert(0, str(READFILE))
try:
    import reader as file_reader          # noqa: E402
    import ocr_engines as ocr_engines_mod  # noqa: E402
except RuntimeError as exc:               # 识别 KEY 未配置：启动即报错退出，不静默降级
    print(f"启动失败：{exc}")
    sys.exit(1)

TEMPLATE = ROOT.parent / "04 报价各说各话，工程分包怎么比？" / "01 原始报价与清单" / "比选输出模板.xlsx"
OUT = BACKEND / "out"
INBOX = BACKEND / "inbox"                 # 上传原件落位区（只读，永不覆盖）
RECOG_DIR = OUT / "recognition"           # 识别结果缓存（JSON，可重放）
# 供应商清单完全由数据决定（5c5b8f5 动态供应商化），不写死
QUOTE_DATA = json.loads((BACKEND / "data" / "gc017_quotes.json").read_text("utf-8"))
SUPS = list(QUOTE_DATA["suppliers"].keys())

# ---------------------------------------------------------------- 新建比选项目
# 运行时项目存储与「识别 → 匹配 → 引擎计算」管线在 project_pipeline.py：
# 本文件只做路由；GC-017 为内置案例编号，新建项目从 GC-018 续号。
import project_pipeline as pp  # noqa: E402  运行时项目存储 + 识别记录装配引擎台账

# ---------------------------------------------------------------- 智慧报表（AI 对话分析）
# LLM 接入全部走环境变量（不写入代码/文件）：
#   AI_REPORT_API_KEY   必填，缺失则智慧报表整体离线（按钮置灰）
#   AI_REPORT_API_BASE  OpenAI 兼容端点，默认智谱 https://open.bigmodel.cn/api/paas/v4
#   AI_REPORT_MODEL     模型名，默认 glm-4.6
# 修改 env 后需重启 python server.py 生效。
import urllib.request  # noqa: E402
import urllib.error  # noqa: E402

AI_REPORT = {
    "key": os.environ.get("AI_REPORT_API_KEY", "").strip(),
    "base": os.environ.get("AI_REPORT_API_BASE", "https://open.bigmodel.cn/api/paas/v4").strip().rstrip("/"),
    "model": os.environ.get("AI_REPORT_MODEL", "glm-4.6").strip(),
}
AI_CTX_MAX = 60_000            # 注入上下文字符数上限（超出截断，防 token 爆炸）
AI_HISTORY_MAX = 10            # 随请求携带的对话历史条数上限

AI_SYSTEM_TEMPLATE = """你是「分包比选工作台」的智慧报表分析助手，服务商务人员的报价归集与比选核对。下面是当前项目 {proj_label} 的全部工作台数据（JSON）：

```json
{context}
```

你的职责：基于以上数据回答用户的提问——读取数据、总结数据、对比供应商、解释异常线索。金额与供应商判断必须来自数据本身，不得编造。

红线（必须遵守）：
- 未知值不当 0：「未报」「税率未给」是状态，不是 0，也不可折算含税；
- 异常只提示不改写：旗标是线索不是结论；
- 系统不推荐中标、不评分、不排名：不做任何倾向性商务建议；
- 引用金额时注明口径（未税/含税）与供应商。

输出约定：
- 用简体中文；结构化回答（小结/要点/表格）；
- 需要图表时，在回答中输出如下 JSON 代码块（前端会渲染为图表，data 不超过 12 项）：
```chart
{{"type": "bar 或 line", "title": "图表标题", "unit": "元", "data": [{{"label": "供应商或分项", "value": 123.45}}]}}
```"""

def ai_status_payload():
    masked = (AI_REPORT["key"][:4] + "…" + AI_REPORT["key"][-4:]) if len(AI_REPORT["key"]) >= 8 else ("已设置" if AI_REPORT["key"] else "")
    return {
        "available": bool(AI_REPORT["key"]),
        "base": AI_REPORT["base"],
        "model": AI_REPORT["model"],
        "key_masked": masked,
        "env_keys": ["AI_REPORT_API_KEY", "AI_REPORT_API_BASE", "AI_REPORT_MODEL"],
        "reason": "" if AI_REPORT["key"] else "未设置环境变量 AI_REPORT_API_KEY——设置后重启 python server.py 启用智慧报表",
    }

def _ai_project_context(proj) -> str:
    """项目工作台全量数据 → 紧凑 JSON 文本（LLM 上下文）。"""
    board = pp.build_board(proj)
    stages = board.get("ledgers") or {}
    ledgers_out = {}
    for stg, led in stages.items():
        rows_out = {}
        for item_id, per_sup in (led.get("rows") or {}).items():
            rows_out[item_id] = {
                sup: [{
                    "qty": c.get("qty"), "ws": c.get("ws"), "tax": c.get("tax"), "hs": c.get("hs"),
                    "stated": c.get("stated_amount"), "status": c.get("status"),
                    "flags": c.get("flags") or [], "basis": c.get("basis") or "",
                } for c in (lines or [])]
                for sup, lines in (per_sup or {}).items()
            }
        ledgers_out[stg] = {"totals": led.get("totals") or {}, "rows": rows_out,
                            "audit_n": len(led.get("audit") or [])}
    ctx = {
        "project": board.get("project"),
        "catalog": board.get("catalog"),
        "suppliers_order": board.get("suppliers_order"),
        "ledgers": ledgers_out,
        "events": board.get("events"),
        "match_report": board.get("match_report"),
        "counts": board.get("counts"),
        "files": [{"file": f.get("file"), "vendor": f.get("vendor"), "channel_desc": f.get("channel_desc")} for f in (board.get("files") or [])],
    }
    text = json.dumps(ctx, ensure_ascii=False, default=str)
    if len(text) > AI_CTX_MAX:
        text = text[:AI_CTX_MAX] + "…（数据过长已截断）"
    return text

def _ai_build_messages(question, history, ctx_text, proj_label):
    msgs = [{"role": "system", "content": AI_SYSTEM_TEMPLATE.format(proj_label=proj_label, context=ctx_text)}]
    for m in (history or [])[-AI_HISTORY_MAX:]:
        role, content = str(m.get("role") or ""), str(m.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content[:8000]})
    msgs.append({"role": "user", "content": question})
    return msgs

STAGES = {
    "v1_raw":       "V1 原始报价（澄清前）",
    "v1_clarified": "V1 澄清后（CLARIFY-01 已回填）",
    "v2":           "V2 变更后（CHANGE-01：C08 60→72根，V1基线保留）",
}

# 前端资产映射：数据 JSON 里的原件文件名 → 本地可回查的截图资产
ASSET_MAP = {
    "报价扫描-1.png": "data/assets/scan-bing-p1.png",
    "报价扫描-2.png": "data/assets/scan-bing-p2.png",
    "丙方扫描报价.pdf": "data/assets/scan-bing-p2.png",
    "丁方报价截图-1.png": "data/assets/chat-ding-quote.png",
    "丁方费用说明聊天.png": "data/assets/chat-ding-note.png",
}


def build_all():
    """三阶段台账一次构建（V1 原始 → V1 澄清后 → V2 变更后，互不污染）。"""
    ns = load_all(BACKEND / "data")
    b = ns.builder
    ch = ns.events["change"]
    ledgers = {
        "v1_raw": b.build(STAGES["v1_raw"]),
        "v1_clarified": b.build(STAGES["v1_clarified"], amendments=ns.events["clarify"]),
        "v2": b.build(STAGES["v2"], amendments=ns.events["clarify"],
                      qty_overrides=ch["qty_overrides"], qty_basis=ch["id"],
                      qty_at=ch["at"], qty_operator=ch["operator"]),
    }
    return ns, ledgers


NS, LEDGERS = build_all()
QUALIFIERS = json.loads((BACKEND / "data" / "gc017_qualifications.json").read_text("utf-8"))["rows"]


def regression_checks():
    """与 run_gc017.py 相同的 13 项底稿数字核对，启动即断言。"""
    v1, v1c, v2 = LEDGERS["v1_raw"], LEDGERS["v1_clarified"], LEDGERS["v2"]
    return [
        ("V1 甲含税合计 40,545.00，与列示一致", v1.totals["甲"]["hs"] == D("40545.00")),
        ("V1 乙未税明细加总 58,175.00 ≠ 列示 58,375.00 → 抓出合计误差 +200.00",
         v1.totals["乙"]["ws"] == D("58175.00") and any("+200.00" in f for f in v1.totals["乙"]["flags"])),
        ("V1 乙含税合计不可折算（税率未给，不当0）", v1.totals["乙"]["hs"] is None),
        ("V1 丙 C04 列示 2,181.80 比乘积 2,161.80 多 20.00 → 抓出抄写错误",
         any("+20.00" in f for f in v1.rows["C04"]["丙"][0].flags)),
        ("V1 丙合计 38,485.84（C04按乘积计；列示 38,505.84 → 合计旗标 +20.00；附件 3,392.00 未并入）",
         v1.totals["丙"]["hs"] == D("38485.84") and any("+20.00" in f for f in v1.totals["丙"]["flags"])),
        ("V1 丁合计 41,924.08（C04按16点、C14按1项原样计）", v1.totals["丁"]["hs"] == D("41924.08")),
        ("澄清后 乙 C07 只计一行；未税合计 62,747.00；含税合计 66,511.82",
         len(v1c.rows["C07"]["乙"]) == 1 and v1c.totals["乙"]["ws"] == D("62747.00")
         and v1c.totals["乙"]["hs"] == D("66511.82")),
        ("澄清后 丙 C13 并入 3,392.00（未税 3,200.00 + 税额 192.00）；合计 41,877.84",
         v1c.rows["C13"]["丙"][0].hs == D("3392.00") and v1c.totals["丙"]["hs"] == D("41877.84")),
        ("澄清后 丁 C04 改 18 点 = 2,182.68；C14 均分 771.68×4 台班总额 3,086.72 不变；合计 42,166.60",
         v1c.rows["C04"]["丁"][0].hs == D("2182.68") and v1c.rows["C14"]["丁"][0].hs == D("3086.72")
         and v1c.totals["丁"]["hs"] == D("42166.60")),
        ("V2 四家 C08 按 72 根重算：甲 6,487.20 / 乙 36,000.00(未税) / 丙 6,681.60 / 丁 6,746.40",
         v2.rows["C08"]["甲"][0].hs == D("6487.20") and v2.rows["C08"]["乙"][0].ws == D("36000.00")
         and v2.rows["C08"]["丙"][0].hs == D("6681.60") and v2.rows["C08"]["丁"][0].hs == D("6746.40")),
        ("V2 合计：甲 41,626.20 / 乙未税 68,747.00 / 丙 42,991.44 / 丁 43,291.00",
         v2.totals["甲"]["hs"] == D("41626.20") and v2.totals["乙"]["ws"] == D("68747.00")
         and v2.totals["丙"]["hs"] == D("42991.44") and v2.totals["丁"]["hs"] == D("43291.00")),
        ("V1 基线在构建 V2 后未被污染（原件永不覆盖）",
         v1.rows["C08"]["甲"][0].hs == D("5406.00") and v1c.rows["C08"]["甲"][0].hs == D("5406.00")),
        ("操作留痕：申报 3 条 + 澄清 8 条 + 变更 4 条 = 15 条，字段齐备", len(v2.audit) == 15),
    ]


def export_xlsx(stage: str) -> Path:
    """按 gen_workbooks.py 的参数把该阶段 Ledger 写成 5-sheet 台账 xlsx。

    rate_map / invoice_status 均用上游 M5 的动态口径（不写死供应商名）。"""
    catalog_qty = {i: c["qty"] for i, c in NS.catalog.items()}
    qty_v2 = {**catalog_qty, "C08": NS.catalog["C08"]["qty"] + 12}  # 60→72
    params = {
        "v1_raw": ("GC-017_比选台账_V1原始.xlsx", _rate_map(NS, False),
                   catalog_qty, None,
                   "台账版本：V1 原始（澄清前，异常线索最全；乙税率未声明，含税口径不可比）"),
        "v1_clarified": ("GC-017_比选台账_V1澄清后.xlsx", _rate_map(NS, True),
                         catalog_qty, None,
                         "台账版本：V1 澄清后（CLARIFY-01 已回填，全程留痕见「操作记录」）"),
        "v2": ("GC-017_比选台账_V2变更后.xlsx", _rate_map(NS, True),
               qty_v2, {s: LEDGERS["v1_clarified"].totals[s]["hs"] for s in LEDGERS["v1_clarified"].totals},
               "台账版本：V2 变更后（CHANGE-01：C08低应变 60根→72根，四家单价税率沿用；V1基线与V1澄清后台账另行保留）"),
    }
    fname, rate_map, qmap, prev, note = params[stage]
    tpl = TEMPLATE if TEMPLATE.exists() else None
    return write_ledger(LEDGERS[stage], NS.catalog, OUT / fname, rate_map,
                        qualifiers=QUALIFIERS, qty_map=qmap, prev_totals=prev,
                        version_note=note, template_path=tpl, issue_source=LEDGERS["v1_raw"],
                        invoice_status=_invoice_status(NS))


def recognition_queue():
    """识别待确认队列（M3/M4 接口位演示）：原始报价行中带 note 的行即为
    识别/核对层留给人工确认的疑点，字段与 gc017_quotes.json 同构。"""
    low_conf = ("C04", "C14")   # 抄写差错/口径疑点 → 低置信演示
    out = []
    for sup in SUPS:
        for ln in QUOTE_DATA["suppliers"][sup].get("lines", []):
            note = ln.get("note", "")
            if not note:
                continue
            src = ln.get("source", {})
            out.append({
                "supplier": sup, "item": ln["item"], "name": ln.get("name", ""),
                "note": note, "source": ln.get("source", ""),
                "asset": ASSET_MAP.get(Path(src.get("file", "")).name, ""),
                "conf": 0.62 if ln["item"] in low_conf and sup in ("丙", "丁") else 0.93,
            })
    return out


def bootstrap_payload():
    checks = [{"msg": m, "ok": ok} for m, ok in regression_checks()]
    suppliers = {}
    for sup, sj in QUOTE_DATA["suppliers"].items():
        suppliers[sup] = {
            "file": sj.get("file", ""), "version": sj.get("version", ""),
            "direction": sj.get("direction", ""), "tax": sj.get("tax", {}),
            "stated_total": sj.get("stated_total"), "stated_total_note": sj.get("stated_total_note", ""),
            "asset": ASSET_MAP.get(Path(sj.get("file", "")).name, ""),
        }
    return {
        "project": {"id": "GC-017", "name": "园区现场测量与检测",
                    "source": (BACKEND / "data" / "gc017_catalog.json").name,
                    "quote_date": QUOTE_DATA.get("quote_date", "")},
        "stages": [{"key": k, "label": v} for k, v in STAGES.items()],
        "catalog": json.loads((BACKEND / "data" / "gc017_catalog.json").read_text("utf-8")),
        "suppliers": suppliers,
        "suppliers_order": SUPS,
        "events": json.loads((BACKEND / "data" / "gc017_events.json").read_text("utf-8")),
        "qualifications": QUALIFIERS,
        "checks": checks,
        "asset_map": ASSET_MAP,
        "recognition_queue": recognition_queue(),
        "recognition_engines": recognition_engines(),
        "template_found": TEMPLATE.exists(),
        "engine": "M1 税率与计算引擎 + M5 区间校验（fde-test-10-24 @ m1-engine）· 金额计算零LLM · 全程Decimal",
    }


def issues_payload(stage: str):
    """需补充事项：问题清单固定源自 V1 原始台账（跨版本累计），闭环按当前版本求值；
    发票类型未说明事项随 invoice_status 立项（M5）。"""
    items = _need_items(LEDGERS["v1_raw"], QUALIFIERS, closure_led=LEDGERS[stage],
                        invoice_status=_invoice_status(NS))
    return [{"no": f"QB-{i:03d}", **it} for i, it in enumerate(items, 1)]


# ---------------------------------------------------------------- read-file 识别
def recognition_engines():
    """识别引擎链可用性（前端据此展示"第三方接口在线/离线"）。"""
    return [{"name": e.name, "available": e.available()} for e in ocr_engines_mod.DEFAULT_ENGINES]


def recognize_upload(filename: str, data: bytes) -> dict:
    """上传原件 → 只读落位 → read_file 识别 → 结果缓存 JSON（可重放）。

    两条红线：
    - 原件永不覆盖（规则第六条）：同名不同内容的文件加时间戳后缀另存；
    - 识别结果皆缓存、可重放（read-file 引擎链同哲学）：相同字节的文件直接
      回放缓存结果，不重复调用引擎——预转录库机制的自然延伸。
    """
    INBOX.mkdir(parents=True, exist_ok=True)
    RECOG_DIR.mkdir(parents=True, exist_ok=True)
    import hashlib
    file_md5 = hashlib.md5(data).hexdigest()

    for jf in RECOG_DIR.glob("*.json"):
        try:
            cached = json.loads(jf.read_text(encoding="utf-8"))
        except Exception:
            continue
        if cached.get("file_md5") == file_md5:
            cached["replayed"] = True
            cached["note"] = (cached.get("note", "") + "（识别缓存重放：相同文件不重复调用引擎）").strip("；")
            return cached

    safe = Path(filename).name or f"upload_{int(time.time())}.bin"
    stem, ext = Path(safe).stem, Path(safe).suffix
    saved = INBOX / safe                        # 首次上传保留原始文件名
    if saved.exists():                          # 同名不同内容 → 时间戳另存，绝不覆盖
        saved = INBOX / f"{stem}__{time.strftime('%Y%m%d__%H%M%S')}{ext}"
    saved.write_bytes(data)

    result = file_reader.read_file(saved)
    result["file"] = filename                   # 对外呈现原始文件名
    result["saved_as"] = saved.name
    result["ts"] = time.strftime("%Y-%m-%d %H:%M:%S")
    result["file_md5"] = file_md5
    result["id"] = saved.stem + f"__{int(time.time())}"
    cache = RECOG_DIR / f"{result['id']}.json"
    cache.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    return result


def recognition_list() -> list:
    """已缓存的识别结果（新→旧），供收集箱回放展示。"""
    if not RECOG_DIR.exists():
        return []
    out = []
    for jf in sorted(RECOG_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            out.append(json.loads(jf.read_text(encoding="utf-8")))
        except Exception:
            continue
    return out


MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
    ".otf": "font/otf", ".ttf": "font/ttf", ".ico": "image/x-icon",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        # 本地开发工具：静态页与接口一律禁缓存，避免浏览器用旧 CSS/JS 渲染
        # （_json/_file 已显式带 no-store，重复的 Cache-Control 指令按最强语义生效）
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):  # 静默访问日志，只保留启动与错误信息
        pass

    # ------------------------------------------------------------ helpers
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, inline: bool = False):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(path.suffix.lower(),
                          "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        fname = quote(path.name)
        self.send_header("Content-Disposition",
                         f"{"inline" if inline else "attachment"}; filename*=UTF-8''{fname}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---------------------------------------------------- 智慧报表：LLM SSE 代理
    def _ai_report_stream(self, pid: str):
        """POST /api/projects/{id}/ai-report　body = {"question", "history": [...]}。
        上游 OpenAI 兼容接口流式转发为 SSE：data:{"delta"| "error"| "done"}。"""
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._json({"error": "请求体不是合法的 UTF-8 JSON"}, 400)
        question = str(body.get("question") or "").strip()
        if not question:
            return self._json({"error": "提问内容不能为空"}, 400)
        if len(question) > 4000:
            return self._json({"error": "提问过长（上限 4000 字）"}, 400)
        if not AI_REPORT["key"]:
            return self._json({"error": "未设置环境变量 AI_REPORT_API_KEY，智慧报表不可用"}, 503)
        proj = pp.find_project(pp.load_projects(), pid)
        if proj is None:
            return self._json({"error": f"项目 {pid} 不存在"}, 404)
        proj_label = f"{proj['id']} · {proj['name']}"
        messages = _ai_build_messages(question, body.get("history"), _ai_project_context(proj), proj_label)

        payload = json.dumps({
            "model": AI_REPORT["model"],
            "messages": messages,
            "stream": True,
            "temperature": 0.3,
        }, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            AI_REPORT["base"] + "/chat/completions", data=payload, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {AI_REPORT['key']}",
                     "Accept": "text/event-stream"})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        def emit(obj):
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                emit({"open": True, "model": AI_REPORT["model"]})
                for raw in resp:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    delta = ((chunk.get("choices") or [{}])[0].get("delta") or {})
                    text = delta.get("content") or ""
                    if text:
                        emit({"delta": text})
            emit({"done": True})
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:500]
            except Exception:
                pass
            emit({"error": f"模型接口返回 HTTP {exc.code}：{detail or exc.reason}"})
            emit({"done": True})
        except Exception as exc:
            emit({"error": f"模型接口调用失败：{exc}"})
            emit({"done": True})

    # ------------------------------------------------------------ routing
    def _project_event_route(self, pid: str, action: str, eid):
        """POST 项目事件：登记（add）/ 确认应用（apply）/ 作废（discard）。"""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                return self._json({"error": "请求体不是合法的 UTF-8 JSON"}, 400)
            if action == "add":
                return self._json({"event": pp.add_event(pid, body if isinstance(body, dict) else {})}, 201)
            if action == "apply":
                return self._json({"event": pp.apply_event(pid, eid)})
            return self._json({"event": pp.discard_event(pid, eid)})
        except KeyError as exc:
            return self._json({"error": f"不存在：{exc}"}, 404)
        except ValueError as exc:
            return self._json({"error": str(exc)}, 400)

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/api/bootstrap":
                return self._json(bootstrap_payload())
            if path.startswith("/api/ledger/"):
                stage = path.rsplit("/", 1)[-1]
                if stage not in LEDGERS:
                    return self._json({"error": f"未知阶段 {stage}"}, 404)
                return self._json(ledger_to_dict(LEDGERS[stage]))
            if path.startswith("/api/issues/"):
                stage = path.rsplit("/", 1)[-1]
                if stage not in LEDGERS:
                    return self._json({"error": f"未知阶段 {stage}"}, 404)
                return self._json(issues_payload(stage))
            if path.startswith("/api/export/"):
                stage = path.rsplit("/", 1)[-1]
                if stage not in LEDGERS:
                    return self._json({"error": f"未知阶段 {stage}"}, 404)
                return self._file(export_xlsx(stage))
            if path == "/api/recognition":
                return self._json({"engines": recognition_engines(), "results": recognition_list()})
            if path.startswith("/api/files/"):
                raw = unquote(path[len("/api/files/"):]).replace("\\", "/")
                safe = Path(raw).name
                if not safe or safe.startswith("."):
                    return self._json({"error": "无效文件名"}, 400)
                cand = INBOX / safe
                if not cand.is_file():
                    stem, suf = Path(safe).stem, Path(safe).suffix
                    variants = sorted(INBOX.glob(f"{stem}__*{suf}"), key=lambda q: q.stat().st_mtime)
                    cand = variants[-1] if variants else None
                if not cand or not cand.is_file():
                    return self._json({"error": f"原件不存在：{safe}"}, 404)
                return self._file(cand, inline=True)
            if path == "/api/ai/status":
                return self._json(ai_status_payload())
            if path == "/api/projects":
                projects = [dict(p, summary=pp.project_summary(p)) for p in pp.load_projects()]
                return self._json({"projects": projects, "next_id": pp.next_project_id(projects)})
            if path.startswith("/api/projects/"):
                pid, _, sub = path[len("/api/projects/"):].partition("/")
                if sub == "board":
                    proj = pp.find_project(pp.load_projects(), pid)
                    if proj is None:
                        return self._json({"error": f"项目 {pid} 不存在"}, 404)
                    return self._json(pp.build_board(proj))
                if sub == "export":
                    qs = parse_qs(urlparse(self.path).query)
                    version = (qs.get("version") or ["v1_raw"])[0]
                    try:
                        f = pp.export_project(pid, version)
                    except KeyError:
                        return self._json({"error": f"项目 {pid} 不存在"}, 404)
                    except ValueError as exc:
                        return self._json({"error": str(exc)}, 400)
                    return self._file(f)
                return self._json({"error": "unknown api"}, 404)
            if path.startswith("/api/"):
                return self._json({"error": "unknown api"}, 404)
            if path in ("/", "/index.html") :
                return super().do_GET()
            return super().do_GET()
        except BrokenPipeError:
            pass
        except Exception as exc:  # 服务不静默吞错：接口异常原样返回，便于排查
            self.log_error("500 on %s: %r", path, exc)
            try:
                self._json({"error": repr(exc)}, 500)
            except Exception:
                pass

    def do_POST(self):
        """POST /api/recognize?filename=<原始文件名>　body = 文件原始字节。
        POST /api/projects　body = {"name": 项目名称, "owner": 项目负责人,
        "created_at"?: "YYYY-MM-DD[ HH:MM[:SS]]"} JSON（created_at 为界面「项目时间」，缺省取当前时刻）。

        recognize 不用 multipart：本地工具直传字节流最简，前端 fetch(file) 即可。"""
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/api/projects":
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > 64 * 1024:
                    return self._json({"error": f"请求体大小不合法（{length} 字节，上限 64KB）"}, 400)
                try:
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    return self._json({"error": "请求体不是合法的 UTF-8 JSON"}, 400)
                if not isinstance(body, dict):
                    return self._json({"error": "请求体应为 JSON 对象"}, 400)
                name, owner = body.get("name"), body.get("owner")
                if not isinstance(name, str) or not isinstance(owner, str):
                    return self._json({"error": "项目名称与项目负责人须为字符串"}, 400)
                name, owner = name.strip(), owner.strip()
                if not name or not owner:
                    return self._json({"error": "项目名称与项目负责人均为必填"}, 400)
                if len(name) > 60 or len(owner) > 30:
                    return self._json({"error": "项目名称不超过 60 字、项目负责人不超过 30 字"}, 400)
                created_at = body.get("created_at")
                if created_at is not None and not isinstance(created_at, str):
                    return self._json({"error": "项目时间须为字符串（YYYY-MM-DD 或 YYYY-MM-DD HH:MM[:SS]）"}, 400)
                try:
                    proj = pp.create_project(name, owner, created_at=(created_at or "").strip() or None)
                except ValueError as exc:
                    return self._json({"error": str(exc)}, 400)
                return self._json(proj, 201)
            if path.startswith("/api/projects/"):
                rest = path[len("/api/projects/"):]
                pid, _, sub = rest.partition("/")
                if sub == "attach":
                    length = int(self.headers.get("Content-Length") or 0)
                    try:
                        body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        return self._json({"error": "请求体不是合法的 UTF-8 JSON"}, 400)
                    rec_id = str(body.get("rec_id") or "")
                    if not rec_id:
                        return self._json({"error": "rec_id 必填（收集箱识别结果 id）"}, 400)
                    try:
                        proj = pp.attach_recognition(pid, rec_id)
                    except KeyError:
                        return self._json({"error": f"项目 {pid} 不存在"}, 404)
                    except ValueError as exc:
                        return self._json({"error": str(exc)}, 404)
                    return self._json(proj)
                if sub == "events":
                    return self._project_event_route(pid, "add", None)
                parts = rest.split("/")
                if len(parts) == 4 and parts[1] == "events" and parts[3] in ("apply", "discard"):
                    return self._project_event_route(pid, parts[3], parts[2])
                if sub == "status":
                    length = int(self.headers.get("Content-Length") or 0)
                    try:
                        body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        return self._json({"error": "请求体不是合法的 UTF-8 JSON"}, 400)
                    try:
                        return self._json(pp.set_status(pid, str(body.get("status") or "")))
                    except KeyError:
                        return self._json({"error": f"项目 {pid} 不存在"}, 404)
                    except ValueError as exc:
                        return self._json({"error": str(exc)}, 400)
                if sub == "ai-report":
                    return self._ai_report_stream(pid)
                return self._json({"error": "unknown api"}, 404)
            if path != "/api/recognize":
                return self._json({"error": "unknown api"}, 404)
            qs = parse_qs(urlparse(self.path).query)
            filename = (qs.get("filename") or [""])[0]
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 50 * 1024 * 1024:
                return self._json({"error": f"文件大小不合法（{length} 字节，上限 50MB）"}, 400)
            data = self.rfile.read(length)
            result = recognize_upload(filename, data)
            pid = (qs.get("project") or [""])[0]
            if pid:
                try:
                    pp.attach_recognition(pid, result.get("id", ""))
                    result["project"] = pid
                except (KeyError, ValueError) as exc:
                    return self._json({"error": f"识别成功但登记项目失败：{exc}"}, 404)
            return self._json(result)
        except BrokenPipeError:
            pass
        except Exception as exc:
            self.log_error("500 on %s: %r", path, exc)
            try:
                self._json({"error": repr(exc)}, 500)
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser(description="分包比选工作台本地服务")
    ap.add_argument("--port", type=int, default=8080)
    args = ap.parse_args()

    checks = regression_checks()
    failed = [m for m, ok in checks if not ok]
    print("=" * 64)
    print("分包比选工作台 · M1 引擎 + M2 台账导出 · 本地服务")
    print("=" * 64)
    print(f"启动自检：{len(checks) - len(failed)}/{len(checks)} 项回归通过")
    for m in failed:
        print(f"  ✗ FAIL  {m}")
    print(f"企业模板：{'已找到，导出时在其副本上填写' if TEMPLATE.exists() else '未找到，按模板表头新建'}")

    port, srv = args.port, None
    for _ in range(5):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            print(f"端口 {port} 被占用，改用 {port + 1}")
            port += 1
    if srv is None:
        print("无法绑定端口，退出")
        return 1
    print(f"打开 http://127.0.0.1:{port}  （Ctrl+C 停止）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())

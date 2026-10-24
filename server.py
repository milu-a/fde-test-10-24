# -*- coding: utf-8 -*-
"""分包比选工作台 · 本地服务（app/server.py）

把 M1 税率与计算引擎（backend/engine，源自 fde-test-10-24 @ m1-engine）
和 M2 台账生成器（backend/report）接给前端：

  GET /                    静态前端（app/ 目录）
  GET /api/bootstrap       项目元数据 + 清单/供应商/事件/资格 + 回归自检结果
  GET /api/ledger/{stage}  三阶段台账（v1_raw / v1_clarified / v2），ledger_to_dict 同构
  GET /api/issues/{stage}  需补充事项（问题清单源自 V1 原始台账，闭环按当前版本求值）
  GET /api/export/{stage}  生成并下载该阶段 5-sheet 比选台账 xlsx（企业模板副本填写）

引擎金额计算零 LLM、全 Decimal（M1 设计红线）；服务仅用 Python 标准库 +
openpyxl（M2 写 xlsx），可离线内网运行。

运行：python server.py [--port 8080]
"""
import argparse
import json
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

from engine import load_all, ledger_to_dict        # noqa: E402
from engine.money import D                          # noqa: E402
from report import write_ledger                     # noqa: E402
from report.xlsx import _need_items                 # noqa: E402
from gen_workbooks import _rate_map, _invoice_status  # noqa: E402  上游 M5 动态口径帮助函数

# read-file 多格式识别模块（源自 fde-test-10-24 @ read-file 分支，扁平 import）
READFILE = BACKEND / "read-file"
sys.path.insert(0, str(READFILE))
import reader as file_reader          # noqa: E402
import ocr_engines as ocr_engines_mod  # noqa: E402

TEMPLATE = ROOT.parent / "04 报价各说各话，工程分包怎么比？" / "01 原始报价与清单" / "比选输出模板.xlsx"
OUT = BACKEND / "out"
INBOX = BACKEND / "inbox"                 # 上传原件落位区（只读，永不覆盖）
RECOG_DIR = OUT / "recognition"           # 识别结果缓存（JSON，可重放）
# 供应商清单完全由数据决定（5c5b8f5 动态供应商化），不写死
QUOTE_DATA = json.loads((BACKEND / "data" / "gc017_quotes.json").read_text("utf-8"))
SUPS = list(QUOTE_DATA["suppliers"].keys())

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

    def _file(self, path: Path):
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(path.suffix.lower(),
                          "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        fname = quote(path.name)
        self.send_header("Content-Disposition",
                         f"attachment; filename*=UTF-8''{fname}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------ routing
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

        不用 multipart：本地工具直传字节流最简，前端 fetch(file) 即可。"""
        path = unquote(urlparse(self.path).path)
        try:
            if path != "/api/recognize":
                return self._json({"error": "unknown api"}, 404)
            qs = parse_qs(urlparse(self.path).query)
            filename = (qs.get("filename") or [""])[0]
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 50 * 1024 * 1024:
                return self._json({"error": f"文件大小不合法（{length} 字节，上限 50MB）"}, 400)
            data = self.rfile.read(length)
            result = recognize_upload(filename, data)
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

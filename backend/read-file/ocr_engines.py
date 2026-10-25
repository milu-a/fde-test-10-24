#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
【模型】OCR 引擎（可插拔）
==========================
扫描件/截图里"只有像素没有字"，必须有识别模型。引擎按顺序尝试：

  PaddleEngine   本地 PaddleOCR（生产方案：离线、免费、真识别）
                 未安装时自动跳过，并给出安装提示
  LibraryEngine  预转录库（演示用：按文件名匹配 transcripts/*.json）
                 仅用于演示环境，生产环境应移除

引擎契约：available() → bool；recognize(path) →
  {"kind": "structured", "data": [...]}   已结构化（预转录库）
  {"kind": "text_lines", "lines": [...]}  仅认出文字行（PaddleOCR），
                                          结构化交给 code_readers.structure_text_document
  None                                    本引擎处理不了该文件
"""
import json
import os
import re
from pathlib import Path

TRANSCRIPTS_DIR = Path(__file__).parent / "transcripts"


def load_api_config() -> dict:
    """API引擎配置：只读环境变量 ZHIPU_API_KEY，未配置直接抛错（fail fast）。

    KEY 一律不进代码、不落文件。引擎链在进程启动时构建，缺 KEY 会在
    python server.py 启动阶段即报错暴露，而不是上传图片时才静默降级。"""
    import os
    key = (os.environ.get("ZHIPU_API_KEY") or "").strip()
    if not key or "粘贴" in key or "PASTE" in key.upper():
        # "粘贴"防护：防止把 .env.example 的占位符原样复制进 .env 后误启动
        raise RuntimeError(
            "未配置环境变量 ZHIPU_API_KEY：云端视觉识别引擎无法初始化。"
            "请复制 app/.env.example 为 app/.env 并填入智谱 API KEY（或自行 set ZHIPU_API_KEY），"
            "然后重新启动 python server.py。")
    return {"provider": "zhipu", "model": "glm-5.3-flash", "protocol": "anthropic",
            "base_url": "https://open.bigmodel.cn/api/anthropic/v1/messages",
            "api_key": key}


class ApiEngine:
    """云端视觉大模型（智谱，凭API KEY调用）。支持两种协议：
    protocol=anthropic → 编程套餐通道（如 glm-5.3-flash，订阅额度内识图）
    protocol=v4         → 开放平台按量通道（如 glm-4v-flash 免费视觉档）
    适合：脱敏演示、快速试点；真实报价生产环境请改用本地引擎（内网红线）。"""

    def __init__(self, config=None):
        self.cfg = config or load_api_config()

    @property
    def name(self):
        return f"云端视觉模型API（{self.cfg.get('model')}·{self.cfg.get('protocol', 'v4')}）"

    def available(self) -> bool:
        return bool(self.cfg.get("api_key", ""))

    @property
    def install_hint(self):
        return "云端视觉引擎不可用：未配置环境变量 ZHIPU_API_KEY（设置后重启 python server.py）"

    _PROMPT = (
        "你是工程报价单识别助手。请把图片内容精确转录为JSON（只输出JSON，不要解释，不要markdown代码块）。"
        '若图片是报价表，输出：{"quote_version":"版本号或空","price_basis":"含税/未税/未声明",'
        '"tax_rate":0.06或null,"basis_note":"口径依据原话","rows":[{"code":"C01","name":"名称",'
        '"unit":"单位","qty":12,"price":123.45,"amount":2345.67}],"totals":{"label":"合计","amount":12345.67}}。'
        "要求：rows逐行对应图中分项行，数字必须与图片完全一致，禁止推算或补全；"
        "看不清或缺失的字段填null并在该行加\"note\":\"说明\"；同一编码出现多次就输出多行；没有合计就省略totals。"
        "若图片是报价附件或补充说明页（如'机械进出场另列一项：含税3392.00元'），把其中费用条目输出为rows，"
        "编码不确定时code填null（例如 name='机械进出场',qty=1,price=3392.00,amount=3392.00,note='附件说明页'）。"
        '仅当图片确实是聊天/即时通讯记录时才输出：{"chat":true,"messages":[{"time":"","from":"","text":"原文"}],'
        '"parse_flags":["发现的口径或费用疑点"]}'
    )

    @staticmethod
    def _image_data_url(path: Path) -> str:
        import base64
        import io
        from PIL import Image
        im = Image.open(path)
        if max(im.size) > 1600:  # 控制token：长边压到1600px
            im.thumbnail((1600, 1600))
        buf = io.BytesIO()
        im.convert("RGB").save(buf, format="JPEG", quality=92)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    def recognize(self, path: Path):
        if not self.available():
            return None
        import requests
        protocol = self.cfg.get("protocol", "v4")
        image_url = self._image_data_url(path)

        def call(extra=""):
            prompt = self._PROMPT + extra
            if protocol == "anthropic":
                media, b64 = image_url.split(",", 1)
                media_type = media.split(":")[1].split(";")[0]
                payload = {
                    "model": self.cfg["model"], "max_tokens": 4096,
                    "messages": [{"role": "user", "content": [
                        {"type": "image", "source": {"type": "base64",
                                                     "media_type": media_type, "data": b64}},
                        {"type": "text", "text": prompt}]}],
                }
                headers = {"x-api-key": self.cfg["api_key"],
                           "anthropic-version": "2023-06-01",
                           "content-type": "application/json"}
            else:
                payload = {
                    "model": self.cfg["model"], "temperature": 0.1,
                    "messages": [{"role": "user", "content": [
                        {"type": "image_url", "image_url": {"url": image_url}},
                        {"type": "text", "text": prompt}]}],
                }
                headers = {"Authorization": f"Bearer {self.cfg['api_key']}",
                           "Content-Type": "application/json"}
            resp = requests.post(self.cfg["base_url"], json=payload, headers=headers, timeout=180)
            resp.raise_for_status()
            j = resp.json()
            if protocol == "anthropic":
                return "\n".join(b.get("text", "") for b in j.get("content", [])
                                 if b.get("type") == "text").strip()
            return j["choices"][0]["message"]["content"].strip()

        def parse(text):
            text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
            try:
                return json.loads(text)
            except Exception:
                pass
            m = re.search(r"\{.*\}", text, re.S)
            if m:
                try:
                    return json.loads(m.group(0))
                except Exception:
                    pass
            # 修复模型偶发的重复起始{ / 结尾}（如 "{\n{...}\n}"）
            t = text.strip()
            n_lead = len(t) - len(t.lstrip("{"))
            n_tail = len(t) - len(t.rstrip("}"))
            if n_lead >= 1 and n_tail >= 1:
                for cut in range(1, min(n_lead, n_tail) + 1):
                    try:
                        return json.loads(t[cut: len(t) - cut])
                    except Exception:
                        continue
            return None

        try:
            data = parse(call())
            if data is None:  # 免费档偶发不合法JSON：带强提醒重试一次
                data = parse(call("（注意：上一次输出无法解析为JSON，本次必须只输出一个JSON对象，"
                                  "不要任何解释、markdown或多余文字；parse_flags要写具体疑点，不得照抄示例文字。）"))
        except Exception as e:
            return None if "401" in str(e) else {"kind": "error", "message": f"API调用失败：{e}"}
        if data is None:
            return {"kind": "error", "message": "API返回JSON解析失败（已重试）"}
        if data.get("chat"):
            return {"kind": "structured",
                    "data": [{"messages": data["messages"], "parse_flags": data.get("parse_flags", []),
                              "quote_version": "", "source_file": path.name}]}
        data.setdefault("rows", [])
        data["source_file"] = path.name
        return {"kind": "structured", "data": [data]}


class PaddleEngine:
    """本地 PaddleOCR（开源、离线、装完免费用）。安装：
    pip install paddlepaddle paddleocr
    装好后本引擎自动生效，无需改代码。兼容 PaddleOCR 2.x 与 3.x 接口。"""
    name = "PaddleOCR（本地模型，离线）"

    def __init__(self):
        self._ocr = None
        try:
            from paddleocr import PaddleOCR  # noqa: F401
            self._available = True
        except Exception:
            self._available = False

    def available(self) -> bool:
        return self._available

    @property
    def install_hint(self):
        return "未安装PaddleOCR。安装后自动启用：pip install paddlepaddle paddleocr（离线运行，永久免费）"

    def _init_ocr(self):
        from paddleocr import PaddleOCR
        try:
            self._ocr = PaddleOCR(use_angle_cls=True, lang="ch", show_log=False)  # 2.x
        except TypeError:
            self._ocr = PaddleOCR(lang="ch")  # 3.x

    @staticmethod
    def _group_lines(boxes):
        """boxes: [(x0,y0,x1,y1,text)] → 按视觉行聚类、行内从左到右拼接为整行文本。"""
        boxes = sorted(boxes, key=lambda b: (b[1], b[0]))
        lines = []  # 每项: {"y0","y1","items":[box]}
        for b in boxes:
            x0, y0, x1, y1, text = b
            h = max(y1 - y0, 1)
            for ln in lines:
                ov = min(ln["y1"], y1) - max(ln["y0"], y0)
                if ov > 0.45 * min(h, ln["y1"] - ln["y0"]):  # 垂直重叠过半视为同一行
                    ln["items"].append(b)
                    ln["y0"], ln["y1"] = min(ln["y0"], y0), max(ln["y1"], y1)
                    break
            else:
                lines.append({"y0": y0, "y1": y1, "items": [b]})
        out = []
        for ln in sorted(lines, key=lambda l: l["y0"]):
            texts = [t for *_, t in sorted(ln["items"], key=lambda b: b[0])]
            if texts:
                out.append(" ".join(texts))
        return out

    def recognize(self, path: Path):
        if not self._available:
            return None
        if self._ocr is None:
            self._init_ocr()
        boxes = []
        # 3.x：predict() → OCRResult（dict式），含 rec_texts/rec_polys
        if hasattr(self._ocr, "predict"):
            try:
                for res in self._ocr.predict(str(path)):
                    texts = res.get("rec_texts", []) if hasattr(res, "get") else []
                    polys = res.get("rec_polys", []) if hasattr(res, "get") else []
                    for text, poly in zip(texts, polys):
                        try:
                            xs = [p[0] for p in poly]
                            ys = [p[1] for p in poly]
                            boxes.append((min(xs), min(ys), max(xs), max(ys), text))
                        except Exception:
                            continue
                if boxes:
                    return {"kind": "text_lines", "lines": self._group_lines(boxes)}
            except Exception:
                boxes = []
        # 2.x：ocr() → [[ [box], (text, conf) ], ...]
        try:
            result = self._ocr.ocr(str(path), cls=True)
            for page in result or []:
                for item in page or []:
                    try:
                        box, (text, conf) = item[0], item[1]
                        xs = [p[0] for p in box]
                        ys = [p[1] for p in box]
                        boxes.append((min(xs), min(ys), max(xs), max(ys), text))
                    except Exception:
                        continue
        except Exception:
            return None
        if not boxes:
            return None
        return {"kind": "text_lines", "lines": self._group_lines(boxes)}


class LibraryEngine:
    """预转录库（演示）：按文件名匹配 transcripts/*.json。
    注意：按文件名匹配是演示手段，生产环境用PaddleOCR读内容后应移除本引擎。"""
    name = "预转录库（演示，按文件名匹配）"
    accepts_pdf = True  # 按文件名匹配，可直接接受PDF路径

    def available(self) -> bool:
        return TRANSCRIPTS_DIR.exists()

    def recognize(self, path: Path):
        hits = []
        # 同名另存的时间戳后缀（__YYYYMMDD__HHMMSS）不参与匹配——重传应命中同一条预转录
        stem = re.sub(r"__\d{8}__\d{6}$", "", path.stem)
        name = stem + path.suffix
        for jf in TRANSCRIPTS_DIR.glob("*.json"):
            try:
                data = json.loads(jf.read_text(encoding="utf-8"))
            except Exception:
                continue
            src = data.get("source_file", "")
            if name in src or stem in src:
                hits.append(data)
        if not hits:
            return None
        return {"kind": "structured", "data": hits}


def _build_default_engines():
    """引擎链：主API（套餐通道glm-5.3-flash）→ 备用API（免费glm-4v-flash）→ 本地Paddle → 预转录库。

    KEY 只读环境变量 ZHIPU_API_KEY；缺失时云端引擎仍在链上但 available()=False（UI 显示 ○ + install_hint），服务照常启动——不静默（启动警告）、不阻断离线演示。"""
    key = (os.environ.get("ZHIPU_API_KEY") or "").strip()
    if not key:
        print("警告：未配置环境变量 ZHIPU_API_KEY——云端视觉识别引擎不可用（○），"
              "扫描件/截图将转人工或失败；Excel/PDF 文字层与预转录重放不受影响。"
              "配置方法：复制 app/.env.example 为 app/.env 并填入智谱 API KEY，然后重启 python server.py。")
    engines = [
        ApiEngine({  # 主力：编程套餐通道（订阅额度识图）
            "provider": "zhipu", "model": "glm-5.3-flash", "protocol": "anthropic",
            "base_url": "https://open.bigmodel.cn/api/anthropic/v1/messages",
            "api_key": key}),
        ApiEngine({  # 备用：开放平台免费视觉档
            "provider": "zhipu", "model": "glm-4v-flash", "protocol": "v4",
            "base_url": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            "api_key": key}),
    ]
    engines.append(PaddleEngine())
    engines.append(LibraryEngine())
    return engines


DEFAULT_ENGINES = _build_default_engines()


def records_from_structured(hits: list, src_label: str):
    """预转录库的JSON → 记录（含人工核验过的行级数据）。"""
    import code_readers as cr
    records, notes = [], []
    for data in hits:
        if "messages" in data:  # 聊天/说明类
            msgs = "；".join(f"{m.get('time', '')} {m.get('from', '')}：{m['text']}"
                            for m in data["messages"])
            flags = "；".join(data.get("parse_flags", []))
            records.append(cr._rec({
                "行类型": "说明", "原始分项名称": "费用说明（聊天截图）",
                "待人工标记": flags, "备注": msgs, "置信度": "中",
                "出处-文件": src_label, "出处-定位": "聊天记录全文"}))
            notes.append("说明记录1条")
            continue
        basis = data.get("price_basis", "未声明")
        tax = data.get("tax_rate")
        tax_disp = f"{float(tax):.0%}" if isinstance(tax, (int, float)) else "未给"
        tax_src = data.get("basis_note", "")
        ver = data.get("quote_version", "")
        n = 0
        for r in data.get("rows", []):
            n += 1
            code = r.get("code") or ""
            records.append(cr._rec({
                "行类型": "分项", "原始编码": code, "原始分项名称": r.get("name", ""),
                "单位": r.get("unit", ""), "数量": r.get("qty"), "单价": r.get("price"),
                "单价口径": basis, "税率": tax_disp, "税率依据": tax_src,
                "原报金额": r.get("amount"), "置信度": "中",
                "待人工标记": "OCR数字待人工抽检" if r.get("need_check") else "",
                "出处-文件": src_label,
                "出处-定位": f"条目{code}" if code else "附件行（编码待对齐层匹配）",
                "备注": (r.get("note", "") or "OCR转录，建议人工抽检") +
                        (f"；版本{ver}" if ver else "")}))
        totals = data.get("totals") or {}
        if totals.get("amount") is not None:
            records.append(cr._rec({
                "行类型": "合计", "原始分项名称": totals.get("label", "合计"),
                "单价口径": basis, "税率": tax_disp, "税率依据": tax_src,
                "原报金额": totals["amount"], "置信度": "中",
                "备注": totals.get("note", ""), "出处-文件": src_label,
                "出处-定位": "表尾合计行"}))
        records.append(cr._rec({
            "行类型": "说明", "原始分项名称": "报价说明", "单价口径": basis,
            "税率": tax_disp, "税率依据": tax_src, "备注": tax_src, "置信度": "中",
            "出处-文件": src_label, "出处-定位": "页首说明"}))
        notes.append(f"分项{n}行")
    return records, "；".join(notes)


def guess_vendor(filename: str) -> str:
    m = re.search(r"([甲乙丙丁戊己庚辛壬癸A-Za-z]{1,3})方", Path(filename).stem)
    return m.group(1) if m else Path(filename).stem[:4]

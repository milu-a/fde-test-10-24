#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
【模型】读取器 —— 扫描PDF与图片
================================
原理：这两类文件只有像素。流程分两步，职责分明：
  第一步（模型）：像素 → 文字行/结构   ← 由 ocr_engines 里的模型引擎完成
  第二步（代码）：文字行 → 结构化记录 ← 由 code_readers.structure_text_document 完成
即"认字靠模型，整理靠代码"。
"""
from pathlib import Path

import code_readers as cr
from ocr_engines import DEFAULT_ENGINES, records_from_structured


def _try_engines(path: Path, engines):
    """依次尝试引擎。返回 (engine, result) 或 (None, 原因说明)。"""
    hints = []
    for eng in engines:
        if not eng.available():
            hint = getattr(eng, "install_hint", f"引擎 {eng.name} 不可用")
            hints.append(hint)
            continue
        try:
            result = eng.recognize(path)
        except Exception as e:
            hints.append(f"{eng.name}：异常 {e}")
            continue
        if result and result.get("kind") == "error":
            hints.append(f"{eng.name}：{result.get('message', '调用失败')}")
            continue
        if result:
            return eng, result
    return None, "；".join(hints) if hints else "所有引擎均未匹配该文件"


def read_image(path: Path, engines=None):
    """图片（截图/扫描图）→ 模型识别。"""
    engines = engines or DEFAULT_ENGINES
    eng, result = _try_engines(path, engines)
    if eng is None:
        return None, result
    if result["kind"] == "structured":
        records, note = records_from_structured(result["data"], path.name)
        return records, f"模型通道·{eng.name}：{note}"
    records, note = cr.structure_text_document(result["lines"], path.name)
    return records, f"模型通道·{eng.name}（像素→文字行，纯代码结构化）：{note}"


def read_scanned_pdf(path: Path, engines=None):
    """扫描版PDF：按页渲染成图片（临时目录，不动原件）→ 模型逐页识别 → 合并。
    接受PDF文件名的引擎（预转录库）直接匹配；图像类引擎逐页调用。"""
    import tempfile

    import pdfplumber
    engines = engines or DEFAULT_ENGINES
    hints = []
    page_imgs = None

    def render():
        nonlocal page_imgs
        if page_imgs is None:
            tmpdir = tempfile.mkdtemp(prefix="pdfpages_")
            out = []
            with pdfplumber.open(path) as pdf:
                for i, page in enumerate(pdf.pages, 1):
                    img_path = Path(tmpdir) / f"page_{i}.png"
                    page.to_image(resolution=200).original.save(img_path)
                    out.append(img_path)
            page_imgs = out
        return page_imgs

    for eng in engines:
        if not eng.available():
            hints.append(getattr(eng, "install_hint", f"引擎 {eng.name} 不可用"))
            continue
        try:
            if getattr(eng, "accepts_pdf", False):
                result = eng.recognize(path)
                if result and result.get("kind") != "error":
                    if result["kind"] == "structured":
                        records, note = records_from_structured(result["data"], path.name)
                        return records, f"模型通道·{eng.name}：{note}"
                    records, note = cr.structure_text_document(result["lines"], path.name)
                    return records, f"模型通道·{eng.name}：{note}"
                if result:
                    hints.append(f"{eng.name}：{result.get('message', '失败')}")
                continue
            # 图像类引擎：逐页识别后合并
            datas, lines, failed = [], [], None
            for img in render():
                r = eng.recognize(img)
                if not r:
                    failed = "空结果"
                    break
                if r.get("kind") == "error":
                    failed = r.get("message", "失败")
                    break
                if r["kind"] == "structured":
                    datas += r["data"]
                else:
                    lines += r["lines"]
            if failed:
                hints.append(f"{eng.name}：{failed}")
                continue
            if datas:
                records, note = records_from_structured(datas, path.name)
                return records, f"模型通道·{eng.name}（扫描PDF逐页识别）：{note}"
            if lines:
                records, note = cr.structure_text_document(lines, path.name)
                return records, f"模型通道·{eng.name}（扫描PDF逐页识别→文字行）：{note}"
        except Exception as e:
            hints.append(f"{eng.name}：异常 {e}")
            continue
    n_pages = len(page_imgs) if page_imgs else "?"
    return None, "；".join(hints) + f"（扫描PDF共{n_pages}页为图像，需模型能力）"

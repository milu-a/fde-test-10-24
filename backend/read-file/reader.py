#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
读取模块 · 统一入口
====================
read_file(path) → 一个结果字典，说明走了哪条通道、用了什么引擎、读出哪些记录。

通道分两类（对应两套读取原理）：
  【纯代码】excel    —— xlsx 是ZIP+XML，openpyxl 按格式读单元格
  【纯代码】pdf_text —— 文字版PDF存着字符+坐标，pdfplumber 抽取拼行
  【模型】  model_ocr —— 扫描PDF/截图只有像素，模型认字（引擎可插拔）
  【需模型】needs_model —— 模型引擎不可用且预转录库无匹配 → 给出明确提示，不硬猜
"""
from pathlib import Path

import code_readers
import model_readers
from ocr_engines import DEFAULT_ENGINES, guess_vendor

CODE_CHANNELS = ("excel", "pdf_text")


def read_file(path, engines=None):
    path = Path(path)
    ext = path.suffix.lower()
    result = {"file": path.name, "vendor_guess": guess_vendor(path.name),
              "channel": None, "channel_desc": "", "engine": None,
              "needs_model": False, "confidence": "", "records": [], "note": ""}
    try:
        if ext in (".xlsx", ".xlsm"):
            records, note = code_readers.read_excel(path)
            result.update(channel="excel", channel_desc="Excel（openpyxl·纯代码）",
                          engine="openpyxl", confidence="高", records=records, note=note)
        elif ext == ".pdf":
            # 文字层抽取失败（如依赖缺失）不终结路由：降级按扫描件走模型引擎链
            try:
                res = code_readers.read_pdf_text(path)
            except Exception as e:
                res = None
                result["note"] = f"文字层抽取异常（{e}），转扫描件通道"
            if res is not None:
                records, note = res
                result.update(channel="pdf_text", channel_desc="PDF文字层（pdfplumber·纯代码）",
                              engine="pdfplumber", confidence="高", records=records, note=note)
            else:
                res2 = model_readers.read_scanned_pdf(path, engines or DEFAULT_ENGINES)
                if res2[0] is None:
                    result.update(channel="needs_model", channel_desc="扫描PDF·需模型（当前无可用引擎）",
                                  needs_model=True, note=res2[1])
                else:
                    result.update(channel="model_ocr", channel_desc="扫描PDF·模型识别",
                                  engine=res2[1].split("·")[1].split("：")[0] if "·" in res2[1] else "OCR",
                                  confidence="中", records=res2[0], note=res2[1])
        elif ext in (".png", ".jpg", ".jpeg", ".bmp", ".webp"):
            res = model_readers.read_image(path, engines or DEFAULT_ENGINES)
            if res[0] is None:
                result.update(channel="needs_model", channel_desc="图片·需模型（当前无可用引擎）",
                              needs_model=True, note=res[1])
            else:
                result.update(channel="model_ocr", channel_desc="图片·模型识别",
                              engine=res[1].split("·")[1].split("（")[0] if "·" in res[1] else "OCR",
                              confidence="中", records=res[0], note=res[1])
        else:
            result.update(channel="needs_model", channel_desc=f"不支持的格式 {ext}",
                          needs_model=True, note=f"暂不支持的格式 {ext}，请人工处理")
    except Exception as e:
        result.update(channel="needs_model", channel_desc="自动解析失败",
                      needs_model=True, note=f"解析失败：{e}——转人工处理")
    return result


if __name__ == "__main__":
    import sys
    r = read_file(sys.argv[1])
    print(r["channel_desc"], "|", r["note"], "| 记录数:", len(r["records"]))

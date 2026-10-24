# -*- coding: utf-8 -*-
"""M4 管线：M3 原始行（item 可为 null）→ 回填清单编号 + 匹配依据 → 引擎可用的 quotes JSON。

原件永不覆盖（规则第六条）：输入文件不改写，结果写 *_matched.json；
语义提案与未匹配行进人工评审文件，确认一条、词库积累一条（越用越准）。
"""
import copy
import json
from collections import OrderedDict
from pathlib import Path

from .matcher import match_line


def run(quotes: dict, catalog: dict, synonyms: dict, kb=None):
    """对整份 M3 输出做归一匹配。返回 (matched, report, review)。

    matched: 深拷贝并回填 item/note 的完整 quotes（未匹配行保持 item=null）
    report:  各层命中统计与疑似重复
    review:  待人工确认清单（语义提案 + 未匹配，含知识库提示）
    kb:      知识库（可选）——为语义提案提供历史确认映射与先例提示
    """
    matched = copy.deepcopy(quotes)
    report = {"exact": 0, "synonym": 0, "proposal": 0, "unmatched": 0, "duplicates": 0}
    review = []

    for sup, sj in matched.get("suppliers", {}).items():
        for ln in sj.get("lines", []):
            if ln.get("item"):                       # M3 已给编号：视为人工已确认，不重算
                continue
            res = match_line(ln.get("name", ""), catalog, synonyms, kb=kb)
            if res.auto:
                ln["item"] = res.item_id
                ln["note"] = (ln.get("note", "") + "；" if ln.get("note") else "") + f"M4：{res.basis}"
                report[res.method] += 1
            else:
                report["unmatched" if res.method == "unmatched" else "proposal"] += 1
                review.append({
                    "supplier": sup,
                    "raw": ln.get("name", ""),
                    "unit": ln.get("unit"),
                    "qty": ln.get("qty"),
                    "source": ln.get("source"),
                    "suggestion": None if res.method == "unmatched" else res.basis,
                    "status": "待确认",
                })
        # 同一分项多行：不删不改，两行都标注（去重与否由商务澄清/引擎处理）
        counts = {}
        for ln in sj.get("lines", []):
            if ln.get("item"):
                counts[ln["item"]] = counts.get(ln["item"], 0) + 1
        for ln in sj.get("lines", []):
            it = ln.get("item")
            if it and counts[it] > 1:
                ln["note"] = (ln.get("note", "") + "；" if ln.get("note") else "") \
                             + f"M4：同一分项出现{counts[it]}行（疑似重复，待确认只计一次）"
                report["duplicates"] += 1
    return matched, report, review


def confirm(raw_name: str, item_id: str, basis: str = "", confirmed_by: str = "商务人员",
            synonyms_path=None, catalog: dict = None):
    """人工确认一条映射并回灌同义词表（飞轮）。catalog 传入时校验 item 存在。"""
    if catalog is not None and item_id not in catalog:
        raise ValueError(f"清单中不存在 {item_id}，请核对")
    p = Path(synonyms_path)
    data = json.loads(p.read_text("utf-8")) if p.exists() else {"note": "行业同义词表", "entries": []}
    data.setdefault("entries", [])
    if any(e.get("raw") == raw_name and e.get("item") == item_id for e in data["entries"]):
        return False
    data["entries"].append({"raw": raw_name, "item": item_id, "basis": basis,
                            "confirmed_by": confirmed_by,
                            "at": __import__("datetime").date.today().isoformat()})
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    return True


def load_json(path):
    return json.loads(Path(path).read_text("utf-8"))


def dump_json(obj, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1), "utf-8")
    return path

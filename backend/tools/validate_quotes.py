# -*- coding: utf-8 -*-
"""M3 输出格式校验器：validate_quotes.py <输出.json>

校验 docs/M3输出格式规范.md 的硬约束，退出码 0 = 合格。
仅标准库，可在内网环境直接运行。
"""
import json
import sys
from pathlib import Path

TAX_STATES = {"未声明", "待澄清", "已声明", "已澄清"}
DIRECTIONS = {"含税", "未税"}
MONEY_FIELDS = ("qty", "unit_price", "stated_amount")


def err(errors, path, msg):
    errors.append(f"{path}: {msg}")


def validate(data):
    errors = []
    if not isinstance(data, dict):
        return [f"顶层必须是对象，得到 {type(data).__name__}"]
    if not isinstance(data.get("suppliers"), dict) or not data["suppliers"]:
        err(errors, "$", "缺少非空 suppliers 对象")
        return errors

    for sup, sj in data["suppliers"].items():
        p = f"suppliers.{sup}"
        if not isinstance(sj, dict):
            err(errors, p, "必须是对象")
            continue
        if sj.get("direction") not in DIRECTIONS:
            err(errors, f"{p}.direction", f"必须是 {'/'.join(DIRECTIONS)} 之一")
        if not sj.get("file"):
            err(errors, f"{p}.file", "缺少原始文件路径")
        if not isinstance(sj.get("lines"), list):
            err(errors, f"{p}.lines", "必须是数组")
            continue

        tax = sj.get("tax") or {}
        state = tax.get("state")
        if state not in TAX_STATES:
            err(errors, f"{p}.tax.state", f"必须是 {'/'.join(TAX_STATES)} 之一")
        elif state in ("已声明", "已澄清"):
            r = tax.get("rate")
            if not r:
                err(errors, f"{p}.tax.rate", "已声明/已澄清必须给税率")
            elif not isinstance(r, str):
                err(errors, f"{p}.tax.rate", "税率必须为字符串（如 \"0.06\"）")
            if not (isinstance(tax.get("evidence"), dict) and tax["evidence"].get("file")):
                err(errors, f"{p}.tax.evidence", "税率声明必须带依据文件（规则第六条）")
        elif tax.get("rate"):
            err(errors, f"{p}.tax.rate", f"state={state} 时不得填税率（不得默认补写，规则第二条）")

        st = sj.get("stated_total")
        if st is not None and not isinstance(st, str):
            err(errors, f"{p}.stated_total", "列示合计必须为字符串")

        for i, ln in enumerate(sj["lines"], 1):
            lp = f"{p}.lines[{i}]"
            if not isinstance(ln, dict):
                err(errors, lp, "必须是对象")
                continue
            if not ln.get("name"):
                err(errors, f"{lp}.name", "缺少原始分项名称")
            if not ln.get("unit"):
                err(errors, f"{lp}.unit", "缺少单位")
            src = ln.get("source")
            if not (isinstance(src, dict) and src.get("file")):
                err(errors, f"{lp}.source", "缺少来源定位（规则第六条）")
            item = ln.get("item")
            if item is not None and not isinstance(item, str):
                err(errors, f"{lp}.item", "清单编号必须为字符串或 null（M3 可空，M4 回填）")
            for f in MONEY_FIELDS:
                v = ln.get(f)
                if v is None:
                    continue
                if isinstance(v, (int, float)):
                    err(errors, f"{lp}.{f}", f"数字必须为字符串，得到 {v!r}（防浮点噪声）")
                elif not isinstance(v, str):
                    err(errors, f"{lp}.{f}", f"必须是字符串或 null，得到 {type(v).__name__}")
                elif v.strip() == "":
                    err(errors, f"{lp}.{f}", "未知值用 null，不得用空串（未知≠0）")
    return errors


def main():
    if len(sys.argv) != 2:
        print("用法：python tools/validate_quotes.py <M3输出.json>")
        return 2
    path = Path(sys.argv[1])
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"无法读取/解析 {path}: {e}")
        return 2
    errors = validate(data)
    if errors:
        print(f"✗ {len(errors)} 处不合格：")
        for e in errors:
            print(f"  · {e}")
        return 1
    n_sup = len(data["suppliers"])
    n_lines = sum(len(sj.get("lines", [])) for sj in data["suppliers"].values())
    print(f"✓ 格式合格：{n_sup} 家供应商，{n_lines} 行原始报价")
    return 0


if __name__ == "__main__":
    sys.exit(main())

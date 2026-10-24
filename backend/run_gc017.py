# -*- coding: utf-8 -*-
"""GC-017 全量回归演示：V1 原始 → V1 澄清后 → V2 变更后，三阶段台账 + 底稿数字核对 + JSON 导出。

运行：python run_gc017.py   （在 agent/ 目录下）
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")

from engine import ledger_to_dict, load_all
from engine.money import D, fmt

SUPS = ["甲", "乙", "丙", "丁"]
OUT = ROOT / "out"


def render(led):
    print(f"\n{'═' * 78}\n〖 {led.version} 〗\n{'═' * 78}")
    catalog = load_all().catalog
    for field, label in (("hs", "含税口径（元）"), ("ws", "未税口径（元）")):
        print(f"\n── {label} ──")
        print(f"{'编号':<6}{'名称':<10}" + "".join(f"{s:>16}" for s in SUPS))
        for item, per in led.rows.items():
            cells = []
            for s in SUPS:
                ls = per[s]
                if ls[0].status != "已计算":
                    cells.append("未报")
                    continue
                v = getattr(ls[0], field)
                txt = "不可折算" if v is None else fmt(v)
                if len(ls) > 1:
                    txt += f" ×{len(ls)}"
                cells.append(txt)
            print(f"{item:<6}{catalog[item]['name']:<10}" + "".join(f"{c:>16}" for c in cells))
        print("-" * 70)
        row = f"{'合计':<16}"
        for s in SUPS:
            t = led.totals[s][field]
            txt = "—" if t is None else fmt(t)
            row += f"{txt:>16}"
        print(row)
        row = f"{'原报列示合计':<14}"
        for s in SUPS:
            row += f"{fmt(led.totals[s]['stated']):>16}"
        print(row)

    flags = []
    for item, per in led.rows.items():
        for s in SUPS:
            for c in per[s]:
                for f in c.flags:
                    entry = f"[{item}·{s}] {f}"
                    if entry not in flags:
                        flags.append(entry)
    print("\n── 异常与口径提示（只提示不裁决） ──")
    for f in flags:
        print(f"  · {f}")
    for s in SUPS:
        for f in led.totals[s]["flags"]:
            print(f"  · [合计·{s}] {f}")

    print("\n── 操作留痕（原值 → 新值，全程可追溯） ──")
    for a in led.audit:
        print(f"  {a['操作时间']}  {a['操作者']}  {a['供应商']}·{a['分项']}："
              f"{a['原值']} → {a['新值']}  依据：{a['变更依据']}")


def main():
    ns = load_all()
    b = ns.builder
    ch = ns.events["change"]
    stages = [
        b.build("V1 原始报价（澄清前）"),
        b.build("V1 澄清后（CLARIFY-01 已回填）", amendments=ns.events["clarify"]),
        b.build("V2 变更后（CHANGE-01：C08 60→72根，V1基线保留）",
                amendments=ns.events["clarify"], qty_overrides=ch["qty_overrides"],
                qty_basis=ch["id"], qty_at=ch["at"], qty_operator=ch["operator"]),
    ]
    for led in stages:
        render(led)

    print(f"\n{'═' * 78}\n底稿数字核对\n{'═' * 78}")
    v1, v1c, v2 = stages
    checks = [
        ("V1 甲含税合计 40,545.00，与列示一致",
         v1.totals["甲"]["hs"] == D("40545.00")),
        ("V1 乙未税明细加总 58,175.00 ≠ 列示 58,375.00 → 抓出合计误差 +200.00",
         v1.totals["乙"]["ws"] == D("58175.00") and any("+200.00" in f for f in v1.totals["乙"]["flags"])),
        ("V1 乙含税合计不可折算（税率未给，不当0）",
         v1.totals["乙"]["hs"] is None),
        ("V1 丙 C04 列示 2,181.80 比乘积 2,161.80 多 20.00 → 抓出抄写错误",
         any("+20.00" in f for f in v1.rows["C04"]["丙"][0].flags)),
        ("V1 丙合计 38,485.84（C04按乘积计；列示合计 38,505.84 → 合计旗标 +20.00；附件 3,392.00 未并入）",
         v1.totals["丙"]["hs"] == D("38485.84") and any("+20.00" in f for f in v1.totals["丙"]["flags"])),
        ("V1 丁合计 41,924.08（C04按16点、C14按1项原样计）",
         v1.totals["丁"]["hs"] == D("41924.08")),
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
        ("操作留痕：申报 3 条 + 澄清 8 条 + 变更 4 条 = 15 条，字段齐备",
         len(v2.audit) == 15),
    ]
    failed = 0
    for msg, ok in checks:
        print(f"  {'✓' if ok else '✗ FAIL'}  {msg}")
        failed += 0 if ok else 1

    OUT.mkdir(exist_ok=True)
    slugs = ["v1_raw", "v1_clarified", "v2"]
    for led, slug in zip(stages, slugs):
        p = OUT / f"gc017_{slug}.json"
        p.write_text(json.dumps(ledger_to_dict(led), ensure_ascii=False, indent=1), "utf-8")
        print(f"  → 已导出 {p.relative_to(ROOT)}")

    print(f"\n结果：{'全部通过' if failed == 0 else f'{failed} 项未通过'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

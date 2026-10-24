# -*- coding: utf-8 -*-
"""M4 归一匹配运行入口。

用法（在 agent/ 目录下）：
  python run_m4.py <M3输出.json>                    # 归一匹配 → <名>_matched.json + 评审文件
  python run_m4.py --confirm "原始名" C03 "依据"     # 人工确认一条映射，回灌同义词表
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")

from engine.loader import load_all
from matching import confirm, run
from matching.pipeline import dump_json, load_json

SYNONYMS = ROOT / "data" / "synonyms.json"


def main():
    args = sys.argv[1:]
    catalog = load_all().catalog

    if args and args[0] == "--confirm":
        if len(args) < 3:
            print("用法：python run_m4.py --confirm \"原始分项名\" <清单编号> [依据]")
            return 2
        raw, item = args[1], args[2]
        basis = args[3] if len(args) > 3 else ""
        created = confirm(raw, item, basis, synonyms_path=SYNONYMS, catalog=catalog)
        print(("✓ 已回灌同义词表" if created else "· 词库已有该映射，未重复添加") + f"：{raw} → {item}")
        return 0

    if not args:
        print(__doc__)
        return 2
    src = Path(args[1] if args[0] == "-o" else args[0])
    data = load_json(src)

    matched, report, review = run(data, catalog, load_json(SYNONYMS))

    out = ROOT / "out" / f"{src.stem}_matched.json"
    dump_json(matched, out)
    print(f"M4 归一匹配：精确 {report['exact']}，同义词 {report['synonym']}，"
          f"提案 {report['proposal']}，未匹配 {report['unmatched']}，疑似重复 {report['duplicates']}")
    if review:
        rp = dump_json(review, ROOT / "out" / "m4_review.json")
        print(f"  → {len(review)} 行待人工确认，评审清单：{rp}")
        for e in review:
            print(f"    · [{e['supplier']}] {e['raw']}：{e['suggestion'] or '无候选'}")
    print(f"  → 匹配结果：{out}（输入文件未改动）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

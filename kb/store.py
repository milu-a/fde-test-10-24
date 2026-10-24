# -*- coding: utf-8 -*-
"""知识库存储与检索：标签 + 字符二元组重合度打分（纯规则，无外部依赖）。

    kb = KnowledgeBase(cases_path, synonyms_path)
    kb.search("单价超参考区间")            -> 相关案例（异常案例/澄清先例）
    kb.related_item("C08", "乙")          -> 某供应商某分项的先例
    kb.hints_for_match("沉降点观测")       -> 匹配提案的 few-shot 提示
    kb.add_case({...})                    # confirmed_by 必填（人确认闸门）
"""
import json
import re
from datetime import date
from pathlib import Path


def _tokens(text: str) -> set:
    """中文 2-gram + 拉丁/数字词。"""
    text = str(text or "")
    toks = {w.lower() for w in re.findall(r"[A-Za-z0-9]+", text)}
    clean = re.sub(r"[A-Za-z0-9]+", " ", text)
    clean = re.sub(r"\s+", "", clean)
    toks |= {clean[i:i + 2] for i in range(len(clean) - 1)}
    return toks


class KnowledgeBase:
    def __init__(self, cases_path, synonyms_path=None):
        self.cases_path = Path(cases_path)
        self.synonyms_path = Path(synonyms_path) if synonyms_path else None
        self.cases = self._load(self.cases_path).get("cases", [])
        self.synonyms = self._load(self.synonyms_path).get("entries", []) if self.synonyms_path else []
        self._index = [(_case_tokens(c), c) for c in self.cases]

    @staticmethod
    def _load(path: Path) -> dict:
        if path and Path(path).exists():
            return json.loads(Path(path).read_text("utf-8"))
        return {}

    # -------------------------------------------------- 检索
    def search(self, query: str, top_k: int = 3, type_: str = None) -> list:
        qt = _tokens(query)
        scored = []
        for toks, c in self._index:
            if type_ and c.get("type") != type_:
                continue
            tag_score = 0.0
            for t in c.get("tags", []):
                tt = _tokens(t)
                if tt:
                    tag_score += 3.0 * len(tt & qt) / len(tt)
            text_score = len(toks & qt)
            if tag_score + text_score > 0:
                scored.append((tag_score + text_score, c))
        scored.sort(key=lambda x: -x[0])
        return [c for _, c in scored[:top_k]]

    def related_item(self, item_id: str, supplier: str = None, top_k: int = 2) -> list:
        """某供应商某分项的先例：优先同分项同供应商，其次同分项。"""
        same = [c for c in self.cases if c.get("item") == item_id
                and (supplier is None or c.get("supplier") == supplier)]
        broader = [c for c in self.cases if c.get("item") == item_id
                   and c not in same]
        return (same + broader)[:top_k]

    def hints_for_match(self, name: str, top_k: int = 2) -> list:
        """给语义匹配提案的 few-shot 提示：相似的历史确认映射 + 匹配先例。"""
        nt = _tokens(name)
        hints = []
        for e in self.synonyms:
            st = _tokens(e.get("raw", ""))
            inter = len(st & nt)
            if inter:
                hints.append({"kind": "已确认映射", "weight": inter,
                              "text": f"「{e['raw']}」→{e['item']}（{e.get('confirmed_by', '人工')}确认）"})
        for c in self.search(f"{name} 异名 匹配", top_k=1, type_="匹配先例"):
            hints.append({"kind": "匹配先例", "weight": 1,
                          "text": f"[{c['id']}] {c['phenomenon']} → {c['resolution']}"})
        hints.sort(key=lambda h: -h["weight"])
        return [{"kind": h["kind"], "text": h["text"]} for h in hints[:top_k]]

    def precedents_for_clarify(self, text: str, top_k: int = 2) -> list:
        """给澄清起草的先例提示：按描述文本检索相似案例。"""
        return self.search(text, top_k=top_k)

    # -------------------------------------------------- 写入（人确认闸门）
    def add_case(self, case: dict) -> bool:
        if not (case.get("confirmed_by") or "").strip():
            raise ValueError("知识条目必须带 confirmed_by（人确认闸门）")
        if not (case.get("phenomenon") or "").strip() or not (case.get("resolution") or "").strip():
            raise ValueError("案例必须有现象（phenomenon）与结论（resolution）")
        for c in self.cases:
            if c.get("type") == case.get("type") and c.get("item") == case.get("item") \
                    and c.get("phenomenon") == case.get("phenomenon"):
                return False                          # 重复条目不重复入库
        case = dict(case)
        case.setdefault("id", f"KB-CASE-{date.today():%Y%m%d}-{len(self.cases) + 1:03d}")
        case.setdefault("tags", [])
        case.setdefault("at", f"{date.today():%Y-%m-%d}")
        self.cases.append(case)
        self._index.append((_case_tokens(case), case))
        self.cases_path.parent.mkdir(parents=True, exist_ok=True)
        self.cases_path.write_text(
            json.dumps({"note": "异常与澄清案例库：结案归档、经人确认。检索仅供 AI 提案与人工参考，不构成裁决依据。",
                        "cases": self.cases}, ensure_ascii=False, indent=1), "utf-8")
        return True


def _case_tokens(c: dict) -> set:
    return (_tokens(" ".join(c.get("tags", []))) | _tokens(c.get("phenomenon", ""))
            | _tokens(c.get("clarification", "")) | _tokens(c.get("resolution", ""))
            | _tokens(c.get("item", "")) | _tokens(c.get("type", "")))

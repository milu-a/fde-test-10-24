# -*- coding: utf-8 -*-
"""M4 匹配器：三层递进，只有前两层（确定性）允许自动回填 item。

  1) 规范化精确匹配——名称归一后与清单名全等（最安全）；
  2) 同义词表——已确认的异名映射（每一经人确认的匹配都会积累进词库）；
  3) 语义提案——只出候选、不自动入账，进人工评审文件。
     当前用字符二元组相似度占位；内网部署本地 LLM 后原位替换 propose() 即可，
     接口（输入原始名+清单 → 输出候选+置信度+依据）不变。

规则第四条：同一分项不同名称应结合范围匹配；台班≠项的换算不在本层处理（M1 单位状态机）。
"""
import re
from dataclasses import dataclass
from typing import Optional

_PUNCT_TABLE = str.maketrans({"（": "(", "）": ")", "，": ",", "、": ",", "　": " "})
_PROPOSAL_THRESHOLD = 0.5


@dataclass(frozen=True)
class MatchResult:
    item_id: Optional[str]      # None = 未匹配（保持 null，进人工评审）
    method: str                 # exact / synonym / proposal / unmatched
    score: float
    basis: str                  # 匹配依据（写入行 note，供台账追溯）

    @property
    def auto(self) -> bool:
        """是否允许自动回填：仅确定性两层。语义提案必须人工确认。"""
        return self.item_id is not None and self.method in ("exact", "synonym")


def normalize_name(s: str) -> str:
    """归一：全角括号/标点转半角、去所有空白、去成对括号及内容（如"（回弹法）"）。"""
    s = (s or "").strip().translate(_PUNCT_TABLE)
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"\([^()]*\)", "", s)
    return s


def _bigrams(s: str) -> set:
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) > 1 else {s}


def propose(name: str, catalog: dict, kb=None) -> dict:
    """语义匹配插座：当前为字符二元组 Jaccard 占位实现。

    接入本地 LLM 时替换本函数：输入 (原始名, 清单, 知识库)，输出
    {"item_id", "score", "basis", "hints"}。知识库（kb）提供历史确认映射与
    先例作为 few-shot 提示——AI 只提案，不回填。
    """
    target = normalize_name(name)
    best_id, best_score = None, 0.0
    for cid, cat in catalog.items():
        cand = normalize_name(cat["name"])
        if not cand:
            continue
        a, b = _bigrams(target), _bigrams(cand)
        score = len(a & b) / len(a | b) if a | b else 0.0
        if score > best_score:
            best_id, best_score = cid, score
    hints = kb.hints_for_match(name) if kb is not None else []
    basis = f"与「{name}」字符相似度{best_score:.0%}（语义提案占位算法，待人工确认）"
    if hints:
        basis += "；知识库提示：" + "；".join(h["text"] for h in hints)
    return {"item_id": best_id, "score": round(best_score, 2),
            "basis": basis, "hints": hints}


def match_line(name: str, catalog: dict, synonyms: dict, kb=None) -> MatchResult:
    """对单个原始分项名做三层匹配。catalog: {id: {"name": ...}}；synonyms: {"entries": [...]}"""
    n = normalize_name(name)
    if not n:
        return MatchResult(None, "unmatched", 0.0, "M4：原始名称为空，待人工确认")

    for cid, cat in catalog.items():                      # 1) 规范化精确
        if normalize_name(cat.get("name", "")) == n:
            return MatchResult(cid, "exact", 1.0, f"名称一致：{cat['name']}")

    for e in (synonyms or {}).get("entries", []):         # 2) 同义词表（已确认映射）
        if normalize_name(e.get("raw", "")) == n and e.get("item") in catalog:
            basis = e.get("basis", "")
            return MatchResult(e["item"], "synonym", 1.0,
                               f"同义词表：{e['raw']}→{e['item']}" + (f"（{basis}）" if basis else ""))

    p = propose(name, catalog, kb=kb)                     # 3) 语义提案（不自动回填）
    if p["item_id"] and p["score"] >= _PROPOSAL_THRESHOLD:
        cat = catalog[p["item_id"]]
        return MatchResult(None, "proposal", p["score"],
                           f"语义提案：相似{p['score']:.0%}，或即「{cat['name']}」——待人工确认；{p['basis']}")
    return MatchResult(None, "unmatched", p["score"],
                       "M4未匹配：清单中无近似项，待人工确认" + (f"；{p['basis']}" if p["hints"] else ""))

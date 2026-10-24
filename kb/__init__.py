# -*- coding: utf-8 -*-
"""知识库（知识层）：异常案例 + 澄清先例 + 匹配先例 + 同义词表的检索与回灌。

定位：给 AI 的「提示」，不是裁决——检索结果仅作为提案依据与人工参考（规则第五/七条）。
写入必须经人确认（confirmed_by 必填，人确认闸门）；检索为纯规则（标签+分词重合），
内网零依赖；企业落地时可原位替换为本地向量库（faiss/chromadb），接口不变。
"""
from .store import KnowledgeBase

__all__ = ["KnowledgeBase"]

# -*- coding: utf-8 -*-
"""智慧报表链路测试用本地 mock LLM（OpenAI 兼容 SSE，仅测试用，不入生产）。

用法：python testdata/mock_llm.py   （监听 127.0.0.1:8010）
配合：AI_REPORT_API_KEY=test AI_REPORT_API_BASE=http://127.0.0.1:8010/v4 python server.py
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

CHUNKS = [
    "好的。基于当前项目台账数据，各供应商 **V1 原始** 含税合计如下：\n\n",
    "| 供应商 | 口径 | 计算合计 |\n|---|---|---|\n| 戊 | 含税 | 35,545.80 |\n| 己 | 含税 | 29,088.52 |\n| 庚 | 含税 | 33,906.00 |\n\n",
    "其中己为未税口径（税率未给，含税不可折算）。异常方面：\n\n- 戊 C04 疑似抄写错误（差 +20.00）\n- 庚 C07 重复行 2 行\n\n用图表直观对比：\n\n```chart\n",
    json.dumps({"type": "bar", "title": "各供应商 V1 原始含税合计", "unit": "元", "data": [
        {"label": "戊", "value": 35545.8}, {"label": "己", "value": 0},
        {"label": "庚", "value": 33906.0}, {"label": "辛", "value": 0}]}),
    "\n```\n\n> 提示：辛未报、己税率未给，图中以 0 占位仅示意，实际为「未报/不可折算」状态，不当 0 解读。",
]


class MockLLM(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for c in CHUNKS:
            frame = json.dumps({"choices": [{"delta": {"content": c}}]}, ensure_ascii=False)
            self.wfile.write(("data: " + frame + "\n\n").encode("utf-8"))
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *a):  # 静默
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8010), MockLLM).serve_forever()

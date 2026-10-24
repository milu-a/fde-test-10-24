# read-file · 多格式报价读取模块

把不同格式的报价文件读成**带出处坐标的结构化数据**，供后续对齐、核对、台账流程使用。

支持格式与读取原理：

| 格式 | 通道 | 引擎 | 成本 | 置信度 |
|---|---|---|---|---|
| Excel（.xlsx/.xlsm） | 纯代码 | openpyxl | 0 | 高（读的是存好的单元格数据） |
| 文字版 PDF | 纯代码 | pdfplumber | 0 | 高（抽的是文件内真实字符） |
| 扫描 PDF / 图片 | 模型 | 云端视觉模型 API（可插拔）→ 本地 PaddleOCR → 人工转录 | API按量 / 本地免费 | 中（需人工抽检） |

引擎链自动降级：主 API → 备用 API → PaddleOCR（未装自动跳过）→ 人工转录兜底；**任何一环失败都不硬猜**，缺税率/缺单价只标记不默认。

## 安装

```bash
pip install openpyxl pdfplumber pillow requests
# 如需本地OCR（离线生产环境）：
pip install paddlepaddle paddleocr
```

## 配置 API KEY（识图用）

```bash
copy api_config.example.json api_config.json   # 然后编辑 api_config.json 填入 KEY
```

`api_config.json` 已被 .gitignore 排除，**KEY 不会入库**。两种协议：

- `protocol: "anthropic"` + `glm-5.3-flash`（默认）：智谱编程套餐通道，订阅额度内识图
- `protocol: "v4"` + `glm-4v-flash`：开放平台免费视觉档（自动作为备用引擎）

## 使用

```python
from reader import read_file

result = read_file("丁方报价截图-1.png")
print(result["channel"])    # excel / pdf_text / model_ocr / needs_model
print(result["note"])       # 通道说明
for r in result["records"]: # 结构化记录，每条带出处
    print(r["原始编码"], r["原始分项名称"], r["数量"], r["单价"], r["原报金额"],
          r["出处-文件"], r["出处-定位"])
```

命令行单文件：`python reader.py <文件路径>`

每条记录 15 个字段：行类型（分项/合计/说明）、原始编码、名称、单位、数量、单价、单价口径（含税/未税）、税率、税率依据、原报金额、置信度、待人工标记、出处-文件、出处-定位、备注。

## 文件说明

| 文件 | 作用 |
|---|---|
| `reader.py` | 统一入口：格式探测与通道路由 |
| `code_readers.py` | 【纯代码】Excel 读取 + PDF 文字层读取 + 文字行结构化 |
| `model_readers.py` | 【模型】扫描 PDF 逐页渲染与图片识别调度 |
| `ocr_engines.py` | 可插拔引擎：ApiEngine（双协议）/ PaddleEngine / LibraryEngine |
| `api_config.example.json` | API KEY 配置模板 |

## 安全红线

- 云端 API 会把图片传至智谱服务器：**仅用于脱敏/演示数据**；真实商业报价须换本地 PaddleEngine（离线），并从引擎链移除 API 引擎。
- 缺失值（税率、单价）只标记待确认，**不默认补写、不当 0**。
- 本模块只读取与结构化，不做计算核对与比选判断。

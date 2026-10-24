# 分包比选工作台 · 前端 + M1/M2 引擎集成

山南勘测分包比选场景（FDE 企业真题 04「报价各说各话，工程分包怎么比？」）的工作台：

- **M1 税率与计算引擎 + M2 台账生成器 + M4 归一匹配 + M5 区间校验**：来自 `git@github.com:milu-a/fde-test-10-24.git` 的 `m1-engine` 分支（同步至 commit `64b3f4e`，源码复制于 `backend/`），金额计算零 LLM、全程 Decimal、**75 个单测** + 13 项 GC-017 全量回归全过；
- **read-file 多格式识别**：来自同一仓库的 `read-file` 分支（`backend/read-file/`）：Excel（openpyxl 纯代码）/ PDF 文字层（pdfplumber 纯代码）/ 扫描件·截图（可插拔引擎链：智谱视觉 API 双协议 → 本地 PaddleOCR → 预转录库），"认字靠模型、整理靠代码"，任何一环失败不硬猜；
- **前端界面**：ORBIS Corporate Design 2026（`../ORBISDESIGN(1)/DESIGN.md`），界面规格见 `../比选工作台-前端界面设计文档.md`；
- **AI 触点**：扫描件/截图识别走 read-file 引擎链（第三方 API，按量/订阅），事件提取按第三方接口设计（界面可切离线降级为人工路径），本机不部署模型；M4 语义匹配预留 `propose()` 插座（本地 LLM 原位替换，接口不变）。

## 运行

```bash
cd app
python server.py            # 默认 http://127.0.0.1:8080（被占用自动 +1）
# 可选：python server.py --port 9000
```

启动即执行 13 项底稿数字回归（结果同时暴露给前端「导出自检」）。依赖：Python 3.10+、openpyxl（仅 M2 写 xlsx 用）；引擎本体只用标准库，可离线内网运行。

> 注意：现在是「前端 + 本地引擎服务」架构，纯静态服务器（`python -m http.server`）只能看壳，必须用 `server.py`。

## 目录结构

```
app/
├── index.html               ← 唯一入口
├── server.py                ← 本地服务：静态前端 + 引擎 API + 识别 API + xlsx 导出 + 启动自检
├── backend/                 ← 全部后端代码（源自 fde-test-10-24 @ m1-engine，同步至 64b3f4e）
│   ├── engine/              ← M1：money/models/calculator/ledger/loader/units（纯标准库）
│   │                          M5：参考区间比对在 calculator.compute_line（超上限约X倍/低于下限异常低价）
│   ├── read-file/           ← 多格式识别（源自 read-file 分支，未改逻辑）：
│   │                          reader.py 统一路由 / code_readers 纯代码通道 /
│   │                          model_readers+ocr_engines 可插拔引擎链（API→Paddle→预转录库）
│   │                          transcripts/ = 案例文件识别缓存（演示离线重放）；api_config.json 不入库
│   ├── matching/            ← M4 归一匹配：三层匹配器（精确/同义词表/语义提案插座）+ 确认回灌词库飞轮
│   ├── report/              ← M2：write_ledger → 5-sheet 台账 xlsx（供应商列数据驱动、模板列自动补插）
│   ├── data/                ← GC-017 结构化兜底数据 + synonyms.json（M4 已确认异名词库）
│   ├── inbox/               ← 上传原件落位区（只读，同名不同内容加时间戳另存，永不覆盖）
│   ├── tools/               ← validate_quotes.py：M3 输出格式契约校验器
│   ├── docs/                ← M3 输出格式规范（M3→M4→M1 数据契约）
│   ├── tests/               ← 75 个单元测试（unittest 标准库）
│   ├── run_gc017.py         ← M1 全量回归：三阶段台账 + 13 项底稿核对 + JSON 导出
│   ├── run_m4.py            ← M4 入口：归一匹配 / --confirm 人工确认回灌词库
│   ├── gen_workbooks.py     ← M2 入口：三阶段 → 三份比选台账 xlsx（rate_map/invoice_status 动态）
│   ├── README-upstream.md   ← 上游仓库 README（设计要点/模块接口/已知边界）
│   └── out/                 ← 导出产物：台账 xlsx、recognition/ 识别结果缓存（与原件物理分离）
└── data/                    ← 前端静态资产
    ├── app/app.js           ← 界面渲染与流程编排（只呈现，不算账；供应商列表由 bootstrap 驱动）
    ├── app/style.css        ← ORBIS 品牌样式
    ├── fonts/ design/       ← Montserrat + ORBIS 令牌与 Logo（本地打包）
    └── assets/              ← 丙/丁原件截图（来源回查用）
```

上游代码维护：后端与 `git@github.com:milu-a/fde-test-10-24.git` 的 `m1-engine` 分支同构（未改引擎逻辑，仅 gen_workbooks.py 的模板路径适配了目录层级）；要拉上游更新可重新克隆对照。

后端独立验证（在 backend/ 目录下）：

```bash
python -m unittest discover -s tests   # 75 个单测
python run_gc017.py                    # 三阶段回归 + 底稿核对
python gen_workbooks.py                # 生成三份台账 xlsx 到 backend/out/
python tools/validate_quotes.py data/gc017_quotes.json   # M3 数据契约校验
python run_m4.py --confirm "原始名" C03 "依据"           # M4 人工确认回灌词库
```

## API

| 端点 | 说明 |
|---|---|
| `GET /api/bootstrap` | 清单/供应商/事件/资格 + 识别待确认队列 + 回归自检结果 + 原件资产映射 + 识别引擎可用性 |
| `GET /api/ledger/{stage}` | 三阶段台账，`engine.ledger_to_dict` 同构 JSON |
| `GET /api/issues/{stage}` | 需补充事项（问题清单固定源自 V1 原始台账，闭环按当前版本求值） |
| `GET /api/export/{stage}` | 该阶段 5-sheet 台账 xlsx 下载 |
| `POST /api/recognize?filename=<名>` | 上传原件（body=文件字节）→ 只读落位 inbox/ → read_file 识别 → 缓存 out/recognition/*.json；相同字节 MD5 重放不重复调用引擎 |
| `GET /api/recognition` | 识别引擎链可用性 + 已缓存识别结果（收集箱回放展示） |

`stage ∈ { v1_raw, v1_clarified, v2 }`。

### read-file 识别模块（backend/read-file/，源自 read-file 分支）

- 统一入口 `read_file(path)` → `{channel, engine, confidence, records[], note, vendor_guess}`；记录为 15 字段中文结构（行类型/原始编码/原始分项名称/单位/数量/单价/单价口径/税率/税率依据/原报金额/置信度/待人工标记/出处-文件/出处-定位/备注）；
- 引擎链：智谱视觉 API（anthropic 协议 glm-5.3-flash 主力 + v4 协议 glm-4v-flash 备用）→ 本地 PaddleOCR（未装自动跳过）→ 预转录库 transcripts/*.json（按文件名匹配的识别缓存，演示离线重放）；配置 KEY 用环境变量 `ZHIPU_API_KEY` 或 `backend/read-file/api_config.json`（该文件不入库，模板见 api_config.example.json）；
- 红线与上游一致：缺失值（税率/单价）只标记待确认不默认补写；任何一环失败转 needs_model 明确提示不硬猜；云端 API 仅用于脱敏演示数据，真实报价生产环境改本地 PaddleEngine。

## 字段名（前端以引擎字段为准）

台账行（`rows[item][sup][instance]`）：`supplier / item / name / unit / qty / direction / orig_qty / stated_amount / note / orig_amount / ws / tax / hs / status(已计算|未报) / flags[] / basis / source / tax_state / unit_state / instance`；合计（`totals[sup]`）：`direction / ws / tax / hs / stated / flags[]`；留痕（`audit[]`）：`操作时间 / 操作者 / 供应商 / 分项 / 原值 / 新值 / 变更依据`；事件（`gc017_events.json`）：`op(DECLARE_TAX|ADD_LINE|SET_FIELD|DEDUPE|RESOLVE_UNIT) / supplier / item / field / old / new / payload / evidence / at / operator / note`。

关键语义（与引擎一致）：计算恒用 `ROUND(数量×单价,2)`，`stated_amount` 只作比对基准；税率未声明 → 显示"税率未给"（不当 0、不折算）；单位无书面说明不换算；乙 C07 重复行 V1 原始按列示原样计入并挂旗标，澄清后只计一次；**参考区间比对在引擎行级产出**（同范围同单位未税单价：超上限"约X倍"、低于下限"异常低价"线索；单位未确认不可比，整项口径经单位确认产生单价后恢复可比）。

## 回归基准（server.py 启动自检 = run_gc017.py 的 13 项）

| 阶段 | 甲(含税) | 乙 | 丙(含税) | 丁(含税) |
|---|---|---|---|---|
| V1 原始 | 40,545.00 | 未税 58,175.00（列示 58,375，差 +200）；含税不可折算 | 38,485.84（列示 38,505.84，差 +20） | 41,924.08 |
| V1 澄清后 | 40,545.00 | 未税 62,747.00 / 含税 66,511.82 | 41,877.84 | 42,166.60 |
| V2 变更后（C08 60→72根） | 41,626.20 | 未税 68,747.00 / 含税 72,871.82 | 42,991.44 | 43,291.00 |

需补充事项 17 项（10 类）：税率/漏报/重复/数量/抄写/单位/附件/合计/区间 + **发票类型未说明 4 项（M5：专票可抵扣则比价看未税，普票含税即真实成本）** + 资格 2 项保持未关闭；闭环只认 CLARIFY-01 依据。

## 界面主线（GC-017）

1. 首页（不预置项目卡；GC-017 工作区入口已随演示卡移除，工作台五页签数据仍可经 `/api/*` 访问）；
2. **② 统一对比台账**（V1 原始，异常线索最全）：乙列"税率未给"、C07 ×2行、C09/C11 未报；丙 C04 乘积值 + 疑似抄错、C13 未报 + 附件未并入；丁 C14 整项口径 + 单位待澄清；**点击任意金额格 → 来源回查**（图片件显原件截图，Excel/PDF 件显解析行高亮表）；
3. **③ 事件与澄清**：需补充事项（QB 编号、10 类、闭环状态）+ CLARIFY-01 / CHANGE-01 事件卡 → 差异预演 → 确认应用 → 台账切换版本（V1 澄清后 / V2 变更后）；
4. **④ 版本与差异**：三版本时间轴（留痕 3/11/15 条）、任意两版本差异表、操作记录（审计日志）；
5. **⑤ 导出交付**：导出自检（13/13 回归 + 未关闭事项如实呈现）+ 三版本 xlsx 真实下载（企业模板副本填写，含 V2"较V1差异"行）。

## 红线（界面行为约束）

不出现"推荐中标/评分/排名"元素；未知值不当 0（未报/税率未给状态化）；异常只提示不改写（乙 C08 超区间线索跨版本保留）；原件永不覆盖（三版台账互不覆盖）；闭环只认 CLARIFY-01 依据（CHANGE-01 不误关异常事项）。

## 已知边界

- 「登记事件」「确认入账」为前端流程演示（不触发引擎重算、不写库）；三份台账由后端按 GC-017 数据预计算；
- AI 提取/识别按钮为第三方接口位（离线置灰走人工路径）；首页不预置任何演示项目卡（GC-017 数据仍由后端 `/api/*` 提供）；
- 单位确认换算只支持"整项均分"口径（引擎限制，见仓库 README）。

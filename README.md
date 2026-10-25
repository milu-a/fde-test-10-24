# 分包比选工作台 · 前端 + M1/M2 引擎集成

山南勘测分包比选场景（FDE 企业真题 04「报价各说各话，工程分包怎么比？」）的工作台：

- **M1 税率与计算引擎 + M2 台账生成器 + M4 归一匹配 + M5 区间校验**：来自 `git@github.com:milu-a/fde-test-10-24.git` 的 `m1-engine` 分支（同步至 commit `64b3f4e`，源码复制于 `backend/`），金额计算零 LLM、全程 Decimal、**75 个单测** + 13 项 GC-017 全量回归全过；
- **read-file 多格式识别**：来自同一仓库的 `read-file` 分支（`backend/read-file/`）：Excel（openpyxl 纯代码）/ PDF 文字层（pdfplumber 纯代码）/ 扫描件·截图（可插拔引擎链：智谱视觉 API 双协议 → 本地 PaddleOCR → 预转录库），"认字靠模型、整理靠代码"，任何一环失败不硬猜；识别 KEY 只读环境变量 `ZHIPU_API_KEY`（未配置启动即报错，不再支持 api_config.json）；
- **前端界面**：orbcafe-ui 组件体系（vendored `orbcafe-ui@3.1.8` 官方 ORBIS 设计系统 CSS：`data/vendor/orbcafe-ui/`，含 `orbis.css` + ORBIS 品牌主题包 + Montserrat/SAP-icons 字体，Community License 文件随附）；前端 markup 直接使用库内 `orb-*` 组件类（orb-tbl/orb-btn/orb-card/orb-chip/orb-inp/orb-snack 等），库内没有的（台账冻结列/状态格、品牌横幅、时间轴等）按同规格补写；`data/app/style.css` 只保留布局与状态钩子胶水；历史界面规格见 `../比选工作台-前端界面设计文档.md`；
- **AI 触点**：扫描件/截图识别走 read-file 引擎链（第三方 API，按量/订阅），事件提取按第三方接口设计（界面可切离线降级为人工路径），本机不部署模型；M4 语义匹配预留 `propose()` 插座（本地 LLM 原位替换，接口不变）。

## 运行

```bash
cd app
copy .env.example .env      # 首次：把 ZHIPU_API_KEY 占位符换成你的智谱APIKEY（.env 不入库）
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
│   ├── project_pipeline.py  ← 运行时项目管线（本仓库新增）：项目存储 + 识别记录→M4匹配→引擎台账
│   ├── engine/              ← M1：money/models/calculator/ledger/loader/units（纯标准库）
│   │                          M5：参考区间比对在 calculator.compute_line（超上限约X倍/低于下限异常低价）
│   ├── read-file/           ← 多格式识别（源自 read-file 分支，未改逻辑）：
│   │                          reader.py 统一路由 / code_readers 纯代码通道 /
│   │                          model_readers+ocr_engines 可插拔引擎链（API→Paddle→预转录库）
│   │                          transcripts/ = 案例文件识别缓存（演示离线重放）；识别 KEY 只读环境变量 ZHIPU_API_KEY（api_config.json 已退役）
│   ├── matching/            ← M4 归一匹配：三层匹配器（精确/同义词表/语义提案插座）+ 确认回灌词库飞轮
│   ├── report/              ← M2：write_ledger → 5-sheet 台账 xlsx（供应商列数据驱动、模板列自动补插）
│   ├── data/                ← GC-017 结构化兜底数据 + synonyms.json（M4 已确认异名词库）
│   │                          projects.json = 运行时新建项目存储（本仓库新增，非上游文件）
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
    ├── app/style.css        ← 胶水层：布局/状态钩子 + 库内无组件的同风格补写
    ├── vendor/orbcafe-ui/   ← orbcafe-ui@3.1.8 官方 ORBIS CSS + 主题包 + 字体（本地打包，离线可用）
    ├── fonts/ design/       ← 旧版 ORBIS 字体与 Logo 资产（Logo 仍在顶栏使用）
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
| `GET /api/projects` | 运行时新建项目列表（backend/data/projects.json）+ 下一个可用项目编号；summary 含待确认事件数（pending_events，与 board counts 同口径） |
| `POST /api/projects` | 新建比选项目：`{"name": 项目名称, "owner": 项目负责人, "created_at"?: "YYYY-MM-DD[ HH:MM[:SS]]"}`，名称/负责人必填，项目时间可选（缺省取当前时刻，非法格式返回 400）；编号自动续号（GC-017 案例之后从 GC-018 起），状态机初始「配置中」 |
| `GET /api/projects/{id}/board` | 项目工作台全量数据：统一清单 + 已登记文件/识别记录 + **双版本台账（V1 原始 / V1 澄清后）** + 事件 + M4 匹配报告；每次请求现算 |
| `GET /api/projects/{id}/export` | 按版本导出 5-sheet 比选台账 xlsx（`?version=v1_raw|v1_clarified`，企业模板副本填写） |
| `POST /api/projects/{id}/attach` | 把已缓存的识别结果登记进项目（`{"rec_id": ...}`），首份文件触发「配置中→归集中」 |
| `POST /api/projects/{id}/events` | 登记事件候选（路径A：op/supplier/item/field/new/payload/evidence，**依据必填**） |
| `POST /api/projects/{id}/events/{eid}/apply` | 确认并应用事件：引擎试算，拒绝则回滚状态（坏事件不入账）；首个应用事件触发「→台账已出」，生成 V1 澄清后 |
| `POST /api/projects/{id}/events/{eid}/discard` | 作废待确认事件（作废不删除，与上游一致） |
| `POST /api/projects/{id}/status` | 项目状态流转（状态机 §6.1，界面「标记为已交付评审」用） |
| （POST /api/recognize） | 支持 `&project={id}`：项目工作区内上传识别成功即自动登记进项目并重算台账 |

### 项目数据管线（识别 → 事件 → 版本 → 导出，project_pipeline.py）

`收集箱上传 → read_file 识别（15 字段）→ 分项对位：原始编码优先、无编码走 M4 三层匹配（仅精确/同义词表自动回填，语义提案只进待确认队列）→ 组装 engine.loader 同构的 catalog/suppliers/tax_profiles（税率取自记录声明，未给则保持未声明）→ LedgerBuilder 计算 → V1 原始台账`。

事件与版本（与上游 M1 事件机制同构）：人工登记 DECLARE_TAX / SET_FIELD / ADD_LINE / DEDUPE / RESOLVE_UNIT 五类事件（依据必填，无依据不改数）→ 待确认 → 确认应用（引擎 `_apply` 试算，拒绝即回滚）→ **生成 V1 澄清后**，V1 原始基线永不覆盖；④版本与差异、操作留痕（audit）随之生效。

导出（M2 复用）：`write_ledger` 按版本写出 5-sheet xlsx（对比表/需补充事项/操作记录/报价明细/资格材料清单），税率展示列与发票立事项按上游同语义由项目税率档案 + DECLARE_TAX 事件动态生成；资格要求未挂载时「资格材料清单」为空表如实导出。金额计算零 LLM、全程 Decimal；异常（合计误差/抄写差错/超区间/数量不符/单位待澄清）由引擎行级旗标自动暴露，只提示不改写。

`stage ∈ { v1_raw, v1_clarified, v2 }`。

### read-file 识别模块（backend/read-file/，源自 read-file 分支）

- 统一入口 `read_file(path)` → `{channel, engine, confidence, records[], note, vendor_guess}`；记录为 15 字段中文结构（行类型/原始编码/原始分项名称/单位/数量/单价/单价口径/税率/税率依据/原报金额/置信度/待人工标记/出处-文件/出处-定位/备注）；
- 引擎链：智谱视觉 API（anthropic 协议 glm-5.3-flash 主力 + v4 协议 glm-4v-flash 备用）→ 本地 PaddleOCR（未装自动跳过）→ 预转录库 transcripts/*.json（按文件名匹配的识别缓存，演示离线重放）；配置 KEY 只读环境变量 `ZHIPU_API_KEY`（**未配置时服务启动即报错退出**，不再支持 api_config.json 文件）；
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

1. 左侧导航岛（orb-navigation-island-v2 玻璃岛）：项目按「项目时间」的年月分组折叠，首屏只显示折叠的时间分组头（含项目计数），不直接铺开项目；点击时间分组 → 侧栏展开该组项目、主区联动只显示该组项目（工具栏出现可清除的时间筛选 chip，再点分组头即折叠并恢复全部）；主区首页保留搜索框与状态筛选 chips（与时间筛选叠加过滤）；项目卡附**比价结论行**（最新版本最低/最高/价差与价差率，仅可折算合计、未计入家数如实标注——`project_summary` 实时装配，算不出即缺省不阻断）；新建比选项目（导航岛底部按钮）含「项目时间」字段（默认当天，侧栏按此时间分组，创建后所在分组自动展开）；点击项目进入工作区后侧栏展开「工作区功能」：**② 统一对比台账为主工作区项（打开项目即落②）**，①③④⑤ 收进「流程与留痕」紧凑次级组（计数徽章仅非零时显示）；
2. **② 统一对比台账**（V1 原始，异常线索最全）：**页签②整体占满一屏视口高度**（表格区在剩余空间内滚动，页面级不出滚动条）；台账标题旁**只看异常**过滤（一键隐藏无异常行，计数=旗标/未报/税率未给行数；表头/合计/差异行不受影响）；台账标题下方**比价摘要条**（一行：当前口径最低/最高/价差三个数字 + 价差率徽章 + 本口径无合计家数提示——只陈述算术事实，不做推荐）；台账标题旁**含税金额/未税金额切换**（分段控件；单元格、表头、合计、V2 差异行全口径联动；未税口径下税率未声明的格显示未税额 + `*` 标记，不当 0、不折算）；乙列"税率未给"、C07 ×2行、C09/C11 未报；丙 C04 乘积值 + 疑似抄错、C13 未报 + 附件未并入；丁 C14 整项口径 + 单位待澄清；**点击任意单元格 → 右侧推挤式抽屉**（与表格等高，默认宽 346px；中间有**可拖拽分隔条**：按住左右滑动调节表格/抽屉占比（范围 240–560px，表格保底 420px），双击恢复默认）：显示供应商/清单项、清单量·税率·单位、参考区间（未税）、未税/税额/含税、**问题提示（异常旗标直接说明问题是什么）**、来源定位与识别记录（折叠收纳）——项目模式来源定位旁附**「打开原件 ↗」**（`GET /api/files/{name}` 只读服务 inbox 原件，同名另存自动取最新时间戳变体，路径穿越已防护）；抽屉内**修改操作**（登记事件：申报税率/更正单价·数量·列示金额/补录行/剔重；**依据文件从已归档原件下拉选择 + 定位手填**——依据必须指向真实原件，杜绝手打文件名断证据链，上传新文件仍只走①收集箱；提交进③待确认队列留痕）与**修改历史**（合并人工事件与识别/澄清文件留痕，按时间倒序，含状态徽章）；
3. **③ 事件与澄清**：需补充事项（QB 编号、10 类、闭环状态）+ CLARIFY-01 / CHANGE-01 事件卡 → 差异预演 → 确认应用 → 台账切换版本（V1 澄清后 / V2 变更后）；
4. **④ 版本与差异**：三版本时间轴（留痕 3/11/15 条）、任意两版本差异表、操作记录（审计日志）；
5. **⑤ 导出交付（DD-UI 蒸馏版）**：一个版本下拉 + 一颗「下载交付包」主按钮（版本切换与 ctxbar 胶囊共享同一全局版本上下文）+ 一行证据（N 家供应商 · N 条已匹配 · 5 张工作表）+ 待补充事项折叠为一行摘要（查看详情展开，边界句「系统不推荐中标」常驻可见）+ 导出记录（含「标记为已交付评审」单向流转确认）+ 交付包说明收纳（5 表结构 / 三版互不覆盖 / 输出与原件物理分离）。主题为 ORBIS CI 2026 覆盖层 `ci-theme.css`（官方 tokens 适配，不改 vendored 文件）；旗标底线为 CI 粉（--orb-err），粉字一律加深 20% 保 AA 对比；首页零项目时呈现「从第一个项目开始」三步引导（证据链叙事 + 演示入口），AI 演示开关为 role=switch 且文案明确「仅切换事件 AI，不影响识别引擎」。

6. **⑥ 智慧报表**：AI 对话分析当前选中项目（OMPHPanel 对话面板 · SSE 流式回答 · Markdown 表格/列表 + chart JSON 块渲染为 orb 配色 SVG 图表）——LLM 经环境变量接入，未配置时页签整体离线并提示原因。

## 智慧报表（页签⑥ · LLM 对话分析，全部经环境变量接入）

- 功能：AI 读取**当前选中项目**的全量工作台数据（统一清单、多版本台账含未税/含税与行级旗标、事件、审计留痕），对话总结数据、对比供应商、解释异常；
- 图表约定：LLM 在回答中输出 chart JSON 代码块（`{"type":"bar|line","title","unit","data":[{"label","value"}]}`，≤12 项），前端解析为 SVG 图表；
- 环境变量（改后重启 `python server.py` 生效；KEY 一律不进代码/文件）：`AI_REPORT_API_KEY`（必填，缺失则页签⑥整体离线）、`AI_REPORT_API_BASE`（OpenAI 兼容端点，默认智谱 `https://open.bigmodel.cn/api/paas/v4`）、`AI_REPORT_MODEL`（默认 `glm-4.6`）；
- 红线写入系统提示词：未知值不当 0、异常只提示不改写、**不推荐中标/不评分/不排名**；数据上下文超 60KB 自动截断；会话历史仅存前端内存（按项目隔离，不落盘）；
- 本地链路测试：`python testdata/mock_llm.py`（8010 端口 mock LLM）+ `set AI_REPORT_API_KEY=test AI_REPORT_API_BASE=http://127.0.0.1:8010/v4` 后启动即可全流程演练；
- API：`GET /api/ai/status`（配置状态与缺失原因）· `POST /api/projects/{id}/ai-report`（`{"question","history"}`，SSE 帧 `data:{"delta"|"error"|"done"}`）。

## 红线（界面行为约束）

不出现"推荐中标/评分/排名"元素；未知值不当 0（未报/税率未给状态化）；异常只提示不改写（乙 C08 超区间线索跨版本保留）；原件永不覆盖（三版台账互不覆盖）；闭环只认 CLARIFY-01 依据（CHANGE-01 不误关异常事项）。

## 已知边界

- 「确认入账」为前端流程演示（不写库）；GC-017 的「登记事件」亦为演示（不触发重算），**新建项目的事件为真实链路**（登记→应用→引擎重算→新版本）；
- 新建比选项目已打通全流程：上传识别（收集箱拖拽或工作区「＋ 上传报价」小按钮）→ M4 匹配 → V1 原始台账 → 人工登记事件 → 确认应用生成 V1 澄清后（④版本差异/操作留痕）→ ⑤导出五表 xlsx（按版本真实下载）→ 标记已交付评审（状态机）；
- 仍为接口位/空状态：事件 AI 提取（路径B，离线置灰）、资格要求挂载（导出「资格材料清单」为空表）、供应商发票类型采集（M5 立项按未采集处理）、清单变更型事件（工程量重算 V2，走 GC-017 演示）；
- GC-017 工作台五页签的前端代码与 `/api/*`（bootstrap/ledger/issues/export）保留，首页经「载入演示项目」按钮或 `#/demo/…` hash 路由进入（只读演示）；
- **Hash 路由**（`#/` 首页含 q/pf/m 筛选参数；`#/p/{项目}/{页签}/{口径}/{版本}/{抽屉?}`；`#/demo/{页签}/{版本}/{口径}/{抽屉?}`）：刷新/分享恢复视图状态，`history.replaceState` 写入不产生历史噪音，手动改址触发 `hashchange` 恢复；
- **高风险操作确认**：「确认入账」与「标记为已交付评审」经统一确认弹层（说明后果 + 再想想），不再一键直通；
- **Toast**：常规 6.5s 自逝、失败/错误类常驻（手动关闭），每条带 ✕，堆叠上限 4；
- AI 提取/识别按钮为第三方接口位（离线置灰走人工路径）；
- 单位确认换算只支持"整项均分"口径（引擎限制，见仓库 README）。

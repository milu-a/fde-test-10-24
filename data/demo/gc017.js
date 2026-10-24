/* =====================================================================
 * 分包比选工作台 · 内置演示数据（项目 GC-017）
 * 数据来源：课程案例「报价各说各话，工程分包怎么比？」脱敏素材
 * 所有金额为演示用虚构数据；原始行与真实文件一一对应（含来源定位）。
 * 修改提示：raw 层只描述"供应商报了什么"；一切口径折算与修正
 * 由 data/app/engine.js 依据 rules + events 计算，勿在本文件手工改数。
 * ===================================================================== */
window.DEMO = (function () {
  "use strict";

  /* ---------- 统一清单（C01–C15）与参考区间（未税单价，元） ---------- */
  const catalog = [
    { id: "C01", name: "控制点复核",     unit: "点",   qty: 12, refLow: 144,  refHigh: 216 },
    { id: "C02", name: "地形测绘",       unit: "亩",   qty: 20, refLow: 176,  refHigh: 264 },
    { id: "C03", name: "建筑物沉降监测", unit: "点",   qty: 24, refLow: 72,   refHigh: 108 },
    { id: "C04", name: "基坑水平位移监测", unit: "点", qty: 18, refLow: 88,   refHigh: 132 },
    { id: "C05", name: "基坑竖向位移监测", unit: "点", qty: 18, refLow: 80,   refHigh: 120 },
    { id: "C06", name: "地下水位观测",   unit: "孔",   qty: 6,  refLow: 120,  refHigh: 180 },
    { id: "C07", name: "地表沉降监测",   unit: "点",   qty: 20, refLow: 64,   refHigh: 96 },
    { id: "C08", name: "低应变检测",     unit: "根",   qty: 60, refLow: 68,   refHigh: 102 },
    { id: "C09", name: "声波透射检测",   unit: "根",   qty: 12, refLow: 360,  refHigh: 540 },
    { id: "C10", name: "混凝土回弹检测", unit: "构件", qty: 30, refLow: 96,   refHigh: 144 },
    { id: "C11", name: "土工含水率试验", unit: "组",   qty: 10, refLow: 48,   refHigh: 72 },
    { id: "C12", name: "土工密度试验",   unit: "组",   qty: 10, refLow: 76,   refHigh: 114 },
    { id: "C13", name: "机械进出场",     unit: "项",   qty: 1,  refLow: 2400, refHigh: 3600 },
    { id: "C14", name: "测量设备使用",   unit: "台班", qty: 4,  refLow: 560,  refHigh: 840 },
    { id: "C15", name: "成果整理与报告", unit: "项",   qty: 1,  refLow: 1440, refHigh: 2160 }
  ];

  /* ---------- 四家原始报价行（V0 · 2026-09-18 收件） ----------
   * 口径: incl = 原报含税单价; excl = 原报未税单价
   * src: 来源定位（文件 + 页/行/条目），供回查弹窗使用
   * flags: 识别层/核对层在此行上发现的客观事实（引擎据此产异常线索）
   * ------------------------------------------------------------- */
  const suppliers = {
    "甲": {
      name: "甲方检测服务商", fileLabel: "甲方报价.xlsx", fileType: "excel",
      taxRate: 0.06, taxOrigin: "原报含税，税率6%",
      lines: catalog.map((c, i) => ({
        id: c.id, name: c.name, unit: c.unit, qty: c.qty, basis: "incl",
        price: { C01:190.8, C02:233.2, C03:95.4, C04:116.6, C05:106, C06:159, C07:84.8,
                 C08:90.1, C09:477, C10:127.2, C11:63.6, C12:100.7, C13:3180, C14:742, C15:1908 }[c.id],
        src: { kind: "table", file: "甲方报价.xlsx", sheet: "甲方含税报价", locator: `工作表「甲方含税报价」第${i + 2}行` },
        flags: []
      })),
      statedTotal: { incl: 40545.00, label: "文件列示合计 40,545.00" }
    },
    "乙": {
      name: "乙方检测服务商", fileLabel: "乙方报价.pdf", fileType: "pdf",
      taxRate: null, taxOrigin: "原报未税单价，税率未填（不得默认补写）",
      lines: [
        { id:"C01", name:"控制点复核", unit:"点", qty:12, basis:"excl", price:176.40,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第1行" }, flags:[] },
        { id:"C02", name:"地形测绘", unit:"亩", qty:20, basis:"excl", price:215.60,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第2行" }, flags:[] },
        { id:"C03", name:"沉降点观测（建筑物）", unit:"点", qty:24, basis:"excl", price:88.20,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第3行" },
          flags:[{ type:"alias", note:"原始名称「沉降点观测（建筑物）」，别名字典映射至 C03" }] },
        { id:"C04", name:"基坑水平位移监测", unit:"点", qty:18, basis:"excl", price:107.80,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第4行" }, flags:[] },
        { id:"C05", name:"基坑竖向位移监测", unit:"点", qty:18, basis:"excl", price:98.00,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第5行" }, flags:[] },
        { id:"C06", name:"地下水位观测", unit:"孔", qty:6, basis:"excl", price:147.00,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第6行" }, flags:[] },
        { id:"C07", name:"地表沉降监测", unit:"点", qty:20, basis:"excl", price:78.40,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第7行、第8行（两行相同）" },
          flags:[{ type:"dup", note:"同一分项出现两行，澄清确认后只计一次" }] },
        { id:"C08", name:"低应变检测", unit:"根", qty:60, basis:"excl", price:500.00,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第9行" },
          flags:[{ type:"range", note:"未税单价 500.00 超出参考区间上限 102.00（约 4.9 倍）" }] },
        { id:"C09", name:"声波透射检测", unit:"根", qty:12, basis:"excl", price:null,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第10行（有量无价）" },
          flags:[{ type:"nOp", note:"有数量无单价，未知值不作为 0" }] },
        { id:"C10", name:"混凝土回弹检测", unit:"构件", qty:30, basis:"excl", price:117.60,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第11行" }, flags:[] },
        { id:"C11", name:null, unit:null, qty:null, basis:"excl", price:null,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格（整项未出现）" },
          flags:[{ type:"missing", note:"清单 C11 土工含水率试验整项缺失" }] },
        { id:"C12", name:"土工密度试验", unit:"组", qty:10, basis:"excl", price:93.10,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第12行" }, flags:[] },
        { id:"C13", name:"机械进出场", unit:"项", qty:1, basis:"excl", price:2940.00,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第13行" }, flags:[] },
        { id:"C14", name:"测量设备使用", unit:"台班", qty:4, basis:"excl", price:686.00,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第14行" }, flags:[] },
        { id:"C15", name:"成果整理与报告", unit:"项", qty:1, basis:"excl", price:1764.00,
          src:{ kind:"pdf", file:"乙方报价.pdf", locator:"第1页 表格第15行" }, flags:[] }
      ],
      statedTotal: { incl: 58375.00, label: "文件列示合计 58,375.00（与明细加总差 200）" }
    },
    "丙": {
      name: "丙方检测服务商", fileLabel: "报价扫描-1/2.png", fileType: "scan",
      taxRate: 0.06, taxOrigin: "扫描件注明含税报价，税率6%",
      lines: [
        { id:"C01", name:"控制点复核", unit:"点", qty:12, basis:"incl", price:196.52, conf:0.97,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目1" }, flags:[] },
        { id:"C02", name:"地形测绘", unit:"亩", qty:20, basis:"incl", price:240.20, conf:0.97,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目2" }, flags:[] },
        { id:"C03", name:"建筑物沉降监测", unit:"点", qty:24, basis:"incl", price:98.26, conf:0.96,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目3" }, flags:[] },
        { id:"C04", name:"基坑水平位移监测", unit:"点", qty:18, basis:"incl", price:120.10, conf:0.62, statedIncl:2181.80,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目4" },
          flags:[{ type:"product", note:"原报金额 2,181.80 ≠ 18 × 120.10 = 2,161.80（多写 20.00），原值保留待澄清" }] },
        { id:"C05", name:"基坑竖向位移监测", unit:"点", qty:18, basis:"incl", price:109.18, conf:0.95,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目5" }, flags:[] },
        { id:"C06", name:"地下水位观测", unit:"孔", qty:6, basis:"incl", price:163.77, conf:0.93,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目6" }, flags:[] },
        { id:"C07", name:"地表沉降监测", unit:"点", qty:20, basis:"incl", price:87.34, conf:0.97,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目7" }, flags:[] },
        { id:"C08", name:"低应变检测", unit:"根", qty:60, basis:"incl", price:92.80, conf:0.97,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目8" }, flags:[] },
        { id:"C09", name:"声波透射检测", unit:"根", qty:12, basis:"incl", price:491.31, conf:0.91,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目9" }, flags:[] },
        { id:"C10", name:"混凝土回弹检测", unit:"构件", qty:30, basis:"incl", price:131.02, conf:0.96,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目10" }, flags:[] },
        { id:"C11", name:"土工含水率试验", unit:"组", qty:10, basis:"incl", price:65.51, conf:0.94,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目11" }, flags:[] },
        { id:"C12", name:"土工密度试验", unit:"组", qty:10, basis:"incl", price:103.72, conf:0.96,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目12" }, flags:[] },
        { id:"C13", name:null, unit:null, qty:1, basis:"incl", price:3392.00, conf:0.90,
          src:{ kind:"image", file:"data/assets/scan-bing-p2.png", locator:"报价扫描-2 费用附件 C-V1-附件1" },
          flags:[{ type:"notInTotal", note:"机械进出场 3,392.00 在附件页另列，未计入主报价页合计" }] },
        { id:"C14", name:"测量设备使用", unit:"台班", qty:4, basis:"incl", price:764.26, conf:0.95,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目13" }, flags:[] },
        { id:"C15", name:"成果整理与报告", unit:"项", qty:1, basis:"incl", price:1965.24, conf:0.96,
          src:{ kind:"image", file:"data/assets/scan-bing-p1.png", locator:"报价扫描-1 条目14" }, flags:[] }
      ],
      statedTotal: { incl: 38505.84, label: "主报价页合计 38,505.84（不含附件进出场费）" }
    },
    "丁": {
      name: "丁方服务商（微信）", fileLabel: "微信截图 ×2", fileType: "chat",
      taxRate: 0.06, taxOrigin: "聊天注明本报价含税，税率6%",
      lines: [
        { id:"C01", name:"控制点复核", unit:"点", qty:12, basis:"incl", price:198.43, conf:0.94,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目1" }, flags:[] },
        { id:"C02", name:"地形测绘", unit:"亩", qty:20, basis:"incl", price:242.53, conf:0.94,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目2" }, flags:[] },
        { id:"C03", name:"建筑物沉降监测", unit:"点", qty:24, basis:"incl", price:99.22, conf:0.95,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目3" }, flags:[] },
        { id:"C04", name:"基坑水平位移监测", unit:"点", qty:16, basis:"incl", price:121.26, conf:0.58,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目4" },
          flags:[{ type:"qtyDiff", note:"报 16 点，统一清单为 18 点" }] },
        { id:"C05", name:"基坑竖向位移监测", unit:"点", qty:18, basis:"incl", price:110.24, conf:0.95,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目5" }, flags:[] },
        { id:"C06", name:"地下水位观测", unit:"孔", qty:6, basis:"incl", price:165.36, conf:0.93,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目6" }, flags:[] },
        { id:"C07", name:"地表沉降监测", unit:"点", qty:20, basis:"incl", price:88.19, conf:0.94,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目7" }, flags:[] },
        { id:"C08", name:"低应变检测", unit:"根", qty:60, basis:"incl", price:93.70, conf:0.96,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目8" }, flags:[] },
        { id:"C09", name:"声波透射检测", unit:"根", qty:12, basis:"incl", price:496.08, conf:0.92,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目9" }, flags:[] },
        { id:"C10", name:"混凝土回弹检测", unit:"构件", qty:30, basis:"incl", price:132.29, conf:0.95,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目10" }, flags:[] },
        { id:"C11", name:"土工含水率试验", unit:"组", qty:10, basis:"incl", price:66.14, conf:0.93,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目11" }, flags:[] },
        { id:"C12", name:"土工密度试验", unit:"组", qty:10, basis:"incl", price:104.73, conf:0.94,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目12" }, flags:[] },
        { id:"C13", name:"机械进出场", unit:"项", qty:1, basis:"incl", price:3307.20, conf:0.94,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目13" }, flags:[] },
        { id:"C14", name:"测量设备使用", unit:"项", qty:1, basis:"incl", price:3086.72, conf:0.61,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目14" },
          flags:[{ type:"unitDiff", note:"按「项」计价，清单单位为「台班」，不能直接比较（聊天称台班数待确认）" }] },
        { id:"C15", name:"成果整理与报告", unit:"项", qty:1, basis:"incl", price:1984.32, conf:0.95,
          src:{ kind:"image", file:"data/assets/chat-ding-quote.png", locator:"报价截图 条目15" }, flags:[] }
      ],
      statedTotal: { incl: 41924.08, label: "消息所附报价合计 41,924.08" }
    }
  };

  /* ---------- 资格材料登记 ---------- */
  const qualifications = [
    { supplier: "甲", item: "营业执照摘要", status: "已提交", doc: "MAT-A-001", note: "有效" },
    { supplier: "甲", item: "检测资质摘要", status: "已提交", doc: "MAT-A-002", note: "有效" },
    { supplier: "乙", item: "营业执照摘要", status: "已提交", doc: "MAT-B-001", note: "有效" },
    { supplier: "乙", item: "检测资质摘要", status: "未提交", doc: "—", note: "待补充", open: true },
    { supplier: "丙", item: "营业执照摘要", status: "已提交", doc: "MAT-C-001", note: "有效" },
    { supplier: "丙", item: "检测资质摘要", status: "已提交", doc: "MAT-C-002", note: "有效" },
    { supplier: "丁", item: "营业执照摘要", status: "已提交", doc: "MAT-D-001", note: "有效" },
    { supplier: "丁", item: "检测资质摘要", status: "已提交", doc: "MAT-D-002", note: "2026-08-31 到期，续期材料未提供", open: true }
  ];

  /* ---------- 事件（上下文文件 → 结构化候选） ----------
   * status: pending(待确认) → applied(已应用·生成版本) ；作废事件保留不删
   * basis.locator 为条款级定位，供回查
   * --------------------------------------------------- */
  const events = [
    {
      id: "EVT-001", doc: "供应商澄清纪要 CLARIFY-01", docFile: "供应商澄清纪要.txt",
      kind: "澄清", effective: "2026-09-19 10:00", operator: "商务人员A",
      source: "ai", conf: 0.91, status: "pending", appliedVersion: null,
      items: [
        { type: "补充型",   supplier: "乙", itemId: null, field: "税率", old: "（未填，不得默认补写）", val: "6%",
          basis: "CLARIFY-01 第2行", note: "税率由澄清补 6%，随后按规则折算双口径" },
        { type: "补充型",   supplier: "乙", itemId: "C09", field: "未税单价", old: "（缺价）", val: "460.00 元/根 × 12 根",
          basis: "CLARIFY-01 第2行", note: "澄清补价后计入合计" },
        { type: "补充型",   supplier: "乙", itemId: "C11", field: "未税单价", old: "（整项缺失）", val: "62.00 元/组 × 10 组",
          basis: "CLARIFY-01 第2行", note: "澄清补项后计入合计" },
        { type: "修正型",   supplier: "乙", itemId: "C07", field: "取数规则", old: "两行重复", val: "只计一次（1,568.00）",
          basis: "CLARIFY-01 第2行", note: "原始两行记录保留" },
        { type: "修正型",   supplier: "乙", itemId: null, field: "总价", old: "列示 58,375.00", val: "按确认后明细重算",
          basis: "CLARIFY-01 第2行", note: "合计核对差 200 元，按明细重算" },
        { type: "修正型",   supplier: "丙", itemId: "C04", field: "含税金额", old: "2,181.80", val: "2,161.80（按乘积更正）",
          basis: "CLARIFY-01 第3行", note: "18 × 120.10，多写 20.00 更正并留痕" },
        { type: "补充型",   supplier: "丙", itemId: "C13", field: "含税金额", old: "（附件页未计入）", val: "加计一次 3,392.00",
          basis: "CLARIFY-01 第3行", note: "附件进出场费作为 C13 计入合计" },
        { type: "依据授予型", supplier: "丁", itemId: "C14", field: "折算依据", old: "按「项」计价，不可比", val: "1 项 = 4 台班，总价均分折算 771.68 元/台班",
          basis: "CLARIFY-01 第4行", note: "书面说明后解锁折算，不另加费用" },
        { type: "修正型",   supplier: "丁", itemId: "C04", field: "数量", old: "16 点", val: "18 点（单价不变，金额重算）",
          basis: "CLARIFY-01 第4行", note: "1,940.16 → 2,182.68" },
        { type: "资格状态型", supplier: "乙/丁", itemId: null, field: "资格材料", old: "乙缺检测资质；丁资质到期未续", val: "待补事项保持未关闭",
          basis: "CLARIFY-01 第5行", note: "仅口径澄清，不表示评审通过" }
      ]
    },
    {
      id: "EVT-002", doc: "项目变更通知 CHANGE-01", docFile: "项目变更通知.txt",
      kind: "变更", effective: "2026-09-20 09:00", operator: "项目负责人",
      source: "manual", conf: null, status: "pending", appliedVersion: null,
      items: [
        { type: "清单变更型", supplier: "全部", itemId: "C08", field: "工程量", old: "60 根", val: "72 根（四家沿用各自澄清后单价）",
          basis: "CHANGE-01 第1行", note: "另存 V2，保留 V1 基线与金额差异" },
        { type: "资格状态型", supplier: "乙/丁", itemId: "C08", field: "异常与待补", old: "—", val: "乙 C08 价格线索保留；资格待补保持未关闭",
          basis: "CHANGE-01 第3行", note: "线索与待办不随版本更迭丢失" }
      ]
    }
  ];

  /* ---------- 识别待确认队列（低置信/空值字段，不直接入账） ---------- */
  const confirmQueue = [
    { id: "Q1", supplier: "丙", itemId: "C04", field: "含税金额", candidate: "2,181.80", conf: 0.62,
      snippet: "扫码识别：金额位「2181.80」倒数第二位 8/6 置信度低", img: "data/assets/scan-bing-p1.png", status: "pending" },
    { id: "Q2", supplier: "丁", itemId: "C04", field: "数量", candidate: "16 点", conf: 0.58,
      snippet: "截图识别：数量位「16」，与清单 18 点不一致，需人工确认", img: "data/assets/chat-ding-quote.png", status: "pending" },
    { id: "Q3", supplier: "乙", itemId: "—", field: "税率", candidate: "（原文为空，不得猜测）", conf: 0.99,
      snippet: "PDF 文本抽取：表头注明「税费口径待商务确认」，税率列无值", img: null, status: "pending" }
  ];

  /* ---------- 验收基线（引擎计算后断言，任何不一致即缺陷） ---------- */
  const baselines = {
    V1: { "甲": 40545.00, "乙": 66511.82, "丙": 41877.84, "丁": 42166.60 },
    V2: { "甲": 41626.20, "乙": 72871.82, "丙": 42991.44, "丁": 43291.00 }
  };

  /* ---------- 其他演示项目（首页列表） ---------- */
  const otherProjects = [
    { id: "GC-020", name: "基坑监测分包", status: "待澄清", vendors: 3, done: 3, version: "V0", todos: 2, activity: "昨天 · 收到丙方澄清回复" },
    { id: "GC-011", name: "桥梁检测外委", status: "已交付评审", vendors: 5, done: 5, version: "V2", todos: 0, activity: "3 天前 · 台账交付评审组" },
    { id: "GC-009", name: "劳务分包（测量辅助）", status: "已归档", vendors: 4, done: 4, version: "V2", todos: 0, activity: "2026-09-02 · 定标归档" }
  ];

  return { project: { id: "GC-017", name: "园区测量检测分包", status: "待澄清", created: "2026-09-18" },
           catalog, suppliers, qualifications, events, confirmQueue, baselines, otherProjects };
})();

/* =====================================================================
 * 分包比选工作台 · 前端应用
 * 数据与计算全部来自本地服务（server.py）：
 *   /api/bootstrap   项目元数据（清单/供应商/事件/资格/回归自检/识别队列）
 *   /api/ledger/{s}  三阶段台账 —— 字段与 engine.ledger_to_dict 同构：
 *     rows[item][sup][instance] = { supplier, item, name, unit, qty, direction,
 *       orig_qty, stated_amount, note, orig_amount, ws, tax, hs, status,
 *       flags[], basis, source, tax_state, unit_state, instance }
 *     totals[sup] = { direction, ws, tax, hs, stated, flags[] }
 *     audit[] = { 操作时间, 操作者, 供应商, 分项, 原值, 新值, 变更依据 }
 *   /api/issues/{s}  需补充事项（源自 V1 原始台账，闭环按当前版本求值）
 *   /api/export/{s}  5-sheet 比选台账 xlsx 下载（企业模板副本填写）
 * 前端只做呈现与流程编排；金额、旗标、留痕一律以引擎结果为准。
 * ===================================================================== */
(function () {
  "use strict";
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (x) => (x == null ? "—" : Number(x).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  /* 项目时间分组（左侧导航按月折叠）：created_at 前缀即月份键 */
  const monthKey = (p) => String(p.created_at || "").slice(0, 7);
  const monthLabel = (k) => { const [y, m] = k.split("-"); return `${y}年${Number(m)}月`; };
  let SUPS = ["甲", "乙", "丙", "丁"];   // 由 bootstrap suppliers_order 数据驱动（上游 5c5b8f5）

  const OP_LABEL = {
    DECLARE_TAX: "申报税率", ADD_LINE: "补录漏报行", SET_FIELD: "更正字段",
    DEDUPE: "剔除重复行", RESOLVE_UNIT: "单位口径确认"
  };
  const STAGE_SHORT = { v1_raw: "V1 原始（澄清前）", v1_clarified: "V1 澄清后", v2: "V2 变更后" };
  /* 项目状态机（界面设计文档 §6.1）→ 徽章色 */
  const STATUS_CLS = {
    "配置中": "st-working", "收件中": "st-working", "归集中": "st-working",
    "待澄清": "st-clarify", "台账已出": "st-clarify",
    "已交付评审": "st-review", "已定标": "st-review", "已归档": "st-archived"
  };
  const STAGE_LABEL = { v1_raw: "V1 原始", v1_clarified: "V1 澄清后" };
  const EVENT_LABEL = {
    DECLARE_TAX: "申报税率", ADD_LINE: "补录漏报行", SET_FIELD: "更正字段",
    DEDUPE: "剔除重复行", RESOLVE_UNIT: "单位口径确认"
  };

  const state = {
    view: "home", tab: 2, stage: "v1_raw",
    unlocked: { v1_raw: true, v1_clarified: false, v2: false },
    boot: null, ledgers: {}, issues: {},
    queue: [], online: false, exports: [], manual: [],
    recognition: { engines: [], results: [] },
    projects: [], nextId: "", cur: null,   // cur = 当前打开的比选项目（新建项目空壳工作区）
    proj: null, projStage: "v1_raw",       // proj = board 数据；projStage = 项目台账当前查看版本
    anFilter: "全部", diffA: "v1_raw", diffB: "v1_clarified",
    projQ: "", projFilter: "全部",   // 首页项目检索与状态筛选（只作用于主区卡片）
    navMonth: null,                  // 左侧导航展开的时间分组（null = 全部折叠，主区显示全部）
    amountMode: "hs",                // 台账金额口径：hs=含税 / ws=未税（含税不可折算的格在未税口径显示未税额 + *）
    drawerKey: null,                 // 当前打开的单元格抽屉（"itemId|supplier"）
    drawerTrigger: null,             // 打开抽屉前的焦点元素（关闭时归还焦点）
    lastModalTrigger: null,          // 打开弹层前的焦点元素（关闭时归还焦点）
    lfUserCollapsed: null,            // 图表折叠：null=按视口高度自动（<900px 折叠），true/false=用户手动指定
    aiStatus: null, aiMsgs: [], aiBusy: false,   // 智慧报表：AI 服务状态 + 会话（内存，不落盘）
    onlyFlagged: false,              // 台账「只看异常」行过滤（会话级，不入 hash）
  };

  /* ---------------- 基础工具 ---------------- */
  /* toast：常规 6.5s 自逝；{ kind:"error", sticky:true } 常驻（toastErr 便捷封装）。
     每条带 ✕ 手动关闭；堆叠上限 4，超出裁掉最旧的（读屏经 #toasts 的 aria-live 播报）。 */
  function toast(msg, opts = {}) {
    const host = $("#toasts");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "orb-snack toast" + (opts.kind === "error" ? " toast-error" : "");
    el.innerHTML = `<div class="tmsg">${msg}</div><button class="tclose" title="关闭提示">✕</button>`;
    host.appendChild(el);
    while (host.children.length > 4) host.firstElementChild.remove();
    const close = () => el.remove();
    el.querySelector(".tclose").addEventListener("click", close);
    if (!opts.sticky) setTimeout(close, opts.ms || 6500);
  }
  const toastErr = (msg) => toast(msg, { kind: "error", sticky: true });
  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.json();
  }
  const curLedger = () => state.ledgers[state.stage];
  function qtyMap(stage) {
    const m = {};
    state.boot.catalog.items.forEach((it) => { m[it.id] = it.qty; });
    if (stage === "v2") m.C08 = String(Number(m.C08) + 12);  // CHANGE-01：60→72
    return m;
  }

  /* ---------------- 首页 ---------------- */
  function renderHome() {
    document.title = "分包比选工作台 · 比选项目列表";
    renderNav();   // 返回首页路径不经 renderCtx，需单独刷新导航活动态
    const q = state.projQ.trim().toLowerCase();
    const list = state.projects.filter((p) =>
      (!state.navMonth || monthKey(p) === state.navMonth) &&
      (state.projFilter === "全部" || p.status === state.projFilter) &&
      (!q || `${p.id} ${p.name}`.toLowerCase().includes(q)));
    const mc = $("#projMonthChip");
    if (mc) mc.style.display = state.navMonth ? "" : "none";
    const mct = $("#projMonthChipText");
    if (mct) mct.textContent = state.navMonth && state.navMonth.includes("-") ? monthLabel(state.navMonth) : state.navMonth || "";
    const pf = $("#projFilter");
    if (pf) pf.innerHTML = ["全部", ...new Set(state.projects.map((p) => p.status))].map((f) =>
      `<button data-pf="${esc(f)}" class="${state.projFilter === f ? "active" : ""}">${esc(f)}</button>`).join("");
    $("#projGrid").innerHTML = list.length ? list.map((p) => {
      const sm = p.summary || {};
      const cmp = sm.compare;
      const stageName = cmp ? (cmp.stage === "v1_clarified" ? "V1 澄清后" : "V1 原始") : "";
      return `
      <div class="proj-card orb-card orb-card-raised" data-proj="${esc(p.id)}">
        <div class="row1"><span class="pid">${esc(p.id)}</span><span class="pname">${esc(p.name)}</span>
          <span class="spacer" style="flex:1"></span><span class="badge ${STATUS_CLS[p.status] || ""}">${esc(p.status)}</span></div>
        <div class="meta"><span>负责人 <b>${esc(p.owner)}</b></span><span>报价 <b>${sm.suppliers || 0} 家</b></span>
          <span>台账 <b>${sm.has_ledger ? stageName || "V1 原始" : "—"}</b></span><span>待办事件 <b>${sm.pending_events || 0}</b> 条</span></div>
        ${cmp ? `<div class="cmp-line">比价（${stageName}）：最低 <b>${fmt(cmp.lo)} ${esc(cmp.lo_sup)}</b> · 最高 ${fmt(cmp.hi)} ${esc(cmp.hi_sup)} · 价差 <b>${fmt(cmp.spread)}</b>${cmp.rate != null ? `（${cmp.rate}%）` : ""}${cmp.excluded ? ` · ${cmp.excluded} 家未计入` : ""}</div>` : ""}
        <div class="act">${esc(p.created_at)} · ${esc(p.owner)} 创建项目 · 点击进入工作区</div>
      </div>`;
    }).join("")
      : (state.projects.length
        ? `<p style="grid-column:1/-1;color:var(--ink-4);font-size:13px;padding:10px 2px">没有符合条件的项目——试试点击时间分组或清除时间筛选，调整搜索关键字与状态筛选。</p>`
        : `<div class="onboard orb-card" style="grid-column:1/-1">
        <div class="ob-main">
          <span class="ob-cap">开始一轮新的比选</span>
          <h3>从第一个项目开始</h3>
          <p>把分散的报价，放进同一个工作空间。创建项目后，即可上传文件、核对差异并生成台账。</p>
          <button class="orb-btn orb-btn-primary" data-new-open>创建第一个项目 →</button>
          <p class="ob-demo">先看看效果？<button class="orb-link" data-demo-open>载入 GC-017 演示项目</button></p>
        </div>
        <div class="ob-steps">
          <span class="ob-chain">一轮比选，一条完整的证据链</span>
          <div class="ob-step"><i>01</i><div><b>建立项目，归集原件</b><span>上传各供应商报价，原件只读落位、永不覆盖。</span></div></div>
          <div class="ob-step"><i>02</i><div><b>统一口径，核对差异</b><span>引擎计算含税/未税，异常只提示、不改写原值。</span></div></div>
          <div class="ob-step"><i>03</i><div><b>保留记录，导出台账</b><span>事件确认后生成新版本，五表 xlsx 交付留痕。</span></div></div>
          <p class="ob-note">系统整理证据，商务与评审人员作出判断。</p>
        </div>
      </div>`);
    writeHash();
  }

  /* ---------------- 左侧导航岛（项目按时间分组折叠；展开某组时主区联动筛选） ---------------- */
  function renderNav() {
    const el = $("#navProjects");
    if (!el) return;
    const fw = $("#navFuncWrap");
    /* 工作区功能在「已选项目」或「演示工作区（cur=null 但 view=project）」时显示 */
    if (fw) fw.style.display = (state.cur || state.view === "project") ? "" : "none";
    if (!state.projects.length) {
      el.innerHTML = `<p class="nav-empty">暂无比选项目——点击下方「＋ 新建比选项目」创建。</p>`;
      return;
    }
    const groups = new Map();
    state.projects.forEach((p) => {
      const k = monthKey(p) || "未标注时间";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    });
    el.innerHTML = [...groups.keys()].sort((a, b) => b.localeCompare(a)).map((k) => {
      const open = state.navMonth === k;
      const items = open ? `<div class="nav-month-group">` + groups.get(k).map((p) => `
        <button class="nav-proj${state.cur && state.cur.id === p.id ? " active" : ""}" data-proj="${esc(p.id)}" title="${esc(p.name)}">
          <span class="nav-proj-copy"><b>${esc(p.id)}</b><span>${esc(p.name)}</span></span>
        </button>`).join("") + `</div>` : "";
      const label = k === "未标注时间" ? k : monthLabel(k);
      return `<button class="nav-month${open ? " open" : ""}" data-month="${esc(k)}" title="${open ? "点击折叠（右侧恢复显示全部）" : "点击展开，右侧显示该时间的项目"}">
          <span class="nav-month-caret">▶</span><span class="nav-month-label">${esc(label)}</span>
          <span class="nav-month-count">${groups.get(k).length}</span>
        </button>${items}`;
    }).join("");
  }

  /* ---------------- 工作区上下文条 ---------------- */
  function renderCtx() {
    renderNav();
    if (state.cur) {
      const pb = state.proj;
      const proj = (pb && pb.project) || state.cur;
      $("#ctxTitle").textContent = `${proj.id} · ${proj.name}`;
      document.title = `${proj.id} · ${proj.name} · 分包比选工作台`;
      $("#ctxBadge").textContent = proj.status;
      $("#ctxBadge").className = `badge ${STATUS_CLS[proj.status] || ""}`;
      const stages = pb && pb.ledgers ? Object.keys(pb.ledgers) : [];
      if (stages.length && !stages.includes(state.projStage)) {
        state.projStage = stages[stages.length - 1];   // 默认最新已确认版本
      }
      const stage = stages.length ? (stages.includes(state.projStage) ? state.projStage : stages[stages.length - 1]) : null;
      const stageLabel = { v1_raw: "V1 原始", v1_clarified: "V1 澄清后" };
      const supN = pb ? pb.suppliers_order.length : 0;
      const umN = pb && pb.counts ? pb.counts.unmatched : 0;
      const evN = pb && pb.counts ? pb.counts.pending_events : 0;
      $("#ctxMeta").innerHTML = `<span>负责人 <b>${esc(proj.owner)}</b></span><span>报价 <b>${supN} 家</b></span>
        <span>台账 <b>${stage ? stageLabel[stage] : "—"}</b></span><span>未关闭待办 <b>${umN + evN}</b></span>`;
      $("#verSwitch").innerHTML = stages.map((k) =>
        `<button data-ver="${k}" class="${k === stage ? "active" : ""}">${stageLabel[k]}</button>`).join("");
      $("#verLabel").style.display = stages.length ? "" : "none";
      $("#btnQuickUpload").style.display = "";
      $("#tabCnt1").style.display = ""; $("#tabCnt1").textContent = umN; $("#tabCnt1").className = "cnt" + (umN ? "" : " zero");
      $("#tabCnt3").style.display = ""; $("#tabCnt3").textContent = evN; $("#tabCnt3").className = "cnt" + (evN ? "" : " zero");
      return;
    }
    $("#btnQuickUpload").style.display = "none";
    $("#verSwitch").innerHTML = Object.keys(STAGE_SHORT).map((k) =>
      `<button data-ver="${k}" class="${state.stage === k ? "active" : ""}" ${state.unlocked[k] ? "" : "disabled"}>${STAGE_SHORT[k]}</button>`).join("");
    $("#verLabel").style.display = "";
    const led = curLedger();
    const openIssues = (state.issues[state.stage] || []).filter((x) => !x.closed).length;
    const pendQ = state.queue.filter((q) => q.status === "pending").length;
    $("#ctxTitle").textContent = `${state.boot.project.id} · 园区测量检测分包`;
    if (state.view === "project") document.title = `分包比选工作台 · ${state.boot.project.id} ${state.boot.project.name}`;
    $("#ctxBadge").textContent = "待澄清";
    $("#ctxBadge").className = "badge st-clarify";
    $("#ctxVersion").textContent = STAGE_SHORT[state.stage];
    $("#ctxMeta").innerHTML = `<span>状态 <b>待澄清</b></span><span>报价 <b>4/4 家</b></span>
      <span>台账版本 <b>${STAGE_SHORT[state.stage]}</b></span>
      <span>未关闭待办 <b>${openIssues + pendQ}</b></span><span>留痕 <b>${led.audit.length}</b> 条</span>`;
    $("#tabCnt1").style.display = "none";
    $("#tabCnt3").style.display = "none";
  }

  /* ---------------- 页签① 收集箱 ---------------- */
  const REC_FIELDS = ["行类型", "原始编码", "原始分项名称", "单位", "数量", "单价", "单价口径",
                      "税率", "原报金额", "待人工标记", "出处-定位"];
  function recCard(r) {
    const flagged = r.records.filter((x) => x["待人工标记"]).length;
    return `<div class="rec-card orb-card">
      <div class="rec-head"><b>${esc(r.file)}</b>
        <span class="bdg info">${esc(r.vendor_guess)}方候选</span>
        <span class="bdg ${r.needs_model ? "warn" : "petrol"}">${esc(r.channel_desc)}</span>
        ${r.engine ? `<span class="bdg">${esc(String(r.engine)).slice(0, 30)}</span>` : ""}
        <span class="bdg">置信度 ${esc(r.confidence || "—")}</span></div>
      <p>${esc(r.note)}</p>
      <div class="rec-meta">记录 <b>${r.records.length}</b> 条 · 待人工标记 <b class="${flagged ? "delta-minus" : ""}">${flagged}</b> 条 · 原件 ${esc(r.saved_as)}（只读落位，未覆盖） · ${esc(r.ts)}</div>
      ${r.records.length ? `<details><summary>展开 ${r.records.length} 条结构化记录（15 字段含出处，与台账流程同构）</summary>
        <div class="rec-table"><table class="orb-tbl"><thead><tr>${REC_FIELDS.map((f) => `<th>${f}</th>`).join("")}</tr></thead><tbody>
          ${r.records.map((x) => `<tr>${REC_FIELDS.map((f) => {
              const v = x[f] ?? "";
              const cls = f === "待人工标记" && v ? " delta-minus" : (f === "数量" || f === "单价" || f === "原报金额" ? "orb-num" : "");
              return `<td class="${cls}" ${f === "备注" ? "" : `title="${esc(x["备注"] || "")}"`}>${esc(String(v === null ? "（null）" : v))}</td>`;
            }).join("")}</tr>`).join("")}
        </tbody></table></div></details>` : ""}
    </div>`;
  }
  function renderInbox() {
    const engs = state.boot.recognition_engines || [];
    $("#dropzone").innerHTML = `拖拽文件到此处，或 <b>点击选择</b>　——　识别通道自动路由：Excel/PDF文字层走纯代码，扫描件/截图走模型引擎链`
      + `<div class="eng-chain">引擎链：${engs.map((e) => `<span class="${e.available ? "on" : "off"}">${e.available ? "●" : "○"} ${esc(e.name)}</span>`).join(" → ")}</div>`;

    $("#recList").innerHTML = state.recognition.results.length
      ? state.recognition.results.map(recCard).join("")
      : `<p class="hint" style="margin:4px 0 10px">${state.cur
          ? "尚无上传识别记录——拖拽或点击上方区域，登记该项目的第一份报价原件。"
          : "尚无上传识别记录。内置样例的识别结果已随项目预载（见下方原件归档区）。"}</p>`;

    if (state.cur) {
      const pb = state.proj;
      const myRes = pb ? state.recognition.results.filter((r) => (pb.file_ids || []).includes(r.id)) : [];
      $("#recList").innerHTML = myRes.length
        ? myRes.map(recCard).join("")
        : `<p class="hint" style="margin:4px 0 10px">尚无上传识别记录——拖拽或点击上方区域，登记该项目的第一份报价原件。</p>`;
      const pfiles = (pb ? pb.files : []).map((f) => {
        const kind = f.file.endsWith(".xlsx") ? ["excel", "XLSX"] : f.file.endsWith(".pdf") ? ["pdf", "PDF"] : ["scan", "IMG"];
        return `<div class="file-item"><span class="ficon ${kind[0]}">${kind[1]}</span>
          <span class="fname"><b>${esc(f.file)}</b><span>${esc(f.vendor || "?")}方候选 · ${esc(f.channel_desc || f.channel || "")} · ${esc(f.ts || "")}</span></span>
          <span class="badge st-archived" style="font-size:11px">原件只读</span></div>`;
      });
      $("#fileList").innerHTML = pfiles.join("");
      const um = pb && pb.match_report ? pb.match_report.unmatched : [];
      $("#queueList").innerHTML = um.length ? um.map((u) => `
        <div class="qcard low">
          <div class="thumb" style="display:flex;align-items:center;justify-content:center;color:var(--ink-4);font-size:11px">无图</div>
          <div>
            <div class="qhead"><b style="font-size:13px">${esc(u.vendor)} · ${esc(u.name || "（空名称行）")}</b>
              <span class="conf">未匹配 · 不入账</span></div>
            <p>${esc(u.basis)}　（文件：${esc(u.file)}）</p>
          </div>
        </div>`).join("")
        : `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">暂无待确认字段：识别结果中的低置信、缺失与未匹配字段会进入此队列，人工逐条确认后才入账。</p>`;
      return;
    }

    const files = [];
    SUPS.forEach((sup) => {
      const s = state.boot.suppliers[sup];
      const fname = s.file.split("/").pop();
      const kind = fname.endsWith(".xlsx") ? ["excel", "XLSX"] : fname.endsWith(".pdf") ? ["pdf", "PDF"] : ["scan", "IMG"];
      files.push(`<div class="file-item"><span class="ficon ${kind[0]}">${kind[1]}</span>
        <span class="fname"><b>${esc(fname)}</b><span>${sup} · 报价正件 ${esc(s.version)} · ${esc(s.direction)}口径 · 税率${esc(s.tax.state)}${s.tax.rate ? " " + Number(s.tax.rate * 100).toFixed(0) + "%" : ""} · 列示合计 ${fmt(s.stated_total)}</span></span>
        <span class="badge st-archived" style="font-size:11px">原件只读</span></div>`);
    });
    files.push(`<div class="file-item"><span class="ficon pdf">TXT</span>
      <span class="fname"><b>供应商澄清纪要 CLARIFY-01</b><span>事件文件 · ${esc(state.boot.events.clarify.doc)}</span></span>
      <span class="badge st-archived" style="font-size:11px">原件只读</span></div>`);
    files.push(`<div class="file-item"><span class="ficon pdf">TXT</span>
      <span class="fname"><b>项目变更通知 CHANGE-01</b><span>事件文件 · ${esc(state.boot.events.change.doc)}</span></span>
      <span class="badge st-archived" style="font-size:11px">原件只读</span></div>`);
    $("#fileList").innerHTML = files.join("");

    $("#queueList").innerHTML = state.queue.map((q) => `
      <div class="qcard ${q.conf < 0.7 ? "low" : ""}">
        ${q.asset ? `<img class="thumb" src="${q.asset}" alt="原文截图">` : `<div class="thumb" style="display:flex;align-items:center;justify-content:center;color:var(--ink-4);font-size:11px">无图（文本抽取）</div>`}
        <div>
          <div class="qhead"><b style="font-size:13px">${q.supplier} · ${esc(q.item)} ${esc(q.name || "")}</b>
            <span class="conf ${q.status === "done" ? "ok" : ""}">置信度 ${q.conf.toFixed(2)}${q.conf < 0.7 ? " · 低" : ""}</span></div>
          <p>${esc(q.note)}</p>
          <div class="ops">
            <button class="orb-btn orb-btn-sm orb-btn-primary" data-qok="${q.id}" ${q.status === "done" ? "disabled" : ""}>${q.status === "done" ? "已确认" : "确认入账"}</button>
            <button class="orb-btn orb-btn-sm orb-btn-neutral" data-qwait="${q.id}" ${q.status === "done" ? "disabled" : ""}>登记待澄清</button>
          </div>
        </div>
      </div>`).join("");
  }
  async function uploadFiles(fileList) {
    for (const f of fileList) {
      toast(`正在识别 <b>${esc(f.name)}</b>…（通道由引擎链自动路由，任何一环失败不硬猜）`);
      try {
        const q = state.cur ? `&project=${encodeURIComponent(state.cur.id)}` : "";
        const r = await fetch(`/api/recognize?filename=${encodeURIComponent(f.name)}${q}`,
          { method: "POST", body: f });
        const j = await r.json();
        if (j.error) { toastErr(`识别失败：${esc(j.error)}`); continue; }
        await loadRecognition();
        if (state.cur) {
          await loadProjectBoard();
          toast(`识别完成：<b>${esc(j.file)}</b> · ${esc(j.channel_desc)} · 记录 ${j.records.length} 条，已登记进项目并重算台账。`);
        } else {
          if (state.tab === 1) renderInbox();
          toast(`识别完成：<b>${esc(j.file)}</b> · ${esc(j.channel_desc)} · 记录 ${j.records.length} 条${j.needs_model ? "（已转人工，不硬猜）" : ""}`);
        }
      } catch (e) {
        toastErr(`识别请求失败：${esc(e.message)}——请确认已运行 python server.py`);
      }
    }
  }
  async function loadRecognition() {
    state.recognition = await getJSON("/api/recognition");
  }

  /* ---------------- 页签② 统一对比台账 ---------------- */
  function ledRawCell(itemId, sup) {
    return state.ledgers.v1_raw.rows[itemId][sup][0];
  }
  /* 口径求和：hs=计算含税 / ws=未税（税率未声明也有未税额，不涉及折算） */
  const sumLines = (lines, mode) => lines.reduce((a, c) => a + Number((mode === "ws" ? c.ws : c.hs) || 0), 0);
  const wsAst = '<i class="ws-ast" title="税率未声明：本列为未税额，含税口径不可折算（不当 0、不硬折算）">*</i>';
  /* 键盘可达：台账金额格可聚焦，回车/空格开抽屉，方向键在网格内移动（keydown 统一驱动） */
  const kbAttr = (label, flagged) => ` tabindex="0" role="button" aria-label="${esc(label + (flagged ? "（有异常旗标，回车查看追溯）" : ""))}"`;
  /* 比价摘要条：当前口径合计的最低/最高/价差三个数字 + 价差率徽章。
     只陈述算术事实，不做推荐（判断权在商务部）；本口径无合计（未报/不可折算）的家数如实标注，
     不当 0、不进极差——与合计行「—」同一套语义。 */
  function renderDecisionStrip(led, sups, ws) {
    const host = $("#decisionStrip");
    if (!host) return;
    const vals = sups.map((s) => {
      const t = led.totals[s] || {};
      const v = Number(ws ? t.ws : t.hs);
      return { s, v: Number.isFinite(v) && v > 0 ? v : null };
    });
    const ok = vals.filter((x) => x.v != null);
    host.hidden = ok.length < 2;
    if (ok.length < 2) return;
    const min = ok.reduce((a, b) => (b.v < a.v ? b : a));
    const max = ok.reduce((a, b) => (b.v > a.v ? b : a));
    const spread = max.v - min.v;
    const rate = min.v > 0 ? (spread / min.v * 100).toFixed(1) + "%" : "—";
    const excluded = sups.length - ok.length;
    host.innerHTML = `
      <span class="ds-cap">比价摘要 · ${ws ? "未税" : "含税"}合计（¥）</span>
      <span class="ds-item">最低 <b class="ds-n">${fmt(min.v)}</b><small>${esc(min.s)}</small></span>
      <span class="ds-item">最高 <b class="ds-n">${fmt(max.v)}</b><small>${esc(max.s)}</small></span>
      <span class="ds-item">价差 <b class="ds-n">${fmt(spread)}</b></span>
      <span class="orb-chip orb-chip-blue ds-badge" title="价差 ÷ 最低合计——算术事实，非评审意见">价差率 ${rate}</span>
      ${excluded ? `<span class="ds-note">${excluded} 家本口径无合计 · 未计入对比</span>` : ""}`;
  }
  /* 新项目台账：识别 → M4 匹配 → 引擎计算的 V1 原始/澄清后（orb-tbl 规格） */
  /* 「只看异常」按钮同步：计数 = 含旗标/未报/税率未给的行数（无论过滤开关） */
  function syncOnlyFlag(n) {
    const b = $("#btnOnlyFlag");
    if (!b) return;
    b.setAttribute("aria-pressed", String(!!state.onlyFlagged));
    b.classList.toggle("orb-btn-primary", !!state.onlyFlagged);
    b.classList.toggle("orb-btn-neutral", !state.onlyFlagged);
    b.textContent = n != null ? `只看异常（${n}）` : "只看异常";
  }
  function renderProjectLedger() {
    const pb = state.proj;
    const stageLabel = { v1_raw: "V1 原始", v1_clarified: "V1 澄清后" };
    const stages = pb && pb.ledgers ? Object.keys(pb.ledgers) : [];
    const stage = stages.includes(state.projStage) ? state.projStage : (stages[stages.length - 1] || "v1_raw");
    $("#ctxVersion").textContent = stages.length ? stageLabel[stage] : "未生成";
    $("#ctxVersion").className = "badge " + (stages.length ? "st-clarify" : "st-archived");
    syncAmountMode();
    $("#legendBar").classList.remove("hidden");
    const sups = pb ? pb.suppliers_order : [];
    const hasData = !!(pb && stages.length && sups.length);
    $("#ledgerEmpty").classList.toggle("hidden", hasData);
    $("#ledgerWrap").classList.toggle("hidden", !hasData);
    if (!hasData) { $("#decisionStrip").hidden = true; return; }
    const ws = state.amountMode === "ws";
    const led = pb.ledgers[stage];
    renderDecisionStrip(led, sups, ws);
    const rawLed = pb.ledgers.v1_raw;
    const head = `<tr><th class="l lock lock1">编号</th><th class="l lock lock2">名称</th><th class="lock lock3">单位</th>
      <th class="lock lock4">数量</th>${sups.map((v) => `<th>${esc(v)}${ws ? "未税" : "含税"}</th>`).join("")}</tr>`;
    const cellHtml = (cat, sup) => {
      const lines = (led.rows[cat.id] || {})[sup] || [];
      const p0 = lines[0];
      const title = p0 ? esc(p0.basis || p0.flags.join("；") || p0.note || "") : "";
      const src = ` data-src="${cat.id}|${sup}"`;
      const kb = (txt, flagged) => kbAttr(`${sup} · ${cat.id} ${cat.name}：${txt}`, flagged);
      if (!p0 || p0.status !== "已计算") return `<td class="amount st-missing"${src}${kb("未报")} title="${title}">未报</td>`;
      const flagged = lines.some((c) => c.flags.length);
      if (p0.hs === null) {
        /* 税率未给：含税口径显示状态文案（不当 0、不折算）；未税口径显示未税额 + * 标记 */
        if (ws) {
          return `<td class="amount st-pending${flagged ? " st-flag" : ""}"${src}${kb(`${fmt(sumLines(lines, "ws"))}（未税，税率未声明）`, flagged)} title="${title}">${fmt(sumLines(lines, "ws"))}${lines.length > 1 ? ` ×${lines.length}` : ""}${wsAst}</td>`;
        }
        return `<td class="amount st-pending${flagged ? " st-flag" : ""}"${src}${kb("税率未给，含税不可折算", flagged)} title="${title}">税率未给${lines.length > 1 ? ` ×${lines.length}` : ""}</td>`;
      }
      /* 澄清修正：与 V1 原始比对，数值/数量变化即浅蓝底 */
      let restated = "";
      if (stage === "v1_clarified" && rawLed) {
        const raw0 = ((rawLed.rows[cat.id] || {})[sup] || [])[0];
        if (raw0 && (Number(p0.qty) !== Number(raw0.qty) || Number(p0.hs) !== Number(raw0.hs) ||
            lines.length !== ((rawLed.rows[cat.id] || {})[sup] || []).length)) {
          restated = " st-restated";
        }
      }
      const val = fmt(sumLines(lines, state.amountMode));
      return `<td class="amount${restated}${flagged ? " st-flag" : ""}"${src}${kb(`${val}（${ws ? "未税" : "含税"}）`, flagged)} title="${title}">${val}</td>`;
    };
    let flaggedN = 0;
    const rows = pb.catalog.items.map((cat) => {
      const cells = sups.map((sup) => cellHtml(cat, sup)).join("");
      const anomalous = /st-flag|st-missing|st-pending/.test(cells);
      if (anomalous) flaggedN += 1;
      return `<tr${state.onlyFlagged && !anomalous ? ' class="row-hidden"' : ""}><td class="l lock lock1">${cat.id}</td><td class="l lock lock2" title="${esc(cat.name)}">${esc(cat.name)}</td>
      <td class="lock lock3">${esc(cat.unit)}</td>
      <td class="lock lock4">${esc(cat.qty)}</td>${cells}</tr>`;
    }).join("");
    const totBar = lfTotBar(led, sups, ws);
    const totalCell = (s) => {
      const t = led.totals[s] || {};
      const flags = t.flags || [];
      const top = (ws ? t.ws : t.hs) != null ? fmt(ws ? t.ws : t.hs) : "—";
      const sub = t.stated != null ? fmt(t.stated) : "—";
      const tip = flags.length ? ` title="${esc(flags.join("；"))}"` : "";
      return `<td class="${flags.length ? "st-flag " : ""}tcell"${tip}><span class="tdwrap">${totBar(s)}${top}<span class="t-sub">${sub}</span></span></td>`;
    };
    const totalRow = `<tr class="total"><td class="t-label lock" colspan="4" style="left:0">合计（上行：计算${ws ? "未税" : "含税"}；下行：原报列示）</td>
      ${sups.map(totalCell).join("")}</tr>`;
    $("#ledger").innerHTML = `<thead>${head}</thead><tbody>${rows}${totalRow}</tbody>`;
    syncOnlyFlag(flaggedN);
  }
  function renderLedger() {
    if (state.cur) return renderProjectLedger();
    $("#ctxVersion").textContent = STAGE_SHORT[state.stage];
    $("#ctxVersion").className = "badge st-clarify";
    $("#legendBar").classList.remove("hidden");
    $("#ledgerEmpty").classList.add("hidden");
    $("#ledgerWrap").classList.remove("hidden");
    const led = curLedger();
    const qm = qtyMap(state.stage);
    const ws = state.amountMode === "ws";
    renderDecisionStrip(led, SUPS, ws);
    syncAmountMode();
    const head = `<tr><th class="l lock lock1">编号</th><th class="l lock lock2">名称</th><th class="lock lock3">单位</th>
      <th class="lock lock4">数量</th>${SUPS.map((v) => `<th>${esc(v)}${ws ? "未税" : "含税"}</th>`).join("")}</tr>`;

    let flaggedN = 0;
    const rows = state.boot.catalog.items.map((cat) => {
      const per = led.rows[cat.id];
      const isV2Changed = state.stage === "v2" && cat.id === "C08";
      const cells = SUPS.map((sup) => {
        const lines = per[sup];
        const p0 = lines[0];
        const title = esc(p0.basis || p0.flags.join("；") || p0.note || "");
        const src = ` data-src="${cat.id}|${sup}"`;
        const kb = (txt, flagged) => kbAttr(`${sup} · ${cat.id} ${cat.name}：${txt}`, flagged);
        const flagged = lines.some((c) => c.flags.length);
        if (p0.status !== "已计算") return `<td class="amount st-missing"${src}${kb("未报", flagged)} title="${title}">未报</td>`;
        if (p0.hs === null) {
          /* 税率未给：含税口径显示状态文案（不当 0、不折算）；未税口径显示未税额 + * 标记 */
          if (ws) {
            return `<td class="amount st-pending${flagged ? " st-flag" : ""}"${src}${kb(`${fmt(sumLines(lines, "ws"))}（未税，税率未声明）`, flagged)} title="${title}">${fmt(sumLines(lines, "ws"))}${lines.length > 1 ? ` ×${lines.length}` : ""}${wsAst}</td>`;
          }
          return `<td class="amount st-pending${flagged ? " st-flag" : ""}"${src}${kb("税率未给，含税不可折算", flagged)} title="${title}">税率未给${lines.length > 1 ? ` ×${lines.length}` : ""}</td>`;
        }
        /* 状态底色：与 V1 原始比对，数值/数量变化即"澄清修正"；C08 在 V2 为"变更重算" */
        const raw = ledRawCell(cat.id, sup);
        const changed = Number(p0.qty) !== Number(raw.qty) || Number(p0.hs) !== Number(raw.hs) ||
          lines.length !== state.ledgers.v1_raw.rows[cat.id][sup].length;
        const st = isV2Changed ? " st-recomp" : (changed ? " st-restated" : "");
        const val = fmt(sumLines(lines, state.amountMode));
        return `<td class="amount${st}${flagged ? " st-flag" : ""}"${src}${kb(`${val}（${ws ? "未税" : "含税"}）`, flagged)} title="${title}">${val}</td>`;
      }).join("");
      const anomalous = /st-flag|st-missing|st-pending/.test(cells);
      if (anomalous) flaggedN += 1;
      return `<tr${state.onlyFlagged && !anomalous ? ' class="row-hidden"' : ""}><td class="l lock lock1">${cat.id}</td><td class="l lock lock2">${esc(cat.name)}</td>
        <td class="lock lock3">${esc(cat.unit)}</td>
        <td class="lock lock4">${qm[cat.id]}</td>${cells}</tr>`;
    }).join("");

    /* 合计（上行：计算口径随切换；下行：原报列示）与（V2）较V1差异 —— 与 M2 对比表 xlsx 同构 */
    const totTip = esc(SUPS.flatMap((s) => led.totals[s].flags.map((f) => `${s}：${f}`)).join("；"));
    const totBar = lfTotBar(led, SUPS, ws);
    const totalRow = `<tr class="total"><td class="t-label lock" colspan="4" style="left:0" title="${totTip}">合计（上行：计算${ws ? "未税" : "含税"}；下行：原报列示）</td>
      ${SUPS.map((s) => {
        const t = led.totals[s];
        const top = (ws ? t.ws : t.hs) != null ? fmt(ws ? t.ws : t.hs) : "—";
        const sub = t.stated != null ? fmt(t.stated) : "—";
        return `<td class="${t.flags.length ? "st-flag " : ""}tcell"><span class="tdwrap">${totBar(s)}${top}<span class="t-sub">${sub}</span></span></td>`;
      }).join("")}</tr>`;
    let deltaRow = "";
    if (state.stage === "v2") {
      const prev = state.ledgers.v1_clarified.totals;
      deltaRow = `<tr class="total"><td class="t-label lock" colspan="4" style="left:0">较V1差异（V2合计 − V1澄清后合计，${ws ? "未税" : "含税"}口径）</td>
        ${SUPS.map((s) => {
          const a = ws ? led.totals[s].ws : led.totals[s].hs, b = ws ? prev[s].ws : prev[s].hs;
          const d = a != null && b != null ? Number(a) - Number(b) : null;
          return `<td class="${d >= 0 ? "delta-plus" : "delta-minus"}">${d != null ? (d >= 0 ? "+" : "") + fmt(d) : "—"}</td>`;
        }).join("")}</tr>`;
    }
    $("#ledger").innerHTML = `<thead>${head}</thead><tbody>${rows}${totalRow}${deltaRow}</tbody>`;
    syncOnlyFlag(flaggedN);
  }
  /* 口径切换按钮活动态（静态骨架，状态在此同步） */
  function syncAmountMode() {
    document.querySelectorAll("#amountMode [data-amt]").forEach((b) =>
      b.classList.toggle("active", b.dataset.amt === state.amountMode));
  }

  /* ---------------- 单元格抽屉（推挤式：不遮挡表格 · 重点信息 + 异常旗标 + 修改登记 + 修改历史） ---------------- */
  function closeCellDrawer() {
    state.drawerKey = null;
    const d = $("#cellDrawer");
    if (d) d.classList.remove("open");
    const host = $(".drawer-host");
    if (host) host.classList.remove("drawer-open");
    const t = state.drawerTrigger;               // 关闭抽屉后焦点归还来源单元格（键盘路径）
    state.drawerTrigger = null;
    if (t && document.contains(t) && t.matches && t.matches("td.amount[data-src]")) t.focus();
    writeHash();
  }
  /* 修改历史：合并「事件（人工/AI 登记，含澄清文件路径）」与「版本留痕（识别与事件应用）」，按时间倒序 */
  function buildCellHistory(sup, itemId, pb, led) {
    const rows = [];
    ((pb && pb.events) || []).forEach((e) => {
      if (e.supplier !== sup || (e.item && e.item !== itemId)) return;
      rows.push({
        time: e.at || "", who: e.operator || "人工", kind: EVENT_LABEL[e.op] || e.op,
        change: (e.old ? `<s>${esc(e.old)}</s> → ` : "") + "<b>" + esc(e.new ?? payloadDesc(e)) + "</b>",
        st: e.status || "待确认", basis: e.evidence || ""
      });
    });
    ((led && led.audit) || []).forEach((o) => {
      if (o["供应商"] !== sup || o["分项"] !== itemId) return;
      rows.push({
        time: o["操作时间"] || "", who: o["操作者"] || "—", kind: "留痕",
        change: `${esc(o["原值"])} → <b>${esc(o["新值"])}</b>`,
        st: "已生效", basis: o["变更依据"] || ""
      });
    });
    rows.sort((a, b) => String(b.time).localeCompare(String(a.time)));
    return rows;
  }
  function histStCls(st) {
    return st === "已应用" || st === "已生效" ? "petrol" : (st === "待确认" ? "warn" : "");
  }
  /* 依据文件控件：从已归档原件中选择 + 定位手填——「无依据不改数」的机制化：
     依据必须指向真实存在的原件，杜绝手打文件名造成证据链断头；上传新文件仍只走
     ①收集箱（单一入口），表单里只做引用。files 缺省（示例环境无项目文件列表）回退手填。 */
  function evidenceFieldsHTML(files, idPrefix, defaultFile) {
    if (!files || !files.length) {
      return `<input class="orb-inp" id="${idPrefix}Basis" placeholder="如 供应商澄清纪要.pdf · 第2行">`;
    }
    const opts = files.map((f) =>
      `<option value="${esc(f.file)}"${f.file === defaultFile ? " selected" : ""}>${esc(f.file)}${f.vendor ? ` · ${esc(f.vendor)}方候选` : ""}</option>`).join("");
    return `<div class="ev-file-row">
      <select class="orb-inp" id="${idPrefix}File" title="依据必须指向已归档原件——新文件请先经①收集箱归档"><option value="">— 选择原件 —</option>${opts}</select>
      <input class="orb-inp" id="${idPrefix}Loc" placeholder="定位：第2行 / 页3 / B5" aria-label="依据定位"></div>`;
  }
  /* 组装依据字符串（与台账 p0.source 同构："文件 · 定位"）；未选原件返回空串 */
  function evidenceValue(idPrefix) {
    const sel = document.getElementById(idPrefix + "File");
    if (!sel) return (document.getElementById(idPrefix + "Basis").value || "").trim();
    const f = sel.value;
    if (!f) return "";
    const loc = (document.getElementById(idPrefix + "Loc").value || "").trim();
    return loc ? `${f} · ${loc}` : f;
  }

  function openCellDrawer(key) {
    const [itemId, sup] = key.split("|");
    const proj = !!state.cur;
    const pb = state.proj;
    const led = proj
      ? pb.ledgers[Object.keys(pb.ledgers).includes(state.projStage) ? state.projStage : "v1_raw"]
      : curLedger();
    const cat = (proj ? pb.catalog : state.boot.catalog).items.find((c) => c.id === itemId);
    const lines = (led.rows[itemId] || {})[sup] || [];
    const p0 = lines[0];
    state.drawerKey = key;
    state.drawerTrigger = document.activeElement;   // 记录来源焦点，closeCellDrawer 归还
    const d = $("#cellDrawer");
    if (!d) return;
    d.classList.add("open");
    const host = $(".drawer-host");
    if (host) host.classList.add("drawer-open");
    const flags = p0 ? (p0.flags || []) : [];
    const note = p0 ? (p0.note || "") : "";
    /* 重点：有问题的数据直接说清问题是什么 */
    const problem = (flags.length || note)
      ? `<div class="cd-problem"><b>问题提示 · 异常只提示不改写原值</b>${esc(flags.join("；"))}${flags.length && note ? "；" : ""}${esc(note)}</div>`
      : "";
    const facts = p0 ? `
      <div class="cd-facts">
        <div class="cd-fact"><div class="v">清单量</div><div class="n num">${esc(cat ? `${cat.qty} ${cat.unit}` : "—")}</div></div>
        <div class="cd-fact"><div class="v">税率</div><div class="n">${esc(p0.tax_state || "—")}</div></div>
        <div class="cd-fact"><div class="v">单位</div><div class="n">${esc(p0.unit_state || "—")}</div></div>
      </div>
      ${cat && cat.range ? `<div class="cd-range num">参考区间（未税）：${esc(cat.range[0])} – ${esc(cat.range[1])}${p0.ws != null && p0.unit_state === "已确认" ? " · 本行口径已确认可比" : ""}</div>` : ""}` : "";
    const money = p0 ? `
      <div class="cd-kv"><span class="k">原始报价</span><span class="num">${esc(p0.qty ?? "—")}${p0.orig_qty != null && Number(p0.orig_qty) !== Number(p0.qty) ? `（原报 ${esc(p0.orig_qty)}）` : ""}${p0.stated_amount != null ? ` · 列示 ${fmt(p0.stated_amount)}` : ""}</span></div>
      <div class="cd-kv"><span class="k">未税 / 税额 / 含税</span><span class="num">${p0.ws != null ? fmt(p0.ws) : "—"} / ${p0.tax != null ? fmt(p0.tax) : "—"} / ${p0.hs != null ? fmt(p0.hs) : "不可折算"}</span></div>
      ${p0.basis ? `<div class="cd-kv"><span class="k">折算依据</span><span>${esc(p0.basis)}</span></div>` : ""}
      ${lines.length > 1 ? `<div class="cd-kv"><span class="k">行数</span><span>该清单项共 ${lines.length} 行报价（重复/分列原样保留，见旗标）</span></div>` : ""}` : "";
    /* 来源与原件（折叠收纳，保持抽屉轻量；每项数字有出处） */
    let srcHtml = "";
    if (proj) {
      const recs = (pb.records[sup] && pb.records[sup].records) || [];
      const srcParts = p0 ? String(p0.source || "").split(" · ") : [];
      const srcFile = srcParts[0] || "", srcLoc = srcParts.slice(1).join(" · ");
      const recRows = recs.filter((r) => r["行类型"] !== "说明");
      const srcLink = p0 && srcFile ? `　<a class="orb-link" href="/api/files/${encodeURIComponent(srcFile)}" target="_blank" rel="noopener" title="在浏览器中打开只读原件（同名另存取最新）">打开原件 ↗</a>` : "";
      srcHtml = `<div class="cd-kv"><span class="k">来源定位</span><span>${esc(p0 ? p0.source || "—" : "—")}${srcLink}</span></div>` + (recRows.length ? `
      <details class="cd-src"><summary>识别记录（${recRows.length} 行 · read-file 15 字段）</summary>
        <div class="src-table"><table class="orb-tbl"><thead><tr><th>原始编码</th><th>名称</th><th class="orb-num">数量</th><th class="orb-num">单价</th><th>税率</th><th class="orb-num">原报金额</th><th>定位</th></tr></thead><tbody>
        ${recRows.map((r) => `<tr${srcFile && r["出处-文件"] === srcFile && r["出处-定位"] === srcLoc ? ' style="background:var(--orb-p50);box-shadow:inset 3px 0 0 var(--orb-primary)"' : ""}>
          <td>${esc(r["原始编码"])}</td><td>${esc(r["原始分项名称"])}</td><td class="orb-num">${esc(r["数量"])}</td><td class="orb-num">${esc(r["单价"])}</td><td>${esc(r["税率"])}</td><td class="orb-num">${esc(r["原报金额"])}</td><td>${esc(r["出处-定位"])}</td></tr>`).join("")}
        </tbody></table></div></details>` : "");
    } else {
      const srcParts = String(p0 ? p0.source : "").split(" · ");
      const srcFile = srcParts[0] || "";
      const asset = state.boot.asset_map[srcFile] || "";
      srcHtml = `<div class="cd-kv"><span class="k">来源定位</span><span>${esc(p0 ? p0.source || "—" : "—")}</span></div>` + (asset ? `
      <details class="cd-src"><summary>查看原件截图</summary><div class="src-img"><img src="${asset}" alt="原件预览"></div></details>` : "");
    }
    /* 修改区：仅项目工作台（GC-017 示例走③的事件演示）；走既有事件链，无依据不改数 */
    const defOp = !p0 || p0.status !== "已计算" ? "ADD_LINE" : (p0.hs === null ? "DECLARE_TAX" : "SET_FIELD:unit_price");
    const editSec = proj ? `
      <div class="cd-sec"><b class="cd-sec-t">修改该单元格（登记事件 · 依据必填）</b>
        <div class="fld"><label>修改类型</label>
          <select class="orb-inp" id="cdOp">
            <option value="DECLARE_TAX"${defOp === "DECLARE_TAX" ? " selected" : ""}>申报税率（税率未给时）</option>
            <option value="SET_FIELD:unit_price"${defOp === "SET_FIELD:unit_price" ? " selected" : ""}>更正单价</option>
            <option value="SET_FIELD:qty"${defOp === "SET_FIELD:qty" ? " selected" : ""}>更正数量</option>
            <option value="SET_FIELD:stated_amount"${defOp === "SET_FIELD:stated_amount" ? " selected" : ""}>更正列示金额</option>
            <option value="ADD_LINE"${defOp === "ADD_LINE" ? " selected" : ""}>补录漏报行（填 数量×单价 或 整项金额）</option>
            <option value="DEDUPE">剔除重复行（无需新值）</option>
          </select></div>
        <div class="fld"><label>新值 <i>*</i></label><input class="orb-inp" id="cdVal" placeholder="如 6% / 460 / 18 / 12×460"></div>
        <div class="fld"><label>依据文件 + 定位 <i>*无依据不改数 · 从已归档原件选择</i></label>${evidenceFieldsHTML(pb.files, "cdEv", String(p0 && p0.source || "").split(" · ")[0] || "")}</div>
        <button class="orb-btn orb-btn-primary" id="cdSubmit">提交修改 → 待确认队列</button>
        <p class="orb-meta" style="margin-top:8px">提交即登记事件并留痕（下方历史可见）；在③事件与澄清确认应用后引擎重算、生成新版本。</p>
      </div>` : `
      <div class="cd-sec"><b class="cd-sec-t">修改</b><p class="orb-meta">示例环境（GC-017 演示）不在抽屉内直接修改；实际项目工作台此处可登记修改事件。</p></div>`;
    /* 修改历史 */
    const hist = buildCellHistory(sup, itemId, pb, led);
    const histSec = `<div class="cd-sec"><b class="cd-sec-t">修改历史（人工 / 识别与澄清文件）</b>
      ${hist.length ? hist.map((h) => `
        <div class="cd-hist-row">
          <span class="cd-hist-change">${h.kind} · ${h.change}</span>
          <span class="bdg ${histStCls(h.st)}">${esc(h.st)}</span>
          <span class="cd-hist-meta num">${esc(h.time)} · ${esc(h.who)}${h.basis ? " · 依据：" + esc(h.basis) : ""}</span>
        </div>`).join("")
      : `<p class="orb-meta">该单元格暂无修改记录——识别入账与事件应用（含澄清文件路径）都会在此留痕。</p>`}
    </div>`;
    $("#cdBody").innerHTML = `
      <div class="cd-title">${esc(sup)} · ${esc(itemId)} ${esc(cat ? cat.name : "")}</div>
      <p class="orb-meta">第 1 行 · ${esc(p0 ? p0.status : "无计算行")}${lines.length > 1 ? ` · 共 ${lines.length} 行` : ""}</p>
      ${facts}
      ${money}
      ${problem}
      ${srcHtml}
      ${editSec}
      ${histSec}`;
    $("#cdBody").scrollTop = 0;
    writeHash();
  }
  async function submitDrawerEdit() {
    if (!state.cur || !state.drawerKey) return;
    const [op, field] = $("#cdOp").value.split(":");
    const nv = $("#cdVal").value.trim(), basis = evidenceValue("cdEv");
    const [itemId, sup] = state.drawerKey.split("|");
    if (op !== "DEDUPE" && !nv) { toast("登记失败：新值必填。"); return; }
    if (!basis) { toast("登记失败：请选择依据原件并填写定位——无依据不改数。"); return; }
    let payload = null, newVal = nv;
    if (op === "DECLARE_TAX") {
      const m = nv.match(/^([\d.]+)\s*%$/);
      newVal = m ? String(Number(m[1]) / 100) : nv;
    } else if (op === "ADD_LINE") {
      const mm = nv.match(/^([\d.]+)\s*[×xX]\s*([\d.]+)$/);
      payload = mm ? { qty: mm[1], unit_price: mm[2] } : { stated_amount: nv };
    }
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.cur.id)}/events`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, supplier: sup, item: itemId, field: field || null, new: newVal, payload, evidence: basis, note: "台账单元格抽屉修改", operator: "商务人员A" })
      });
      const j = await r.json();
      if (!r.ok) { toastErr(`登记失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      toast(`修改已登记为事件 <b>${esc(j.event.id)}</b>（待确认·已留痕）——在③事件与澄清确认应用后引擎重算生效。`);
      await loadProjectBoard();   // 完成后重取台账，并重开本抽屉以刷新历史
    } catch (e) {
      toastErr(`登记失败：${esc(e.message)}——请确认已运行 python server.py`);
    }
  }

  /* ---------------- 页签③ 事件与澄清 ---------------- */
  function payloadDesc(a) {
    if (a.op === "ADD_LINE" && a.payload) {
      const p = a.payload;
      return p.unit_price ? `${p.qty}${p.unit || ""}×${p.unit_price}` : `整项 ${p.stated_amount || "—"}`;
    }
    if (a.op === "RESOLVE_UNIT" && a.payload) return `1${a.payload.quote_unit}=${a.payload.items_per_quote_unit}台班`;
    return "—";
  }
  /* 页签③ 异常旗标分类（项目模式筛选 chips 由实际旗标动态生成，与 demo 模式同构） */
  const FLAG_CAT = [
    [/税率|税额/, "税率"], [/重复/, "重复"], [/参考区间|异常低价|区间/, "区间"],
    [/数量/, "数量"], [/合计/, "合计"], [/列示|抄写|不一致|差额/, "抄写"],
    [/单位/, "单位"], [/漏报|未报|缺失/, "漏报"], [/附件|未并入/, "附件"], [/发票/, "发票"]
  ];
  const flagCat = (f) => { const hit = FLAG_CAT.find(([re]) => re.test(f)); return hit ? hit[1] : "其他"; };
  function renderEvents() {
    if (state.cur) {
      const pb = state.proj;
      const stages = Object.keys(pb && pb.ledgers ? pb.ledgers : {});
      const led = stages.length ? pb.ledgers[stages.includes(state.projStage) ? state.projStage : stages[0]] : null;
      /* 异常与待核查：当前版本引擎行级旗标聚合（状态型旗标按供应商折叠，原值保留） */
      if (led) {
        const seen = new Set();
        const items = [];
        pb.catalog.items.forEach((cat) => pb.suppliers_order.forEach((sup) => {
          ((led.rows[cat.id] || {})[sup] || []).forEach((c) => {
            (c.flags || []).forEach((f) => {
              const collapse = f.includes("税率未给") || f.includes("相关口径合计不完整");
              const key = collapse ? `${sup}|${f}` : `${sup}|${cat.id}|${f}`;
              if (seen.has(key)) return;
              seen.add(key);
              items.push({ sup, catId: cat.id, f, collapse, cat: flagCat(f) });
            });
          });
        }));
        const cats = [...new Set(items.map((x) => x.cat))];
        if (!cats.includes(state.anFilter)) state.anFilter = "全部";   // 跨项目残留的筛选类别安全复位
        $("#anFilter").innerHTML = ["全部", ...cats].map((x) =>
          `<button data-anf="${esc(x)}" class="${state.anFilter === x ? "active" : ""}">${esc(x)}</button>`).join("");
        const rows = items.filter((x) => state.anFilter === "全部" || x.cat === state.anFilter)
          .map((x) => `<div class="an-row"><span class="cls"><span class="bdg info">${esc(x.sup)}${x.collapse ? "" : " · " + esc(x.catId)}</span></span>
            <span class="txt"><b>${esc(x.f)}</b><small>引擎行级旗标 · 异常只提示不改写原值</small></span>
            <span class="st"><span class="tag-open">● 待核查</span></span></div>`);
        $("#anList").innerHTML = rows.length ? rows.join("")
          : `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">当前版本无该类事项。</p>`;
      } else {
        $("#anFilter").innerHTML = "";
        $("#anList").innerHTML = `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">暂无异常事项：报价归集并生成台账后，系统核对发现的异常会列在这里。</p>`;
      }
      $("#evtEntries").innerHTML = `
        <button class="orb-btn orb-btn-primary" id="btnManual">＋ 登记事件（人工路径 · 离线可用）</button>
        <button class="orb-btn orb-btn-neutral" id="btnAI" ${state.online ? "" : "disabled"} title="${state.online ? "第三方模型接口：从纪要提取事件候选（M4 接口位）" : "当前离线：第三方模型接口不可用，请使用人工登记路径"}">⚡ AI 提取事件${state.online ? "" : "（离线不可用）"}</button>
        <span style="font-size:12px;color:var(--ink-4);align-self:center">事件候选 → 人工逐条确认 → 引擎按序应用重算；确认前不动台账。</span>`;
      const evs = (pb && pb.events ? pb.events : []).slice().reverse();
      $("#evtCards").innerHTML = evs.length ? evs.map((e) => {
        const st = e.status || "待确认";
        const badge = st === "已应用" ? `<span class="bdg petrol">已应用 · 生成新版本</span>`
          : st === "已作废" ? `<span class="bdg">已作废</span>` : `<span class="bdg warn">待确认</span>`;
        const target = `${esc(e.supplier)}${e.item ? " · " + esc(e.item) : ""}${e.field ? " · " + esc(e.field) : ""}`;
        const newTxt = e.op === "RESOLVE_UNIT" && e.payload
          ? `1${esc(e.payload.quote_unit || "项")}=${esc(e.payload.items_per_quote_unit)}台班（总价均分）` : esc(e.new || "—");
        const ops = st === "待确认"
          ? `<button class="orb-btn orb-btn-sm orb-btn-accent" data-evok="${esc(e.id)}">确认并应用 → 重算台账</button>
             <button class="orb-btn orb-btn-sm orb-btn-neutral" data-evdis="${esc(e.id)}">作废</button>` : "";
        return `<div class="evt-card orb-card"><div class="ehead"><b>${esc(e.id)} · ${esc(EVENT_LABEL[e.op] || e.op)}</b>${badge}
          <span class="spacer" style="flex:1"></span><span class="esub">${esc(e.at)} · ${esc(e.operator)}</span></div>
        <div class="evt-items"><div class="evt-item"><span class="etype">${esc(EVENT_LABEL[e.op] || e.op)}</span>
          <span class="target">${target}</span>
          <span class="delta">${e.old ? `<s>${esc(e.old)}</s> → ` : ""}<b>${newTxt}</b></span></div></div>
        <div class="eops">${ops}<span style="font-size:12px;color:var(--ink-4)">依据：${esc(e.evidence)}${e.note ? " · " + esc(e.note) : ""}</span></div>
      </div>`;
      }).join("")
        : `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">尚无事件：经下方人工路径登记澄清（如给「税率未给」的供应商补税率、剔除重复行、更正抄写差错），确认应用后生成 <b>V1 澄清后</b> 版本——依据文件必填，无依据不改数。</p>`;
      return;
    }
    const issues = state.issues[state.stage] || [];
    const cats = [...new Set(issues.map((i) => i.cat))];
    $("#anFilter").innerHTML = ["全部", ...cats].map((f) =>
      `<button data-anf="${f}" class="${state.anFilter === f ? "active" : ""}">${f}</button>`).join("");
    const list = issues.filter((i) => state.anFilter === "全部" || i.cat === state.anFilter);
    $("#anList").innerHTML = list.length ? list.map((i) => `
      <div class="an-row ${i.closed ? "closed" : ""}">
        <span class="cls"><span class="bdg info">${esc(i.cat)}</span></span>
        <span class="txt"><b class="num">${esc(i.supplier)}${i.item && i.item !== "—" && i.item !== "资质" ? " · " + esc(i.item) : ""}</b>　${esc(i.problem)}
          <small>${esc(i.no)} · 所需材料：${esc(i.material)} · 依据：${esc(i.basis)}</small></span>
        <span class="st">${i.closed ? '<span class="tag-closed">✓ 已澄清关闭</span>' : '<span class="tag-open">● 待补充</span>'}</span>
      </div>`).join("") : `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">当前版本无该类事项。</p>`;

    $("#evtEntries").innerHTML = `
      <button class="orb-btn orb-btn-primary" id="btnManual">＋ 登记事件（人工路径 · 离线可用）</button>
      <button class="orb-btn orb-btn-neutral" id="btnAI" ${state.online ? "" : "disabled"} title="${state.online ? "第三方模型接口：从纪要提取事件候选（M4 接口位）" : "当前离线：第三方模型接口不可用，请使用人工登记路径"}">⚡ AI 提取事件${state.online ? "" : "（离线不可用）"}</button>
      <span style="font-size:12px;color:var(--ink-4);align-self:center">事件候选 → 人工逐条确认 → 引擎按序应用重算；确认前不动台账。</span>`;

    const cl = state.boot.events.clarify, ch = state.boot.events.change;
    $("#evtCards").innerHTML = `
      <div class="evt-card orb-card">
        <div class="ehead"><b>EVT-001 · ${esc(cl.id)} 供应商澄清纪要</b><span class="bdg info">澄清</span>
          <span class="bdg">${state.unlocked.v1_clarified ? "已应用 · 生成 V1 澄清后" : "待确认"}</span>
          <span class="spacer" style="flex:1"></span><span class="esub">生效 ${esc(cl.at)} · 操作者 ${esc(cl.operator)}</span></div>
        <div class="evt-items">${cl.actions.map((a) => `
          <div class="evt-item"><span class="etype">${OP_LABEL[a.op] || esc(a.op)}</span>
            <span class="target">${esc(a.supplier)}${a.item ? " · " + esc(a.item) : ""}${a.field ? " · " + esc(a.field) : ""}</span>
            <span class="delta">${a.old ? `<s>${esc(a.old)}</s> → ` : ""}<b>${esc(a.new || payloadDesc(a))}</b>　<span style="color:var(--ink-4)">${esc(a.note || "")}</span></span>
          </div>`).join("")}</div>
        <div class="eops">
          ${state.unlocked.v1_clarified
            ? `<button class="orb-btn orb-btn-sm orb-btn-neutral" data-diffjump="v1_clarified">查看差异表（V1 原始 → V1 澄清后）</button>`
            : `<button class="orb-btn orb-btn-sm orb-btn-neutral" data-dry="v1_clarified">差异预演（dry-run）</button>
               <button class="orb-btn orb-btn-sm orb-btn-accent" data-apply="v1_clarified">确认并应用 → 生成 V1 澄清后</button>`}
          <span style="font-size:12px;color:var(--ink-4)">依据：${esc(cl.doc)}</span>
        </div>
      </div>
      <div class="evt-card orb-card change">
        <div class="ehead"><b>EVT-002 · ${esc(ch.id)} 项目变更通知</b><span class="bdg petrol">变更</span>
          <span class="bdg">${state.unlocked.v2 ? "已应用 · 生成 V2 变更后" : "待确认"}</span>
          <span class="spacer" style="flex:1"></span><span class="esub">生效 ${esc(ch.at)} · 操作者 ${esc(ch.operator)}</span></div>
        <div class="evt-items">${Object.entries(ch.qty_overrides).map(([item, q]) => `
          <div class="evt-item"><span class="etype">清单变更型</span>
            <span class="target">全部供应商 · ${esc(item)} · 工程量</span>
            <span class="delta"><s>60 根</s> → <b>${esc(q)} 根</b>　<span style="color:var(--ink-4)">四家沿用各自已澄清的单价与税率</span></span>
          </div>`).join("")}</div>
        <div class="eops">
          ${state.unlocked.v2
            ? `<button class="orb-btn orb-btn-sm orb-btn-neutral" data-diffjump="v2">查看差异表（V1 澄清后 → V2）</button>`
            : `<button class="orb-btn orb-btn-sm orb-btn-neutral" data-dry="v2" ${state.unlocked.v1_clarified ? "" : "disabled"}>差异预演（dry-run）</button>
               <button class="orb-btn orb-btn-sm orb-btn-accent" data-apply="v2" ${state.unlocked.v1_clarified ? "" : "disabled"}>确认并应用 → 生成 V2 变更后</button>`}
          <span style="font-size:12px;color:var(--ink-4)">依据：${esc(ch.doc)} · 乙C08区间线索与资格待补保持未关闭</span>
        </div>
      </div>` + state.manual.map((m) => `
      <div class="evt-card orb-card"><div class="ehead"><b>${esc(m.id)} · 人工登记事件</b><span class="bdg">待确认</span>
        <span class="spacer" style="flex:1"></span><span class="esub">${esc(m.time)} · ${esc(m.op)}</span></div>
      <div class="evt-items"><div class="evt-item"><span class="etype">${esc(m.type)}</span>
        <span class="target">${esc(m.target)}</span><span class="delta">${esc(m.detail)}　<span class="basis-link">依据：${esc(m.basis)}</span></span></div></div>
      <div class="eops"><span style="font-size:12px;color:var(--ink-4)">示例环境：已登记并留痕，未触发引擎重算。</span></div>
    </div>`).join("");
  }

  /* ---------------- 差异预演（dry-run，客户端对比两阶段 Ledger） ---------------- */
  function stageCell(led, itemId, sup) {
    const lines = led.rows[itemId][sup];
    const p0 = lines[0];
    if (p0.status !== "已计算") return { text: "未报", qty: null, n: lines.length };
    if (p0.hs === null) return { text: "税率未给", qty: p0.qty, n: lines.length };
    return { text: fmt(lines.reduce((a, c) => a + Number(c.hs || 0), 0)), qty: p0.qty, n: lines.length };
  }
  function dryRun(target) {
    const cur = curLedger(), tgt = state.ledgers[target];
    $("#mDryTitle").textContent = `差异预演 · ${STAGE_SHORT[state.stage]} → ${STAGE_SHORT[target]}`;
    $("#mDrySum").innerHTML = SUPS.map((s) => {
      const a = cur.totals[s], b = tgt.totals[s];
      const hsTxt = a.hs != null || b.hs != null ? `${fmt(a.hs)} → ${fmt(b.hs)}` : "含税不可折算 → " + fmt(b.hs);
      const d = a.hs != null && b.hs != null ? Number(b.hs) - Number(a.hs) : null;
      return `<div class="sumcard orb-card orb-card-raised"><div class="v">${s} 含税总价</div><div class="n num">${hsTxt}</div>
        <div class="d ${d >= 0 ? "delta-plus" : "delta-minus"}">${d != null ? (d >= 0 ? "+" : "") + fmt(d) : "税率澄清后可折算"}</div>
        <div class="v" style="margin-top:4px">未税 ${fmt(a.ws)} → ${fmt(b.ws)}</div>
        <svg class="lfmini" data-sup="${esc(s)}" data-from="${a.hs != null ? esc(a.hs) : ""}" data-to="${b.hs != null ? esc(b.hs) : ""}" aria-hidden="true"></svg></div>`;
    }).join("");
    lfDryMinis();
    const changes = [];
    state.boot.catalog.items.forEach((cat) => SUPS.forEach((sup) => {
      const x = stageCell(cur, cat.id, sup), y = stageCell(tgt, cat.id, sup);
      if (x.text !== y.text || x.qty !== y.qty || x.n !== y.n) {
        changes.push({ sup, item: cat.id, from: x.text + (x.n > 1 ? `（×${x.n}行）` : ""), to: y.text + (y.n > 1 ? `（×${y.n}行）` : "") });
      }
    }));
    $("#mDryRows").innerHTML = changes.length ? changes.map((r) => `
      <div class="dry-row"><span>${r.sup} · ${r.item}</span><span>含税金额</span>
        <span>${esc(r.from)} → ${esc(r.to)}</span><span style="color:var(--ink-4)">${esc(state.boot.events[target === "v1_clarified" ? "clarify" : "change"].id)}</span></div>`).join("")
      : '<p style="color:var(--ink-4);font-size:13px">两阶段无差异。</p>';
    $("#mDryApply").dataset.apply = target;
    showModal("mDry");
  }
  function applyStage(target) {
    state.unlocked[target] = true;
    state.stage = target;
    hideModals();
    renderAll();
    const evtName = target === "v1_clarified" ? "CLARIFY-01" : "CHANGE-01";
    toast(`已应用 <b>${evtName}</b>：引擎重算完成，台账切换至 <b>${STAGE_SHORT[target]}</b> · 操作留痕 ${curLedger().audit.length} 条（见「版本与差异」）`);
  }

  /* ---------------- 页签④ 版本与差异 ---------------- */
  /* 两份台账 dict 的逐格差异（GC-017 与项目通用） */
  function diffLedgers(items, sups, A, B) {
    if (!A || !B) return [];
    const out = [];
    items.forEach((cat) => sups.forEach((sup) => {
      const x = stageCell(A, cat.id, sup), y = stageCell(B, cat.id, sup);
      if (x.text !== y.text || x.qty !== y.qty || x.n !== y.n) {
        const b0 = ((B.rows[cat.id] || {})[sup] || [])[0] || {};
        const basis = b0.basis || (b0.flags || [])[0] || "";
        out.push({ sup, item: cat.id, field: "含税金额", from: x.text, to: y.text,
                   basis: (basis || "—").length > 44 ? basis.slice(0, 44) + "…" : (basis || "—") });
      }
    }));
    return out;
  }
  function diffStages(sa, sb) {
    if (sa === sb) return [];
    return diffLedgers(state.boot.catalog.items, SUPS, state.ledgers[sa], state.ledgers[sb]);
  }
  function renderVersions() {
    if (state.cur) {
      const pb = state.proj;
      const stages = Object.keys(pb && pb.ledgers ? pb.ledgers : {});
      const appliedN = (pb.events || []).filter((e) => e.status === "已应用").length;
      $("#vtimeline").innerHTML = stages.length ? stages.map((k) => {
        const meta = k === "v1_raw" ? "收集箱识别归集 · 引擎计算" : `已应用事件 ${appliedN} 条`;
        return `<div class="vnode reached ${state.projStage === k ? "cur" : ""}">
          <div class="dot2"></div><b>${STAGE_LABEL[k]}${state.projStage === k ? " · 当前" : ""}</b>
          <span>${meta} · 留痕 ${pb.ledgers[k].audit.length} 条</span></div>`;
      }).join("") + (stages.length < 2
          ? `<div class="vnode"><div class="dot2"></div><b>V1 澄清后</b><span>登记并应用澄清事件后生成（历史版本永不覆盖）</span></div>` : "")
        : `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">尚无版本：报价归集生成台账后，事件确认应用即生成新版本。</p>`;
      $("#sumBar").innerHTML = stages.length ? pb.suppliers_order.map((s) => {
        const cur = stages.includes(state.projStage) ? state.projStage : stages[0];
        const t = pb.ledgers[cur].totals[s] || {};
        const chain = stages.map((k) => {
          const tv = pb.ledgers[k].totals[s] || {};
          return `${STAGE_LABEL[k].split(" ")[0]} ${tv.hs != null ? fmt(tv.hs) : "—"}`;
        }).join(" → ");
        return `<div class="sumcard orb-card orb-card-raised"><div class="v">${esc(s)} · ${STAGE_LABEL[cur]} 含税合计</div>
          <div class="n num">${t.hs != null ? fmt(t.hs) : "—（不可折算）"}</div>
          <div class="d" style="color:var(--ink-4)">${chain}</div></div>`;
      }).join("") : "";
      const selA = $("#diffA"), selB = $("#diffB");
      if (stages.length === 2) {
        $("#diffSel").style.display = "";
        selA.innerHTML = stages.map((k) => `<option value="${k}">${STAGE_LABEL[k]}</option>`).join("");
        selB.innerHTML = stages.map((k) => `<option value="${k}">${STAGE_LABEL[k]}</option>`).join("");
        selA.value = stages[0]; selB.value = stages[1];
        state.diffA = stages[0]; state.diffB = stages[1];
        const d = diffLedgers(pb.catalog.items, pb.suppliers_order, pb.ledgers[stages[0]], pb.ledgers[stages[1]]);
        $("#diffWrap").innerHTML = d.length ? `<table class="orb-tbl"><thead><tr>
            <th>供应商</th><th>清单项</th><th>字段</th><th class="orb-num">${STAGE_LABEL[stages[0]]}</th><th class="orb-num">${STAGE_LABEL[stages[1]]}</th><th>变化依据</th></tr></thead><tbody>
            ${d.map((r) => `<tr><td>${r.sup}</td><td>${r.item}</td><td>${r.field}</td>
              <td class="orb-num">${esc(r.from)}</td><td class="orb-num">${esc(r.to)}</td>
              <td>${esc(r.basis)}</td></tr>`).join("")}</tbody></table>`
          : `<p style="color:var(--ink-4);font-size:13px;padding:12px 0">两版本无差异。</p>`;
      } else {
        $("#diffSel").style.display = "none";
        $("#diffWrap").innerHTML = `<p style="color:var(--ink-4);font-size:13px;padding:12px">生成 V1 澄清后版本后，可在此对比两版本的逐项差异（每行差异可追溯到事件与依据）。</p>`;
      }
      const ledCur = stages.length ? pb.ledgers[stages.includes(state.projStage) ? state.projStage : stages[0]] : null;
      $("#opLog").innerHTML = ledCur ? `<table class="orb-tbl"><thead><tr><th style="width:130px">操作时间</th><th style="width:90px">操作者</th><th style="width:64px">供应商</th><th style="width:64px">分项</th><th>原值 → 新值 · 依据</th></tr></thead><tbody>
        ${ledCur.audit.map((o) => `<tr><td class="num">${esc(o["操作时间"])}</td><td>${esc(o["操作者"])}</td><td>${esc(o["供应商"])}</td><td>${esc(o["分项"])}</td>
          <td>${esc(o["原值"])} → <b>${esc(o["新值"])}</b>　<span style="color:var(--ink-4)">依据：${esc(o["变更依据"])}</span></td></tr>`).join("")}
        </tbody></table>` : `<p style="color:var(--ink-4);font-size:13px;padding:12px">暂无操作记录。</p>`;
      lfVerChart();
      return;
    }
    $("#vtimeline").innerHTML = Object.keys(STAGE_SHORT).map((k) => {
      const reached = state.unlocked[k];
      const meta = { v1_raw: "2026-09-18 · 原件归档 + 引擎计算", v1_clarified: "2026-09-19 · CLARIFY-01 应用", v2: "2026-09-20 · CHANGE-01 应用" }[k];
      return `<div class="vnode ${reached ? "reached" : ""} ${state.stage === k ? "cur" : ""}">
        <div class="dot2"></div><b>${STAGE_SHORT[k]}${state.stage === k ? " · 当前" : ""}</b>
        <span>${reached ? meta : "待事件应用后生成"}${reached ? ` · 留痕 ${state.ledgers[k].audit.length} 条` : ""}</span></div>`;
    }).join("");

    const led = curLedger();
    $("#sumBar").innerHTML = SUPS.map((s) => {
      const t = led.totals[s];
      const chain = Object.keys(STAGE_SHORT).map((k) =>
        `${STAGE_SHORT[k].split(" ")[0]} ${state.unlocked[k] ? (state.ledgers[k].totals[s].hs != null ? fmt(state.ledgers[k].totals[s].hs) : "—") : "…"}`).join(" → ");
      return `<div class="sumcard orb-card orb-card-raised"><div class="v">${s} · ${STAGE_SHORT[state.stage]} 含税合计</div>
        <div class="n num">${t.hs != null ? fmt(t.hs) : "—（不可折算）"}</div>
        <div class="d" style="color:var(--ink-4)">${chain}</div></div>`;
    }).join("");

    const a = state.diffA, b = state.diffB;
    const d = diffStages(a, b);
    $("#diffWrap").innerHTML = d.length ? `<table class="orb-tbl"><thead><tr>
        <th>供应商</th><th>清单项</th><th>字段</th><th class="orb-num">${STAGE_SHORT[a]}</th><th class="orb-num">${STAGE_SHORT[b]}</th><th>变化依据</th></tr></thead><tbody>
        ${d.map((r) => `<tr><td>${r.sup}</td><td>${r.item}</td><td>${r.field}</td>
          <td class="orb-num">${esc(r.from)}</td><td class="orb-num">${esc(r.to)}</td>
          <td>${esc(r.basis)}</td></tr>`).join("")}</tbody></table>`
      : `<p style="color:var(--ink-4);font-size:13px;padding:12px 0">所选两版本无差异，请选择不同版本。</p>`;

    $("#opLog").innerHTML = `<table class="orb-tbl"><thead><tr><th style="width:130px">操作时间</th><th style="width:90px">操作者</th><th style="width:64px">供应商</th><th style="width:64px">分项</th><th>原值 → 新值 · 依据</th></tr></thead><tbody>
      ${led.audit.map((o) => `<tr><td class="num">${esc(o["操作时间"])}</td><td>${esc(o["操作者"])}</td><td>${esc(o["供应商"])}</td><td>${esc(o["分项"])}</td>
          <td>${esc(o["原值"])} → <b>${esc(o["新值"])}</b>　<span style="color:var(--ink-4)">依据：${esc(o["变更依据"])}</span></td></tr>`).join("")}
      </tbody></table>`;
    lfVerChart();
  }

  /* =====================================================================
   * Lieflat 图表层 · 手写 SVG 零依赖（内网离线可用）
   * 结构正本：lieflat-charts basics-gallery.html
   *   合计行内嵌对比条 —— 合计行内等比例长度条（四家一把尺），不占版面。
   *   版本图（分组柱，C2 Paired Rungs 骨架扩至 N 阶段）—— 一组一家，
   *      柱色浅→深 = 版本由旧到新，柱高 ∝ 含税合计（0 起量、共享标尺），
   *      组下标注较基线变动；不可折算不画柱（不当 0）。
   *   差异预演微缩（F12 微缩）—— 弹窗统一标尺迷你哑铃，应用前看影响。
   * 颜色全部取自 ORBIS 品牌变量（--orb-*），不引入第二套色系；
   * 动画沿用 gallery 的 fade/pop 节奏，支持 prefers-reduced-motion 降级。
   * ===================================================================== */
  const LF_NS = "http://www.w3.org/2000/svg";
  const lfEl = (p, t, a) => { const n = document.createElementNS(LF_NS, t); for (const k in a) n.setAttribute(k, a[k]); p.appendChild(n); return n; };
  const lfTxt = (p, a, s) => { const n = lfEl(p, "text", a); n.textContent = s; return n; };
  const lfTip = (n, s) => { const t = document.createElementNS(LF_NS, "title"); t.textContent = s; n.appendChild(t); };
  const lfRnd = (i, k) => Math.abs(((i * 73856093) ^ (k * 19349663)) % 1000) / 1000;   // 确定性抖动，刷新不变形
  const lfInk = "var(--orb-fg-strong)", lfMut = "var(--orb-muted)", lfGrid = "var(--line-2)";
  const lfData = "var(--orb-primary)", lfPaper = "var(--orb-canvas,#fff)", lfWarn = "var(--orb-accent)";
  const lfFade = (n, d) => { n.setAttribute("class", "lfc-fade"); n.style.animationDelay = d + "s"; return n; };
  const lfPop = (n, d) => { n.setAttribute("class", "lfc-pop"); n.style.animationDelay = d + "s"; return n; };
  const lfGrow = (n, d) => { n.setAttribute("class", n.getAttribute("class") + " lfc-grow"); n.style.animationDelay = d + "s"; return n; };
  /* 当前项目可用的台账阶段与查看阶段（demo / 项目两种模式统一取数） */
  function lfCtx() {
    const pb = state.cur ? state.proj : null;
    const sups = pb ? (pb.suppliers_order || []) : SUPS;
    const ledMap = pb ? (pb.ledgers || {}) : state.ledgers;
    const stages = pb ? Object.keys(ledMap) : Object.keys(STAGE_SHORT).filter((k) => state.unlocked[k] && ledMap[k]);
    if (!stages.length || !sups.length) return null;
    const curStage = pb
      ? (stages.includes(state.projStage) ? state.projStage : stages[stages.length - 1])
      : (stages.includes(state.stage) ? state.stage : stages[0]);
    const label = (k) => (pb ? STAGE_LABEL[k] : STAGE_SHORT[k]) || k;
    return { pb, sups, ledMap, stages, curStage, label };
  }
  /* 折叠联动：默认按视口高度自动（<900px 折叠成标题摘要条，矮视口把空间还给台账表格）；
     用户点击开关后以手动选择优先，跨会话不记忆 */
  function applyLfCollapse() {
    const collapsed = state.lfUserCollapsed !== null ? state.lfUserCollapsed : window.innerHeight < 900;
    document.querySelectorAll(".lfblock").forEach((b) => {
      b.classList.toggle("collapsed", collapsed);
      const btn = b.querySelector(".lf-toggle");
      if (btn) {
        btn.setAttribute("aria-expanded", String(!collapsed));
        btn.title = collapsed ? "展开图表" : "折叠图表";
      }
    });
  }
  /* 卡片四件套：折叠开关 + 结论式标题 + 副标题（图例/口径） + 图 + 来源行 */
  function lfBlock(host, { title, sub, src, h, w = 840 }) {
    host.innerHTML = `<h4><button type="button" class="lf-toggle" aria-expanded="true"><span class="lf-caret">▾</span></button>${title}</h4><div class="lfsub">${sub}</div>
      <svg class="lfchart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img"></svg>
      <div class="lfsrc">${src}</div>`;
    host.querySelector(".lf-toggle").addEventListener("click", () => {
      state.lfUserCollapsed = !host.classList.contains("collapsed");
      applyLfCollapse();
    });
    applyLfCollapse();
    return host.querySelector("svg");
  }
  function lfReveal(svg, fn) {
    const go = () => { svg.innerHTML = ""; fn(svg); };
    svg.style.cursor = "pointer";
    svg.addEventListener("click", go);   // 点击重播
    if (typeof IntersectionObserver === "undefined") { go(); return; }
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { go(); io.disconnect(); } }, { threshold: .15 });
    io.observe(svg);                     // 滚入视野才播（隐藏页签切过来时触发）
  }

  /* 合计行内嵌对比条：长度 ∝ 当前口径合计，四家共用一把尺；不占额外版面，
     明细清单保持原样一屏可读。不可折算（null/NaN）不画条——不当 0。 */
  function lfTotBar(led, sups, ws) {
    const val = (s) => { const t = led.totals[s] || {}; const v = Number(ws ? t.ws : t.hs); return Number.isFinite(v) ? v : 0; };
    const max = Math.max(...sups.map(val), 1);
    return (s) => {
      const v = val(s);
      return v > 0 ? `<span class="tbar" style="width:${Math.max(6, v / max * 100).toFixed(1)}%" aria-hidden="true"></span>` : "";
    };
  }

  /* 版本间合计对比（分组柱状 · C2 Paired Rungs 骨架扩至 N 阶段，含税口径）
   * 一组一家；组内每解锁阶段一根柱，浅→深 = 版本由旧到新；柱从 0 起量、
   * 四组共享 y 标尺（长度诚实）。不可折算的阶段不画柱（不当 0）。 */
  function lfVerChart() {
    const host = $("#verChart");
    if (!host) return;
    const c = lfCtx();
    if (!c) { host.innerHTML = ""; host.classList.add("hidden"); return; }
    host.classList.remove("hidden");
    const nStage = c.stages.length, moved = nStage > 1;
    const fromStage = c.stages[0], curStage = c.curStage;
    const fromLabel = c.label(fromStage), curLabel = c.label(curStage);
    const ws = state.amountMode === "ws", modeName = ws ? "未税" : "含税";
    const hsOf = (k, s) => { const t = (c.ledMap[k].totals[s]) || {}; const v = ws ? t.ws : t.hs; return v == null ? null : Number(v); };
    /* 每组的柱：[{k, v}]，仅收可折算阶段；全部不可折算 → 空数组 */
    const groups = c.sups.map((s) => ({
      s,
      bars: c.stages.map((k) => ({ k, label: c.label(k), v: hsOf(k, s) })).filter((b) => b.v != null)
    }));
    const nums = groups.flatMap((g) => g.bars.map((b) => b.v));
    if (!nums.length) { host.innerHTML = ""; host.classList.add("hidden"); return; }
    const maxV = Math.max(...nums);
    const W = 840, plotBase = 214, plotTop = 46, plotH = plotBase - plotTop;
    const mapY = (v) => plotBase - (v / maxV) * plotH;
    const H = plotBase + 52;
    const barW = 30, gap = 7;
    /* 柱色深度档：阶段由旧到新 0→2（浅→深），当前版本恒为最深层 */
    const barCls = (j, n) => n <= 1 ? 2 : j === n - 1 ? 2 : n === 3 && j === 1 ? 1 : 0;
    const svg = lfBlock(host, {
      title: moved ? `版本推进，${c.sups.length} 家合计各走了多远` : `${c.sups.length} 家合计基线，事件应用后此处呈现两版对比`,
      sub: `图例：一组一家 · 柱色浅→深 = 版本由旧到新 · 柱高 ∝ ${modeName}合计（从 0 起量，四组共用一把尺）· 组下标注较基线变动 · 柱可悬停${moved ? "" : " · 应用事件生成新版本后出现对比柱"}`,
      src: `GROUPED BARS · 来源：引擎台账 · ${fromLabel} → ${curLabel} · ${modeName}口径 · 点击图重播`,
      h: H
    });
    lfReveal(svg, (s) => {
      /* 共享 0 基线 */
      lfFade(lfEl(s, "line", { x1: 16, y1: plotBase, x2: W - 16, y2: plotBase, stroke: lfGrid, "stroke-width": .8 }), .1);
      const groupW = W / c.sups.length;
      groups.forEach((g, i) => {
        const gx = groupW * (i + .5);
        const k = g.bars.length;
        /* 组基线小刻度 */
        lfFade(lfEl(s, "line", { x1: gx - groupW / 2 + 14, y1: plotBase, x2: gx + groupW / 2 - 14, y2: plotBase, stroke: lfGrid, "stroke-width": .6 }), .15 + i * .06);
        if (!k) {
          lfFade(lfTxt(s, { x: gx, y: plotBase - 10, "font-size": 8.5, "font-weight": 600, fill: lfMut, "text-anchor": "middle" }, "合计不可折算 · 未参与比较"), .3 + i * .06);
        }
        g.bars.forEach((b, j) => {
          const total = k * barW + (k - 1) * gap;
          const x = gx - total / 2 + j * (barW + gap);
          const y = mapY(b.v), hgt = plotBase - y;
          const rect = lfGrow(lfEl(s, "rect", { x, y, width: barW, height: Math.max(hgt, 1), rx: 3, class: `lfc-grow lfbar${barCls(j, k)}` }), .25 + i * .07 + j * .09);
          lfTip(rect, `${g.s} — ${b.label} ${modeName}合计 ${fmt(b.v)}`);
          /* 柱顶数值：当前版本加粗；与后一根同值的旧柱跳过标签，让加粗当前值呈现 */
          const next = j < k - 1 ? g.bars[j + 1] : null;
          const dupNext = next && Math.abs(next.v - b.v) < .005;
          if (!dupNext) {
            const cur = j === k - 1;
            lfFade(lfTxt(s, { x: x + barW / 2, y: y - 6, "font-size": cur ? 10 : 7.5, "font-weight": cur ? 800 : 600,
              fill: cur ? lfInk : lfMut, "text-anchor": "middle", class: "num" }, fmt(b.v)), .45 + i * .07 + j * .09);
          }
        });
        /* 组名 + 变动标注 */
        lfFade(lfTxt(s, { x: gx, y: plotBase + 18, "font-size": 9.5, "font-weight": 700, fill: lfMut, "text-anchor": "middle" }, g.s), .5 + i * .07);
        let delta = null, hasBase = g.bars.length && g.bars[0].k === fromStage;
        if (moved && hasBase) delta = g.bars[g.bars.length - 1].v - g.bars[0].v;
        if (moved && g.bars.length) {
          const txt = !hasBase ? `${fromLabel}不可折算`
            : Math.abs(delta) < .005 ? "无变动" : `${delta > 0 ? "+" : ""}${fmt(delta)}`;
          lfFade(lfTxt(s, { x: gx, y: plotBase + 32, "font-size": 8.5, "font-weight": hasBase && Math.abs(delta) >= .005 ? 700 : 600,
            fill: !hasBase || Math.abs(delta) < .005 ? lfMut : lfWarn, "text-anchor": "middle", class: "num" }, txt), .65 + i * .07);
        }
      });
      lfFade(lfTxt(s, { x: 16, y: H - 10, "font-size": 7.5, "font-weight": 600, fill: lfMut }, `${fromLabel}（基线）`), .9);
      lfFade(lfTxt(s, { x: W - 16, y: H - 10, "font-size": 7.5, "font-weight": 600, fill: lfMut, "text-anchor": "end" }, `${curLabel} · ${modeName}合计（¥）`), .9);
    });
  }

  /* 图C · 差异预演迷你哑铃（F12 微缩 · 四家共用一把尺） */
  function lfDryMinis() {
    const minis = [...document.querySelectorAll("#mDrySum .lfmini")];
    if (!minis.length) return;
    const pts = minis.map((m) => ({ el: m, from: m.dataset.from === "" ? null : Number(m.dataset.from), to: m.dataset.to === "" ? null : Number(m.dataset.to) }));
    const nums = pts.flatMap((p) => [p.from, p.to]).filter((v) => v != null);
    if (!nums.length) return;
    const lo = Math.min(...nums) - 800, hi = Math.max(...nums) + 800;
    const mapX = (v) => 10 + (v - lo) / (hi - lo) * 200;
    pts.forEach((p, i) => {
      const svg = p.el;
      svg.innerHTML = "";
      const s = lfEl(svg, "g", {});
      lfEl(s, "line", { x1: 6, y1: 12, x2: 214, y2: 12, stroke: lfGrid, "stroke-width": .7 });
      if (p.to != null) {
        const solid = lfEl(s, "circle", { cx: mapX(p.to), cy: 12, r: 3.6, fill: lfData });
        lfPop(solid, .25 + i * .06);
        lfTip(solid, `应用后合计 ${fmt(p.to)}`);
        lfEl(s, "text", { x: Math.min(mapX(p.to), 204), y: 9, "font-size": 7.5, "font-weight": 800, fill: lfInk, "text-anchor": "middle" }).textContent = "";
      }
      if (p.from != null) {
        const hollow = lfEl(s, "circle", { cx: mapX(p.from), cy: 12, r: 3.4, fill: lfPaper, stroke: lfInk, "stroke-width": 1.1 });
        lfPop(hollow, .1 + i * .06);
        lfTip(hollow, `当前合计 ${fmt(p.from)}`);
        if (p.to != null) {
          const xa = mapX(p.from), xb = mapX(p.to);
          lfEl(s, "line", { x1: xa, y1: 12, x2: xb, y2: 12, stroke: lfMut, "stroke-width": 1, opacity: .5 });
        }
      }
    });
  }

  /* ---------------- 页签⑤ 导出交付（一选一下载 + 待补充事项折叠） ---------------- */
  function renderExport() {
    if (state.cur) {
      const pb = state.proj;
      const stages = Object.keys(pb && pb.ledgers ? pb.ledgers : {});
      const can = stages.length > 0;
      $("#btnExport").disabled = !can;
      $("#btnDeliver").disabled = !can;
      if (!can) {
        $("#exportVersion").innerHTML = `<option value="">—</option>`;
        $("#exportMeta").textContent = "";
        $("#expChk").innerHTML = `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">尚无可导出的台账：先到①收集箱上传供应商报价原件，识别匹配并生成台账后，此处选择版本下载五表 xlsx。</p>`;
        $("#expHistory").innerHTML = `<p style="font-size:12.5px;color:var(--ink-4)">尚未导出。</p>`;
        return;
      }
      const stage = stages.includes(state.projStage) ? state.projStage : stages[stages.length - 1];
      $("#exportVersion").innerHTML = stages.map((k) =>
        `<option value="${k}"${k === stage ? " selected" : ""}>${STAGE_LABEL[k]}</option>`).join("");
      const pendEv = pb.counts.pending_events, um = pb.counts.unmatched;
      $("#exportMeta").textContent = `${pb.suppliers_order.length} 家供应商 · ${pb.match_report.matched} 条已匹配 · 包含 5 张工作表`;
      const parts = [];
      if (um) parts.push(`${um} 项报价待匹配`);
      if (pendEv) parts.push(`${pendEv} 条事件待确认`);
      parts.push("资格材料未配置");
      $("#expChk").innerHTML = `<details class="export-issues"><summary><span class="export-issue-summary">${parts.map((p) => `<span>${esc(p)}</span>`).join("")}</span><span class="export-detail-label">查看详情</span></summary>
        <div class="export-issue-body">
          <p><b>M4 匹配 ${pb.match_report.matched}</b> 条 · 供应商 ${pb.suppliers_order.length} 家 · 金额计算零LLM、全程 Decimal。</p>
          <p><b>口径已统一</b>：含税单口径 · 折算依据逐行随附。</p>
          <p><b>资格要求清单未挂载</b>：导出的「资格材料清单」表为空（挂载后自动补齐）。</p>
        </div></details>
        <p class="export-issue-note">待补充事项不阻止下载，将如实写入交付包的「需补充事项」表 · 列示金额只作比对基准 · 系统不推荐中标。</p>`;
      $("#expHistory").innerHTML = state.exports.length ? state.exports.map((x) => `<div class="export-record">${esc(x)}</div>`).join("")
        : `<p class="export-muted">尚未导出。</p>`;
      return;
    }
    $("#btnExport").disabled = false;
    $("#btnDeliver").disabled = false;
    const checks = state.boot.checks;
    const okN = checks.filter((c) => c.ok).length;
    const issues = state.issues[state.stage] || [];
    const open = issues.filter((i) => !i.closed).length;
    $("#exportVersion").innerHTML = Object.keys(STAGE_SHORT).map((k) =>
      `<option value="${k}"${k === state.stage ? " selected" : ""}${state.unlocked[k] ? "" : " disabled"}>${STAGE_SHORT[k]}</option>`).join("");
    $("#exportMeta").textContent = `${SUPS.length} 家供应商（示例） · 引擎回归自检 ${okN}/${checks.length} 项通过 · 包含 5 张工作表`;
    $("#expChk").innerHTML = `<details class="export-issues"><summary><span class="export-issue-summary"><span>${open} 项未关闭事项</span><span>资格待补 2 项</span></span><span class="export-detail-label">查看详情</span></summary>
      <div class="export-issue-body">
        <p><b>未关闭事项 ${open} 项 / 已澄清关闭 ${issues.length - open} 项</b>——如实写入「需补充事项」表，不阻断交付。</p>
        <p><b>资格待补 2 项</b>：乙检测资质未提交；丁资质 2026-08-31 到期未续（保持未关闭，由评审判断）。</p>
        <p><b>引擎回归自检 ${okN}/${checks.length} 项通过</b>（底稿数字核对）；<b>口径已统一</b>：双口径并列 · 折算依据逐行随附 · 列示金额只作比对基准。</p>
      </div></details>
      <p class="export-issue-note">待补充事项不阻止交付 · 列示金额只作比对基准 · 系统不推荐中标。</p>`;
    $("#expHistory").innerHTML = state.exports.length ? state.exports.map((x) => `<div class="export-record">${esc(x)}</div>`).join("")
      : `<p class="export-muted">尚未导出。导出即由 M2 生成器在${state.boot.template_found ? "企业模板副本上" : "模板表头新建"}写出 5-sheet xlsx（backend/out/）。</p>`;
  }

/* ---------------- 页签⑥ 智慧报表（OMPHPanel · AI 对话分析项目数据） ---------------- */
  const AI_HISTORY_MAX = 8;
  function aiMd(text) {
    /* 轻量 markdown → HTML（先转义防注入）：```chart 块渲染为 SVG 图表 */
    const charts = [];
    text = String(text ?? "").replace(/```chart\s*([\s\S]*?)```/g, (m, body) => {
      charts.push(body);
      return `\u0000CHART${charts.length - 1}\u0000`;
    });
    const codes = [];
    text = text.replace(/```([\w-]*)\s*([\s\S]*?)```/g, (m, lang, body) => {
      codes.push({ lang, body });
      return `\u0000CODE${codes.length - 1}\u0000`;
    });
    const inline = (s) => esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    const lines = text.split("\n");
    let html = "", list = null, table = null;
    const closeAll = () => {
      if (list) { html += `</${list}>`; list = null; }
      if (table) { html += "</tbody></table></div>"; table = null; }
    };
    for (const raw of lines) {
      const line = String(raw).trimEnd();
      const t = line.trim();
      if (!t) { closeAll(); continue; }
      const tm = t.match(/^\|(.+)\|$/);
      if (tm) {
        const cells = tm[1].split("|").map((c) => c.trim());
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;   // 表头分隔行
        if (!table) {
          closeAll();
          table = { head: cells };
          html += '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
            cells.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
        } else {
          html += "<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        }
        continue;
      }
      if (table) { html += "</tbody></table></div>"; table = null; }
      const hm = t.match(/^(#{1,4})\s+(.*)$/);
      if (hm) { closeAll(); html += `<h${hm[1].length + 2} class="md-h">${inline(hm[2])}</h${hm[1].length + 2}>`; continue; }
      const ul = t.match(/^[-*]\s+(.*)$/);
      if (ul) { if (list !== "ul") { closeAll(); html += "<ul>"; list = "ul"; } html += `<li>${inline(ul[1])}</li>`; continue; }
      const ol = t.match(/^\d+[.、]\s+(.*)$/);
      if (ol) { if (list !== "ol") { closeAll(); html += "<ol>"; list = "ol"; } html += `<li>${inline(ol[1])}</li>`; continue; }
      closeAll();
      html += `<p class="md-p">${inline(t)}</p>`;
    }
    closeAll();
    html = html.replace(/\u0000CODE(\d+)\u0000/g, (m, i) =>
      `<pre class="md-code"><code>${esc(codes[+i].body)}</code></pre>`);
    html = html.replace(/\u0000CHART(\d+)\u0000/g, (m, i) => aiChart(charts[+i]));
    return html;
  }
  function aiChart(body) {
    let spec = null;
    try { spec = JSON.parse(body); } catch (e) { /* 落到下方无效提示 */ }
    const data = Array.isArray(spec && spec.data) ? spec.data.filter((d) => d && isFinite(Number(d.value))) : [];
    if (!spec || !data.length) return '<div class="ai-chart-err">（图表数据无效，已跳过渲染）</div>';
    const type = spec.type === "line" ? "line" : "bar";
    const W = 480, H = 240, padL = 86, padB = 46, padT = 36, padR = 14;
    const iw = W - padL - padR, ih = H - padT - padB;
    const vals = data.map((d) => Number(d.value));
    const vmax = Math.max(...vals, 0), vmin = Math.min(...vals, 0);
    const span = (vmax - vmin) || 1;
    const y = (v) => padT + ih - ((v - vmin) / span) * ih;
    const step = iw / data.length;
    let svg = `<div class="ai-chart"><svg viewBox="0 0 ${W} ${H}" role="img">`;
    svg += `<text x="${W - padR}" y="20" text-anchor="end" class="ai-chart-title">${esc(String(spec.title || ""))}</text>`;
    svg += `<text x="6" y="20" text-anchor="start" class="ai-chart-unit">${esc(String(spec.unit || ""))}</text>`;
    for (let i = 0; i <= 4; i++) {
      const v = vmin + (span * i) / 4, yy = y(v);
      svg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" class="ai-chart-grid"/>` +
        `<text x="${padL - 6}" y="${yy + 4}" text-anchor="end" class="ai-chart-tick">${fmt(v)}</text>`;
    }
    if (type === "bar") {
      const bw = Math.min(step * 0.62, 56);
      data.forEach((d, i) => {
        const x = padL + step * i + (step - bw) / 2, v = Number(d.value);
        const top = Math.min(y(v), y(0)), hgt = Math.abs(y(v) - y(0)) || 1;
        svg += `<rect x="${x}" y="${top}" width="${bw}" height="${hgt}" rx="4" class="ai-chart-bar"/>` +
          `<text x="${x + bw / 2}" y="${top - 5}" text-anchor="middle" class="ai-chart-val">${fmt(v)}</text>` +
          `<text x="${x + bw / 2}" y="${H - padB + 16}" text-anchor="middle" class="ai-chart-lbl">${esc(String(d.label))}</text>`;
      });
    } else {
      const pts = data.map((d, i) => [padL + step * i + step / 2, y(Number(d.value))]);
      svg += `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" class="ai-chart-line"/>`;
      pts.forEach((p, i) => {
        svg += `<circle cx="${p[0]}" cy="${p[1]}" r="4" class="ai-chart-dot"/>` +
          `<text x="${p[0]}" y="${p[1] - 9}" text-anchor="middle" class="ai-chart-val">${fmt(vals[i])}</text>` +
          `<text x="${p[0]}" y="${H - padB + 16}" text-anchor="middle" class="ai-chart-lbl">${esc(String(data[i].label))}</text>`;
      });
    }
    svg += "</svg></div>";
    return svg;
  }
  function aiScrollBottom() {
    const s = $("#aiScroll");
    if (s) s.scrollTop = s.scrollHeight;
  }
  function aiTurnHtml(m, streaming) {
    const time = `<span class="orb-omph-actions-time">${esc(m.time || "")}</span>`;
    if (m.role === "user") {
      return `<div class="orb-omph-turn"><div class="orb-omph-user"><div class="orb-omph-user-bubble">${esc(m.content)}</div>
        <div class="orb-omph-user-meta">${time}</div></div></div>`;
    }
    if (m.role === "error") {
      return `<div class="orb-omph-turn"><div class="orb-omph-failure" data-severity="error">${esc(m.content)}</div>
        <div class="orb-omph-turn-actions">${time}</div></div>`;
    }
    return `<div class="orb-omph-turn"><div class="orb-omph-assistant"><div class="markdown-body">${aiMd(m.content)}${streaming ? '<span class="orb-omph-caret"></span>' : ""}</div></div>
      ${streaming ? "" : `<div class="orb-omph-turn-actions">${time}</div>`}</div>`;
  }
  function renderAI() {
    if (!state.aiStatus) { loadAiStatus(); return; }
    const st = state.aiStatus;
    $("#aiProjLabel").textContent = state.cur ? `${state.cur.id} · ${state.cur.name}` : "";
    const ok = st.available;
    $("#aiDot").style.background = ok ? "" : "var(--orb-err)";
    $("#aiStatus").textContent = ok
      ? `已连接 ${st.model} · 已注入当前项目全部工作台数据`
      : (st.reason || "AI 服务不可用");
    $("#aiInput").disabled = !ok;
    $("#aiInput").placeholder = ok
      ? "向 AI 提问当前项目的数据，如：总结各供应商报价、哪些分项有异常…（Enter 发送 / Shift+Enter 换行）"
      : (st.reason || "AI 服务不可用");
    $("#aiSend").disabled = !ok || state.aiBusy;
    const col = $("#aiColumn");
    const msgs = state.aiMsgs;
    col.innerHTML = msgs.length
      ? msgs.map((m, i) => aiTurnHtml(m, state.aiBusy && i === msgs.length - 1 && m.role === "assistant" && m.streaming)).join("")
      : `<div class="ai-empty">
          <p class="orb-omph-title">让 AI 读取并总结当前项目的台账数据</p>
          <p class="orb-meta">AI 已获得本项目的统一清单、全版本台账（含未税/含税与异常旗标）、事件与审计留痕。试试：</p>
          <div class="ai-suggest">
            <button class="orb-btn orb-btn-sm orb-btn-neutral" data-aiq="总结各供应商当前版本的报价合计，并指出异常较多的供应商">总结各供应商报价与异常</button>
            <button class="orb-btn orb-btn-sm orb-btn-neutral" data-aiq="对比各供应商含税合计，用柱状图展示">含税合计柱状图</button>
            <button class="orb-btn orb-btn-sm orb-btn-neutral" data-aiq="列出当前台账里的全部异常旗标，按供应商归类并说明影响">异常旗标清单</button>
          </div>
        </div>`;
    aiScrollBottom();
  }
  async function loadAiStatus() {
    try {
      state.aiStatus = await getJSON("/api/ai/status");
    } catch (e) {
      state.aiStatus = { available: false, reason: "无法获取 AI 服务状态：" + e.message };
    }
    renderAI();
  }
  async function sendAI(question) {
    if (!state.cur || state.aiBusy || !question) return;
    if (!state.aiStatus || !state.aiStatus.available) { renderAI(); return; }
    state.aiMsgs.push({ role: "user", content: question, time: new Date().toLocaleTimeString("zh-CN", { hour12: false }) });
    const reply = { role: "assistant", content: "", streaming: true, time: "" };
    state.aiMsgs.push(reply);
    state.aiBusy = true;
    renderAI();
    const history = state.aiMsgs.slice(0, -2)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-AI_HISTORY_MAX)
      .map((m) => ({ role: m.role, content: m.content }));
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.cur.id)}/ai-report`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "HTTP " + r.status);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!frame.startsWith("data:")) continue;
          let evt;
          try { evt = JSON.parse(frame.slice(5).trim()); } catch (e) { continue; }
          if (evt.delta) {
            reply.content += evt.delta;
            renderAI();
          } else if (evt.error) {
            reply.role = "error"; reply.content = evt.error; reply.streaming = false;
            renderAI();
          } else if (evt.done) {
            reply.streaming = false;
            reply.time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
            renderAI();
          }
        }
      }
    } catch (e) {
      reply.role = "error";
      reply.content = "请求失败：" + e.message + "——请确认已运行 python server.py";
      reply.streaming = false;
    } finally {
      state.aiBusy = false;
      reply.streaming = false;
      renderAI();
    }
  }

  /* ---------------- 弹层 / 登记 / AI 位 ---------------- */
  /* 弹层焦点管理：打开时记录来源焦点并落焦首控件，关闭时归还（Tab 循环见全局 keydown） */
  function showModal(id) {
    state.lastModalTrigger = document.activeElement;
    $("#" + id).classList.add("show");
    const f = $("#" + id).querySelector("input:not(:disabled), select:not(:disabled), button:not(:disabled)");
    if (f) f.focus();
  }
  function hideModals() {
    document.querySelectorAll(".overlay").forEach((o) => o.classList.remove("show"));
    confirmAction = null;
    const t = state.lastModalTrigger;
    state.lastModalTrigger = null;
    if (t && document.contains(t)) { try { t.focus(); } catch (_) { /* 焦点元素已失效则忽略 */ } }
  }
  /* 高风险操作统一确认（确认入账 / 状态流转）：说明后果 + 「再想想」反悔口，确认后才执行 onOk */
  let confirmAction = null;
  function askConfirm({ title, body, okLabel, okStyle, onOk }) {
    $("#mConfirmTitle").textContent = title;
    $("#mConfirmBody").innerHTML = body;
    const ok = $("#mConfirmOk");
    ok.textContent = okLabel || "确认";
    ok.className = "orb-btn " + (okStyle === "accent" ? "orb-btn-accent" : "orb-btn-primary");
    confirmAction = onOk;
    showModal("mConfirm");
  }
  function registerModal() {
    if (state.cur) {
      const pb = state.proj;
      $("#mRegBody").innerHTML = `
        <div class="form-grid">
          <div class="fld"><label>事件类型 <i>*</i></label>
            <select class="orb-inp" id="regType">
              <option value="DECLARE_TAX">申报税率（补充型 · 如给税率未给的乙补 6%）</option>
              <option value="SET_FIELD">更正字段（修正型 · 单价/数量/列示金额）</option>
              <option value="ADD_LINE">补录漏报行（补充型）</option>
              <option value="DEDUPE">剔除重复行（修正型）</option>
              <option value="RESOLVE_UNIT">单位口径确认（依据授予型 · 总价均分）</option>
            </select></div>
          <div class="fld"><label>供应商 <i>*</i></label>
            <select class="orb-inp" id="regSup">${pb.suppliers_order.map((s) => `<option>${esc(s)}</option>`).join("")}</select></div>
          <div class="fld"><label>清单项</label>
            <select class="orb-inp" id="regItem">${pb.catalog.items.map((c) => `<option value="${c.id}">${c.id} · ${esc(c.name)}</option>`).join("")}</select></div>
          <div class="fld"><label>更正字段（SET_FIELD 时生效）</label>
            <select class="orb-inp" id="regField"><option value="unit_price">单价</option><option value="qty">数量</option><option value="stated_amount">列示金额</option></select></div>
          <div class="fld"><label>新值 <i>*</i></label>
            <input class="orb-inp" id="regNew" placeholder="税率 6%（或 0.06）；单价 460.00；数量 18；单位确认填 4"></div>
          <div class="fld"><label>补录行 数量×单价（ADD_LINE 时生效，可空）</label>
            <input class="orb-inp" id="regLine" placeholder="如 12×460；留空则新值按整项金额"></div>
          <div class="fld full"><label>依据文件 + 条款定位 <i>*必填：无依据不改数 · 从已归档原件选择</i></label>${evidenceFieldsHTML(pb.files, "regEv", "")}</div>
          <div class="fld full"><label>备注（可空）</label><input class="orb-inp" id="regNote" placeholder="补充说明，随事件留痕"></div>
        </div>`;
      showModal("mReg");
      return;
    }
    $("#mRegBody").innerHTML = `
      <div class="form-grid">
        <div class="fld"><label>事件类型 <i>*</i></label>
          <select class="orb-inp" id="regType"><option>SET_FIELD 更正字段</option><option>ADD_LINE 补录行</option><option>DECLARE_TAX 申报税率</option><option>DEDUPE 剔重</option><option>RESOLVE_UNIT 单位确认</option></select></div>
        <div class="fld"><label>影响对象（供应商 · 清单项 · 字段）<i>*</i></label><input class="orb-inp" id="regTarget" placeholder="如：乙 · C09 · 单价"></div>
        <div class="fld full"><label>变更内容（原值 → 新值）<i>*</i></label><input class="orb-inp" id="regDetail" placeholder="如：（缺价）→ 460.00 元/根 × 12 根"></div>
        <div class="fld full"><label>依据文件 + 条款定位 <i>*必填：无依据不改数</i></label>${evidenceFieldsHTML(null, "regEv")}</div>
      </div>`;
    showModal("mReg");
  }
  async function submitRegister() {
    if (state.cur) {
      const op = $("#regType").value, sup = $("#regSup").value, item = $("#regItem").value,
            field = $("#regField").value, nv = $("#regNew").value.trim(),
            line = $("#regLine").value.trim(), basis = evidenceValue("regEv"),
            note = $("#regNote").value.trim();
      if (!nv || !basis) { toast("登记失败：新值与依据均为必填——无依据不改数（依据须指向已归档原件）。"); return; }
      let payload = null, newVal = nv;
      if (op === "DECLARE_TAX") {
        const m = nv.match(/^([\d.]+)\s*%$/);
        newVal = m ? String(Number(m[1]) / 100) : nv;
      } else if (op === "ADD_LINE") {
        if (line) {
          const mm = line.match(/^([\d.]+)\s*[×xX]\s*([\d.]+)$/);
          if (!mm) { toastErr("补录行格式：数量×单价，如 12×460"); return; }
          payload = { qty: mm[1], unit_price: mm[2] };
        } else {
          payload = { stated_amount: nv };
        }
      } else if (op === "RESOLVE_UNIT") {
        payload = { items_per_quote_unit: Number(nv), quote_unit: "项" };
      }
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(state.cur.id)}/events`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op, supplier: sup, item, field, new: newVal, payload, evidence: basis, note, operator: "商务人员A" })
        });
        const j = await r.json();
        if (!r.ok) { toastErr(`登记失败：${esc(j.error || "HTTP " + r.status)}`); return; }
        hideModals();
        await loadProjectBoard();
        state.tab = 3; renderTabs();
        toast(`事件 <b>${esc(j.event.id)}</b> 已登记并留痕（待确认——确认应用前不动台账）。`);
      } catch (e) {
        toastErr(`登记失败：${esc(e.message)}——请确认已运行 python server.py`);
      }
      return;
    }
    const tg = $("#regTarget").value.trim(), dt = $("#regDetail").value.trim(), ba = evidenceValue("regEv");
    if (!tg || !dt || !ba) { toast("登记失败：影响对象、变更内容与依据均为必填——无依据不改数。"); return; }
    state.manual.push({ id: "EVT-M" + (state.manual.length + 1), type: $("#regType").value, target: tg, detail: dt, basis: ba, time: "2026-09-20 10:00", op: "商务人员A" });
    hideModals(); renderEvents(); renderCtx();
    toast("事件已登记并进入待确认队列（示例环境不触发引擎重算）。依据已随事件留痕。");
  }

  /* ---------------- 新建比选项目 ---------------- */
  async function loadProjects() {
    const j = await getJSON("/api/projects");
    state.projects = j.projects || [];
    state.nextId = j.next_id || "";
  }
  function openNewProjModal() {
    $("#mNewBody").innerHTML = `
      <div class="form-grid">
        <div class="fld"><label>项目编号（自动生成）</label>
          <input class="orb-inp" value="${esc(state.nextId)}" disabled style="background:#f6f7f9;color:var(--ink-3)"></div>
        <div class="fld"><label>项目状态（创建后随流程流转）</label>
          <input class="orb-inp" value="配置中" disabled style="background:#f6f7f9;color:var(--ink-3)"></div>
        <div class="fld"><label>项目名称 <i>*</i></label>
          <input class="orb-inp" id="npName" maxlength="60" placeholder="如：园区现场测量与检测"></div>
        <div class="fld"><label>项目负责人 <i>*</i></label>
          <input class="orb-inp" id="npOwner" maxlength="30" placeholder="如：商务人员A"></div>
        <div class="fld"><label>项目时间（左侧导航按此时间分组）</label>
          <input class="orb-inp" id="npTime" type="date" value="${localToday()}"></div>
        <div class="fld full" style="font-size:12px;color:var(--ink-4);line-height:1.8">统一清单、计算规则版本与资格要求按组织级默认挂载（界面设计文档 §5.0）；供应商名单与报价在工作区收集箱逐步归集。</div>
      </div>`;
    showModal("mNew");
    $("#npName").focus();
  }
  async function submitNewProject() {
    const name = $("#npName").value.trim(), owner = $("#npOwner").value.trim(),
          time = $("#npTime") ? $("#npTime").value.trim() : "";
    if (!name || !owner) { toast("创建失败：项目名称与项目负责人均为必填。"); return; }
    try {
      const r = await fetch("/api/projects", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(time ? { name, owner, created_at: time } : { name, owner }) });
      const j = await r.json();
      if (!r.ok) { toastErr(`创建失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      hideModals();
      await loadProjects();
      state.navMonth = String(j.created_at || "").slice(0, 7) || null;   // 新项目所在时间组自动展开
      renderHome();
      toast(`已创建 <b>${esc(j.id)}</b> · ${esc(j.name)}（负责人 ${esc(j.owner)}）——左侧已按「${esc(state.navMonth ? monthLabel(state.navMonth) : "未标注时间")}」分组展开。`);
    } catch (e) {
      toastErr(`创建失败：${esc(e.message)}——请确认已运行 python server.py`);
    }
  }
  function openProject(p) {
    state.cur = p;
    state.proj = null;
    state.view = "project";
    state.tab = 2;                          // 打开项目即落在主工作区②台账（hash 路由恢复时会被显式覆盖）
    state.drawerKey = null;
    state.aiMsgs = [];                      // 智慧报表会话按项目隔离（切项目即清空）
    state.navMonth = monthKey(p) || null;   // 侧栏自动展开该项目所在时间组
    switchView();
    loadProjectBoard();
  }
  async function applyEvent(eid) {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.cur.id)}/events/${encodeURIComponent(eid)}/apply`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) { toastErr(`应用失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      await loadProjectBoard();
      state.tab = 3; renderTabs();
      toast(`已应用 <b>${esc(j.event.id)}</b>：引擎重算完成，生成 <b>V1 澄清后</b> 版本（V1 原始基线保留，差异见「版本与差异」）。`);
    } catch (e) {
      toastErr(`应用失败：${esc(e.message)}`);
    }
  }
  async function discardEvent(eid) {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.cur.id)}/events/${encodeURIComponent(eid)}/discard`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) { toastErr(`作废失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      await loadProjectBoard();
      toast(`事件 <b>${esc(j.event.id)}</b> 已作废（作废不删除，留痕可查）。`);
    } catch (e) {
      toastErr(`作废失败：${esc(e.message)}`);
    }
  }
  async function deliverProject() {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.cur.id)}/status`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "已交付评审" })
      });
      const j = await r.json();
      if (!r.ok) { toastErr(`流转失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      await loadProjectBoard();
      toast(`项目状态已流转：<b>已交付评审</b>（状态机 §6.1，已写入项目档案）。`);
    } catch (e) {
      toastErr(`流转失败：${esc(e.message)}`);
    }
  }
  /* 项目工作台全量数据（清单 + 识别登记 + 引擎台账 + 匹配报告），上传识别后重取 */
  async function loadProjectBoard() {
    if (!state.cur) return;
    try {
      const pb = await getJSON(`/api/projects/${encodeURIComponent(state.cur.id)}/board`);
      state.proj = pb;
      state.cur = pb.project;
      const stages = Object.keys(pb.ledgers || {});
      state.projStage = stages.includes("v1_clarified") ? "v1_clarified" : (stages[0] || "v1_raw");
      const i = state.projects.findIndex((x) => x.id === pb.project.id);
      if (i >= 0) state.projects[i] = pb.project;
      renderAll();
      if (state.drawerKey) openCellDrawer(state.drawerKey);   // 台账重算后刷新已打开的单元格抽屉
    } catch (e) {
      toastErr(`项目数据加载失败：${esc(e.message)}`);
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-open],[data-ver],[data-tab],[data-src],[data-qok],[data-qwait],[data-anf],[data-dry],[data-apply],[data-diffjump],[data-proj],[data-evok],[data-evdis],[data-pf],[data-month],[data-mclear],[data-amt],[data-new-open],[data-demo-open],[data-aiq],.mclose,#btnManual,#aiSend,#aiClear,#btnAI,#btnOnlyFlag,#mRegOk,#btnExport,#btnNewProj,#mNewOk,#btnQuickUpload,#btnDeliver,#btnDemoProj,#mConfirmOk,#cdClose,#cdSubmit");
    if (!t) return;
    const ds = t.dataset;
    if (ds.newOpen) return openNewProjModal();
    if (ds.aiq) return sendAI(ds.aiq);
    if (ds.demoOpen) { state.cur = null; state.proj = null; state.view = "project"; state.tab = 2; state.drawerKey = null; switchView(); return; }
    if (t.id === "aiSend") return sendAI($("#aiInput").value.trim());
    if (t.id === "aiClear") { state.aiMsgs = []; return renderAI(); }
    if (t.id === "btnOnlyFlag") { state.onlyFlagged = !state.onlyFlagged; renderLedger(); return; }
    if (t.id === "btnNewProj") return openNewProjModal();
    if (t.id === "mNewOk") return submitNewProject();
    if (t.id === "btnQuickUpload") return getFileInput().click();
    if (t.id === "btnDemoProj") { state.cur = null; state.proj = null; state.view = "project"; state.tab = 2; state.drawerKey = null; switchView(); return; }
    if (t.id === "mConfirmOk") { const fn = confirmAction; hideModals(); if (fn) fn(); return; }
    if (t.id === "btnDeliver") {
      if (!state.cur) return toast("标记为已交付评审：示例环境演示位。");
      return askConfirm({
        title: "标记为已交付评审",
        okLabel: "确认流转 · 已交付评审",
        okStyle: "accent",
        body: `<p style="font-size:13px;line-height:1.8">这是<b>单向</b>状态流转（状态机 §6.1）：项目「${esc(state.cur.name)}」将标记为<b>已交付评审</b>并写入项目档案。</p>
          <p style="font-size:12px;color:var(--ink-4);line-height:1.7">流转前建议完成⑤导出自检——未关闭事项会如实随「需补充事项」表交付，不阻断。</p>`,
        onOk: deliverProject
      });
    }
    if (ds.evok) return applyEvent(ds.evok);
    if (ds.evdis) return discardEvent(ds.evdis);
    if (t.id === "btnManual") return registerModal();
    if (t.id === "btnAI") {
      if (!state.online) return;
      return toast("正在调用第三方模型接口提取事件候选…（演示：读取结构化缓存，与仓库 gc017_events.json 同构）");
    }
    if (t.id === "mRegOk") return submitRegister();
    if (t.id === "btnExport") {
      if (state.cur) {
        const stage = STAGE_LABEL[state.projStage] ? state.projStage : "v1_raw";
        state.exports.unshift(`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} · 导出 ${STAGE_LABEL[stage]} 台账 xlsx（backend/out/）`);
        renderExport();
        const a = document.createElement("a");
        a.href = `/api/projects/${encodeURIComponent(state.cur.id)}/export?version=${stage}`;
        a.download = ""; a.click();
        return toast("M2 生成器已按当前版本写出 5-sheet 台账 xlsx（企业模板副本填写），开始下载。");
      }
      state.exports.unshift(`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} · 导出 ${STAGE_SHORT[state.stage]} 台账 xlsx（backend/out/）`);
      renderExport();
      const a = document.createElement("a"); a.href = `/api/export/${state.stage}`; a.download = ""; a.click();
      return toast("M2 生成器已写出 5-sheet 台账 xlsx（企业模板副本填写），开始下载。");
    }
    if (ds.open) { state.view = "project"; switchView(); return; }
    if (ds.proj) { const p = state.projects.find((x) => x.id === ds.proj); if (p) openProject(p); return; }
    if (ds.ver) { if (state.cur) { state.projStage = ds.ver; } else { state.stage = ds.ver; } renderAll(); if (state.drawerKey) openCellDrawer(state.drawerKey); else writeHash(); return; }
    if (ds.tab) {
      if (state.view !== "project") { toast("请先在左侧「比选项目」中选择一个项目，再进入工作区功能。"); return; }
      state.tab = +ds.tab; renderTabs(); return;
    }
    if (t.id === "cdClose") return closeCellDrawer();
    if (t.id === "cdSubmit") return submitDrawerEdit();
    if (ds.amt) { state.amountMode = ds.amt; renderLedger(); lfVerChart(); writeHash(); return; }
    if (ds.src) return openCellDrawer(ds.src);
    if (ds.qok) {
      const q = state.queue.find((x) => x.id === ds.qok);
      if (!q) return;
      return askConfirm({
        title: "确认入账",
        okLabel: "确认入账",
        body: `<p style="font-size:13px;line-height:1.8">将把这条<b>低置信识别字段</b>确认写入台账数据：</p>
          <p style="font-size:13px;margin:6px 0"><b>${esc(q.supplier)} · ${esc(q.item)} ${esc(q.name || "")}</b><br>
          <span style="color:var(--ink-4);font-size:12px">置信度 ${q.conf.toFixed(2)}${q.conf < 0.7 ? " · 低" : ""} · ${esc(q.note)}</span></p>
          <p style="font-size:12px;color:var(--ink-4);line-height:1.7">确认动作留痕；无书面依据的未知值请改用「登记待澄清」——不当 0、不硬猜。</p>`,
        onOk: () => { q.status = "done"; renderInbox(); renderCtx(); toast(`字段已确认入账：${q.supplier} ${q.item}（确认动作留痕，实际环境写入操作记录）`); }
      });
    }
    if (ds.qwait) { const q = state.queue.find((x) => x.id === ds.qwait); q.status = "done"; renderInbox(); renderCtx(); return toast(`已登记待澄清：${q.supplier} ${q.item}——未知值不入账，等待书面澄清。`); }
    if (ds.anf) { state.anFilter = ds.anf; renderEvents(); return; }
    if (ds.pf) { state.projFilter = ds.pf; renderHome(); return; }
    if (ds.month) {
      state.navMonth = state.navMonth === ds.month ? null : ds.month;   // 再点一次折叠，主区恢复全部
      if (state.view === "home") renderHome(); else renderNav();
      return;
    }
    if (ds.mclear) { state.navMonth = null; renderHome(); return; }
    if (ds.dry) return dryRun(ds.dry);
    if (ds.apply) return applyStage(ds.apply);
    if (ds.diffjump) { state.diffA = ds.diffjump === "v1_clarified" ? "v1_raw" : "v1_clarified"; state.diffB = ds.diffjump; state.tab = 4; renderTabs(); return; }
    if (t.classList.contains("mclose")) return hideModals();
  });
  document.querySelectorAll(".overlay").forEach((o) => o.addEventListener("click", (e) => { if (e.target === o) hideModals(); }));
  document.addEventListener("change", (ev) => {
    if (ev.target.id === "diffA") { state.diffA = ev.target.value; renderVersions(); }
    if (ev.target.id === "diffB") { state.diffB = ev.target.value; renderVersions(); }
  });
  document.addEventListener("input", (ev) => {
    if (ev.target.id === "projSearch") { state.projQ = ev.target.value; renderHome(); }
  });
  /* ---------------- 键盘可达：台账网格导航 + Esc 关闭 + 弹层焦点陷阱 ----------------
     金额格（td.amount[tabindex]）：Enter/Space 开抽屉；方向键在网格内移动
     （左右 = 同行相邻供应商列，上下 = 同供应商相邻清单行）；Esc 自顶向下关闭
     （先弹层后抽屉）；Tab 在打开的弹层内循环，焦点不逃逸到背景。 */
  document.addEventListener("keydown", (ev) => {
    if (ev.target.id === "aiInput" && ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      const q = $("#aiInput").value.trim();
      if (q) { $("#aiInput").value = ""; sendAI(q); }
    }
    const k = ev.key;
    if (k === "Escape") {
      if (document.querySelector(".overlay.show")) { hideModals(); return; }
      if (state.drawerKey) { closeCellDrawer(); return; }
      return;
    }
    if ((k === "Enter" || k === " ") && ev.target instanceof HTMLElement &&
        ev.target.matches("td.amount[data-src]")) {
      ev.preventDefault();
      openCellDrawer(ev.target.dataset.src);
      return;
    }
    if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(k) ||
        !(ev.target instanceof HTMLElement) || !ev.target.matches("td.amount[data-src]")) return;
    ev.preventDefault();
    const tr = ev.target.parentElement;
    const cells = [...tr.querySelectorAll("td.amount[data-src]")];
    const ci = cells.indexOf(ev.target);
    const rows = [...tr.parentElement.querySelectorAll("tr")].filter((r) => r.querySelector("td.amount[data-src]"));
    const ri = rows.indexOf(tr);
    let target = null;
    if (k === "ArrowRight") target = cells[ci + 1];
    if (k === "ArrowLeft") target = cells[ci - 1];
    if (k === "ArrowDown" && rows[ri + 1]) target = rows[ri + 1].querySelectorAll("td.amount[data-src]")[ci];
    if (k === "ArrowUp" && rows[ri - 1]) target = rows[ri - 1].querySelectorAll("td.amount[data-src]")[ci];
    if (target) target.focus();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.target.id === "aiInput" && ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      const q = $("#aiInput").value.trim();
      if (q) { $("#aiInput").value = ""; sendAI(q); }
    }
    if (ev.key !== "Tab") return;
    const ov = document.querySelector(".overlay.show");
    if (!ov) return;
    const f = [...ov.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")]
      .filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (document.activeElement === last || !ov.contains(document.activeElement))) { ev.preventDefault(); first.focus(); }
  });
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("#onlToggle")) {
      state.online = !state.online;
      const tk = ev.target.closest("#onlToggle");
      tk.classList.toggle("on", state.online);
      tk.setAttribute("aria-checked", String(state.online));
      $("#onlChip").innerHTML = state.online ? "事件 AI 演示 · 开启" : "事件 AI 演示 · 关闭";
      renderEvents();
      toast(state.online ? "事件 AI 演示开启：AI 触点可调用第三方接口（结果缓存后经人工确认）。" : "事件 AI 演示关闭：AI 按钮置灰，人工路径承担全部能力；识别引擎与 M1/M2 本地计算不受影响。");
    }
  });

  /* ---------------- 上传识别绑定（收集箱拖拽/点击 + 工作区小上传按钮，共用同一选择器） ---------------- */
  let _fileInput = null;
  function getFileInput() {
    if (!_fileInput) {
      _fileInput = document.createElement("input");
      _fileInput.type = "file"; _fileInput.multiple = true; _fileInput.style.display = "none";
      _fileInput.addEventListener("change", () => uploadFiles([..._fileInput.files]));
      document.body.appendChild(_fileInput);
    }
    return _fileInput;
  }
  (function bindUpload() {
    const dz = document.querySelector("#dropzone");
    if (!dz) return;
    dz.addEventListener("click", () => getFileInput().click());
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault(); dz.classList.remove("drag");
      if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
    });
  })();

  /* ---------------- 台账/抽屉分隔条：按住拖动调节两侧占比（双击恢复默认） ---------------- */
  (function bindSplitter() {
    const sp = document.querySelector("#splitter");
    if (!sp) return;
    const MIN = 240, MAX = 560, DEF = 346;
    let dragging = false;
    const setW = (px) => document.documentElement.style.setProperty("--drawer-w", `${Math.round(px)}px`);
    sp.addEventListener("mousedown", (e) => { dragging = true; e.preventDefault(); document.body.classList.add("splitting"); });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const drawer = document.querySelector("#cellDrawer.open");
      const host = document.querySelector(".drawer-host");
      if (!drawer || !host) return;
      const rect = host.getBoundingClientRect();
      const raw = rect.right - e.clientX;
      const cap = Math.max(MIN, rect.width - 420);   // 表格区至少保留 420px
      setW(Math.min(MAX, Math.min(cap, Math.max(MIN, raw))));
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("splitting");
    });
    sp.addEventListener("dblclick", () => setW(DEF));
  })();

  /* 图表折叠随视口高度联动（用户未手动指定时）；防抖 150ms */
  let _lfRzT = 0;
  window.addEventListener("resize", () => {
    clearTimeout(_lfRzT);
    _lfRzT = setTimeout(() => { if (state.lfUserCollapsed === null) applyLfCollapse(); }, 150);
  });

  /* ---------------- 视图与页签 ---------------- */
  function switchView() {
    $("#viewHome").classList.toggle("show", state.view === "home");
    $("#viewProject").classList.toggle("show", state.view === "project");
    if (state.view === "home") renderHome(); else renderAll();
    window.scrollTo(0, 0);
  }
  function renderTabs() {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", +b.dataset.tab === state.tab));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.remove("show"));
    $("#" + { 1: "paneInbox", 2: "paneLedger", 3: "paneEvents", 4: "paneVersions", 5: "paneExport", 6: "paneAI" }[state.tab]).classList.add("show");
    renderCtx();
    [renderInbox, renderLedger, renderEvents, renderVersions, renderExport, renderAI][state.tab - 1]();
    writeHash();
  }
  function renderAll() { renderCtx(); renderTabs(); }

  /* ---------------- Hash 路由：刷新 / 分享 / 手动改址恢复视图状态 ----------------
     #/                                        首页（q=搜索 pf=状态筛选 m=时间分组）
     #/p/{项目ID}/{页签}/{口径}/{版本}/{抽屉?}  项目工作区
     #/demo/{页签}/{版本}/{口径}/{抽屉?}        内置 GC-017 演示工作区
     写入统一走 writeHash（history.replaceState，不产生历史记录噪音）；
     读取仅在初始化与外部 hashchange（手动改址）时进行，lastHash 守卫自触发。 */
  let lastHash = null;
  function hashForState() {
    if (state.view === "home") {
      const p = new URLSearchParams();
      if (state.projQ.trim()) p.set("q", state.projQ.trim());
      if (state.projFilter !== "全部") p.set("pf", state.projFilter);
      if (state.navMonth) p.set("m", state.navMonth);
      const qs = p.toString();
      return "#/" + (qs ? "?" + qs : "");
    }
    if (state.cur) {
      let h = `#/p/${state.cur.id}/${state.tab}/${state.amountMode}/${state.projStage || "v1_raw"}`;
      if (state.drawerKey) h += `/${state.drawerKey}`;
      return h;
    }
    let h = `#/demo/${state.tab}/${state.stage}/${state.amountMode}`;
    if (state.drawerKey) h += `/${state.drawerKey}`;
    return h;
  }
  function writeHash() {
    const h = hashForState();
    lastHash = h;
    if (location.hash !== h) history.replaceState(null, "", h);
  }
  const clampTab = (n) => (n >= 1 && n <= 6 ? n : 2);
  function parseHash() {
    const [path, qs] = (location.hash || "#/").slice(1).split("?");
    /* 浏览器写入 hash 时会把中文 percent-encode（如 戊 → %E6%88%8A），读取段统一解码 */
    const seg = path.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch (_) { return s; } });
    return { seg, q: new URLSearchParams(qs || "") };
  }
  function applyHash() {
    const { seg, q } = parseHash();
    state.projQ = q.get("q") || "";
    state.projFilter = q.get("pf") || "全部";
    state.navMonth = q.get("m") || null;
    const si = $("#projSearch");
    if (si && state.projQ) si.value = state.projQ;
    if (seg[0] === "p" && seg[1]) {
      const p = state.projects.find((x) => x.id === seg[1]);
      state.tab = clampTab(Number(seg[2]));
      if (seg[3] === "ws" || seg[3] === "hs") state.amountMode = seg[3];
      state.projStage = seg[4] || "v1_raw";
      state.drawerKey = seg[5] || null;
      if (!p) return false;   // 项目已被删除或不存在 → 回落首页
      state.cur = p;
      state.proj = null;
      state.view = "project";
      state.navMonth = monthKey(p) || null;
      switchView();
      loadProjectBoard();     // board 到达后按 state.drawerKey 重开抽屉（既有钩子）
      return true;
    }
    if (seg[0] === "demo") {
      state.tab = clampTab(Number(seg[1]));
      const st = seg[2];
      if (st && state.unlocked[st]) state.stage = st;   // 未解锁版本回落已解锁的最新
      let i = 3;
      if (seg[i] === "ws" || seg[i] === "hs") { state.amountMode = seg[i]; i++; }
      state.cur = null;
      state.proj = null;
      state.view = "project";
      state.drawerKey = seg[i] || null;
      switchView();
      if (state.drawerKey) openCellDrawer(state.drawerKey);
      return true;
    }
    state.view = "home";
    state.cur = null;
    state.proj = null;
    switchView();
    return true;
  }
  window.addEventListener("hashchange", () => {
    if ((location.hash || "#/") === lastHash) return;   // 自己写入的忽略
    applyHash();
  });

  /* ---------------- 启动 ---------------- */
  async function init() {
    state.boot = await getJSON("/api/bootstrap");
    const [r, c, v, ir, ic, iv] = await Promise.all([
      getJSON("/api/ledger/v1_raw"), getJSON("/api/ledger/v1_clarified"), getJSON("/api/ledger/v2"),
      getJSON("/api/issues/v1_raw"), getJSON("/api/issues/v1_clarified"), getJSON("/api/issues/v2"),
      loadProjects(),
    ]);
    state.ledgers = { v1_raw: r, v1_clarified: c, v2: v };
    state.issues = { v1_raw: ir, v1_clarified: ic, v2: iv };
    state.queue = state.boot.recognition_queue.map((q, i) => ({ ...q, id: "Q" + (i + 1), status: "pending" }));
    await loadRecognition();
    if (Array.isArray(state.boot.suppliers_order) && state.boot.suppliers_order.length) {
      SUPS = state.boot.suppliers_order;   // 供应商清单由数据决定（与引擎/导出层一致）
    }

    $("#backHome").addEventListener("click", () => { state.view = "home"; state.cur = null; state.proj = null; switchView(); });
    /* ⑤版本下拉：与 ctxbar 版本胶囊共享同一全局版本上下文（DD-UI 吸收） */
    $("#exportVersion").addEventListener("change", (ev) => {
      if (state.cur) state.projStage = ev.target.value; else state.stage = ev.target.value;
      renderCtx(); renderExport();
    });
    ["#diffA", "#diffB"].forEach((sel) => {
      $(sel).innerHTML = Object.keys(STAGE_SHORT).map((k) => `<option value="${k}">${STAGE_SHORT[k]}</option>`).join("");
    });
    $("#diffA").value = state.diffA; $("#diffB").value = state.diffB;

    if (!applyHash()) { state.view = "home"; renderHome(); switchView(); renderTabs(); }   // 路由恢复（项目不存在回落首页）
    const bad = state.boot.checks.filter((x) => !x.ok);
    if (bad.length) toast("⚠ 引擎回归未全过：" + bad.map((b) => b.msg.slice(0, 18)).join("、"));
  }
  init().catch((e) => {
    toast(`引擎服务未连接：${esc(e.message)} —— 请运行 <b>python server.py</b>`, { kind: "error", sticky: true });
  });
})();

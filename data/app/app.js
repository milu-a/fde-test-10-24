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
    queue: [], exports: [], manual: [],
    recognition: { engines: [], results: [] },
    projects: [], nextId: "", cur: null,   // cur = 当前打开的比选项目（新建项目空壳工作区）
    proj: null, projStage: "v1_raw",       // proj = board 数据；projStage = 项目台账当前查看版本
    anFilter: "全部", diffA: "v1_raw", diffB: "v1_clarified",
    projQ: "", projFilter: "全部",   // 首页项目检索与状态筛选（只作用于主区卡片）
    navMonth: null,                  // 左侧导航展开的时间分组（null = 全部折叠，主区显示全部）
    amountMode: "hs",                // 台账金额口径：hs=含税 / ws=未税（含税不可折算的格在未税口径显示未税额 + *）
    drawerKey: null,                 // 当前打开的单元格抽屉（"itemId|supplier"）
    aiStatus: null, aiMsgs: [], aiBusy: false   // 智慧报表：AI 服务状态 + 会话（内存，不落盘）
  };

  /* ---------------- 基础工具 ---------------- */
  function toast(msg) {
    const el = document.createElement("div");
    el.className = "orb-snack toast"; el.innerHTML = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
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
    renderNav();   // 返回首页路径不经 renderCtx，需单独刷新导航活动态
    $("#projectCount").textContent = state.projects.length;
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
      return `
      <button class="proj-card orb-card" data-proj="${esc(p.id)}">
        <span class="row1"><span class="pid">${esc(p.id)}</span><span class="badge ${STATUS_CLS[p.status] || ""}">${esc(p.status)}</span></span>
        <span class="pname">${esc(p.name)}</span>
        <span class="meta"><span>负责人 <b>${esc(p.owner)}</b></span><span>报价 <b>${sm.suppliers || 0} 家</b></span>
          <span>台账 <b>${sm.has_ledger ? "已生成" : "待归集"}</b></span></span>
        <span class="act"><span>${esc(String(p.created_at).slice(0, 10))} 创建</span><span class="project-enter">进入工作区 →</span></span>
      </button>`;
    }).join("")
      : (state.projects.length
        ? `<div class="empty-search"><b>没有找到匹配的项目</b><p>试试其他关键词，或清除筛选查看全部项目。</p><button class="orb-btn orb-btn-neutral" data-clear-filters="1">清除筛选</button></div>`
        : `<div class="onboarding">
            <div class="onboarding-copy"><span class="eyebrow">开始一轮新的比选</span><h3>从第一个项目开始</h3><p>把分散的报价，放进同一个工作空间。<br>创建项目后，即可上传文件、核对差异并生成台账。</p><button class="orb-btn orb-btn-secondary" data-new-project="1">创建第一个项目 <span aria-hidden="true">→</span></button><span class="format-note">支持 Excel、PDF 与报价截图</span></div>
            <ol class="onboarding-steps"><li><span class="step-no">01</span><div><b>建立项目，归集原件</b><p>填写项目名称与负责人，上传供应商报价。</p></div></li><li><span class="step-no">02</span><div><b>统一口径，核对差异</b><p>查看异常提示，登记有依据的澄清与修改。</p></div></li><li><span class="step-no">03</span><div><b>保留记录，导出台账</b><p>核对版本差异，交付包含来源与操作记录的五表台账。</p></div></li></ol>
          </div>`);
  }

  /* ---------------- 左侧导航岛（项目按时间分组折叠；展开某组时主区联动筛选） ---------------- */
  function renderNav() {
    $("#navTotal").textContent = state.projects.length;
    const ov = $(".nav-overview");
    if (ov) ov.classList.toggle("active", state.view === "home");
    const el = $("#navProjects");
    if (!el) return;
    const fw = $("#navFuncWrap");
    if (fw) fw.style.display = state.cur ? "" : "none";
    if (!state.projects.length) {
      el.innerHTML = `<div class="nav-empty"><span class="nav-empty-line"></span><b>还没有项目</b><span>新建后，项目将在这里<br>按时间分组展示。</span></div>`;
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
        <button class="nav-proj${state.cur && state.cur.id === p.id ? " active" : ""}" data-proj="${esc(p.id)}" title="${esc(p.id)} · ${esc(p.name)}">
          <span class="nav-proj-copy"><b>${esc(p.id)}</b><span>${esc(p.name)}</span></span>
          <span class="nav-proj-short">${esc(String(p.id || "").replace(/^GC-?/, "") || "·")}</span>
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
        if (j.error) { toast(`识别失败：${esc(j.error)}`); continue; }
        await loadRecognition();
        if (state.cur) {
          await loadProjectBoard();
          toast(`识别完成：<b>${esc(j.file)}</b> · ${esc(j.channel_desc)} · 记录 ${j.records.length} 条，已登记进项目并重算台账。`);
        } else {
          if (state.tab === 1) renderInbox();
          toast(`识别完成：<b>${esc(j.file)}</b> · ${esc(j.channel_desc)} · 记录 ${j.records.length} 条${j.needs_model ? "（已转人工，不硬猜）" : ""}`);
        }
      } catch (e) {
        toast(`识别请求失败：${esc(e.message)}——请确认已运行 python server.py`);
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
  /* 新项目台账：识别 → M4 匹配 → 引擎计算的 V1 原始/澄清后（orb-tbl 规格） */
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
    if (!hasData) return;
    const ws = state.amountMode === "ws";
    const led = pb.ledgers[stage];
    const rawLed = pb.ledgers.v1_raw;
    const head = `<tr><th class="l lock lock1">编号</th><th class="l lock lock2">名称</th><th class="lock lock3">单位</th>
      <th class="lock lock4">数量</th>${sups.map((v) => `<th>${esc(v)}${ws ? "未税" : "含税"}</th>`).join("")}</tr>`;
    const cellHtml = (cat, sup) => {
      const lines = (led.rows[cat.id] || {})[sup] || [];
      const p0 = lines[0];
      const title = p0 ? esc(p0.basis || p0.flags.join("；") || p0.note || "") : "";
      const src = ` data-src="${cat.id}|${sup}"`;
      if (!p0 || p0.status !== "已计算") return `<td class="amount st-missing"${src} title="${title}">未报</td>`;
      const flagged = lines.some((c) => c.flags.length);
      if (p0.hs === null) {
        /* 税率未给：含税口径显示状态文案（不当 0、不折算）；未税口径显示未税额 + * 标记 */
        if (ws) {
          return `<td class="amount st-pending${flagged ? " st-flag" : ""}"${src} title="${title}">${fmt(sumLines(lines, "ws"))}${lines.length > 1 ? ` ×${lines.length}` : ""}${wsAst}</td>`;
        }
        return `<td class="amount st-pending${flagged ? " st-flag" : ""}"${src} title="${title}">税率未给${lines.length > 1 ? ` ×${lines.length}` : ""}</td>`;
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
      return `<td class="amount${restated}${flagged ? " st-flag" : ""}"${src} title="${title}">${fmt(sumLines(lines, state.amountMode))}</td>`;
    };
    const rows = pb.catalog.items.map((cat) => `
      <tr><td class="l lock lock1">${cat.id}</td><td class="l lock lock2" title="${esc(cat.name)}">${esc(cat.name)}</td>
      <td class="lock lock3">${esc(cat.unit)}</td>
      <td class="lock lock4">${esc(cat.qty)}</td>${sups.map((sup) => cellHtml(cat, sup)).join("")}</tr>`).join("");
    const totalCell = (s) => {
      const t = led.totals[s] || {};
      const flags = t.flags || [];
      const top = (ws ? t.ws : t.hs) != null ? fmt(ws ? t.ws : t.hs) : "—";
      const sub = t.stated != null ? fmt(t.stated) : "—";
      const tip = flags.length ? ` title="${esc(flags.join("；"))}"` : "";
      return `<td${flags.length ? ` class="st-flag"${tip}` : tip}>${top}<span class="t-sub">${sub}</span></td>`;
    };
    const totalRow = `<tr class="total"><td class="t-label lock" colspan="4" style="left:0">合计（上行：计算${ws ? "未税" : "含税"}；下行：原报列示）</td>
      ${sups.map(totalCell).join("")}</tr>`;
    $("#ledger").innerHTML = `<thead>${head}</thead><tbody>${rows}${totalRow}</tbody>`;
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
    syncAmountMode();
    const head = `<tr><th class="l lock lock1">编号</th><th class="l lock lock2">名称</th><th class="lock lock3">单位</th>
      <th class="lock lock4">数量</th>${SUPS.map((v) => `<th>${esc(v)}${ws ? "未税" : "含税"}</th>`).join("")}</tr>`;

    const rows = state.boot.catalog.items.map((cat) => {
      const per = led.rows[cat.id];
      const isV2Changed = state.stage === "v2" && cat.id === "C08";
      const cells = SUPS.map((sup) => {
        const lines = per[sup];
        const p0 = lines[0];
        const title = esc(p0.basis || p0.flags.join("；") || p0.note || "");
        const src = ` data-src="${cat.id}|${sup}"`;
        if (p0.status !== "已计算") return `<td class="amount st-missing"${src} title="${title}">未报</td>`;
        const flagged = lines.some((c) => c.flags.length);
        if (p0.hs === null) {
          /* 税率未给：含税口径显示状态文案（不当 0、不折算）；未税口径显示未税额 + * 标记 */
          if (ws) {
            return `<td class="amount st-pending${flagged ? " st-flag" : ""}"${src} title="${title}">${fmt(sumLines(lines, "ws"))}${lines.length > 1 ? ` ×${lines.length}` : ""}${wsAst}</td>`;
          }
          return `<td class="amount st-pending${flagged ? " st-flag" : ""}"${src} title="${title}">税率未给${lines.length > 1 ? ` ×${lines.length}` : ""}</td>`;
        }
        /* 状态底色：与 V1 原始比对，数值/数量变化即"澄清修正"；C08 在 V2 为"变更重算" */
        const raw = ledRawCell(cat.id, sup);
        const changed = Number(p0.qty) !== Number(raw.qty) || Number(p0.hs) !== Number(raw.hs) ||
          lines.length !== state.ledgers.v1_raw.rows[cat.id][sup].length;
        const st = isV2Changed ? " st-recomp" : (changed ? " st-restated" : "");
        return `<td class="amount${st}${flagged ? " st-flag" : ""}"${src} title="${title}">${fmt(sumLines(lines, state.amountMode))}</td>`;
      }).join("");
      return `<tr><td class="l lock lock1">${cat.id}</td><td class="l lock lock2">${esc(cat.name)}</td>
        <td class="lock lock3">${esc(cat.unit)}</td>
        <td class="lock lock4">${qm[cat.id]}</td>${cells}</tr>`;
    }).join("");

    /* 合计（上行：计算口径随切换；下行：原报列示）与（V2）较V1差异 —— 与 M2 对比表 xlsx 同构 */
    const totTip = esc(SUPS.flatMap((s) => led.totals[s].flags.map((f) => `${s}：${f}`)).join("；"));
    const totalRow = `<tr class="total"><td class="t-label lock" colspan="4" style="left:0" title="${totTip}">合计（上行：计算${ws ? "未税" : "含税"}；下行：原报列示）</td>
      ${SUPS.map((s) => {
        const t = led.totals[s];
        const top = (ws ? t.ws : t.hs) != null ? fmt(ws ? t.ws : t.hs) : "—";
        const sub = t.stated != null ? fmt(t.stated) : "—";
        return `<td${t.flags.length ? ' class="st-flag"' : ""}>${top}<span class="t-sub">${sub}</span></td>`;
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
      srcHtml = `<div class="cd-kv"><span class="k">来源定位</span><span>${esc(p0 ? p0.source || "—" : "—")}</span></div>` + (recRows.length ? `
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
        <div class="fld"><label>依据文件 + 定位 <i>*无依据不改数</i></label><input class="orb-inp" id="cdEvidence" placeholder="如 供应商澄清纪要.pdf · 第2行"></div>
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
  }
  async function submitDrawerEdit() {
    if (!state.cur || !state.drawerKey) return;
    const [op, field] = $("#cdOp").value.split(":");
    const nv = $("#cdVal").value.trim(), basis = $("#cdEvidence").value.trim();
    if (op !== "DEDUPE" && !nv) { toast("登记失败：新值必填。"); return; }
    if (!basis) { toast("登记失败：依据必填——无依据不改数。"); return; }
    const [itemId, sup] = state.drawerKey.split("|");
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
      if (!r.ok) { toast(`登记失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      toast(`修改已登记为事件 <b>${esc(j.event.id)}</b>（待确认·已留痕）——在③事件与澄清确认应用后引擎重算生效。`);
      await loadProjectBoard();   // 完成后重取台账，并重开本抽屉以刷新历史
    } catch (e) {
      toast(`登记失败：${esc(e.message)}——请确认已运行 python server.py`);
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
  function renderEvents() {
    if (state.cur) {
      const pb = state.proj;
      const stages = Object.keys(pb && pb.ledgers ? pb.ledgers : {});
      const led = stages.length ? pb.ledgers[stages.includes(state.projStage) ? state.projStage : stages[0]] : null;
      /* 异常与待核查：当前版本引擎行级旗标聚合（状态型旗标按供应商折叠，原值保留） */
      $("#anFilter").innerHTML = "";
      if (led) {
        const seen = new Set();
        const rows = [];
        pb.catalog.items.forEach((cat) => pb.suppliers_order.forEach((sup) => {
          ((led.rows[cat.id] || {})[sup] || []).forEach((c) => {
            (c.flags || []).forEach((f) => {
              const collapse = f.includes("税率未给") || f.includes("相关口径合计不完整");
              const key = collapse ? `${sup}|${f}` : `${sup}|${cat.id}|${f}`;
              if (seen.has(key)) return;
              seen.add(key);
              rows.push(`<div class="an-row"><span class="cls"><span class="bdg info">${esc(sup)}${collapse ? "" : " · " + cat.id}</span></span>
                <span class="txt"><b>${esc(f)}</b><small>引擎行级旗标 · 异常只提示不改写原值</small></span>
                <span class="st"><span class="tag-open">● 待核查</span></span></div>`);
            });
          });
        }));
        $("#anList").innerHTML = rows.length ? rows.join("")
          : `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">当前版本无异常旗标。</p>`;
      } else {
        $("#anList").innerHTML = `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">暂无异常事项：报价归集并生成台账后，系统核对发现的异常会列在这里。</p>`;
      }
    $("#evtEntries").innerHTML = `
      <button class="orb-btn orb-btn-primary" id="btnManual">＋ 登记事件（人工路径 · 离线可用）</button>
      <button class="orb-btn orb-btn-neutral" id="btnAI" ${state.online ? "" : "disabled"} title="${state.online ? "演示入口，尚未接入模型服务" : "演示已关闭，请使用人工登记"}">AI 提取演示${state.online ? "" : "（已关闭）"}</button>
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
      <button class="orb-btn orb-btn-neutral" id="btnAI" title="第三方模型接口：从纪要提取事件候选（M4 接口位 · 演示环境读取结构化缓存，确认前不动台账）">⚡ AI 提取事件</button>
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
        <div class="v" style="margin-top:4px">未税 ${fmt(a.ws)} → ${fmt(b.ws)}</div></div>`;
    }).join("");
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
  }

  /* ---------------- 页签⑤ 导出交付（远程 DD-UI 版整体重做） ---------------- */
  let exportBusy = false;
  function exportContext() {
    const pb = state.proj;
    const stages = state.cur ? Object.keys(pb?.ledgers || {}) : Object.keys(STAGE_SHORT).filter(k => state.unlocked[k]);
    const selected = state.cur ? state.projStage : state.stage;
    return { pb, stages, stage: stages.includes(selected) ? selected : stages[0], projectId: state.cur?.id || "example" };
  }
  function renderExport() {
    const { pb, stages, stage, projectId } = exportContext();
    const can = stages.length > 0;
    const history = state.exports.filter(x => x.projectId === projectId);
    $("#exportVersion").innerHTML = can ? stages.map(k => `<option value="${k}" ${k === stage ? "selected" : ""}>${esc(STAGE_LABEL[k] || STAGE_SHORT[k])}</option>`).join("") : '<option>暂无可用版本</option>';
    $("#exportVersion").disabled = !can || exportBusy;
    $("#btnExport").disabled = !can || exportBusy;
    $("#btnExport").textContent = exportBusy ? "正在生成…" : "下载交付包";
    const delivered = ["已交付评审", "已定标", "已归档"].includes(state.cur?.status);
    $("#btnDeliver").hidden = !can || (!history.length && !delivered);
    $("#btnDeliver").disabled = delivered || !state.cur;
    $("#btnDeliver").textContent = delivered ? "已交付评审" : "标记为已交付评审";
    $("#expHistory").innerHTML = history.length ? history.map(x => `<div class="export-record"><span><b>${esc(x.label)}</b><span>Excel · 已发起下载</span></span><time>${esc(x.time)}</time></div>`).join("") : '<p class="export-muted">暂无记录</p>';
    if (!can) {
      $("#exportMeta").textContent = "上传报价并生成台账后，即可下载。";
      $("#expChk").innerHTML = '<p class="export-muted">暂无可检查的台账。<button class="orb-link" data-tab="1">前往收集箱 →</button></p>';
      return;
    }
    const suppliers = state.cur ? pb.suppliers_order.length : SUPS.length;
    $("#exportMeta").textContent = `${suppliers} 家供应商${state.cur ? ` · ${pb.match_report.matched} 条已匹配` : ""} · 包含 5 张工作表`;
    let summary, detail;
    if (state.cur) {
      const um = pb.match_report.unmatched || [];
      const pending = pb.counts.pending_events;
      summary = [um.length ? `${um.length} 项报价待匹配` : "", pending ? `${pending} 条事件待确认` : "", "资格材料未配置"].filter(Boolean).join(" · ");
      detail = `<ul>${um.map(u => `<li><b>${esc(u.vendor)} · ${esc(u.name || "未命名报价项")}</b><span>${esc(String(u.basis || "").replace(/^M4/, ""))}${u.file ? ` · ${esc(u.file)}` : ""}</span></li>`).join("")}${pending ? `<li>${pending} 条事件尚未确认，不计入所选版本。<button class="orb-link" data-tab="3">查看事件 →</button></li>` : ""}<li>资格材料清单为空，交付前请另行核对。</li></ul><button class="orb-link" data-tab="3">查看台账异常与澄清 →</button>`;
    } else {
      const issues = state.issues[stage] || [];
      const open = issues.filter(i => !i.closed).length;
      summary = `${open} 项待核查 · 资格材料待补充`;
      detail = '<p>乙检测资质未提交；丁资质到期未续，请核对后交付。</p><button class="orb-link" data-tab="3">查看异常与澄清 →</button>';
    }
    $("#expChk").innerHTML = `<details class="export-issues"><summary><span class="export-issue-summary">${summary.split(" · ").map(part => `<span>${esc(part)}</span>`).join("")}</span><span class="export-detail-label">查看详情</span></summary><div class="export-issue-body">${detail}</div></details><p class="export-muted export-issue-note">待补充事项不阻止下载，请结合台账中的「需补充事项」核对。</p>`;
  }
  async function downloadExport() {
    const { stages, stage, projectId } = exportContext();
    if (!stages.length || exportBusy) return;
    const label = STAGE_LABEL[stage] || STAGE_SHORT[stage];
    const url = state.cur ? `/api/projects/${encodeURIComponent(projectId)}/export?version=${stage}` : `/api/export/${stage}`;
    exportBusy = true;
    renderExport();
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`服务返回 ${response.status}，请重试`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `${projectId}_${label}_比选台账.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      state.exports.unshift({ projectId, label, time: new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) });
      toast(`${esc(label)} 交付包已生成，已发起下载。`);
    } catch (e) {
      toast(`下载失败：${esc(e instanceof TypeError ? "无法连接服务，请稍后重试" : e.message)}`);
    } finally {
      exportBusy = false;
      renderExport();
    }
  }

  /* ---------------- 弹层 / 登记 / AI 位 ---------------- */
  let modalTrigger = null;
  function showModal(id) {
    modalTrigger = document.activeElement;
    const overlay = $("#" + id);
    overlay.classList.add("show");
    const modal = overlay.querySelector(".modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", overlay.querySelector(".mhead b").textContent);
    overlay.querySelectorAll(".fld").forEach((fld) => {
      const input = fld.querySelector("input,select"), label = fld.querySelector("label");
      if (input && label && input.id) label.htmlFor = input.id;
    });
    $(".app-shell").inert = true;
    (overlay.querySelector(".mbody input:not(:disabled),.mbody select:not(:disabled)") || overlay.querySelector("button")).focus();
  }
  function hideModals() {
    document.querySelectorAll(".overlay").forEach((o) => o.classList.remove("show"));
    $(".app-shell").inert = false;
    if (modalTrigger && modalTrigger.isConnected) modalTrigger.focus();
  }
  document.addEventListener("keydown", (ev) => {
    const overlay = $(".overlay.show");
    if (!overlay) return;
    if (ev.key === "Escape") { ev.preventDefault(); hideModals(); return; }
    if (ev.key === "Tab") {
      const focusable = [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter((el) => el.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  });
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
          <div class="fld full"><label>依据文件 + 条款定位 <i>*必填：无依据不改数</i></label>
            <input class="orb-inp" id="regBasis" placeholder="如 供应商澄清纪要.pdf · 第2行"></div>
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
        <div class="fld full"><label>依据文件 + 条款定位 <i>*必填：无依据不改数</i></label><input class="orb-inp" id="regBasis" placeholder="如：02 报价澄清/供应商澄清纪要.txt · CLARIFY-01"></div>
      </div>`;
    showModal("mReg");
  }
  async function submitRegister() {
    if (state.cur) {
      const op = $("#regType").value, sup = $("#regSup").value, item = $("#regItem").value,
            field = $("#regField").value, nv = $("#regNew").value.trim(),
            line = $("#regLine").value.trim(), basis = $("#regBasis").value.trim(),
            note = $("#regNote").value.trim();
      if (!nv || !basis) { toast("登记失败：新值与依据均为必填——无依据不改数。"); return; }
      let payload = null, newVal = nv;
      if (op === "DECLARE_TAX") {
        const m = nv.match(/^([\d.]+)\s*%$/);
        newVal = m ? String(Number(m[1]) / 100) : nv;
      } else if (op === "ADD_LINE") {
        if (line) {
          const mm = line.match(/^([\d.]+)\s*[×xX]\s*([\d.]+)$/);
          if (!mm) { toast("补录行格式：数量×单价，如 12×460"); return; }
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
        if (!r.ok) { toast(`登记失败：${esc(j.error || "HTTP " + r.status)}`); return; }
        hideModals();
        await loadProjectBoard();
        state.tab = 3; renderTabs();
        toast(`事件 <b>${esc(j.event.id)}</b> 已登记并留痕（待确认——确认应用前不动台账）。`);
      } catch (e) {
        toast(`登记失败：${esc(e.message)}——请确认已运行 python server.py`);
      }
      return;
    }
    const tg = $("#regTarget").value.trim(), dt = $("#regDetail").value.trim(), ba = $("#regBasis").value.trim();
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
          <input class="orb-inp" value="${esc(state.nextId)}" disabled style="background:var(--orb-surface);color:var(--ink-3)"></div>
        <div class="fld"><label>项目状态（创建后随流程流转）</label>
          <input class="orb-inp" value="配置中" disabled style="background:var(--orb-surface);color:var(--ink-3)"></div>
        <div class="fld"><label>项目名称 <i>*</i></label>
          <input class="orb-inp" id="npName" maxlength="60" placeholder="如：园区现场测量与检测"></div>
        <div class="fld"><label>项目负责人 <i>*</i></label>
          <input class="orb-inp" id="npOwner" maxlength="30" placeholder="如：商务人员A"></div>
        <div class="fld"><label>项目时间（左侧导航按此时间分组）</label>
          <input class="orb-inp" id="npTime" type="date" value="${localToday()}"></div>
        <div class="fld full form-note">创建后可在收集箱上传报价。本项目使用默认的测量检测清单，资格材料暂需另行核对。</div>
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
      if (!r.ok) { toast(`创建失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      hideModals();
      await loadProjects();
      state.navMonth = String(j.created_at || "").slice(0, 7) || null;   // 新项目所在时间组自动展开
      renderHome();
      toast(`已创建 <b>${esc(j.id)}</b> · ${esc(j.name)}（负责人 ${esc(j.owner)}）——左侧已按「${esc(state.navMonth ? monthLabel(state.navMonth) : "未标注时间")}」分组展开。`);
    } catch (e) {
      toast(`创建失败：${esc(e.message)}——请确认已运行 python server.py`);
    }
  }
  function openProject(p) {
    state.cur = p;
    state.proj = null;
    state.view = "project";
    state.navMonth = monthKey(p) || null;   // 侧栏自动展开该项目所在时间组
    state.tab = 2;                          // 切换项目 → 右侧自动落到「② 统一对比台账」
    state.projStage = "v1_raw";
    state.anFilter = "全部";
    if (state.drawerKey) closeCellDrawer(); // 上一项目的单元格抽屉不带入新项目
    state.aiMsgs = [];                      // 智慧报表会话按项目隔离（切项目即清空）
    switchView();
    loadProjectBoard();
  }
  async function applyEvent(eid) {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.cur.id)}/events/${encodeURIComponent(eid)}/apply`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) { toast(`应用失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      await loadProjectBoard();
      state.tab = 3; renderTabs();
      toast(`已应用 <b>${esc(j.event.id)}</b>：引擎重算完成，生成 <b>V1 澄清后</b> 版本（V1 原始基线保留，差异见「版本与差异」）。`);
    } catch (e) {
      toast(`应用失败：${esc(e.message)}`);
    }
  }
  async function discardEvent(eid) {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.cur.id)}/events/${encodeURIComponent(eid)}/discard`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) { toast(`作废失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      await loadProjectBoard();
      toast(`事件 <b>${esc(j.event.id)}</b> 已作废（作废不删除，留痕可查）。`);
    } catch (e) {
      toast(`作废失败：${esc(e.message)}`);
    }
  }
  async function deliverProject() {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(state.cur.id)}/status`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "已交付评审" })
      });
      const j = await r.json();
      if (!r.ok) { toast(`流转失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      await loadProjectBoard();
      toast(`项目状态已流转：<b>已交付评审</b>，已保存至项目档案。`);
    } catch (e) {
      toast(`流转失败：${esc(e.message)}`);
    }
  }
  /* 项目工作台全量数据（清单 + 识别登记 + 引擎台账 + 匹配报告），上传识别后重取 */
  async function loadProjectBoard() {
    if (!state.cur) return;
    const pid = state.cur.id;   // 竞态保护：连续切换项目时，慢到的旧响应按归属丢弃
    try {
      const pb = await getJSON(`/api/projects/${encodeURIComponent(pid)}/board`);
      if (!state.cur || state.cur.id !== pid) return;   // 响应回来时已切到别的项目 → 丢弃
      state.proj = pb;
      state.cur = pb.project;
      const stages = Object.keys(pb.ledgers || {});
      state.projStage = stages.includes("v1_clarified") ? "v1_clarified" : (stages[0] || "v1_raw");
      const i = state.projects.findIndex((x) => x.id === pb.project.id);
      if (i >= 0) state.projects[i] = { ...pb.project, summary: { suppliers: pb.suppliers_order.length, has_ledger: stages.length > 0 } };
      renderAll();
      if (state.drawerKey) openCellDrawer(state.drawerKey);   // 台账重算后刷新已打开的单元格抽屉
    } catch (e) {
      toast(`项目数据加载失败：${esc(e.message)}`);
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-home],[data-new-project],[data-clear-filters],[data-open],[data-ver],[data-tab],[data-src],[data-qok],[data-qwait],[data-anf],[data-dry],[data-apply],[data-diffjump],[data-proj],[data-evok],[data-evdis],[data-pf],[data-month],[data-mclear],[data-amt],[data-aiq],.mclose,#btnManual,#btnAI,#mRegOk,#btnExport,#btnNewProj,#mNewOk,#btnQuickUpload,#btnDeliver,#cdClose,#cdSubmit,#aiSend,#aiClear,#navToggle");
    if (!t) return;
    const ds = t.dataset;
    if (ds.newProject) return openNewProjModal();
    if (ds.home) { closeCellDrawer(); state.view = "home"; state.cur = null; state.proj = null; switchView(); return; }
    if (ds.clearFilters) { state.projQ = ""; state.projFilter = "全部"; state.navMonth = null; $("#projSearch").value = ""; renderHome(); return; }
    if (t.id === "btnNewProj") return openNewProjModal();
    if (t.id === "mNewOk") return submitNewProject();
    if (t.id === "btnQuickUpload") return getFileInput().click();
    if (t.id === "btnDeliver") { if (state.cur) return deliverProject(); return toast("标记为已交付评审：示例环境演示位。"); }
    if (ds.evok) return applyEvent(ds.evok);
    if (ds.evdis) return discardEvent(ds.evdis);
    if (t.id === "btnManual") return registerModal();
    if (t.id === "btnAI") {
      return toast("事件 AI 提取为演示入口，尚未接入模型服务。请使用人工登记添加事件。");
    }
    if (t.id === "mRegOk") return submitRegister();
    if (t.id === "btnExport") return downloadExport();
    if (ds.open) { state.view = "project"; switchView(); return; }
    if (ds.proj) { const p = state.projects.find((x) => x.id === ds.proj); if (p) openProject(p); return; }
    if (ds.ver) { if (state.cur) { state.projStage = ds.ver; } else { state.stage = ds.ver; } renderAll(); if (state.drawerKey) openCellDrawer(state.drawerKey); return; }
    if (ds.tab) {
      if (state.view !== "project") { toast("请先在左侧「比选项目」中选择一个项目，再进入工作区功能。"); return; }
      state.tab = +ds.tab; renderTabs(); return;
    }
    if (t.id === "cdClose") return closeCellDrawer();
    if (t.id === "cdSubmit") return submitDrawerEdit();
    if (t.id === "aiSend") return sendAI($("#aiInput").value.trim());
    if (t.id === "aiClear") { state.aiMsgs = []; return renderAI(); }
    if (t.id === "navToggle") {
      const sn = $(".sidenav");
      const collapsed = sn.classList.toggle("collapsed");
      try { localStorage.setItem("fde_nav_collapsed", collapsed ? "1" : "0"); } catch (e) { /* 隐私模式忽略 */ }
      $("#navToggle").title = collapsed ? "展开导航栏" : "收起导航栏（右侧自适应放大）";
      return;
    }
    if (ds.aiq) return sendAI(ds.aiq);
    if (ds.amt) { state.amountMode = ds.amt; renderLedger(); return; }
    if (ds.src) return openCellDrawer(ds.src);
    if (ds.qok) { const q = state.queue.find((x) => x.id === ds.qok); q.status = "done"; renderInbox(); renderCtx(); return toast(`字段已确认入账：${q.supplier} ${q.item}（确认动作留痕，实际环境写入操作记录）`); }
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
    if (ev.target.id === "exportVersion") { if (state.cur) state.projStage = ev.target.value; else state.stage = ev.target.value; renderCtx(); renderExport(); }
    if (ev.target.id === "diffA") { state.diffA = ev.target.value; renderVersions(); }
    if (ev.target.id === "diffB") { state.diffB = ev.target.value; renderVersions(); }
  });
  document.addEventListener("input", (ev) => {
    if (ev.target.id === "projSearch") { state.projQ = ev.target.value; renderHome(); }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.target.id === "aiInput" && ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      const q = $("#aiInput").value.trim();
      if (q) { $("#aiInput").value = ""; sendAI(q); }
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
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); getFileInput().click(); } });
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
  }
  function renderAll() { renderCtx(); renderTabs(); }

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
    // 侧栏折叠状态记忆（localStorage；折叠由 #navToggle 切换）
    try {
      if (localStorage.getItem("fde_nav_collapsed") === "1") {
        $(".sidenav").classList.add("collapsed");
        $("#navToggle").title = "展开导航栏";
      }
    } catch (e) { /* 隐私模式忽略 */ }
    ["#diffA", "#diffB"].forEach((sel) => {
      $(sel).innerHTML = Object.keys(STAGE_SHORT).map((k) => `<option value="${k}">${STAGE_SHORT[k]}</option>`).join("");
    });
    $("#diffA").value = state.diffA; $("#diffB").value = state.diffB;

    renderHome(); switchView(); renderTabs();
    const bad = state.boot.checks.filter((x) => !x.ok);
    if (bad.length) toast("⚠ 引擎回归未全过：" + bad.map((b) => b.msg.slice(0, 18)).join("、"));
  }
  init().catch((e) => {
    document.body.insertAdjacentHTML("beforeend",
      `<div class="orb-snack toast" style="position:fixed;top:70px;right:20px;z-index:300">引擎服务未连接：${esc(e.message)} —— 请运行 <b>python server.py</b></div>`);
  });
})();

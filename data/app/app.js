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
  let SUPS = ["甲", "乙", "丙", "丁"];   // 由 bootstrap suppliers_order 数据驱动（上游 5c5b8f5）

  /* 对比表"差异及待核对"列不重复展示的旗标（与 report/xlsx.py EXCLUDE_DIFF 一致） */
  const EXCLUDE_DIFF = ["税率未给", "单价未填", "报价中无此分项", "未知值不当0", "按列示金额"];

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

  const state = {
    view: "home", tab: 2, stage: "v1_raw",
    unlocked: { v1_raw: true, v1_clarified: false, v2: false },
    boot: null, ledgers: {}, issues: {},
    queue: [], online: false, exports: [], manual: [],
    recognition: { engines: [], results: [] },
    projects: [], nextId: "", cur: null,   // cur = 当前打开的比选项目（新建项目空壳工作区）
    proj: null,                            // 当前项目的 board 数据（清单/识别登记/引擎台账/匹配报告）
    anFilter: "全部", diffA: "v1_raw", diffB: "v1_clarified"
  };

  /* ---------------- 基础工具 ---------------- */
  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast"; el.innerHTML = msg;
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

  /* ---------------- 行级旗标 → 短徽章（关键词映射，与 report/_cat_of 同思路） ---------------- */
  function flagBadge(f) {
    if (f.includes("同一分项出现")) return { t: "重复行", c: "info" };
    if (f.includes("列示金额与数量×单价差")) return { t: "疑似抄错", c: "warn", dot: true };
    if (f.includes("数量与清单不符")) return { t: "数量不符", c: "warn", dot: true };
    if (f.includes("未并入")) return { t: "附件未并入", c: "warn", dot: true };
    if (f.includes("超参考区间上限")) return { t: "超区间", c: "warn", dot: true };      // M5：区间旗标入引擎
    if (f.includes("低于参考区间下限")) return { t: "低于区间", c: "warn", dot: true };  // M5：异常低价线索
    if (f.includes("单位口径待澄清")) return { t: "单位待澄清", c: "" };
    if (f.includes("无单价，按列示金额")) return { t: "整项口径", c: "" };
    if (f.includes("税率未给") || f.includes("单价未填") || f.includes("报价中无此分项")) return null;
    return { t: f.length > 14 ? f.slice(0, 14) + "…" : f, c: "" };
  }

  /* ---------------- 首页 ---------------- */
  function renderHome() {
    $("#projGrid").innerHTML = state.projects.length ? state.projects.map((p) => `
      <div class="proj-card" data-proj="${esc(p.id)}">
        <div class="row1"><span class="pid">${esc(p.id)}</span><span class="pname">${esc(p.name)}</span>
          <span class="spacer" style="flex:1"></span><span class="badge ${STATUS_CLS[p.status] || ""}">${esc(p.status)}</span></div>
        <div class="meta"><span>负责人 <b>${esc(p.owner)}</b></span><span>报价 <b>0 家</b></span>
          <span>台账 <b>—</b></span><span>待办 <b>0</b> 项</span></div>
        <div class="act">${esc(p.created_at)} · ${esc(p.owner)} 创建项目 · 点击进入工作区</div>
      </div>`).join("")
      : `<p style="grid-column:1/-1;color:var(--ink-4);font-size:13px;padding:10px 2px">暂无比选项目——点击右上角「＋ 新建比选项目」创建第一轮比选；创建后进入工作区归集报价文件。</p>`;
  }

  /* ---------------- 工作区上下文条 ---------------- */
  function renderCtx() {
    if (state.cur) {
      const pb = state.proj;
      const proj = (pb && pb.project) || state.cur;
      $("#ctxTitle").textContent = `${proj.id} · ${proj.name}`;
      $("#ctxBadge").textContent = proj.status;
      $("#ctxBadge").className = `badge ${STATUS_CLS[proj.status] || ""}`;
      const supN = pb ? pb.suppliers_order.length : 0;
      const hasLed = !!(pb && pb.ledger && Object.keys(pb.ledger.rows || {}).length);
      const umN = pb && pb.match_report ? pb.match_report.unmatched.length : 0;
      $("#ctxMeta").innerHTML = `<span>负责人 <b>${esc(proj.owner)}</b></span><span>报价 <b>${supN} 家</b></span>
        <span>台账 <b>${hasLed ? "V1 原始" : "—"}</b></span><span>未关闭待办 <b>${umN}</b></span>`;
      $("#verSwitch").innerHTML = hasLed ? `<button class="active">V1 原始</button>` : "";
      $("#verLabel").style.display = hasLed ? "" : "none";
      $("#tabCnt1").textContent = umN; $("#tabCnt1").className = "cnt" + (umN ? "" : " zero");
      $("#tabCnt3").textContent = 0; $("#tabCnt3").className = "cnt zero";
      return;
    }
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
    $("#tabCnt1").textContent = pendQ; $("#tabCnt1").className = "cnt" + (pendQ ? "" : " zero");
    $("#tabCnt3").textContent = openIssues; $("#tabCnt3").className = "cnt" + (openIssues ? "" : " zero");
  }

  /* ---------------- 页签① 收集箱 ---------------- */
  const REC_FIELDS = ["行类型", "原始编码", "原始分项名称", "单位", "数量", "单价", "单价口径",
                      "税率", "原报金额", "待人工标记", "出处-定位"];
  function recCard(r) {
    const flagged = r.records.filter((x) => x["待人工标记"]).length;
    return `<div class="rec-card">
      <div class="rec-head"><b>${esc(r.file)}</b>
        <span class="bdg info">${esc(r.vendor_guess)}方候选</span>
        <span class="bdg ${r.needs_model ? "warn" : "petrol"}">${esc(r.channel_desc)}</span>
        ${r.engine ? `<span class="bdg">${esc(String(r.engine)).slice(0, 30)}</span>` : ""}
        <span class="bdg">置信度 ${esc(r.confidence || "—")}</span></div>
      <p>${esc(r.note)}</p>
      <div class="rec-meta">记录 <b>${r.records.length}</b> 条 · 待人工标记 <b class="${flagged ? "delta-minus" : ""}">${flagged}</b> 条 · 原件 ${esc(r.saved_as)}（只读落位，未覆盖） · ${esc(r.ts)}</div>
      ${r.records.length ? `<details><summary>展开 ${r.records.length} 条结构化记录（15 字段含出处，与台账流程同构）</summary>
        <div class="rec-table"><table class="simple"><thead><tr>${REC_FIELDS.map((f) => `<th>${f}</th>`).join("")}</tr></thead><tbody>
          ${r.records.map((x) => `<tr>${REC_FIELDS.map((f) => {
              const v = x[f] ?? "";
              const cls = f === "待人工标记" && v ? " delta-minus" : (f === "数量" || f === "单价" || f === "原报金额" ? "r num" : "");
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
            <button class="btn sm primary" data-qok="${q.id}" ${q.status === "done" ? "disabled" : ""}>${q.status === "done" ? "已确认" : "确认入账"}</button>
            <button class="btn sm" data-qwait="${q.id}" ${q.status === "done" ? "disabled" : ""}>登记待澄清</button>
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
  /* 新项目台账：识别 → M4 匹配 → 引擎计算的 V1 原始结果（单版本，无跨版本状态比对） */
  function renderProjectLedger() {
    const pb = state.proj;
    $("#ctxVersion").textContent = "V1 原始";
    $("#ctxVersion").className = "badge st-clarify";
    $("#legendBar").classList.remove("hidden");
    const sups = pb ? pb.suppliers_order : [];
    const hasData = !!(pb && pb.ledger && sups.length && Object.keys(pb.ledger.rows || {}).length);
    $("#ledgerEmpty").classList.toggle("hidden", hasData);
    $("#ledgerWrap").classList.toggle("hidden", !hasData);
    if (!hasData) return;
    const led = pb.ledger;
    const head = `<tr><th class="l lock lock1">清单编号</th><th class="l lock lock2">名称</th><th class="l lock lock3">单位</th>
      <th class="l lock lock4">数量</th>${sups.map((v) => `<th>${esc(v)} · 含税（未税）</th>`).join("")}<th class="l">差异及待核对</th></tr>`;
    const rows = pb.catalog.items.map((cat) => {
      const per = led.rows[cat.id] || {};
      const cells = sups.map((sup) => {
        const lines = per[sup] || [];
        const p0 = lines[0];
        if (!p0) return `<td class="amount num st-missing">未报</td>`;
        let cls = "amount num", body, note = "";
        const badges = [];
        if (p0.status !== "已计算") {
          cls += " st-missing"; body = "未报";
        } else if (p0.hs === null) {
          cls += " st-pending"; body = "税率未给";
          if (p0.ws != null) note = `<span class="v-note">未税 ${fmt(p0.ws)}</span>`;
        } else {
          body = fmt(lines.reduce((a, c) => a + Number(c.hs || 0), 0));
          if (lines.every((c) => c.ws != null)) {
            note = `<span class="v-note">未税 ${fmt(lines.reduce((a, c) => a + Number(c.ws), 0))}</span>`;
          }
        }
        lines.forEach((c) => c.flags.forEach((f) => { const b = flagBadge(f); if (b) badges.push(b); }));
        if (lines.length > 1) badges.push({ t: `×${lines.length}行`, c: "info" });
        const dot = badges.some((b) => b.dot) ? '<span class="dot"></span>' : "";
        const bgs = [...new Map(badges.map((b) => [b.t, b])).values()].slice(0, 3)
          .map((b) => `<span class="bdg ${b.c}">${b.t}</span>`).join("");
        return `<td class="${cls}" data-src="${cat.id}|${sup}" title="${esc(p0.basis || p0.flags.join("；") || p0.note)}">${body}${bgs}${dot}${note}</td>`;
      }).join("");
      const diffTxt = sups.map((sup) => {
        const fs = (per[sup] || []).flatMap((c) => c.flags).filter((f) => !EXCLUDE_DIFF.some((k) => f.includes(k)));
        return fs.length ? `${sup}：${fs.map(esc).join("；")}` : null;
      }).filter(Boolean).join("；") || "—";
      return `<tr><td class="l lock lock1">${cat.id}</td><td class="l lock lock2">${esc(cat.name)}</td>
        <td class="l lock lock3">${esc(cat.unit)}</td>
        <td class="l lock lock4 num">${esc(cat.qty)}</td>${cells}<td class="diffcell">${diffTxt}</td></tr>`;
    }).join("");
    const totFlags = sups.flatMap((s) => ((led.totals[s] || {}).flags || []).map((f) => `${s}：${f}`)).join("；") || "—";
    const totalRow = `<tr class="total"><td class="l lock lock1">合计</td><td class="l lock lock2">按明细计算</td><td class="l lock lock3"></td><td class="l lock lock4"></td>
      ${sups.map((s) => {
        const t = led.totals[s] || {};
        const main = t.hs != null ? fmt(t.hs) : "—";
        const sub = t.hs == null && t.ws != null ? `未税 ${fmt(t.ws)} · 含税不可折算（税率未声明）` : (t.ws != null ? `未税 ${fmt(t.ws)}` : "");
        return `<td class="amount num">${main}<span class="v-note">${esc(sub)}</span></td>`;
      }).join("")}<td class="diffcell">${esc(totFlags)}</td></tr>`;
    const statedRow = `<tr><td class="l lock lock1">列示合计</td><td class="l lock lock2">供应商原报，未核实</td><td class="l lock lock3"></td><td class="l lock lock4"></td>
      ${sups.map((s) => `<td class="num">${led.totals[s] && led.totals[s].stated != null ? fmt(led.totals[s].stated) : "—"}</td>`).join("")}
      <td class="diffcell">收集箱识别归集 · 金额计算零LLM、全 Decimal；异常仅提示不改写，价格合理性与选商由评审人员判断。</td></tr>`;
    $("#ledger").innerHTML = `<thead>${head}</thead><tbody>${rows}${totalRow}${statedRow}</tbody>`;
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
    const head = `<tr><th class="l lock lock1">清单编号</th><th class="l lock lock2">名称</th><th class="l lock lock3">单位</th>
      <th class="l lock lock4">数量</th>${SUPS.map((v) => `<th>${v} · 含税（未税）</th>`).join("")}<th class="l">差异及待核对</th></tr>`;

    const rows = state.boot.catalog.items.map((cat) => {
      const per = led.rows[cat.id];
      const isV2Changed = state.stage === "v2" && cat.id === "C08";
      const cells = SUPS.map((sup) => {
        const lines = per[sup];
        const p0 = lines[0];
        let cls = "amount num", body, note = "";
        const badges = [];
        if (p0.status !== "已计算") {
          cls += " st-missing"; body = "未报";
        } else if (p0.hs === null) {
          cls += " st-pending"; body = "税率未给";
          if (p0.ws != null) note = `<span class="v-note">未税 ${fmt(p0.ws)}</span>`;
        } else {
          body = fmt(lines.reduce((a, c) => a + Number(c.hs || 0), 0));
          if (lines.every((c) => c.ws != null)) {
            note = `<span class="v-note">未税 ${fmt(lines.reduce((a, c) => a + Number(c.ws), 0))}</span>`;
          }
          /* 状态底色：与 V1 原始比对，数值/数量变化即"澄清修正"；C08 在 V2 为"变更重算" */
          const raw = ledRawCell(cat.id, sup);
          if (Number(p0.qty) !== Number(raw.qty) || Number(p0.hs) !== Number(raw.hs) ||
              lines.length !== state.ledgers.v1_raw.rows[cat.id][sup].length) {
            cls += isV2Changed ? " st-recomp" : " st-restated";
          }
        }
        lines.forEach((c) => {
          c.flags.forEach((f) => { const b = flagBadge(f); if (b) badges.push(b); });
        });
        if (lines.length > 1) badges.push({ t: `×${lines.length}行`, c: "info" });
        const dot = badges.some((b) => b.dot) ? '<span class="dot"></span>' : "";
        const bgs = [...new Map(badges.map((b) => [b.t, b])).values()].slice(0, 3)
          .map((b) => `<span class="bdg ${b.c}">${b.t}</span>`).join("");
        return `<td class="${cls}" data-src="${cat.id}|${sup}" title="${esc(p0.basis || p0.flags.join("；") || p0.note)}">${body}${bgs}${dot}${note}</td>`;
      }).join("");

      const diffTxt = SUPS.map((sup) => {
        const fs = per[sup].flatMap((c) => c.flags).filter((f) => !EXCLUDE_DIFF.some((k) => f.includes(k)));
        return fs.length ? `${sup}：${fs.map(esc).join("；")}` : null;
      }).filter(Boolean).join("；") || "—";
      const stCls = isV2Changed ? " st-recomp" : "";
      return `<tr><td class="l lock lock1${stCls}">${cat.id}</td><td class="l lock lock2${stCls}">${esc(cat.name)}</td>
        <td class="l lock lock3${stCls}">${esc(cat.unit)}</td>
        <td class="l lock lock4 num${stCls}">${qm[cat.id]}</td>${cells}<td class="diffcell">${diffTxt}</td></tr>`;
    }).join("");

    /* 合计 / 列示合计 / （V2）较V1差异 —— 与 M2 对比表 xlsx 同构 */
    const totFlags = SUPS.flatMap((s) => led.totals[s].flags.map((f) => `${s}：${f}`)).join("；") || "—";
    const totalRow = `<tr class="total"><td class="l lock lock1">合计</td><td class="l lock lock2">按明细计算</td><td class="l lock lock3"></td><td class="l lock lock4"></td>
      ${SUPS.map((s) => {
        const t = led.totals[s];
        const main = t.hs != null ? fmt(t.hs) : "—";
        const sub = t.hs == null && t.ws != null ? `未税 ${fmt(t.ws)} · 含税不可折算（税率未声明）` : (t.ws != null ? `未税 ${fmt(t.ws)}` : "");
        return `<td class="amount num">${main}<span class="v-note">${esc(sub)}</span></td>`;
      }).join("")}<td class="diffcell">${esc(totFlags)}</td></tr>`;
    const statedRow = `<tr><td class="l lock lock1">列示合计</td><td class="l lock lock2">供应商原报，未核实</td><td class="l lock lock3"></td><td class="l lock lock4"></td>
      ${SUPS.map((s) => `<td class="num">${led.totals[s].stated != null ? fmt(led.totals[s].stated) : "—"}</td>`).join("")}
      <td class="diffcell">口径：金额计算零LLM、全 Decimal；异常仅提示，价格合理性与选商由评审人员判断。</td></tr>`;
    let deltaRow = "";
    if (state.stage === "v2") {
      const prev = state.ledgers.v1_clarified.totals;
      deltaRow = `<tr><td class="l lock lock1">较V1差异</td><td class="l lock lock2">V2合计−V1澄清后合计（含税口径）</td><td class="l lock lock3"></td><td class="l lock lock4"></td>
        ${SUPS.map((s) => {
          const a = led.totals[s].hs, b = prev[s].hs;
          const d = a != null && b != null ? Number(a) - Number(b) : null;
          return `<td class="num ${d >= 0 ? "delta-plus" : "delta-minus"}">${d != null ? (d >= 0 ? "+" : "") + fmt(d) : "—"}</td>`;
        }).join("")}<td class="diffcell">保留 V1 基线与金额差异（CHANGE-01 要求）。</td></tr>`;
    }
    $("#ledger").innerHTML = `<thead>${head}</thead><tbody>${rows}${totalRow}${statedRow}${deltaRow}</tbody>`;
  }

  /* ---------------- 来源回查弹窗 ---------------- */
  function openSrc(key) {
    const [itemId, sup] = key.split("|");
    const lines = curLedger().rows[itemId][sup];
    const cat = state.boot.catalog.items.find((c) => c.id === itemId);
    const p0 = lines[0];
    const parts = String(p0.source || "—").split(" · ");
    const srcFile = parts[0], locator = parts.slice(1).join(" · ");
    const asset = state.boot.asset_map[srcFile] || "";

    let preview;
    if (asset) {
      preview = `<div class="src-img"><img src="${asset}" alt="原件预览">
        <div style="padding:8px 10px;font-size:11.5px;color:var(--ink-4);border-top:1px solid var(--line-2)">原件截图 · 识别来源：第三方视觉接口（结果已缓存）· 定位：${esc(p0.source)}</div></div>`;
    } else {
      const raw = state.ledgers.v1_raw.rows;
      preview = `<div class="src-table"><table class="simple"><thead><tr><th>清单编号</th><th>原始分项</th><th class="r">原数量</th><th class="r">原金额</th><th class="r">列示金额</th></tr></thead><tbody>
        ${Object.keys(raw).map((it) => raw[it][sup].map((c) => `
          <tr style="${it === itemId ? "background:rgba(0,72,138,.10);box-shadow:inset 3px 0 0 var(--orbis-blue)" : ""}">
            <td>${c.item}</td><td>${esc(c.name)}</td><td class="r">${c.orig_qty ?? "—"}</td>
            <td class="r">${c.orig_amount != null ? fmt(c.orig_amount) : "—"}</td>
            <td class="r">${c.stated_amount != null ? fmt(c.stated_amount) : "—"}</td></tr>`).join("")).join("")}
        </tbody></table></div>
        <div style="font-size:11.5px;color:var(--ink-4);margin-top:6px">解析来源：${srcFile.endsWith(".xlsx") ? "Excel 程序直读（本地）" : "PDF 文本层抽取（本地）"} · ${esc(srcFile)}${locator ? " · " + esc(locator) : ""}</div>`;
    }
    $("#mSrcBody").innerHTML = `
      <div class="src-grid"><div>${preview}</div>
      <div><div class="src-kv">
        <div class="kv"><span class="k">清单项</span><span>${itemId} ${esc(cat.name)}（${esc(cat.unit)} · 清单量 ${cat.qty}）</span></div>
        <div class="kv"><span class="k">供应商</span><span>${sup} · ${esc(state.boot.suppliers[sup].file.split("/").pop())}</span></div>
        <div class="kv"><span class="k">行状态</span><span>${esc(p0.status)} · 税率${esc(p0.tax_state)} · 单位${esc(p0.unit_state)}${lines.length > 1 ? ` · ×${lines.length}行` : ""}</span></div>
        <div class="kv"><span class="k">数量</span><span class="num">统一 ${p0.qty ?? "—"}${p0.orig_qty != null && Number(p0.orig_qty) !== Number(p0.qty) ? `（原报 ${p0.orig_qty}）` : ""}</span></div>
        <div class="kv"><span class="k">列示金额</span><span class="num">${p0.stated_amount != null ? fmt(p0.stated_amount) : "—"}（原报，未核实）</span></div>
        <div class="kv"><span class="k">计算金额</span><span class="num">原始口径 ${p0.orig_amount != null ? fmt(p0.orig_amount) : "—"} · 未税 ${p0.ws != null ? fmt(p0.ws) : "不可折算"} · 税额 ${p0.tax != null ? fmt(p0.tax) : "—"} · 含税 ${p0.hs != null ? fmt(p0.hs) : "不可折算"}</span></div>
        <div class="kv"><span class="k">折算依据</span><span>${esc(p0.basis || "—")}</span></div>
        <div class="kv"><span class="k">来源定位</span><span>${esc(p0.source)}</span></div>
        ${(p0.flags.length || p0.note) ? `<div class="kv"><span class="k">线索</span><span>${esc(p0.flags.join("；"))}${p0.note ? (p0.flags.length ? "；" : "") + esc(p0.note) : ""}</span></div>` : ""}
        <div class="kv"><span class="k">红线提示</span><span style="color:var(--ink-4)">异常仅提示不改写原值；区间不构成定价或中标判断；系统不推荐中标。</span></div>
      </div></div></div>`;
    showModal("mSrc");
  }
  /* 新项目来源回查：金额 → 识别记录 15 字段表（对应行高亮）→ 原件出处 */
  function openProjectSrc(key) {
    const [itemId, sup] = key.split("|");
    const pb = state.proj;
    if (!pb || !pb.ledger) return;
    const lines = (pb.ledger.rows[itemId] || {})[sup] || [];
    const p0 = lines[0];
    const cat = pb.catalog.items.find((c) => c.id === itemId);
    const recs = (pb.records[sup] && pb.records[sup].records) || [];
    const srcParts = p0 ? String(p0.source || "").split(" · ") : [];
    const srcFile = srcParts[0] || "", srcLoc = srcParts.slice(1).join(" · ");
    const recRows = recs.filter((r) => r["行类型"] !== "说明");
    const preview = recRows.length ? `<div class="src-table"><table class="simple"><thead><tr><th>行类型</th><th>原始编码</th><th>原始分项名称</th><th>单位</th><th class="r">数量</th><th class="r">单价</th><th>口径</th><th>税率</th><th class="r">原报金额</th><th>出处-定位</th></tr></thead><tbody>
        ${recRows.map((r) => {
          const hit = srcFile && r["出处-文件"] === srcFile && r["出处-定位"] === srcLoc;
          return `<tr style="${hit ? "background:rgba(0,72,138,.10);box-shadow:inset 3px 0 0 var(--orbis-blue)" : ""}">
            <td>${esc(r["行类型"])}</td><td>${esc(r["原始编码"])}</td><td>${esc(r["原始分项名称"])}</td><td>${esc(r["单位"])}</td>
            <td class="r">${esc(r["数量"])}</td><td class="r">${esc(r["单价"])}</td><td>${esc(r["单价口径"])}</td><td>${esc(r["税率"])}</td>
            <td class="r">${esc(r["原报金额"])}</td><td>${esc(r["出处-定位"])}</td></tr>`;
        }).join("")}
      </tbody></table></div>
      <div style="font-size:11.5px;color:var(--ink-4);margin-top:6px">read-file 识别记录（15 字段缓存）· ${esc(srcFile)}${srcLoc ? " · " + esc(srcLoc) : ""}</div>`
      : `<p style="color:var(--ink-4);font-size:13px">该供应商暂无识别记录缓存。</p>`;
    $("#mSrcBody").innerHTML = `
      <div class="src-grid"><div>${preview}</div>
      <div><div class="src-kv">
        ${p0 ? `<div class="kv"><span class="k">清单项</span><span>${itemId} ${esc(cat ? cat.name : "")}（${esc(cat ? cat.unit : "")} · 清单量 ${esc(cat ? cat.qty : "")}）</span></div>
        <div class="kv"><span class="k">供应商</span><span>${esc(sup)} · ${esc(p0.source || "—")}</span></div>
        <div class="kv"><span class="k">行状态</span><span>${esc(p0.status)} · 税率${esc(p0.tax_state)} · 单位${esc(p0.unit_state)}${lines.length > 1 ? ` · ×${lines.length}行` : ""}</span></div>
        <div class="kv"><span class="k">数量</span><span class="num">统一 ${esc(p0.qty ?? "—")}${p0.orig_qty != null && Number(p0.orig_qty) !== Number(p0.qty) ? `（原报 ${esc(p0.orig_qty)}）` : ""}</span></div>
        <div class="kv"><span class="k">列示金额</span><span class="num">${p0.stated_amount != null ? fmt(p0.stated_amount) : "—"}（原报，未核实）</span></div>
        <div class="kv"><span class="k">计算金额</span><span class="num">原始口径 ${p0.orig_amount != null ? fmt(p0.orig_amount) : "—"} · 未税 ${p0.ws != null ? fmt(p0.ws) : "不可折算"} · 税额 ${p0.tax != null ? fmt(p0.tax) : "—"} · 含税 ${p0.hs != null ? fmt(p0.hs) : "不可折算"}</span></div>
        <div class="kv"><span class="k">折算依据</span><span>${esc(p0.basis || "—")}</span></div>
        ${(p0.flags.length || p0.note) ? `<div class="kv"><span class="k">线索</span><span>${esc(p0.flags.join("；"))}${p0.note ? (p0.flags.length ? "；" : "") + esc(p0.note) : ""}</span></div>` : ""}
        <div class="kv"><span class="k">红线提示</span><span style="color:var(--ink-4)">异常仅提示不改写原值；区间不构成定价或中标判断；系统不推荐中标。</span></div>` : `<p>该格暂无引擎计算行。</p>`}
      </div></div></div>`;
    showModal("mSrc");
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
      $("#anFilter").innerHTML = "";
      $("#anList").innerHTML = `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">暂无异常事项：报价归集并生成台账后，系统核对发现的异常会按类列在这里。</p>`;
      $("#evtEntries").innerHTML = `
        <button class="btn primary" id="btnManual">＋ 登记事件（人工路径 · 离线可用）</button>
        <button class="btn" id="btnAI" ${state.online ? "" : "disabled"} title="${state.online ? "第三方模型接口：从纪要提取事件候选（M4 接口位）" : "当前离线：第三方模型接口不可用，请使用人工登记路径"}">⚡ AI 提取事件${state.online ? "" : "（离线不可用）"}</button>
        <span style="font-size:12px;color:var(--ink-4);align-self:center">事件候选 → 人工逐条确认 → 引擎按序应用重算；确认前不动台账。</span>`;
      $("#evtCards").innerHTML = state.manual.length ? state.manual.map((m) => `
        <div class="evt-card"><div class="ehead"><b>${esc(m.id)} · 人工登记事件</b><span class="bdg">待确认</span>
          <span class="spacer" style="flex:1"></span><span class="esub">${esc(m.time)} · ${esc(m.op)}</span></div>
        <div class="evt-items"><div class="evt-item"><span class="etype">${esc(m.type)}</span>
          <span class="target">${esc(m.target)}</span><span class="delta">${esc(m.detail)}　<span class="basis-link">依据：${esc(m.basis)}</span></span></div></div>
        <div class="eops"><span style="font-size:12px;color:var(--ink-4)">演示环境：已登记并留痕，未触发引擎重算。</span></div>
      </div>`).join("")
        : `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">尚无事件：澄清纪要、变更通知等上下文文件登记为事件并确认应用后，在此形成时间轴并驱动台账新版本。</p>`;
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
      <button class="btn primary" id="btnManual">＋ 登记事件（人工路径 · 离线可用）</button>
      <button class="btn" id="btnAI" ${state.online ? "" : "disabled"} title="${state.online ? "第三方模型接口：从纪要提取事件候选（M4 接口位）" : "当前离线：第三方模型接口不可用，请使用人工登记路径"}">⚡ AI 提取事件${state.online ? "" : "（离线不可用）"}</button>
      <span style="font-size:12px;color:var(--ink-4);align-self:center">事件候选 → 人工逐条确认 → 引擎按序应用重算；确认前不动台账。</span>`;

    const cl = state.boot.events.clarify, ch = state.boot.events.change;
    $("#evtCards").innerHTML = `
      <div class="evt-card">
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
            ? `<button class="btn sm" data-diffjump="v1_clarified">查看差异表（V1 原始 → V1 澄清后）</button>`
            : `<button class="btn sm" data-dry="v1_clarified">差异预演（dry-run）</button>
               <button class="btn sm petrol" data-apply="v1_clarified">确认并应用 → 生成 V1 澄清后</button>`}
          <span style="font-size:12px;color:var(--ink-4)">依据：${esc(cl.doc)}</span>
        </div>
      </div>
      <div class="evt-card change">
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
            ? `<button class="btn sm" data-diffjump="v2">查看差异表（V1 澄清后 → V2）</button>`
            : `<button class="btn sm" data-dry="v2" ${state.unlocked.v1_clarified ? "" : "disabled"}>差异预演（dry-run）</button>
               <button class="btn sm petrol" data-apply="v2" ${state.unlocked.v1_clarified ? "" : "disabled"}>确认并应用 → 生成 V2 变更后</button>`}
          <span style="font-size:12px;color:var(--ink-4)">依据：${esc(ch.doc)} · 乙C08区间线索与资格待补保持未关闭</span>
        </div>
      </div>` + state.manual.map((m) => `
      <div class="evt-card"><div class="ehead"><b>${esc(m.id)} · 人工登记事件</b><span class="bdg">待确认</span>
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
      return `<div class="sumcard"><div class="v">${s} 含税总价</div><div class="n num">${hsTxt}</div>
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
  function diffStages(sa, sb) {
    if (sa === sb) return [];
    const A = state.ledgers[sa], B = state.ledgers[sb], out = [];
    state.boot.catalog.items.forEach((cat) => SUPS.forEach((sup) => {
      const x = stageCell(A, cat.id, sup), y = stageCell(B, cat.id, sup);
      if (x.text !== y.text || x.qty !== y.qty || x.n !== y.n) {
        const basis = B.rows[cat.id][sup][0].basis || B.rows[cat.id][sup][0].flags[0] || "";
        out.push({ sup, item: cat.id, field: "含税金额", from: x.text, to: y.text,
                   basis: (basis || "—").length > 44 ? basis.slice(0, 44) + "…" : (basis || "—") });
      }
    }));
    return out;
  }
  function renderVersions() {
    if (state.cur) {
      $("#vtimeline").innerHTML = `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">尚无版本：事件确认应用后生成新版本（V1 澄清后 → V2 变更后），历史版本永不覆盖。</p>`;
      $("#sumBar").innerHTML = "";
      $("#diffWrap").innerHTML = `<p style="color:var(--ink-4);font-size:13px;padding:12px">生成台账版本后，可在此对比任意两个版本的逐项差异。</p>`;
      $("#opLog").innerHTML = `<p style="color:var(--ink-4);font-size:13px;padding:12px">暂无操作记录。</p>`;
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
      return `<div class="sumcard"><div class="v">${s} · ${STAGE_SHORT[state.stage]} 含税合计</div>
        <div class="n num">${t.hs != null ? fmt(t.hs) : "—（不可折算）"}</div>
        <div class="d" style="color:var(--ink-4)">${chain}</div></div>`;
    }).join("");

    const a = state.diffA, b = state.diffB;
    const d = diffStages(a, b);
    $("#diffWrap").innerHTML = d.length ? `<table class="simple"><thead><tr>
        <th>供应商</th><th>清单项</th><th>字段</th><th class="r">${STAGE_SHORT[a]}</th><th class="r">${STAGE_SHORT[b]}</th><th>变化依据</th></tr></thead><tbody>
        ${d.map((r) => `<tr><td>${r.sup}</td><td>${r.item}</td><td>${r.field}</td>
          <td class="r num">${esc(r.from)}</td><td class="r num">${esc(r.to)}</td>
          <td>${esc(r.basis)}</td></tr>`).join("")}</tbody></table>`
      : `<p style="color:var(--ink-4);font-size:13px;padding:12px 0">所选两版本无差异，请选择不同版本。</p>`;

    $("#opLog").innerHTML = `<table class="simple"><thead><tr><th style="width:130px">操作时间</th><th style="width:90px">操作者</th><th style="width:64px">供应商</th><th style="width:64px">分项</th><th>原值 → 新值 · 依据</th></tr></thead><tbody>
      ${led.audit.map((o) => `<tr><td class="num">${esc(o["操作时间"])}</td><td>${esc(o["操作者"])}</td><td>${esc(o["供应商"])}</td><td>${esc(o["分项"])}</td>
        <td>${esc(o["原值"])} → <b>${esc(o["新值"])}</b>　<span style="color:var(--ink-4)">依据：${esc(o["变更依据"])}</span></td></tr>`).join("")}
      </tbody></table>`;
  }

  /* ---------------- 页签⑤ 导出交付 ---------------- */
  function renderExport() {
    if (state.cur) {
      $("#expChk").innerHTML = `<p style="color:var(--ink-4);font-size:13px;padding:8px 0">尚无可导出的台账：报价归集、澄清确认并生成台账版本后，此处进行导出自检并产出五表 xlsx（企业模板副本填写，输出目录与原件物理分离）。</p>`;
      $("#btnExport").disabled = true;
      $("#btnDeliver").disabled = true;
      $("#stageDl").innerHTML = "";
      $("#expHistory").innerHTML = `<p style="font-size:12.5px;color:var(--ink-4)">尚未导出。</p>`;
      return;
    }
    $("#btnExport").disabled = false;
    $("#btnDeliver").disabled = false;
    const checks = state.boot.checks;
    const okN = checks.filter((c) => c.ok).length;
    const issues = state.issues[state.stage] || [];
    const open = issues.filter((i) => !i.closed).length;
    $("#expChk").innerHTML = `
      <div class="chk"><span class="ic ${open ? "warn" : "ok"}">${open ? "!" : "✓"}</span><span>未关闭事项 <b>${open}</b> 项 / 已澄清关闭 <b>${issues.length - open}</b> 项（如实写入「需补充事项」表，不阻断交付）</span></div>
      <div class="chk"><span class="ic ok">✓</span><span>引擎回归自检 <b>${okN}/${checks.length}</b> 项通过（底稿数字核对）　<button class="btn sm" id="btnChecks" style="height:22px;padding:0 8px;font-size:11px">明细</button></span></div>
      <div class="chk"><span class="ic ok">✓</span><span>口径已统一：双口径并列 · 折算依据逐行随附 · 列示金额只作比对基准</span></div>
      <div class="chk"><span class="ic warn">!</span><span>资格待补 2 项：乙检测资质未提交；丁资质 2026-08-31 到期未续（保持未关闭，由评审判断）</span></div>
      <div id="checkList" class="hidden" style="max-height:190px;overflow:auto;border:1px solid var(--line-2);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--ink-3);margin-top:6px">
        ${checks.map((c) => `<div>${c.ok ? "✓" : "✗"} ${esc(c.msg)}</div>`).join("")}
      </div>`;
    $("#btnChecks").onclick = () => $("#checkList").classList.toggle("hidden");

    $("#expHistory").innerHTML = state.exports.length ? state.exports.map((x) => `
      <div class="chk"><span class="ic ok">✓</span><span>${esc(x)}</span></div>`).join("")
      : `<p style="font-size:12.5px;color:var(--ink-4)">尚未导出。导出即由 M2 生成器在${state.boot.template_found ? "企业模板副本上" : "模板表头新建"}写出 5-sheet xlsx（backend/out/）。</p>`;

    $("#stageDl").innerHTML = Object.keys(STAGE_SHORT).map((k, i) => `
      <div class="sheet-card"><span class="no">${i + 1}</span>
        <div style="flex:1"><b>${STAGE_SHORT[k]}</b><span>对比表 / 需补充事项 / 操作记录 / 报价明细 / 资格材料清单${k === "v2" ? " · 附较V1差异行" : ""}${k === "v1_raw" ? " · 异常线索最全" : ""}</span></div>
        <a class="btn sm" href="/api/export/${k}" download>下载 xlsx</a></div>`).join("");
  }

  /* ---------------- 弹层 / 登记 / AI 位 ---------------- */
  function showModal(id) { $("#" + id).classList.add("show"); }
  function hideModals() { document.querySelectorAll(".overlay").forEach((o) => o.classList.remove("show")); }
  function registerModal() {
    $("#mRegBody").innerHTML = `
      <div class="form-grid">
        <div class="fld"><label>事件类型 <i>*</i></label>
          <select id="regType"><option>SET_FIELD 更正字段</option><option>ADD_LINE 补录行</option><option>DECLARE_TAX 申报税率</option><option>DEDUPE 剔重</option><option>RESOLVE_UNIT 单位确认</option></select></div>
        <div class="fld"><label>影响对象（供应商 · 清单项 · 字段）<i>*</i></label><input id="regTarget" placeholder="如：乙 · C09 · 单价"></div>
        <div class="fld full"><label>变更内容（原值 → 新值）<i>*</i></label><input id="regDetail" placeholder="如：（缺价）→ 460.00 元/根 × 12 根"></div>
        <div class="fld full"><label>依据文件 + 条款定位 <i>*必填：无依据不改数</i></label><input id="regBasis" placeholder="如：02 报价澄清/供应商澄清纪要.txt · CLARIFY-01"></div>
      </div>`;
    showModal("mReg");
  }
  function submitRegister() {
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
          <input value="${esc(state.nextId)}" disabled style="background:#f6f7f9;color:var(--ink-3)"></div>
        <div class="fld"><label>项目状态（创建后随流程流转）</label>
          <input value="配置中" disabled style="background:#f6f7f9;color:var(--ink-3)"></div>
        <div class="fld"><label>项目名称 <i>*</i></label>
          <input id="npName" maxlength="60" placeholder="如：园区现场测量与检测"></div>
        <div class="fld"><label>项目负责人 <i>*</i></label>
          <input id="npOwner" maxlength="30" placeholder="如：商务人员A"></div>
        <div class="fld full" style="font-size:12px;color:var(--ink-4);line-height:1.8">统一清单、计算规则版本与资格要求按组织级默认挂载（界面设计文档 §5.0）；供应商名单与报价在工作区收集箱逐步归集。</div>
      </div>`;
    showModal("mNew");
    $("#npName").focus();
  }
  async function submitNewProject() {
    const name = $("#npName").value.trim(), owner = $("#npOwner").value.trim();
    if (!name || !owner) { toast("创建失败：项目名称与项目负责人均为必填。"); return; }
    try {
      const r = await fetch("/api/projects", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, owner }) });
      const j = await r.json();
      if (!r.ok) { toast(`创建失败：${esc(j.error || "HTTP " + r.status)}`); return; }
      hideModals();
      await loadProjects();
      renderHome();
      toast(`已创建 <b>${esc(j.id)}</b> · ${esc(j.name)}（负责人 ${esc(j.owner)}）——点击项目卡进入工作区。`);
    } catch (e) {
      toast(`创建失败：${esc(e.message)}——请确认已运行 python server.py`);
    }
  }
  function openProject(p) {
    state.cur = p;
    state.proj = null;
    state.view = "project";
    switchView();
    loadProjectBoard();
  }
  /* 项目工作台全量数据（清单 + 识别登记 + 引擎台账 + 匹配报告），上传识别后重取 */
  async function loadProjectBoard() {
    if (!state.cur) return;
    try {
      const pb = await getJSON(`/api/projects/${encodeURIComponent(state.cur.id)}/board`);
      state.proj = pb;
      state.cur = pb.project;
      const i = state.projects.findIndex((x) => x.id === pb.project.id);
      if (i >= 0) state.projects[i] = pb.project;
      renderAll();
    } catch (e) {
      toast(`项目数据加载失败：${esc(e.message)}`);
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-open],[data-ver],[data-tab],[data-src],[data-qok],[data-qwait],[data-anf],[data-dry],[data-apply],[data-diffjump],[data-proj],.mclose,#btnManual,#btnAI,#mRegOk,#btnExport,#btnNewProj,#mNewOk");
    if (!t) return;
    const ds = t.dataset;
    if (t.id === "btnNewProj") return openNewProjModal();
    if (t.id === "mNewOk") return submitNewProject();
    if (t.id === "btnManual") return registerModal();
    if (t.id === "btnAI") {
      if (!state.online) return;
      return toast("正在调用第三方模型接口提取事件候选…（演示：读取结构化缓存，与仓库 gc017_events.json 同构）");
    }
    if (t.id === "mRegOk") return submitRegister();
    if (t.id === "btnExport") {
      state.exports.unshift(`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} · 导出 ${STAGE_SHORT[state.stage]} 台账 xlsx（backend/out/）`);
      renderExport();
      const a = document.createElement("a"); a.href = `/api/export/${state.stage}`; a.download = ""; a.click();
      return toast("M2 生成器已写出 5-sheet 台账 xlsx（企业模板副本填写），开始下载。");
    }
    if (ds.open) { state.view = "project"; switchView(); return; }
    if (ds.proj) { const p = state.projects.find((x) => x.id === ds.proj); if (p) openProject(p); return; }
    if (ds.ver) { state.stage = ds.ver; renderAll(); return; }
    if (ds.tab) { state.tab = +ds.tab; renderTabs(); return; }
    if (ds.src) return state.cur ? openProjectSrc(ds.src) : openSrc(ds.src);
    if (ds.qok) { const q = state.queue.find((x) => x.id === ds.qok); q.status = "done"; renderInbox(); renderCtx(); return toast(`字段已确认入账：${q.supplier} ${q.item}（确认动作留痕，实际环境写入操作记录）`); }
    if (ds.qwait) { const q = state.queue.find((x) => x.id === ds.qwait); q.status = "done"; renderInbox(); renderCtx(); return toast(`已登记待澄清：${q.supplier} ${q.item}——未知值不入账，等待书面澄清。`); }
    if (ds.anf) { state.anFilter = ds.anf; renderEvents(); return; }
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
  document.addEventListener("click", (ev) => {
    if (ev.target.closest("#onlToggle")) {
      state.online = !state.online;
      ev.target.closest("#onlToggle").classList.toggle("on", state.online);
      $("#onlChip").innerHTML = state.online ? "第三方模型接口 · 在线" : "内网离线模式";
      renderEvents();
      toast(state.online ? "已切换在线：AI 触点可调用第三方接口（结果缓存后经人工确认）。" : "已切换离线：AI 按钮置灰，人工路径承担全部能力；M1/M2 引擎为本地计算，不受影响。");
    }
  });

  /* ---------------- 上传识别绑定（收集箱拖拽/点击） ---------------- */
  (function bindUpload() {
    const dz = document.querySelector("#dropzone");
    if (!dz) return;
    let input = null;
    dz.addEventListener("click", () => {
      if (!input) {
        input = document.createElement("input");
        input.type = "file"; input.multiple = true; input.style.display = "none";
        input.addEventListener("change", () => uploadFiles([...input.files]));
        document.body.appendChild(input);
      }
      input.click();
    });
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault(); dz.classList.remove("drag");
      if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
    });
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
    $("#" + { 1: "paneInbox", 2: "paneLedger", 3: "paneEvents", 4: "paneVersions", 5: "paneExport" }[state.tab]).classList.add("show");
    renderCtx();
    [renderInbox, renderLedger, renderEvents, renderVersions, renderExport][state.tab - 1]();
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
      `<div class="toast" style="position:fixed;top:70px;right:20px;z-index:300">引擎服务未连接：${esc(e.message)} —— 请运行 <b>python server.py</b></div>`);
  });
})();

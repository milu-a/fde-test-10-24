/* =====================================================================
 * 分包比选工作台 · 前端应用（纯静态，无后端）
 * 所有数据来自 data/demo/gc017.js，计算来自 data/app/engine.js。
 * AI 触点（扫描件识别 / 事件提取）按第三方接口设计：离线时按钮置灰，
 * 在线模式演示"调用→缓存→待确认队列"的完整关口（演示用模拟缓存）。
 * ===================================================================== */
(function () {
  "use strict";
  const D = window.DEMO, E = window.Engine, V = E.VENDORS;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const state = {
    view: "home", tab: 2, version: "V0", online: false,
    queue: D.confirmQueue.map((q) => ({ ...q })),
    events: D.events.map((e) => ({ ...e, items: e.items.map((i) => ({ ...i })) })),
    manual: [], exports: [], anFilter: "全部"
  };

  /* ---------------- Toast ---------------- */
  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast"; el.innerHTML = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  /* ---------------- 首页 ---------------- */
  const stClass = { "归集中": "st-working", "待澄清": "st-clarify", "已交付评审": "st-review", "已归档": "st-archived" };
  function renderHome() {
    const cards = [];
    const todoGC = state.queue.filter((q) => q.status === "pending").length
      + E.versions[state.version].anomalies.filter((a) => a.open).length
      + state.events.filter((e) => e.status === "pending").length;
    cards.push(`
      <div class="proj-card demo" data-open="GC-017">
        <div class="row1"><span class="pid">GC-017</span><span class="pname">园区测量检测分包</span>
          <span class="spacer" style="flex:1"></span><span class="badge ${stClass["待澄清"]}">待澄清</span></div>
        <div class="meta"><span>报价 <b>4 家已收</b></span><span>台账 <b>${state.version}</b></span>
          <span>待办 <b>${todoGC}</b> 项未关闭</span></div>
        <div class="meta"><span>待确认字段 ${state.queue.filter((q) => q.status === "pending").length} · 待处理事件 ${state.events.filter((e) => e.status === "pending").length} · 待补材料 2</span></div>
        <div class="act">内置演示项目 · 最近活动：刚刚 · 事件与澄清中心有待处理事项</div>
      </div>`);
    D.otherProjects.forEach((p) => {
      cards.push(`
      <div class="proj-card ${p.status === "已归档" ? "readonly" : ""}">
        <div class="row1"><span class="pid">${p.id}</span><span class="pname">${esc(p.name)}</span>
          <span class="spacer" style="flex:1"></span><span class="badge ${stClass[p.status]}">${p.status}</span></div>
        <div class="meta"><span>报价 <b>${p.done}/${p.vendors} 家</b></span><span>台账 <b>${p.version}</b></span><span>待办 <b>${p.todos}</b> 项</span></div>
        <div class="act">${esc(p.activity)}${p.status === "已归档" ? " · 全项目只读封存" : ""}</div>
      </div>`);
    });
    $("#projGrid").innerHTML = cards.join("");
  }

  /* ---------------- 工作区上下文 ---------------- */
  function renderCtx() {
    const label = state.version;
    const has = (l) => !!E.versions[l];
    $("#verSwitch").innerHTML = ["V0", "V1", "V2"].map((l) => {
      const reachable = l === "V0" || (l === "V1" && state.events[0].status === "applied") || (l === "V2" && state.events[1].status === "applied");
      return `<button data-ver="${l}" class="${label === l ? "active" : ""}" ${reachable ? "" : "disabled"}>${l} ${l === "V0" ? "原报" : l === "V1" ? "澄清后" : "变更后"}</button>`;
    }).join("");
    $("#ctxVersion").textContent = label;
    const snap = E.versions[label];
    const openAn = snap.anomalies.filter((a) => a.open).length;
    const pendEv = state.events.filter((e) => e.status === "pending").length;
    const pendQ = state.queue.filter((q) => q.status === "pending").length;
    $("#ctxMeta").innerHTML = `<span>状态 <b>待澄清</b></span><span>报价 <b>4/4 家</b></span>
      <span>台账版本 <b>${label}</b>${label !== E.current.label ? "（历史版本，只读）" : ""}</span>
      <span>未关闭待办 <b>${openAn + pendEv + pendQ}</b></span>`;
    $("#tabCnt1").textContent = pendQ; $("#tabCnt1").className = "cnt" + (pendQ ? "" : " zero");
    $("#tabCnt3").textContent = openAn; $("#tabCnt3").className = "cnt" + (openAn ? "" : " zero");
  }

  /* ---------------- 页签① 收集箱 ---------------- */
  const fMeta = [
    { icon: "excel", label: "XLSX", name: "甲方报价.xlsx", sub: "甲 · 报价正件 A-V1 · 已解析 15 项 · 本地直读" },
    { icon: "pdf", label: "PDF", name: "乙方报价.pdf", sub: "乙 · 报价正件 B-V1 · 已解析 15 行 · 本地文本层抽取" },
    { icon: "scan", label: "IMG", name: "报价扫描-1/2.png", sub: "丙 · 报价正件 C-V1 · 已识别（第三方视觉接口，结果已缓存）" },
    { icon: "chat", label: "IMG", name: "丁方报价截图-1.png", sub: "丁 · 报价正件 D-V1 · 已识别（第三方视觉接口，结果已缓存）" },
    { icon: "chat", label: "IMG", name: "丁方费用说明聊天.png", sub: "丁 · 费用说明附件 · 已识别并关联 C14 口径疑点" },
    { icon: "pdf", label: "TXT", name: "供应商澄清纪要 CLARIFY-01", sub: "事件文件 · 已进入事件与澄清中心待确认" }
  ];
  function renderInbox() {
    $("#fileList").innerHTML = fMeta.map((f) => `
      <div class="file-item"><span class="ficon ${f.icon}">${f.label}</span>
        <span class="fname"><b>${esc(f.name)}</b><span>${f.sub}</span></span>
        <span class="badge st-archived" style="font-size:11px">原件只读</span></div>`).join("");
    $("#queueList").innerHTML = state.queue.map((q) => `
      <div class="qcard ${q.conf < 0.7 ? "low" : ""}">
        ${q.img ? `<img class="thumb" src="${q.img}" alt="原文截图">` : `<div class="thumb" style="display:flex;align-items:center;justify-content:center;color:var(--ink-4);font-size:11px">无图（文本抽取）</div>`}
        <div>
          <div class="qhead"><b style="font-size:13px">${q.supplier} · ${q.itemId === "—" ? "整体" : q.itemId} ${esc(q.field)}</b>
            <span class="conf ${q.status === "done" ? "ok" : ""}">置信度 ${q.conf.toFixed(2)}${q.conf < 0.7 ? " · 低" : ""}</span></div>
          <p>${esc(q.snippet)}　候选值：<b>${esc(q.candidate)}</b></p>
          <div class="ops">
            <button class="btn sm primary" data-qok="${q.id}" ${q.status === "done" ? "disabled" : ""}>${q.status === "done" ? "已确认" : "确认入账"}</button>
            <button class="btn sm" data-qedit="${q.id}" ${q.status === "done" ? "disabled" : ""}>编辑后确认</button>
            <button class="btn sm" data-qwait="${q.id}" ${q.status === "done" ? "disabled" : ""}>登记待澄清</button>
          </div>
        </div>
      </div>`).join("");
  }

  /* ---------------- 页签② 台账 ---------------- */
  const badgeCls = { "超区间": "warn", "乘积不符": "warn", "附件未计入": "warn", "缺失": "", "待确认": "petrol", "不可比": "", "重复·只计一次": "info", "数量偏差": "info", "别名映射": "info" };
  function cellHtml(snap, itemId, v, cat) {
    const c = snap.rows[itemId][v];
    let cls = "amount num", body = "", note = "";
    if (c.status === "缺失") cls += " st-missing";
    else if (c.status === "待确认") cls += " st-pending";
    else if (c.status === "澄清修正") cls += " st-restated";
    else if (c.status === "变更重算") cls += " st-recomp";
    if (c.badges.includes("不可比")) cls += " st-nocomp";
    if (c.incl != null) body = fmt(c.incl);
    else if (c.excl != null) body = fmt(c.excl);
    else body = c.status === "待确认" ? "待确认" : c.status === "缺失" ? "缺失" : "—";
    if (c.badges.includes("超区间") || c.badges.includes("乘积不符") || c.badges.includes("附件未计入")) body += '<span class="dot"></span>';
    if (c.excl != null && c.incl != null) note = `<span class="v-note">未税 ${fmt(c.excl)}</span>`;
    const bgs = c.badges.filter((b) => b !== "超区间").slice(0, 2)
      .map((b) => `<span class="bdg ${badgeCls[b] || ""}">${b}</span>`).join("");
    return `<td class="${cls}" data-src="${itemId}|${v}" title="${esc(c.basis)}">${body}${bgs}${note}</td>`;
  }
  function renderLedger() {
    const snap = E.versions[state.version];
    const head = `<tr><th class="l lock lock1">编号</th><th class="l lock lock2">工作内容</th><th class="l lock lock3">单位</th>
      <th class="l lock lock4">数量</th>${V.map((v) => `<th colspan="1">${v} · 含税（未税）</th>`).join("")}<th class="l">差异及待核对</th></tr>`;
    const rows = D.catalog.map((cat) => {
      const openAn = snap.anomalies.filter((a) => a.open && a.itemId === cat.id);
      const diffTxt = openAn.map((a) => `${a.supplier} ${esc(a.text.split("——")[0])}`).join("；") || "—";
      const qty = state.version !== "V0" && cat.id === "C08" ? 72 : cat.qty;
      return `<tr><td class="l lock lock1">${cat.id}</td><td class="l lock lock2">${cat.name}</td>
        <td class="l lock lock3">${cat.id === "C08" && state.version === "V2" ? cat.unit : (snap.rows[cat.id][V[0]].unit || cat.unit)}</td>
        <td class="l lock lock4 num">${cat.id === "C08" && state.version === "V2" ? 72 : qty}</td>
        ${V.map((v) => cellHtml(snap, cat.id, v, cat)).join("")}
        <td class="diffcell">${diffTxt}</td></tr>`;
    }).join("");
    const tot = V.map((v) => {
      const t = snap.totals[v];
      let main = t.incl != null ? fmt(t.incl) : "待确认";
      let notes = [];
      if (t.listedIncl != null) notes.push(`文件列示 ${fmt(t.listedIncl)}`);
      if (t.note) notes.push(t.note);
      if (t.pending) notes.push(`含 ${t.pending} 项待确认未计入`);
      if (t.excl != null) notes.push(`未税合计 ${fmt(t.excl)}`);
      return `<td class="amount num">${main}<span class="v-note">${esc(notes.join(" · "))}</span></td>`;
    }).join("");
    $("#ledger").innerHTML = `<thead>${head}</thead><tbody>${rows}
      <tr class="total"><td class="l lock lock1"></td><td class="l lock lock2">合计（含税）</td><td class="l lock lock3"></td><td class="l lock lock4"></td>${tot}<td class="diffcell">口径：双口径并列，折算依据见单元格悬浮与回查弹窗；系统不推荐中标。</td></tr>
      </tbody>`;
  }

  /* ---------------- 回查弹窗 ---------------- */
  function openSrc(key) {
    const [itemId, v] = key.split("|");
    const snap = E.versions[state.version];
    const c = snap.rows[itemId][v];
    const cat = D.catalog.find((x) => x.id === itemId);
    const evtLink = c.status === "变更重算" ? "EVT-002 CHANGE-01" : (c.status === "澄清修正" ? "EVT-001 CLARIFY-01" : null);
    let preview = "";
    if (c.src && c.src.kind === "image") {
      preview = `<div class="src-img"><img src="${c.src.file}" alt="原件预览">
        <div style="padding:8px 10px;font-size:11.5px;color:var(--ink-4);border-top:1px solid var(--line-2)">原件截图 · 识别来源：第三方视觉接口（结果已缓存）· 定位：${esc(c.src.locator)}</div></div>`;
    } else {
      const lines = D.suppliers[v].lines.filter((l) => l.name || l.id === "C11");
      preview = `<div class="src-table"><table class="simple"><thead><tr><th>编码</th><th>分项</th><th class="r">数量</th><th class="r">单价</th><th class="r">金额</th></tr></thead><tbody>
        ${lines.map((l) => {
          const hit = l.id === itemId;
          const amt = l.id === "C09" && l.price == null ? "（空）" : l.price == null ? "—" : fmt(l.basis === "incl" ? Math.round(l.qty * l.price * 100) / 100 : Math.round(l.qty * l.price * 100) / 100);
          return `<tr style="${hit ? "background:rgba(0,72,138,.10);box-shadow:inset 3px 0 0 var(--orbis-blue)" : ""}">
            <td>${l.id || "—"}</td><td>${esc(l.name || "（整项缺失）")}</td><td class="r">${l.qty ?? "—"}</td>
            <td class="r">${l.price == null ? "—" : fmt(l.price)}</td><td class="r">${l.id === "C11" && l.name == null ? "缺失" : amt}</td></tr>`;
        }).join("")}</tbody></table></div>
        <div style="font-size:11.5px;color:var(--ink-4);margin-top:6px">解析来源：${c.src && c.src.kind === "pdf" ? "PDF 文本层抽取（本地）" : "Excel 程序直读（本地）"} · 定位：${esc(c.src ? c.src.locator : "—")}</div>`;
    }
    $("#mSrcBody").innerHTML = `
      <div class="src-grid"><div>${preview}</div>
      <div>
        <div class="src-kv">
          <div class="kv"><span class="k">清单项</span><span>${itemId} ${cat.name}（${cat.unit} · 清单量 ${cat.qty}）</span></div>
          <div class="kv"><span class="k">供应商</span><span>${v} ${D.suppliers[v].name}</span></div>
          <div class="kv"><span class="k">当前值</span><span class="num"><b>${c.incl != null ? fmt(c.incl) : "待确认"}</b>（含税）${c.excl != null ? ` · 未税 ${fmt(c.excl)}` : ""}</span></div>
          <div class="kv"><span class="k">原始口径</span><span>${esc(D.suppliers[v].taxOrigin)}</span></div>
          <div class="kv"><span class="k">折算依据</span><span>${esc(c.basis)}</span></div>
          <div class="kv"><span class="k">状态</span><span>${c.status}${evtLink ? ` · <a href="javascript:void(0)" data-goto-evt="${evtLink.split(" ")[0]}" style="color:var(--orbis-petrol)">查看事件 ${evtLink}</a>` : ""}</span></div>
          ${c.flags.length ? `<div class="kv"><span class="k">线索</span><span>${c.flags.map((f) => esc(f.note)).join("；")}</span></div>` : ""}
          <div class="kv"><span class="k">红线提示</span><span style="color:var(--ink-4)">异常仅提示不改写原值；区间不构成定价或中标判断。</span></div>
        </div>
      </div></div>`;
    showModal("mSrc");
  }

  /* ---------------- 页签③ 事件与澄清 ---------------- */
  function renderEvents() {
    const snap = E.versions[state.version];
    const filters = ["全部", "计算类", "完整性", "口径类", "价格类", "资格类"];
    $("#anFilter").innerHTML = filters.map((f) => `<button data-anf="${f}" class="${state.anFilter === f ? "active" : ""}">${f}</button>`).join("");
    const list = snap.anomalies.filter((a) => state.anFilter === "全部" || a.cls === state.anFilter);
    $("#anList").innerHTML = list.map((a) => `
      <div class="an-row ${a.open ? "" : "closed"}">
        <span class="cls"><span class="bdg info">${a.cls}</span></span>
        <span class="txt"><b class="num">${a.supplier}${a.itemId !== "—" ? " · " + a.itemId : ""}</b>　${esc(a.text)}
          <small>规则 ${esc(a.rule)} · 证据：${esc(a.evidence)} · <a href="javascript:void(0)" data-ansev="${a.evidence}" style="color:var(--orbis-blue)">查看证据</a> · <a href="javascript:void(0)" data-draft="${a.id}" style="color:var(--orbis-blue)">生成澄清草稿</a></small></span>
        <span class="st">${a.open ? '<span class="tag-open">● 未关闭</span>' : `<span class="tag-closed">✓ 已由 ${a.closeBy} 关闭</span>`}</span>
      </div>`).join("");

    $("#evtEntries").innerHTML = `
      <button class="btn primary" id="btnManual">＋ 登记事件（人工路径 · 离线可用）</button>
      <button class="btn" id="btnAI" ${state.online ? "" : "disabled"} title="${state.online ? "从已上传纪要提取事件候选（第三方模型接口）" : "当前离线：第三方模型接口不可用，请使用人工登记路径"}">⚡ AI 提取事件${state.online ? "" : "（离线不可用）"}</button>
      <span style="font-size:12px;color:var(--ink-4);align-self:center">两条路径产出同一事件候选，进入同一确认队列；确认前不动台账。</span>`;

    $("#evtCards").innerHTML = state.events.map((e) => {
      const evSnap = e.id === "EVT-001" ? E.versions.V1 : E.versions.V2;
      const cur = E.versions[state.version];
      const delta = V.map((v) => {
        const a = cur.totals[v].incl, b = evSnap.totals[v].incl;
        if (a == null || b == null) return `<div class="sumcard"><div class="v">${v}</div><div class="n">—</div><div class="d" style="color:var(--ink-4)">澄清后可算</div></div>`;
        const d = Math.round((b - a) * 100) / 100;
        return `<div class="sumcard"><div class="v">${v} 含税总价</div><div class="n num">${fmt(a)}</div>
          <div class="d ${d >= 0 ? "delta-plus" : "delta-minus"}">${d >= 0 ? "+" : ""}${fmt(d)} → ${fmt(b)}</div></div>`;
      }).join("");
      return `
      <div class="evt-card ${e.kind === "变更" ? "change" : ""} ${e.status === "applied" ? "applied" : ""}">
        <div class="ehead"><b>${e.id} · ${esc(e.doc)}</b>
          <span class="bdg ${e.kind === "变更" ? "petrol" : "info"}">${e.kind}</span>
          <span class="bdg">${e.status === "applied" ? `已应用 · 生成 ${e.id === "EVT-001" ? "V1" : "V2"}` : "待确认"}</span>
          <span class="bdg">${e.source === "ai" ? "AI提取 + 人工确认" : "人工登记"}</span>
          <span class="spacer" style="flex:1"></span><span class="esub">生效 ${e.effective} · 操作者 ${e.operator}</span></div>
        <div class="evt-items">${e.items.map((it, ix) => `
          <div class="evt-item"><span class="etype">${it.type}</span>
            <span class="target">${it.supplier}${it.itemId ? " · " + it.itemId : ""} · ${esc(it.field)}</span>
            <span class="delta"><s>${esc(it.old)}</s> → <b>${esc(it.val)}</b>　<span class="basis-link" data-basis="${esc(it.basis)}" data-note="${esc(it.note)}">依据：${esc(it.basis)}</span></span>
          </div>`).join("")}</div>
        <div class="eops">
          ${e.status === "pending" ? `
            <button class="btn sm" data-dry="${e.id}">差异预演（dry-run）</button>
            <button class="btn sm petrol" data-apply="${e.id}">确认并应用 → 生成 ${e.id === "EVT-001" ? "V1" : "V2"}</button>`
          : `<button class="btn sm" data-diffver="${e.id}">查看 ${e.id === "EVT-001" ? "V0→V1" : "V1→V2"} 差异表</button>`}
          <span style="font-size:12px;color:var(--ink-4)">应用前不动账；应用后版本另存、全程留痕。</span>
        </div>
      </div>`;
    }).join("") + state.manual.map((m) => `
      <div class="evt-card"><div class="ehead"><b>${m.id} · 人工登记事件</b><span class="bdg">${m.type}</span>
        <span class="bdg">待确认</span><span class="spacer" style="flex:1"></span><span class="esub">${esc(m.time)} · ${esc(m.op)}</span></div>
        <div class="evt-items"><div class="evt-item"><span class="etype">${m.type}</span>
          <span class="target">${esc(m.target)}</span><span class="delta">${esc(m.detail)}　<span class="basis-link">依据：${esc(m.basis)}</span></span></div></div>
        <div class="eops"><span style="font-size:12px;color:var(--ink-4)">示例环境：已登记并留痕，未触发重算。</span></div>
      </div>`).join("");
  }

  /* ---------------- 页签④ 版本与差异 ---------------- */
  function renderVersions() {
    const applied1 = state.events[0].status === "applied", applied2 = state.events[1].status === "applied";
    $("#vtimeline").innerHTML = `
      ${[["V0", "2026-09-18 · 原件归档识别", true],
         ["V1", "2026-09-19 · CLARIFY-01 应用", applied1],
         ["V2", "2026-09-20 · CHANGE-01 应用", applied2]].map(([l, t, ok]) => `
        <div class="vnode ${ok ? "reached" : ""} ${state.version === l ? "cur" : ""}">
          <div class="dot2"></div><b>${l} ${l === "V0" ? "原报" : l === "V1" ? "澄清后" : "变更后"}${state.version === l ? " · 当前" : ""}</b>
          <span>${ok ? t : "待事件应用后生成"}</span></div>`).join("")}`;
    const a = $("#diffA").value, b = $("#diffB").value;
    const d = E.diff(E.versions[a], E.versions[b]);
    $("#diffWrap").innerHTML = d.length ? `<table class="simple"><thead><tr>
        <th>供应商</th><th>清单项</th><th>字段</th><th class="r">${a}</th><th class="r">${b}</th><th class="r">差异</th><th>变化来源</th></tr></thead><tbody>
        ${d.map((r) => {
          const dv = r.toIncl != null && r.fromIncl != null ? Math.round((r.toIncl - r.fromIncl) * 100) / 100 : null;
          return `<tr><td>${r.supplier}</td><td>${r.itemId} ${r.name}</td><td>${r.field}</td>
            <td class="r num">${r.fromIncl != null ? fmt(r.fromIncl) : esc(String(r.from))}</td>
            <td class="r num">${r.toIncl != null ? fmt(r.toIncl) : esc(String(r.to))}</td>
            <td class="r num ${dv >= 0 ? "delta-plus" : "delta-minus"}">${dv != null ? (dv >= 0 ? "+" : "") + fmt(dv) : "—"}</td>
            <td>${esc(r.event)}</td></tr>`;
        }).join("")}</tbody></table>`
      : `<p style="color:var(--ink-4);font-size:13px;padding:12px 0">所选两版本无差异（如 V0→V0），请选择不同版本。</p>`;
    const sumb = V.map((v) => {
      const t = E.versions[state.version].totals[v];
      const t0 = E.versions.V0.totals[v].incl, t1 = E.versions.V1.totals[v].incl, t2 = E.versions.V2.totals[v].incl;
      const base = state.version === "V2" ? t2 : state.version === "V1" ? t1 : t0;
      const dlt = t0 != null && base != null ? Math.round((base - t0) * 100) / 100 : null;
      return `<div class="sumcard"><div class="v">${v} · ${state.version} 含税总价${dlt != null && state.version !== "V0" ? `（较 V0 ${dlt >= 0 ? "+" : ""}${fmt(dlt)}）` : ""}</div>
        <div class="n num">${base != null ? fmt(base) : "待确认"}</div>
        <div class="d" style="color:var(--ink-4)">V0 ${t0 != null ? fmt(t0) : "待确认"} → V1 ${t1 != null ? fmt(t1) : "待确认"} → V2 ${fmt(t2)}</div></div>`;
    }).join("");
    $("#sumBar").innerHTML = sumb;
    $("#opLog").innerHTML = `<table class="simple"><thead><tr><th style="width:150px">操作时间</th><th style="width:90px">操作者</th><th style="width:110px">动作</th><th>内容与依据</th></tr></thead><tbody>
      ${E.opLog.map((o) => `<tr><td class="num">${o.time}</td><td>${esc(o.who)}</td><td>${esc(o.op)}</td><td>${esc(o.detail)}　<span style="color:var(--ink-4)">依据：${esc(o.basis)}</span></td></tr>`).join("")}
      </tbody></table>`;
  }

  /* ---------------- 页签⑤ 导出 ---------------- */
  function renderExport() {
    const snap = E.versions[state.version];
    const openAn = snap.anomalies.filter((a) => a.open).length;
    const pendQ = state.queue.filter((q) => q.status === "pending").length;
    $("#expChk").innerHTML = `
      <div class="chk"><span class="ic ${openAn ? "warn" : "ok"}">${openAn ? "!" : "✓"}</span><span>未关闭异常 <b>${openAn}</b> 项（将如实写入「需补充事项」表，不阻断交付）</span></div>
      <div class="chk"><span class="ic ${pendQ ? "warn" : "ok"}">${pendQ ? "!" : "✓"}</span><span>待确认字段 <b>${pendQ}</b> 项${pendQ ? "（建议确认后导出）" : "（全部已确认）"}</span></div>
      <div class="chk"><span class="ic warn">!</span><span>资格待补 <b>2</b> 项：乙检测资质未提交；丁资质到期未续（保持未关闭）</span></div>
      <div class="chk"><span class="ic ok">✓</span><span>口径已统一：含税/未税双口径并列，折算依据逐行随附</span></div>
      <div class="chk"><span class="ic ok">✓</span><span>数字可复算：确定性规则引擎 + 验收基线断言（见控制台 assertLog）</span></div>`;
    $("#expHistory").innerHTML = state.exports.length ? state.exports.map((x) => `
      <div class="chk"><span class="ic ok">✓</span><span>${esc(x)}</span></div>`).join("")
      : `<p style="font-size:12.5px;color:var(--ink-4)">尚未导出。导出将写入与原件区物理分离的输出目录。</p>`;
  }

  /* ---------------- 弹层 ---------------- */
  function showModal(id) { $("#" + id).classList.add("show"); }
  function hideModals() { document.querySelectorAll(".overlay").forEach((o) => o.classList.remove("show")); }

  function dryRun(eventId) {
    const e = state.events.find((x) => x.id === eventId);
    const cur = E.versions[state.version];
    const nxt = E.versions[eventId === "EVT-001" ? "V1" : "V2"];
    const rows = E.diff(cur, nxt);
    $("#mDryTitle").textContent = `差异预演 · 应用 ${e.id} ${e.doc}`;
    $("#mDrySum").innerHTML = V.map((v) => {
      const a = cur.totals[v].incl, b = nxt.totals[v].incl;
      const d = a != null && b != null ? Math.round((b - a) * 100) / 100 : null;
      return `<div class="sumcard"><div class="v">${v} 含税总价</div>
        <div class="n num">${a != null ? fmt(a) : "待确认"} → ${fmt(b)}</div>
        <div class="d ${d >= 0 ? "delta-plus" : "delta-minus"}">${d != null ? (d >= 0 ? "+" : "") + fmt(d) : "明细澄清后可算"}</div></div>`;
    }).join("");
    $("#mDryRows").innerHTML = rows.length ? rows.map((r) => `
      <div class="dry-row"><span>${r.supplier} · ${r.itemId}</span><span>${r.field}</span>
        <span>${r.fromIncl != null ? fmt(r.fromIncl) : esc(String(r.from))} → ${r.toIncl != null ? fmt(r.toIncl) : esc(String(r.to))}</span>
        <span style="color:var(--ink-4)">${esc(r.event)}</span></div>`).join("")
      : '<p style="color:var(--ink-4);font-size:13px">当前版本与目标版本一致，无需应用。</p>';
    $("#mDryApply").dataset.apply = eventId;
    showModal("mDry");
  }

  function applyEvent(eventId) {
    const e = state.events.find((x) => x.id === eventId);
    e.status = "applied";
    E.apply(eventId);
    state.version = E.current.label;
    E.appendOp({
      time: eventId === "EVT-001" ? "2026-09-19 10:05" : "2026-09-20 09:03",
      op: "应用事件", who: e.operator, detail: `${e.id} ${e.doc} 逐条人工确认后应用，重算生成 ${E.current.label}，原版本另存保留`,
      basis: e.doc + "（条款级依据见事件卡）"
    });
    hideModals();
    renderAll();
    toast(`已应用 <b>${e.id}</b>：重算完成，生成 <b>${E.current.label}</b>，差异 ${E.diff(E.versions[eventId === "EVT-001" ? "V0" : "V1"], E.versions[E.current.label]).length} 项，操作已留痕`);
  }

  function registerModal() {
    $("#mRegBody").innerHTML = `
      <div class="form-grid">
        <div class="fld"><label>事件类型 <i>*</i></label>
          <select id="regType">
            <option>修正型</option><option>补充型</option><option>依据授予型</option>
            <option>清单变更型</option><option>范围变更型</option><option>资格状态型</option><option>流程状态型</option>
          </select></div>
        <div class="fld"><label>影响对象（供应商 · 清单项 · 字段）<i>*</i></label>
          <input id="regTarget" placeholder="如：乙 · C09 · 未税单价"></div>
        <div class="fld full"><label>变更内容（原值 → 新值）<i>*</i></label>
          <input id="regDetail" placeholder="如：（缺价）→ 460.00 元/根 × 12 根"></div>
        <div class="fld full"><label>依据文件 + 条款定位 <i>*必填：无依据不改数</i></label>
          <input id="regBasis" placeholder="如：供应商澄清纪要 CLARIFY-01 第2行"></div>
        <div class="fld full"><label>备注</label><textarea id="regNote" placeholder="补充说明（可空）"></textarea></div>
      </div>`;
    showModal("mReg");
  }
  function submitRegister() {
    const t = $("#regType").value, tg = $("#regTarget").value.trim(), dt = $("#regDetail").value.trim(), ba = $("#regBasis").value.trim();
    if (!tg || !dt || !ba) { toast("登记失败：影响对象、变更内容与依据均为必填——无依据不改数。"); return; }
    const now = new Date();
    const ts = `2026-09-20 ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    state.manual.push({ id: "EVT-M" + (state.manual.length + 1), type: t, target: tg, detail: `${esc(dt)}`, basis: ba, time: ts, op: "商务人员A" });
    E.appendOp({ time: ts, op: "登记事件", who: "商务人员A", detail: `人工路径登记：${tg}，${dt}`, basis: ba });
    hideModals(); renderEvents(); renderCtx();
    toast("事件已登记并进入待确认队列（示例环境不触发重算）。依据已随事件留痕。");
  }

  function aiExtract() {
    if (!state.online) return;
    toast("正在调用第三方视觉/语言接口提取事件候选…（演示：读取缓存结果）");
    setTimeout(() => {
      const cached = D.events[0];
      toast(`接口返回 <b>${cached.items.length}</b> 条事件候选（缓存 JSON）——已进入待确认队列，请逐条确认后再应用。`);
      $("#evtCards").scrollIntoView({ behavior: "smooth" });
    }, 900);
  }

  /* ---------------- 证据查看（异常条目） ---------------- */
  function showEvidence(ev) {
    const map = {
      "乙方报价.pdf": null, "报价扫描-1 条目4": "data/assets/scan-bing-p1.png",
      "报价扫描-2 费用附件 C-V1-附件1": "data/assets/scan-bing-p2.png",
      "聊天截图 条目14 + 费用说明": "data/assets/chat-ding-note.png",
      "聊天截图 条目4": "data/assets/chat-ding-quote.png"
    };
    const img = map[ev];
    $("#mEvBody").innerHTML = img
      ? `<div class="src-img"><img src="${img}"><div style="padding:8px 10px;font-size:11.5px;color:var(--ink-4);border-top:1px solid var(--line-2)">证据原件 · ${esc(ev)}</div></div>`
      : `<div class="src-table"><table class="simple"><tbody>
          <tr><td>乙方报价.pdf · 第1页合计行</td></tr>
          <tr style="background:rgba(219,51,96,.06)"><td>「报价单列示合计：58375.00元」 ≠ 明细 16 行金额加总 58,175.00（含重复 C07 两行），差 200.00</td></tr>
        </tbody></table></div>
        <div style="font-size:11.5px;color:var(--ink-4);margin-top:6px">解析来源：PDF 文本层抽取（本地）</div>`;
    showModal("mEv");
  }

  /* ---------------- 事件绑定 ---------------- */
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-open],[data-ver],[data-tab],[data-src],[data-qok],[data-qedit],[data-qwait],[data-anf],[data-dry],[data-apply],[data-draft],[data-basis],[data-goto-evt],[data-diffver],[data-ansev],.mclose");
    if (!t) return;
    const ds = t.dataset;
    if (ds.open) { state.view = "project"; switchView(); }
    else if (ds.ver) { state.version = ds.ver; renderAll(); }
    else if (ds.tab) { state.tab = +ds.tab; renderTabs(); }
    else if (ds.src) openSrc(ds.src);
    else if (ds.qok) { const q = state.queue.find((x) => x.id === ds.qok); q.status = "done"; renderInbox(); renderCtx(); toast(`字段已确认入账：${q.supplier} ${q.itemId} ${q.field}（确认动作已留痕）`); }
    else if (ds.qedit) toast("编辑后确认：示例环境以候选值为准，实际环境此处弹出字段编辑框并记录原值→新值。");
    else if (ds.qwait) { const q = state.queue.find((x) => x.id === ds.qwait); q.status = "done"; renderInbox(); renderCtx(); toast(`已登记待澄清：${q.supplier} ${q.field}——未知值不入账，等待书面澄清。`); }
    else if (ds.anf) { state.anFilter = ds.anf; renderEvents(); }
    else if (ds.dry) dryRun(ds.dry);
    else if (ds.apply) applyEvent(ds.apply);
    else if (ds.draft) toast("澄清草稿已生成（可编辑）：请书面回复后以「登记事件」进入流程——示例环境仅演示入口。");
    else if (ds.basis) toast(`依据定位：${ds.basis} —— ${ds.note || ""}（实际环境点击可回查纪要原文条款）`);
    else if (ds.gotoEvt) { state.tab = 3; renderTabs(); }
    else if (ds.diffver) { $("#diffA").value = ds.diffver === "EVT-001" ? "V0" : "V1"; $("#diffB").value = ds.diffver === "EVT-001" ? "V1" : "V2"; state.tab = 4; renderTabs(); }
    else if (ds.ansev) showEvidence(ds.ansev);
    else if (t.classList.contains("mclose")) hideModals();
  });
  document.querySelectorAll(".overlay").forEach((o) => o.addEventListener("click", (e) => { if (e.target === o) hideModals(); }));
  document.addEventListener("click", (ev) => {
    if (ev.target.id === "btnManual") registerModal();
    if (ev.target.id === "btnAI") aiExtract();
    if (ev.target.id === "mRegOk") submitRegister();
    if (ev.target.id === "btnExport") {
      const ts = "2026-09-20 10:12";
      state.exports.unshift(`${ts} · 导出五表台账（${state.version}）+ 异常报告 → outputs/GC-017/（与原件区物理分离）`);
      E.appendOp({ time: ts, op: "导出台账", who: "商务人员A", detail: `导出五表台账（${state.version}）与异常报告至输出区`, basis: "导出自检通过（待补事项如实随附）" });
      renderExport(); toast("导出完成：报价对比表 / 报价明细 / 资格材料清单 / 需补充事项 / 操作记录 —— 已写入输出目录（原件区未改动）。");
    }
    if (ev.target.id === "mDryApply" && ev.target.dataset.apply) applyEvent(ev.target.dataset.apply);
    if (ev.target.id === "onlToggle") {
      state.online = !state.online;
      ev.target.classList.toggle("on", state.online);
      $("#onlChip").innerHTML = state.online ? "第三方模型接口 · 在线" : "内网离线模式";
      renderEvents();
      toast(state.online ? "已切换在线：AI 触点可调用第三方接口（结果一律缓存后经人工确认）。" : "已切换离线：AI 按钮置灰，人工路径承担全部能力，主链路不受影响。");
    }
  });
  document.addEventListener("change", (ev) => {
    if (ev.target.id === "diffA" || ev.target.id === "diffB") renderVersions();
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
    const pane = { 1: "paneInbox", 2: "paneLedger", 3: "paneEvents", 4: "paneVersions", 5: "paneExport" }[state.tab];
    $("#" + pane).classList.add("show");
    renderCtx();
    if (state.tab === 1) renderInbox();
    if (state.tab === 2) renderLedger();
    if (state.tab === 3) renderEvents();
    if (state.tab === 4) renderVersions();
    if (state.tab === 5) renderExport();
  }
  function renderAll() { renderCtx(); renderTabs(); }

  /* ---------------- 启动 ---------------- */
  $("#backHome").addEventListener("click", () => { state.view = "home"; switchView(); });
  window.addEventListener("load", () => {
    const bad = E.assertions.filter((a) => !a.ok);
    if (bad.length) toast("⚠ 引擎与验收基线不一致：" + bad.map((b) => `${b.label} ${b.vendor}`).join("、"));
  });
  renderHome(); switchView(); renderTabs();
})();

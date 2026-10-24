/* =====================================================================
 * 确定性规则引擎（纯前端实现 · 与后端无关）
 * 《项目范围与计算规则》逐条代码化：
 *   R1 折算: 含税金额=ROUND(数量×含税单价,2)；未税=ROUND(含税/(1+税率),2)
 *           原报未税时: 未税=ROUND(数量×未税单价,2)；税额=ROUND(未税×税率,2)；含税=未税+税额
 *   R2 未给税率不得默认补写 → 含税口径置"待确认"
 *   R3 未知值不可当作 0 → 缺价/缺失状态化，不参与合计
 *   R4 台班与项不直接换算，须书面说明（依据授予事件）后才折算
 *   R5 参考区间仅提示，不改写原值
 *   R6 合计=分项相加；保留原始口径与折算依据
 * 引擎产出 V0/V1/V2 三个版本快照，并与验收基线断言核对。
 * ===================================================================== */
window.Engine = (function () {
  "use strict";
  const D = window.DEMO;
  const TAX = 0.06;
  const c2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100; // ROUND(·,2)
  const VENDORS = ["甲", "乙", "丙", "丁"];

  /* ---- 依据事件集合计算一个版本快照 ----
   * applied: { "EVT-001": bool, "EVT-002": bool }
   * versionLabel: "V0" | "V1" | "V2"                                  */
  function compute(applied, versionLabel) {
    const has = (id) => !!applied[id];
    const rows = {};   // rows[itemId][vendor] = cell
    const totals = {}; // totals[vendor] = {incl, excl, note, pending}

    VENDORS.forEach((v) => {
      const S = D.suppliers[v];
      const rate = v === "乙" && has("EVT-001") ? TAX : S.taxRate; // 乙税率由澄清补 6%
      const c07once = v === "乙" && has("EVT-001");
      totals[v] = { incl: 0, excl: 0, pending: 0, note: "" };

      D.catalog.forEach((cat) => {
        const line = S.lines.find((l) => l.id === cat.id);
        const cell = {
          vendor: v, itemId: cat.id, itemName: cat.name, unit: cat.unit, listQty: cat.qty,
          qty: null, unitPrice: null, incl: null, excl: null,
          status: "原报", flags: [], basis: "", src: null, badges: []
        };

        if (!line || line.id === "C11" && line.name === null) {
          // 整项缺失（乙 C11）——澄清补项后计入
          if (line && line.name === null && has("EVT-001")) {
            buildFilled(cell, line, cat, rate, v);           // 乙 C11 补 62×10
          } else {
            cell.status = "缺失";
            cell.flags = (line && line.flags) || [{ type: "missing", note: "清单项整项缺失" }];
            cell.basis = "该供应商未报此分项";
            cell.src = line ? line.src : null;
          }
        } else if (line.price === null) {
          // 有量无价（乙 C09）——澄清补价后计入
          if (has("EVT-001")) buildFilled(cell, line, cat, rate, v);
          else {
            cell.qty = line.qty; cell.status = "待确认";
            cell.flags = line.flags; cell.src = line.src;
            cell.basis = "原报缺价（不为 0），待澄清补充";
          }
        } else {
          buildNormal(cell, line, cat, rate, v, applied, versionLabel);
        }
        (rows[cat.id] = rows[cat.id] || {})[v] = cell;
      });

      finishTotals(v, totals, rows, S, applied, versionLabel);
    });
    return { label: versionLabel, rows, totals, anomalies: anomaliesFor(applied) };
  }

  /* 正常行：按口径折算（R1/R2） */
  function buildNormal(cell, line, cat, rate, v, applied, versionLabel) {
    const qtyEff = effQty(v, cell.itemId, line, applied);
    cell.qty = qtyEff; cell.unitPrice = line.price; cell.src = line.src;
    cell.flags = line.flags.map((f) => ({ ...f }));

    if (line.basis === "incl") {
      /* 丙 C04 原报金额与乘积不符：V0 保留原报值（不改写），澄清事件应用后按乘积更正 */
      if (line.statedIncl && !applied["EVT-001"]) {
        cell.incl = line.statedIncl;
        cell.excl = rate != null ? c2(cell.incl / (1 + rate)) : null;
        cell.basis = `按原文金额列示 ${fmt(line.statedIncl)}（原报）；乘积核对 ${qtyEff} × ${fmt(line.price)} = ${fmt(c2(qtyEff * line.price))} 不符，待澄清更正`;
      } else {
        cell.incl = c2(qtyEff * line.price);
        cell.excl = rate != null ? c2(cell.incl / (1 + rate)) : null;   // R1
        cell.basis = `原报含税单价 ${fmt(line.price)} × ${qtyEff}${cat.unit}` +
          (rate != null ? `；未税=含税/(1+${(rate * 100).toFixed(0)}%)` : "；税率未填，未税待确认");
      }
    } else {
      cell.excl = c2(qtyEff * line.price);
      cell.incl = rate != null ? c2(cell.excl + c2(cell.excl * rate)) : null; // R1
      cell.basis = `原报未税单价 ${fmt(line.price)} × ${qtyEff}${cat.unit}` +
        (rate != null ? `；税额=未税×${(rate * 100).toFixed(0)}%` : "；税率待商务确认，不默认补写");
    }

    /* 状态演进：V1 澄清修正 / V2 变更重算 */
    if (versionLabel === "V2" && cell.itemId === "C08") {
      cell.status = "变更重算";
      cell.basis += `；工程量 ${appliedqty0(v)}→72 根（CHANGE-01）`;
    } else if (versionLabel !== "V0" && changedAtV1(v, cell.itemId)) {
      cell.status = "澄清修正";
      if (applied["EVT-001"]) {
        /* 澄清事件已关闭的异常线索随行消失；区间线索（乙C08）按规则保留 */
        cell.flags = cell.flags.filter((f) => !["product", "notInTotal", "qtyDiff", "dup", "nOp", "missing"].includes(f.type));
      }
    }
    /* 丁 C14 依据授予：台班折算（R4） */
    if (v === "丁" && cell.itemId === "C14" && applied["EVT-001"]) {
      cell.status = "澄清修正";
      cell.qty = 4; cell.unit = "台班";
      cell.unitPrice = c2(cell.incl / 4);
      cell.basis = "澄清书面说明「1 项 = 4 台班」→ 总价均分折算 771.68 元/台班（含税），不另加费用";
      dropFlag(cell, "unitDiff");
    }
    /* 区间核对（R5）：仅提示，不改写 */
    if (cell.excl != null) {
      const unitExcl = perUnitExcl(v, cell.itemId, cell);
      if (unitExcl != null && (unitExcl < cat.refLow || unitExcl > cat.refHigh)) {
        cell.flags.push({ type: "range", note: `未税单价 ${fmt(unitExcl)} 超出参考区间 ${cat.refLow}–${cat.refHigh}` });
      }
    }
    refreshBadges(cell);
  }

  /* 乙 C09 / C11 澄清补价行 */
  function buildFilled(cell, line, cat, rate, v) {
    const fills = {
      "C09": { price: 460.00, qty: 12, name: "声波透射检测", unit: "根" },
      "C11": { price: 62.00,  qty: 10, name: "土工含水率试验", unit: "组" }
    };
    const f = fills[cell.itemId];
    cell.qty = f.qty; cell.unitPrice = f.price; cell.unit = f.unit; cell.itemName = f.name;
    cell.excl = c2(f.qty * f.price);
    cell.incl = c2(cell.excl + c2(cell.excl * TAX));
    cell.status = "澄清修正";
    cell.basis = `原报${cell.itemId === "C09" ? "缺价" : "缺项"}；CLARIFY-01 补未税单价 ${fmt(f.price)} × ${f.qty}${f.unit}，税率 6%`;
    cell.src = line ? line.src : { kind: "doc", file: "供应商澄清纪要.txt", locator: "CLARIFY-01 第2行" };
    cell.flags = []; refreshBadges(cell);
  }

  /* 各行有效数量：C08 工程量 60→72（CHANGE-01）；丁 C04 16→18 点（CLARIFY-01） */
  function effQty(v, itemId, line, applied) {
    if (itemId === "C08" && applied["EVT-002"]) return 72;
    if (v === "丁" && itemId === "C04" && applied["EVT-001"]) return 18;
    return line.qty;
  }
  function appliedqty0(v) { return 60; }

  /* V1 发生变化的单元格（用于状态标色） */
  function changedAtV1(v, itemId) {
    if (v === "乙") return ["C07", "C09", "C11", "C08"].includes(itemId) || itemId === null;
    if (v === "丙") return ["C04", "C13"].includes(itemId);
    if (v === "丁") return ["C04", "C14"].includes(itemId);
    return false;
  }

  function finishTotals(v, totals, rows, S, applied, versionLabel) {
    let incl = 0, excl = 0, pending = 0, notes = [], hasIncl = false;
    D.catalog.forEach((cat) => {
      const cell = rows[cat.id][v];
      if (cell.status === "缺失") return;                        // R3
      if (cell.itemId === "C09" && cell.status === "待确认") { pending++; return; }
      /* 丙 C13：V0 附件未计入主合计；V1 起加计一次 */
      if (v === "丙" && cell.itemId === "C13" && !applied["EVT-001"]) {
        notes.push("机械进出场 3,392.00 在附件页另列，未计入本合计");
        return;
      }
      /* 乙 C07：V0 明细加总按原文两行计（1,568×2）；澄清后只计一次 */
      if (v === "乙" && cell.itemId === "C07" && !applied["EVT-001"]) {
        incl += c2(cell.incl * 2); excl += c2(cell.excl * 2);
        return;
      }
      if (cell.incl != null) { incl = c2(incl + cell.incl); hasIncl = true; }
      if (cell.excl != null) excl = c2(excl + cell.excl);
    });
    const T = totals[v];
    T.incl = hasIncl ? incl : null;   // 税率缺失时含税合计不可信 → 待确认（R2/R3）
    T.excl = excl; T.pending = pending;
    if (v === "乙" && !applied["EVT-001"]) {
      T.note = "文件列示合计 58,375.00 ≠ 明细加总 58,175.00（差 200.00）→ 待核查";
      T.listedIncl = 58375.00;
    }
    if (v === "丙" && !applied["EVT-001"]) T.listedIncl = 38505.84;
    if (v === "丁" && !applied["EVT-001"]) T.listedIncl = 41924.08;
  }

  function perUnitExcl(v, itemId, cell) {
    if (v === "丁" && itemId === "C14") return cell.excl != null ? c2(cell.excl / 4) : null;
    if (!cell.qty || cell.excl == null) return null;
    return c2(cell.excl / cell.qty);
  }
  function dropFlag(cell, type) { cell.flags = cell.flags.filter((f) => f.type !== type); }
  function refreshBadges(cell) {
    cell.badges = [];
    cell.flags.forEach((f) => {
      if (f.type === "range") cell.badges.push("超区间");
      if (f.type === "dup") cell.badges.push("重复·只计一次");
      if (f.type === "unitDiff") cell.badges.push("不可比");
      if (f.type === "qtyDiff") cell.badges.push("数量偏差");
      if (f.type === "product") cell.badges.push("乘积不符");
      if (f.type === "notInTotal") cell.badges.push("附件未计入");
      if (f.type === "alias") cell.badges.push("别名映射");
    });
    cell.badges = [...new Set(cell.badges)];
  }

  /* ---- 异常清单（按事件应用状态闭合；乙C08线索与资格待办恒开放） ---- */
  function anomaliesFor(applied) {
    const A = [
      { id: "AN-01", cls: "计算类", sev: "高", supplier: "乙", itemId: "—", rule: "R6 合计核对",
        text: "文件列示合计 58,375.00 ≠ 明细加总 58,175.00（差 200.00）",
        evidence: "乙方报价.pdf 第1页合计行", closeBy: "EVT-001" },
      { id: "AN-02", cls: "完整性", sev: "高", supplier: "乙", itemId: "C07", rule: "R3 完整性",
        text: "地表沉降监测同一分项出现两行（各 1,568.00）",
        evidence: "乙方报价.pdf 第1页 表格第7、8行", closeBy: "EVT-001" },
      { id: "AN-03", cls: "完整性", sev: "高", supplier: "乙", itemId: "C09", rule: "R3 未知值",
        text: "声波透射检测有量无价（12 根，单价空）",
        evidence: "乙方报价.pdf 第1页 表格第10行", closeBy: "EVT-001" },
      { id: "AN-04", cls: "完整性", sev: "高", supplier: "乙", itemId: "C11", rule: "R3 完整性",
        text: "土工含水率试验整项缺失",
        evidence: "乙方报价.pdf 第1页（整表无 C11）", closeBy: "EVT-001" },
      { id: "AN-05", cls: "价格类", sev: "高", supplier: "乙", itemId: "C08", rule: "R5 区间提示",
        text: "未税单价 500.00 超出参考区间 68–102（约 4.9 倍）——保留原值，仅挂线索，由评审判断",
        evidence: "乙方报价.pdf 第1页 表格第9行", closeBy: null },
      { id: "AN-06", cls: "计算类", sev: "中", supplier: "丙", itemId: "C04", rule: "R6 乘积核对",
        text: "金额 2,181.80 ≠ 18 × 120.10 = 2,161.80（多写 20.00）",
        evidence: "报价扫描-1 条目4", closeBy: "EVT-001" },
      { id: "AN-07", cls: "完整性", sev: "高", supplier: "丙", itemId: "C13", rule: "R6 合计核对",
        text: "机械进出场 3,392.00 在附件页另列，未计入主报价合计 38,505.84",
        evidence: "报价扫描-2 费用附件 C-V1-附件1", closeBy: "EVT-001" },
      { id: "AN-08", cls: "口径类", sev: "中", supplier: "丁", itemId: "C14", rule: "R4 单位换算",
        text: "按「项」计价与清单「台班」不可直接比较，须书面说明",
        evidence: "聊天截图 条目14 + 费用说明", closeBy: "EVT-001" },
      { id: "AN-09", cls: "完整性", sev: "中", supplier: "丁", itemId: "C04", rule: "R3 完整性",
        text: "报 16 点，统一清单为 18 点",
        evidence: "聊天截图 条目4", closeBy: "EVT-001" },
      { id: "AN-10", cls: "资格类", sev: "高", supplier: "乙", itemId: "—", rule: "资格要求",
        text: "检测资质摘要未提交——待补事项保持未关闭",
        evidence: "资格材料登记.xlsx 提交登记", closeBy: null },
      { id: "AN-11", cls: "资格类", sev: "中", supplier: "丁", itemId: "—", rule: "资格要求",
        text: "检测资质 2026-08-31 到期，续期材料未提供——保持未关闭",
        evidence: "资格材料登记.xlsx 提交登记", closeBy: null }
    ];
    return A.map((a) => ({ ...a, open: !(a.closeBy && applied[a.closeBy]) }));
  }

  /* ---- 版本差异表（V(a) → V(b)） ---- */
  function diff(a, b) {
    const out = [];
    D.catalog.forEach((cat) => VENDORS.forEach((v) => {
      const ca = a.rows[cat.id][v], cb = b.rows[cat.id][v];
      if (ca.incl !== cb.incl || ca.excl !== cb.excl || ca.qty !== cb.qty || ca.status !== cb.status) {
        out.push({
          supplier: v, itemId: cat.id, name: cat.name,
          field: ca.incl !== cb.incl ? "含税金额" : (ca.excl !== cb.excl ? "未税金额" : (ca.qty !== cb.qty ? "数量" : "状态")),
          from: ca.incl ?? ca.excl ?? ca.qty ?? ca.status,
          to: cb.incl ?? cb.excl ?? cb.qty ?? cb.status,
          fromIncl: ca.incl, toIncl: cb.incl, fromExcl: ca.excl, toExcl: cb.excl,
          basis: cb.basis, event: cb.status === "变更重算" ? "EVT-002 CHANGE-01" : "EVT-001 CLARIFY-01"
        });
      }
    }));
    return out;
  }

  /* ---- 构建三版本 + 基线断言 ---- */
  const V0 = compute({}, "V0");
  const V1 = compute({ "EVT-001": true }, "V1");
  const V2 = compute({ "EVT-001": true, "EVT-002": true }, "V2");
  const versions = { V0, V1, V2 };

  const assertLog = [];
  function assertBaselines() {
    [["V1", V1], ["V2", V2]].forEach(([label, snap]) => {
      VENDORS.forEach((v) => {
        const got = snap.totals[v].incl, want = D.baselines[label][v];
        const ok = Math.abs(got - want) < 0.005;
        assertLog.push({ label, vendor: v, got, want, ok });
        if (!ok) console.error(`[基线断言失败] ${label} ${v}: 引擎 ${got} ≠ 基线 ${want}`);
      });
    });
    return assertLog;
  }
  const assertions = assertBaselines();

  /* 操作记录（演示环境按事件应用时追加） */
  const opLog = [
    { time: "2026-09-18 09:41", op: "归档原件", who: "商务人员A", detail: "登记甲/乙/丙/丁四家原始报价至只读原件区（6 个文件）", basis: "收件登记" },
    { time: "2026-09-18 09:45", op: "识别解析", who: "系统", detail: "Excel/PDF 本地解析完成；扫描件与截图调用第三方视觉接口识别并缓存 JSON", basis: "识别层" }
  ];
  function appendOp(entry) { opLog.unshift(entry); }

  return { VENDORS, versions, diff, appendOp, opLog, assertions,
           current: { applied: {}, label: "V0" },
           apply(eventId) {
             this.current.applied[eventId] = true;
             this.current.label = eventId === "EVT-001" ? "V1" : "V2";
             return this.versions[this.current.label];
           } };
})();

function fmt(x) {
  if (x == null) return "—";
  return x.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

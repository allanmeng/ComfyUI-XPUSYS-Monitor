/**
 * xpu_monitor.js — ComfyUI-XPUSYS-Monitor
 *
 * Bar layout:
 *   [ PRED x.xx/x.xGB xx% ]  [ CPU x% @ x.xGHz ]  [ RAM x% ]  | GPU x% @ xMHz | x°C  VRAM x/xGB  RSV xGB  PWR xW x% |
 *   └── .vram-predictor-section ──┘                              └──────────────── .gpu-composite-group ────────────────┘
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NS      = "XPUSYS_Mon";
const VERSION = "1.0.0";
const GITHUB  = "https://github.com/allanmeng/ComfyUI-XPUSYS-Monitor";
const S = {
  lang:          `${NS}.Language`,
  fontSize:      `${NS}.FontSize`,
  refreshMs:     `${NS}.RefreshInterval`,
  showPredictor: `${NS}.ShowPredictor`,
  showCPU:       `${NS}.ShowCPU`,
  showRAM:       `${NS}.ShowRAM`,
  showEngine:    `${NS}.ShowEngine`,
  showVRAM:      `${NS}.ShowVRAM`,
  showRSV:       `${NS}.ShowRSV`,
  showPower:     `${NS}.ShowPower`,
};

// Intel Arc PCI device ID → spec TBP (W) — Intel ARK / product pages / NotebookCheck
// Only includes cards with practical AI inference capability (≥8 GB VRAM or workstation Pro series)
const ARC_PCI_TGP = {
  // ── Battlemage (Xe2) — B series consumer ─────────────────────────────────
  "0xe20b": 190,   // Arc B580        (desktop, 12 GB)
  "0xe20a": 190,   // Arc B770        (desktop, 16 GB, announced)
  "0xe20c": 150,   // Arc B570        (desktop, 10 GB)
  "0xe208": 120,   // Arc B580M       (mobile, 12 GB)
  "0xe209": 100,   // Arc B570M       (mobile, 10 GB)

  // ── Battlemage (Xe2) — B series Pro (workstation) ─────────────────────────
  "0xe211": 200,   // Arc Pro B60     (desktop, 24 GB, TBP 120–200 W, use max)
  "0xe212": 70,    // Arc Pro B50     (desktop, 16 GB)

  // ── Alchemist (Xe-HPG) — A series consumer desktop ───────────────────────
  "0x56a0": 225,   // Arc A770        (desktop, 16 GB)
  "0x56a1": 150,   // Arc A750        (desktop, 8 GB)
  "0x56a2": 75,    // Arc A580        (desktop, 8 GB)
  "0x56a5": 75,    // Arc A380        (desktop, 6 GB — borderline, kept)

  // ── Alchemist (Xe-HPG) — A series consumer mobile ────────────────────────
  "0x5690": 150,   // Arc A770M       (120–150 W configurable, use max)
  "0x5691": 120,   // Arc A730M       (80–120 W configurable, use max)
  "0x5696": 80,    // Arc A570M       (50–80 W configurable, use max)
  "0x5692": 80,    // Arc A550M       (60–80 W configurable, use max)
  "0x5697": 50,    // Arc A530M       (35–50 W configurable, use max)

  // ── Alchemist (Xe-HPG) — A series Pro (workstation) ──────────────────────
  "0x56b3": 130,   // Arc Pro A60     (desktop, 12 GB)
  "0x56b2": 75,    // Arc Pro A60M    (mobile, 8 GB)   — device ID: 56B2
  "0x56b1": 50,    // Arc Pro A40/A50 (desktop, 6 GB)  — shared device ID
  "0x56b0": 35,    // Arc Pro A30M    (mobile, 4 GB)
};

// Intel Arc PCI device ID → marketing name
const ARC_PCI_NAMES = {
  // ── Battlemage (Xe2) — B series consumer ─────────────────────────────────
  "0xe20b": "Intel Arc B580",
  "0xe20a": "Intel Arc B770",
  "0xe20c": "Intel Arc B570",
  "0xe208": "Intel Arc B580M",
  "0xe209": "Intel Arc B570M",

  // ── Battlemage (Xe2) — B series Pro (workstation) ─────────────────────────
  "0xe211": "Intel Arc Pro B60",
  "0xe212": "Intel Arc Pro B50",

  // ── Alchemist (Xe-HPG) — A series consumer desktop ───────────────────────
  "0x56a0": "Intel Arc A770",
  "0x56a1": "Intel Arc A750",
  "0x56a2": "Intel Arc A580",
  "0x56a5": "Intel Arc A380",

  // ── Alchemist (Xe-HPG) — A series consumer mobile ────────────────────────
  "0x5690": "Intel Arc A770M",
  "0x5691": "Intel Arc A730M",
  "0x5696": "Intel Arc A570M",
  "0x5692": "Intel Arc A550M",
  "0x5697": "Intel Arc A530M",

  // ── Alchemist (Xe-HPG) — A series Pro (workstation) ──────────────────────
  "0x56b3": "Intel Arc Pro A60",
  "0x56b2": "Intel Arc Pro A60M",
  "0x56b1": "Intel Arc Pro A40/A50", // A40 and A50 share the same device ID
  "0x56b0": "Intel Arc Pro A30M",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTGP(snap) {
  // Table (Intel ARK specs) takes priority over backend reading
  if (snap.device_name) {
    const m = snap.device_name.match(/\[0x([0-9a-fA-F]+)\]/);
    if (m) {
      const key = "0x" + m[1].toLowerCase();
      if (ARC_PCI_TGP[key]) return ARC_PCI_TGP[key];
    }
  }
  if (snap.tgp_w > 0) return snap.tgp_w;
  return 0;
}

function resolveDeviceName(raw) {
  if (!raw) return "Intel Arc GPU";
  const m = raw.match(/\[0x([0-9a-fA-F]+)\]/);
  if (m) {
    const key = "0x" + m[1].toLowerCase();
    if (ARC_PCI_NAMES[key]) return ARC_PCI_NAMES[key];
  }
  return raw;
}

function shortDeviceName(raw) {
  const full  = resolveDeviceName(raw);
  const parts = full.trim().split(/\s+/);
  return parts[parts.length - 1] || full;
}

function getSetting(id, def) {
  try { const v = app.extensionManager?.setting?.get(id); if (v !== undefined) return v; } catch (_) {}
  try { return app.ui.settings.getSettingValue(id, def); } catch (_) {}
  return def;
}

function en() {
  const manual = getSetting(S.lang, "system");
  if (manual === "en") return true;
  if (manual === "zh") return false;
  // "system" 或未知值 → 跟随 Comfy.Locale
  const comfyLocale = getSetting("Comfy.Locale", "");
  if (comfyLocale) return !comfyLocale.toLowerCase().startsWith("zh");
  return true;  // 最终 fallback：英文
}


// 双语辅助：en() 为 true 时返回英文，否则返回中文
function t(zh, en_str) { return en() ? en_str : zh; }

function makeSliderType(min, max, step, liveUpdate = false) {
  return (_name, setter, value) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;";

    const slider = document.createElement("input");
    slider.type = "range"; slider.min = min; slider.max = max; slider.step = step;
    slider.value = value ?? min;
    slider.style.cssText = "flex:1;cursor:pointer;";

    const box = document.createElement("input");
    box.type = "number"; box.min = min; box.max = max; box.step = step;
    box.value = value ?? min;
    box.style.cssText = "width:62px;padding:2px 4px;background:transparent;" +
                        "border:1px solid #555;border-radius:3px;color:inherit;" +
                        "text-align:center;font-size:inherit;";

    slider.addEventListener("input", () => {
      const c = Math.max(min, Math.min(max, Number(slider.value)));
      box.value = c;
    });
    slider.addEventListener("mouseover", () => {
      const c = Math.max(min, Math.min(max, Number(slider.value)));
      box.value = c;
      if (liveUpdate) setter(c);
    });
    slider.addEventListener("change", () => {
      const c = Math.max(min, Math.min(max, Number(slider.value)));
      slider.value = c; box.value = c; setter(c);
    });
    box.addEventListener("change", () => {
      const c = Math.max(min, Math.min(max, Number(box.value)));
      slider.value = c; box.value = c; setter(c);
    });
    wrap.appendChild(slider); wrap.appendChild(box);
    return wrap;
  };
}

function makeLangSelectType() {
  return (_name, setter, value) => {
    const sel = document.createElement("select");
    sel.style.cssText = "background:#2a2a2a;border:1px solid #555;border-radius:4px;" +
                        "color:inherit;padding:3px 8px;font-size:inherit;cursor:pointer;";
    const opts = [
      { label: "系统", value: "system" },
      { label: "中文", value: "zh" },
      { label: "English", value: "en" },
    ];
    // 兼容旧版存的 boolean 值
    const normalized = value === true ? "en" : value === false ? "zh" : (value || "system");
    opts.forEach(o => {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (normalized === o.value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => setter(sel.value));
    return sel;
  };
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .xpu-monitor-bar {
      font-family: 'Consolas', 'JetBrains Mono', 'Cascadia Code', 'PingFang SC', 'Microsoft YaHei', monospace;
      font-size: var(--xpusys-fs, 18px);
      font-variant-numeric: tabular-nums;
      line-height: 1;
      display: flex;
      align-items: center;
      gap: 0;
      padding: 1px 0;
      user-select: none;
      white-space: nowrap;
    }
    .xpu-monitor-bar > *:first-child { margin-left: 0; }

    /* ── 固定宽度数字槽位 ──
         每个 min-width = 该字段最长可能输出的字符数，单位 ch（等宽字体下 1ch = 1字符宽）
         n-pct  : "100.0%" = 6ch
         n-ghz  : "5.2GHz" = 6ch
         n-mhz  : "2450MHz"= 7ch
         n-gb   : "11.9"   = 4ch
         n-temp : "99°C"   = 4ch
         n-w    : "190W"   = 4ch
         n-ratio: "100%"   = 4ch  ── */
    .n-pct   { display: inline-block; min-width: 6ch; text-align: right; }
    .n-ghz   { display: inline-block; min-width: 6ch; text-align: right; }
    .n-mhz   { display: inline-block; min-width: 7ch; text-align: right; }
    .n-gb    { display: inline-block; min-width: 4ch; text-align: right; }
    .n-temp  { display: inline-block; min-width: 4ch; text-align: right; }
    .n-w     { display: inline-block; min-width: 4ch; text-align: right; }
    .n-ratio { display: inline-block; min-width: 4ch; text-align: right; }

    /* ── 显存预测胶囊 ── */
    .vram-predictor-section {
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Consolas', 'JetBrains Mono', 'Cascadia Code', 'PingFang SC', 'Microsoft YaHei', monospace;
      font-size: var(--xpusys-fs, 18px);   /* 直接读变量，与 bar 联动 */
      line-height: 1;                       /* 防止中文字体默认行高撑高胶囊 */
      font-variant-numeric: tabular-nums;
      background: rgba(54, 207, 201, 0.10);
      border: 1px solid rgba(54, 207, 201, 0.22);
      border-radius: 8px;
      padding: 10px 0.6em;
      margin: 0 2px;
      cursor: default;
      position: relative;
      transition: background 0.15s, box-shadow 0.15s;
      box-shadow:
        -2px -2px 5px rgba(255, 255, 255, 0.03),
        2px 2px 6px rgba(0, 0, 0, 0.5);
    }
    .vram-predictor-section:hover {
      background: rgba(54, 207, 201, 0.18);
      box-shadow:
        -2px -2px 5px rgba(255, 255, 255, 0.05),
        2px 2px 6px rgba(0, 0, 0, 0.6);
    }
    /* 中文标签视觉微调：汉字渲染比等宽英文大，缩至 0.85em */
    .pred-zh { font-size: 0.85em; }
    /* 让胶囊内所有 inline 元素（中文/数字/符号）flex 垂直居中，消除基线错位 */
    .vram-predictor-section .xpusys-value {
      display: inline-flex;
      align-items: center;
    }

    /* ── 通用胶囊段落 ── */
    .cpu-section, .ram-section {
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 10px 0.6em;
      margin: 0 1.5px;
      cursor: default;
      position: relative;
      transition: background 0.15s, box-shadow 0.15s;
      box-shadow:
        -2px -2px 5px rgba(255, 255, 255, 0.03),
        2px 2px 6px rgba(0, 0, 0, 0.5);
    }
    /* cpu: "CPU"(3) + n-pct(6) + "@"(1) + n-ghz(6) = 16ch */
    .cpu-section { min-width: 16ch; }
    /* ram: "RAM"(3) + n-pct(6) = 9ch */
    .ram-section { min-width: 9ch; }
    .cpu-section:hover, .ram-section:hover {
      background: rgba(255, 255, 255, 0.08);
      box-shadow:
        -2px -2px 5px rgba(255, 255, 255, 0.05),
        2px 2px 6px rgba(0, 0, 0, 0.6);
    }

    /* ── GPU 综合体强化 ── */
    .gpu-composite-group {
      display: flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 0 4px;
      margin: 0 1.5px;
      gap: 0;
      box-shadow:
        -2px -2px 5px rgba(255, 255, 255, 0.03),
        2px 2px 6px rgba(0, 0, 0, 0.5);
    }

    /* ── GPU 子项 ── */
    .gpu-engine, .gpu-vram, .gpu-rsv, .gpu-pwr {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px 0.6em;
      border-right: 1px solid rgba(255, 255, 255, 0.10);
      cursor: default;
      position: relative;
      transition: background 0.15s;
    }
    /* engine: "GPU"(3)+n-pct(6)+"@"(1)+n-mhz(7)+"|"(1)+n-temp(4) = 22ch */
    .gpu-engine { min-width: 22ch; }
    /* vram: "VRAM"(4)+n-gb(4)+"/"(1)+n-gb(4)+" GB"(3) = 16ch */
    .gpu-vram   { min-width: 16ch; }
    /* rsv: "RSV"(3)+n-gb(4)+" GB"(3) = 10ch */
    .gpu-rsv    { min-width: 10ch; }
    /* pwr: "PWR"(3)+n-w(4)+n-ratio(4) = 11ch */
    .gpu-pwr    { min-width: 11ch; }
    .gpu-pwr { border-right: none; }
    .gpu-engine:hover, .gpu-vram:hover, .gpu-rsv:hover, .gpu-pwr:hover {
      background: rgba(255, 255, 255, 0.06);
      border-radius: 3px;
    }

    .xpusys-value    { font-weight: 600; letter-spacing: 0.02em; }
    .xpusys-ok       { color: #52c41a; }
    .xpusys-warn     { color: #faad14; }
    .xpusys-critical { color: #ff4d4f; }
    .xpusys-vram-ok  { color: #e8e8e8; }
    .xpusys-vram-warn{ color: #ff7a00; }
    .xpusys-vram-crit{ color: #ff4d4f; }
    .xpusys-pwr-ok   { color: #36cfc9; }
    .xpusys-pwr-warn { color: #b37feb; }
    .xpusys-pwr-crit { color: #ff4d4f; }
    .xpusys-na       { color: #555; }

    .xpusys-lock {
      font-size: 10px; color: #666; cursor: pointer;
      border: 1px solid #444; border-radius: 3px;
      padding: 0 3px; line-height: 14px; margin-left: 4px;
      transition: color 0.15s, border-color 0.15s;
    }
    .xpusys-lock:hover { color: #aaa; border-color: #aaa; }

    .xpusys-tooltip {
      position: fixed;
      background: rgba(18,18,24,0.97);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 16px;
      font-family: 'JetBrains Mono', monospace;
      color: #ccc;
      line-height: 1.7;
      pointer-events: none;
      z-index: 99999;
      min-width: 220px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.6);
      white-space: pre;
    }
    .xpusys-tooltip-title {
      color: #fff; font-weight: 700; font-size: 17px; margin-bottom: 4px;
      border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 3px;
    }
    .xpusys-tooltip-row { display: flex; justify-content: space-between; gap: 16px; }
    .xpusys-tooltip-key { color: #888; }
    .xpusys-tooltip-val { color: #e8e8e8; font-weight: 600; }
    .xpusys-tooltip-note{ color: #666; font-size: 15px; margin-top: 4px; }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Tooltip engine
// ---------------------------------------------------------------------------

let _tipEl     = null;
let _tipTarget = null;

function createTooltip() {
  _tipEl = document.createElement("div");
  _tipEl.className    = "xpusys-tooltip";
  _tipEl.style.display = "none";
  document.body.appendChild(_tipEl);
}

function showTooltip(el, html) {
  _tipTarget = el;
  _tipEl.innerHTML    = html;
  _tipEl.style.display = "block";
  positionTooltip(el);
}

function positionTooltip(el) {
  const r  = el.getBoundingClientRect();
  const tw = _tipEl.offsetWidth, th = _tipEl.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  let y = r.bottom + 6;
  x = Math.max(6, Math.min(x, window.innerWidth - tw - 6));
  if (y + th > window.innerHeight - 6) y = r.top - th - 6;
  _tipEl.style.left = x + "px";
  _tipEl.style.top  = y + "px";
}

function hideTooltip() {
  if (_tipEl) _tipEl.style.display = "none";
  _tipTarget = null;
}

function tipRow(key, val, color) {
  const vc = color ? ` style="color:${color}"` : "";
  return `<div class="xpusys-tooltip-row">` +
         `<span class="xpusys-tooltip-key">${key}</span>` +
         `<span class="xpusys-tooltip-val"${vc}>${val}</span>` +
         `</div>`;
}
function tipTitle(t) { return `<div class="xpusys-tooltip-title">${t}</div>`; }
function tipNote(t)  { return `<div class="xpusys-tooltip-note">${t}</div>`; }

// ---------------------------------------------------------------------------
// DOM — bar builder
// ---------------------------------------------------------------------------

let _sec = {};   // { predictor, cpu, ram, engine, vram, rsv, pwr } each { el, valEl }

// ---------------------------------------------------------------------------
// Predictor state  (model-file scan results from /xpusys/model_sizes)
// ---------------------------------------------------------------------------
let _predModels = [];   // [{ name: string, size: number }]
let _predTimer  = null; // debounce handle

function makeSection(cls, initText) {
  const el    = document.createElement("div");
  el.className = cls;
  const valEl = document.createElement("span");
  valEl.className  = "xpusys-value";
  valEl.textContent = initText;
  el.appendChild(valEl);
  return { el, valEl };
}

function buildBar() {
  const bar = document.createElement("div");
  bar.id        = "xpusys-bar";
  bar.className = "xpu-monitor-bar";

  _sec.predictor = makeSection("vram-predictor-section", "PRED ---");
  bar.appendChild(_sec.predictor.el);

  _sec.cpu = makeSection("cpu-section", "CPU --.--%");
  bar.appendChild(_sec.cpu.el);

  _sec.ram = makeSection("ram-section", "RAM --.--%");
  bar.appendChild(_sec.ram.el);

  const gpuGroup = document.createElement("div");
  gpuGroup.className = "gpu-composite-group";

  _sec.engine = makeSection("gpu-engine", "GPU ---");
  _sec.vram   = makeSection("gpu-vram",   "VRAM ---");
  _sec.rsv    = makeSection("gpu-rsv",    "RSV ---");
  _sec.pwr    = makeSection("gpu-pwr",    "PWR ---");

  gpuGroup.appendChild(_sec.engine.el);
  gpuGroup.appendChild(_sec.vram.el);
  gpuGroup.appendChild(_sec.rsv.el);
  gpuGroup.appendChild(_sec.pwr.el);
  bar.appendChild(gpuGroup);

  for (const [key, sec] of Object.entries(_sec)) {
    sec.el.addEventListener("mouseenter", () => { if (_snap) showTip(key, _snap); });
    sec.el.addEventListener("mousemove",  () => { if (_tipTarget === sec.el && _snap) positionTooltip(sec.el); });
    sec.el.addEventListener("mouseleave", hideTooltip);
  }

  return bar;
}

function mountBar(bar) {
  if (app.menu?.settingsGroup?.element) {
    app.menu.settingsGroup.element.before(bar);
  } else {
    Object.assign(bar.style, { position: "fixed", top: "6px", right: "8px", zIndex: "9999" });
    document.body.appendChild(bar);
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let _snap = null;

function setVal(key, text, cls) {
  const sec = _sec[key];
  if (!sec) return;
  sec.valEl.textContent = text;
  sec.valEl.className   = "xpusys-value " + (cls || "");
}

function setHTML(key, html, cls) {
  const sec = _sec[key];
  if (!sec) return;
  sec.valEl.innerHTML = html;
  sec.valEl.className = "xpusys-value " + (cls || "");
}

function renderSnap(snap) {
  if (!snap) return;
  _snap = snap;
  renderCPU(snap);
  renderRAM(snap);
  renderEngine(snap);
  renderVRAM(snap);
  renderRSV(snap);
  renderPWR(snap);
  renderPredictor();   // re-render with latest vram_total_gb from snap
  applyVisibility();
}

function renderCPU(snap) {
  const pct  = snap.cpu_pct      ?? 0;
  const freq = snap.cpu_freq_ghz ?? 0;
  const cls  = pct > 80 ? "xpusys-critical" : pct > 50 ? "xpusys-warn" : "xpusys-ok";
  let html = `CPU<span class="n-pct">${pct.toFixed(1)}%</span>`;
  if (freq > 0) html += `@<span class="n-ghz">${freq.toFixed(2)}GHz</span>`;
  setHTML("cpu", html, cls);
}

function renderRAM(snap) {
  const pct = snap.ram_pct ?? 0;
  const cls = pct > 90 ? "xpusys-critical" : pct > 70 ? "xpusys-warn" : "xpusys-ok";
  setHTML("ram", `RAM<span class="n-pct">${pct.toFixed(1)}%</span>`, cls);
}

function renderEngine(snap) {
  const load = snap.gpu_load_pct ?? 0;
  const freq = snap.gpu_freq_mhz ?? 0;
  const temp = snap.gpu_temp_c   ?? -1;
  const cls  = load > 95 ? "xpusys-critical" : load > 80 ? "xpusys-warn" : "xpusys-ok";
  let html = `GPU<span class="n-pct">${load.toFixed(1)}%</span>`;
  if (freq > 0)  html += `@<span class="n-mhz">${Math.round(freq)}MHz</span>`;
  if (temp >= 0) html += `|<span class="n-temp">${Math.round(temp)}°C</span>`;
  setHTML("engine", html, cls);
}

function renderVRAM(snap) {
  const used  = snap.vram_driver_used_gb ?? 0;
  const total = snap.vram_total_gb       ?? 0;
  const pct   = total > 0 ? used / total : 0;
  const cls   = pct > 0.95 ? "xpusys-vram-crit" : pct > 0.85 ? "xpusys-vram-warn" : "xpusys-vram-ok";
  setHTML("vram",
    `VRAM<span class="n-gb">${used.toFixed(1)}</span>/<span class="n-gb">${total.toFixed(1)}</span> GB`,
    cls);
}

function renderRSV(snap) {
  const rsv = snap.vram_reserved_gb ?? 0;
  setHTML("rsv",
    `RSV<span class="n-gb">${rsv.toFixed(1)}</span> GB`,
    rsv > 0.01 ? "xpusys-pwr-warn" : "xpusys-na");
}

function renderPWR(snap) {
  const sec = _sec.pwr;
  if (!sec) return;

  const existing = sec.el.querySelector(".xpusys-lock");
  if (existing) existing.remove();

  if (!snap.power_available) {
    setVal("pwr", "PWR N/A", "xpusys-na");
    const lock = document.createElement("span");
    lock.className   = "xpusys-lock";
    lock.textContent = "🔒";
    lock.title       = "点击了解详情";
    lock.addEventListener("click", e => {
      e.stopPropagation();
      const dev = shortDeviceName(snap.device_name);
      const msg = snap.is_admin
        ? "未找到功率域 — 请检查驱动版本。"
        : `${dev} 功率数据需要管理员权限。\n\n以管理员身份运行 ComfyUI 即可启用实时功率监控。`;
      alert("⚡ XPUSYSMonitor — 功率说明\n\n" + msg);
    });
    sec.el.appendChild(lock);
    return;
  }

  if (snap.power_w < 0) { setVal("pwr", "PWR N/A", "xpusys-na"); return; }

  const tgp = resolveTGP(snap);
  let pCls, html;
  if (tgp > 0) {
    const ratio = snap.power_w / tgp;
    pCls = ratio > 0.95 ? "xpusys-pwr-crit" : ratio > 0.80 ? "xpusys-pwr-warn" : "xpusys-pwr-ok";
    html = `PWR<span class="n-w">${snap.power_w.toFixed(0)}W</span><span class="n-ratio">${Math.round(ratio * 100)}%</span>`;
  } else {
    pCls = snap.power_w > 170 ? "xpusys-pwr-crit" : snap.power_w > 120 ? "xpusys-pwr-warn" : "xpusys-pwr-ok";
    html = `PWR<span class="n-w">${snap.power_w.toFixed(0)}W</span>`;
  }
  setHTML("pwr", html, pCls);
}

function renderPredictor() {
  if (!_sec.predictor) return;
  const total = _predModels.reduce((s, m) => s + (m.size || 0), 0);
  const peak  = _predModels.length > 0 ? Math.max(..._predModels.map(m => m.size || 0)) : 0;
  const isEn  = en();
  const pred  = calcPrediction(total, peak, _snap);
  const { rate, color: c, label } = pred;
  const vEff  = pred.vEff.toFixed(1);
  const risk  = isEn ? label.en : label.zh;

  const html = isEn
    ? `Model:<span style="color:${c}">${total.toFixed(2)}G</span>/${vEff}G`
      + ` | <span style="color:${c}">${risk}</span>`
      + ` | Success Rate:<span style="color:${c}">${rate}%</span>`
    : `<span class="pred-zh">模型体量:</span><span style="color:${c}">${total.toFixed(2)}G</span>/${vEff}G`
      + ` | <span class="pred-zh">状态:</span><span class="pred-zh" style="color:${c}">${risk}</span>`
      + ` | <span class="pred-zh">预测工作流执行成功率:</span><span style="color:${c}">${rate}%</span>`;
  setHTML("predictor", html);
}

// ---------------------------------------------------------------------------
// Predictor — 成功率计算（三级内存模型）
// ---------------------------------------------------------------------------
// 常量
const PRED_ALPHA  = 0.9;   // 显存碎片化折扣

/**
 * 双约束成功率预测（串行回收模型）
 *
 * 硬约束 P_peak：最大单模型能否装入显存（决定能否运行）
 * 软约束 P_load：总模型量能否在显存+内存中循环（决定稳定性）
 * P_success = P_peak × P_load
 *
 * @param {number} mTotal  所有模型总大小 (GB)
 * @param {number} mPeak   最大单个模型大小 (GB)
 * @param {object} snap    最新系统快照
 */
function calcPrediction(mTotal, mPeak, snap) {
  const vFree  = snap?.vram_free_gb        ?? 0;
  const vAlloc = snap?.vram_allocated_gb   ?? 0;
  const vRsv   = snap?.vram_reserved_gb    ?? 0;
  const rFree  = snap?.ram_free_gb         ?? 0;
  const cUsed  = snap?.commit_used_gb      ?? 0;
  const cLimit = snap?.commit_limit_gb     ?? 0;

  // 可回收显存 = 空闲 + PyTorch 占用（工作流启动前会释放）
  const vReclaim = vFree + vAlloc + vRsv;
  const vEff     = Math.max(0.1, vReclaim * PRED_ALPHA);
  const cRam  = rFree;   // ram_free_gb 已是 OS 报告的真实空闲量，直接使用
  const sVirt = Math.max(0, cLimit - cUsed);   // 与内存胶囊"虚拟内存"定义一致

  // ── 平台系数：NVIDIA UVM 允许更大显存溢出 ─────────────────────────────
  const PLATFORM_GAMMA = {
    "intel":  1.0,   // Intel Arc：硬约束严格
    "nvidia": 4.0,   // NVIDIA：UVM 支持约 4x 溢出
  };
  const gpuVendor = snap?.gpu_vendor ?? "intel";
  const gamma = PLATFORM_GAMMA[gpuVendor] ?? 1.0;

  // ── 硬约束：峰值模型 vs 显存 ──────────────────────────────────────────
  const dPeak = Math.max(0, mPeak - vEff);
  // 平台差异化：NVIDIA 的 effective 显存按 gamma 倍计算
  const vEffPlatform = vEff * gamma;
  const pPeak = dPeak === 0 ? 1 : Math.max(0.02, Math.exp(-3 * dPeak / vEffPlatform));

  // ── 软约束：总量 vs 显存+内存（串行回收） ────────────────────────────
  const dLoad = Math.max(0, mTotal - vEff);
  let pLoad;
  if (dLoad === 0) {
    pLoad = 1;
  } else if (cRam > 0 && dLoad <= cRam) {
    pLoad = 1 - 0.3 * Math.pow(dLoad / cRam, 0.6);
  } else if (sVirt > 0 && dLoad <= cRam + sVirt) {
    pLoad = 0.05 + 0.65 * Math.pow(1 - (dLoad - cRam) / sVirt, 2);
  } else {
    pLoad = Math.max(0, 0.05 - 0.1 * (dLoad - cRam - sVirt));
  }

  const rate = Math.max(0, Math.min(100, Math.round(pPeak * pLoad * 100)));

  let color, label;
  if (rate >= 95) {
    color = "#52c41a"; label = { zh: "轻松",   en: "Smooth"   };
  } else if (rate >= 80) {
    color = "#afff00"; label = { zh: "安全",   en: "Safe"     };
  } else if (rate >= 40) {
    color = "#faad14"; label = { zh: "预警",   en: "Warning"  };
  } else {
    color = "#ff4d4f"; label = { zh: "危险",   en: "Critical" };
  }

  return { rate, color, label, dPeak, dLoad, vEff, cRam, sVirt, pPeak, pLoad, gamma, gpuVendor };
}

// ---------------------------------------------------------------------------
// Visibility & font
// ---------------------------------------------------------------------------

function applyVisibility() {
  if (!_sec.cpu) return;
  if (_sec.predictor)
    _sec.predictor.el.style.display = getSetting(S.showPredictor, true) ? "" : "none";
  _sec.cpu.el.style.display    = getSetting(S.showCPU,    true) ? "" : "none";
  _sec.ram.el.style.display    = getSetting(S.showRAM,    true) ? "" : "none";
  _sec.engine.el.style.display = getSetting(S.showEngine, true) ? "" : "none";
  _sec.vram.el.style.display   = getSetting(S.showVRAM,   true) ? "" : "none";
  _sec.rsv.el.style.display    = getSetting(S.showRSV,    true) ? "" : "none";
  _sec.pwr.el.style.display    = getSetting(S.showPower,  true) ? "" : "none";
}

function applyFontSize(val) {
  const px = (val != null && !isNaN(Number(val))) ? Number(val) : Number(getSetting(S.fontSize, 18));
  document.documentElement.style.setProperty("--xpusys-fs", px + "px");
}

// ---------------------------------------------------------------------------
// Tooltip content
// ---------------------------------------------------------------------------

function showTip(key, snap) {
  const el = _sec[key]?.el;
  if (!el) return;
  const builders = { predictor: buildPredictorTip,
                     cpu: buildCPUTip, ram: buildRAMTip, engine: buildEngineTip,
                     vram: buildVRAMTip, rsv: buildRSVTip, pwr: buildPWRTip };
  const html = builders[key]?.(snap, en());
  if (html) showTooltip(el, html);
}

function buildCPUTip(snap, eng) {
  const pct  = snap.cpu_pct      ?? 0;
  const freq = snap.cpu_freq_ghz ?? 0;
  const c    = pct > 80 ? "#ff4d4f" : pct > 50 ? "#faad14" : "#52c41a";
  if (eng) {
    return tipTitle("🖥️ CPU")
      + tipRow("Utilisation", pct.toFixed(1) + " %", c)
      + (snap.cpu_model   ? tipRow("Model",   snap.cpu_model) : "")
      + (freq > 0         ? tipRow("Freq",    freq.toFixed(2) + " GHz") : "")
      + (snap.cpu_threads ? tipRow("Threads", String(snap.cpu_threads)) : "")
      + tipNote("Source: psutil · cpu_percent / wmic CurrentClockSpeed\nRegistry: ProcessorNameString");
  }
  return tipTitle("🖥️ 处理器")
    + tipRow("占用率",  pct.toFixed(1) + " %", c)
    + (snap.cpu_model   ? tipRow("型号",   snap.cpu_model) : "")
    + (freq > 0         ? tipRow("频率",   freq.toFixed(2) + " GHz") : "")
    + (snap.cpu_threads ? tipRow("线程数", String(snap.cpu_threads)) : "")
    + tipNote("来源: psutil · cpu_percent / wmic CurrentClockSpeed\n注册表: ProcessorNameString");
}

function buildRAMTip(snap, eng) {
  const pct         = snap.ram_pct          ?? 0;
  const total       = snap.ram_total_gb     ?? 0;
  const used        = snap.ram_used_gb      ?? 0;
  const free        = snap.ram_free_gb      ?? 0;
  const commitUsed  = snap.commit_used_gb   ?? 0;
  const commitLimit = snap.commit_limit_gb  ?? 0;
  const c     = pct > 90 ? "#ff4d4f" : pct > 70 ? "#faad14" : "#52c41a";
  const commitStr = commitLimit > 0
    ? `${commitUsed.toFixed(1)} / ${commitLimit.toFixed(1)} GB`
    : `${commitUsed.toFixed(1)} GB`;
  if (eng) {
    return tipTitle("💾 System RAM")
      + tipRow("Total",   total.toFixed(1) + " GB")
      + tipRow("Used",    used.toFixed(1)  + " GB", c)
      + tipRow("Free",    free.toFixed(1)  + " GB", "#52c41a")
      + (commitUsed > 0 ? tipRow("Commit", commitStr, "#b37feb") : "")
      + tipNote("Source: psutil · virtual_memory\nCommit: GlobalMemoryStatusEx");
  }
  return tipTitle("💾 系统内存")
    + tipRow("总量",   total.toFixed(1) + " GB")
    + tipRow("已用",   used.toFixed(1)  + " GB", c)
    + tipRow("空闲",   free.toFixed(1)  + " GB", "#52c41a")
    + (commitUsed > 0 ? tipRow("虚拟内存", commitStr, "#b37feb") : "")
    + tipNote("来源: psutil · virtual_memory\n虚拟内存: GlobalMemoryStatusEx");
}

function buildEngineTip(snap, eng) {
  const load = snap.gpu_load_pct ?? 0;
  const freq = snap.gpu_freq_mhz ?? 0;
  const temp = snap.gpu_temp_c   ?? -1;
  const c    = load > 95 ? "#ff4d4f" : load > 80 ? "#faad14" : "#52c41a";
  const tc   = temp > 85 ? "#ff4d4f" : temp > 70 ? "#faad14" : "#36cfc9";
  if (eng) {
    return tipTitle("📊 GPU Engine")
      + tipRow("Load",  load.toFixed(1) + " %", c)
      + (freq > 0  ? tipRow("Clock", Math.round(freq) + " MHz") : "")
      + (temp >= 0 ? tipRow("Temp",  Math.round(temp) + " °C", tc) : "")
      + tipNote("Source: Intel Level Zero · zesEngineGetActivity\n" +
                "        zesFrequencyGetState · zesTemperatureGetState");
  }
  return tipTitle("📊 GPU 引擎")
    + tipRow("负载", load.toFixed(1) + " %", c)
    + (freq > 0  ? tipRow("频率", Math.round(freq) + " MHz") : "")
    + (temp >= 0 ? tipRow("温度", Math.round(temp) + " °C", tc) : "")
    + tipNote("来源: Intel Level Zero · zesEngineGetActivity\n" +
              "      zesFrequencyGetState · zesTemperatureGetState");
}

function buildVRAMTip(snap, eng) {
  const total  = snap.vram_total_gb        ?? 0;
  const used   = snap.vram_driver_used_gb  ?? 0;
  const alloc  = snap.vram_allocated_gb    ?? 0;
  const rsv    = snap.vram_reserved_gb     ?? 0;
  const free   = snap.vram_free_gb         ?? 0;
  // Breakdown: C = driver_used - pytorch_reserved, E = reserved - allocated
  const sysEnv = Math.max(0, used  - rsv);
  const buf    = Math.max(0, rsv   - alloc);
  const pct    = total > 0 ? used / total : 0;
  const c      = pct > 0.95 ? "#ff4d4f" : pct > 0.85 ? "#ff7a00" : "#e8e8e8";
  // 统一用 GB（2位小数）显示，与 bar 上的 toFixed(1) 对齐，避免 MB÷1000 的心算误差
  const g2     = gb => gb.toFixed(2) + " GB";
  if (eng) {
    return tipTitle("🧠 VRAM Breakdown")
      + tipRow("Total",             g2(total))
      + tipRow("Current Used",      g2(used),   c)
      + tipRow("  System & Env (display & driver)",     g2(sysEnv), "#888")
      + tipRow("  Model & Compute (loaded model)",      g2(alloc),  "#36cfc9")
      + tipRow("  Reserved Buffer (PyTorch pre-alloc)", g2(buf),    "#b37feb")
      + tipRow("Free",              g2(free),   "#52c41a")
      + tipNote("Source: zesMemoryGetState / torch.xpu.memory_allocated / memory_reserved");
  }
  return tipTitle("🧠 显存详情")
    + tipRow("总量",       g2(total))
    + tipRow("当前占用",   g2(used),   c)
    + tipRow("  系统与环境 (系统显示及驱动占用)",           g2(sysEnv), "#888")
    + tipRow("  模型与计算 (当前加载模型与实时运算)",       g2(alloc),  "#36cfc9")
    + tipRow("  预留缓冲区 (PyTorch 预先霸占的待分配空间)", g2(buf),    "#b37feb")
    + tipRow("空闲",       g2(free),   "#52c41a")
    + tipNote("来源: zesMemoryGetState / torch.xpu.memory_allocated / memory_reserved");
}

function buildRSVTip(snap, eng) {
  const rsv   = snap.vram_reserved_gb  ?? 0;
  const alloc = snap.vram_allocated_gb ?? 0;
  const buf   = Math.max(0, rsv - alloc);
  if (eng) {
    return tipTitle("💾 Reserved (PyTorch Cache)")
      + tipRow("Cache Pool",  (rsv   * 1024).toFixed(0) + " MB", "#b37feb")
      + tipRow("  In Use",    (alloc * 1024).toFixed(0) + " MB", "#36cfc9")
      + tipRow("  Free Buf",  (buf   * 1024).toFixed(0) + " MB", "#888")
      + tipNote("Source: torch.xpu.memory_reserved()");
  }
  return tipTitle("💾 PyTorch 缓存池")
    + tipRow("缓存总量",   (rsv   * 1024).toFixed(0) + " MB", "#b37feb")
    + tipRow("  实际占用", (alloc * 1024).toFixed(0) + " MB", "#36cfc9")
    + tipRow("  空闲缓存", (buf   * 1024).toFixed(0) + " MB", "#888")
    + tipNote("来源: torch.xpu.memory_reserved()");
}

function buildPWRTip(snap, eng) {
  if (!snap.power_available) {
    const dev = shortDeviceName(snap.device_name);
    if (eng) {
      return tipTitle("⚡ Power — 🔒 Admin Only")
        + `<div style="color:#888;margin-top:4px">${dev} power data requires admin privileges.<br>` +
          `Run ComfyUI as Administrator to enable live power monitoring.</div>`;
    }
    return tipTitle("⚡ 功率 — 🔒 需要管理员")
      + `<div style="color:#888;margin-top:4px">${dev} 功率数据需要管理员权限。<br>` +
        `以管理员身份运行 ComfyUI 即可启用实时功率监控。</div>`;
  }
  const tgp = resolveTGP(snap);
  const dev = shortDeviceName(snap.device_name);
  const pct = tgp > 0 ? snap.power_w / tgp : 0;
  const c   = (tgp > 0 && pct > 0.95) ? "#ff4d4f"
            : (tgp > 0 && pct > 0.80) ? "#b37feb"
            : snap.power_w > 170       ? "#ff4d4f"
            : snap.power_w > 120       ? "#b37feb"
            : "#36cfc9";
  if (eng) {
    let html = tipTitle(`⚡ ${dev} Power`)
      + tipRow("Instant Power", snap.power_w.toFixed(1) + " W", c);
    if (tgp > 0) html += tipRow("TGP Limit",  tgp.toFixed(0) + " W", "#666")
                       + tipRow("Load Ratio", (pct * 100).toFixed(0) + " %", c);
    return html + tipNote("Source: Intel Level Zero · zesPowerGetEnergyCounter\nAdmin · Dual-sample energy delta");
  }
  let html = tipTitle(`⚡ ${dev} 实时功率`)
    + tipRow("瞬时功率", snap.power_w.toFixed(1) + " W", c);
  if (tgp > 0) html += tipRow("TGP 上限",  tgp.toFixed(0) + " W", "#666")
                     + tipRow("负载比例", (pct * 100).toFixed(0) + " %", c);
  return html + tipNote("来源: Intel Level Zero · zesPowerGetEnergyCounter\n需要管理员权限 · 双采样能量差值");
}

function buildPredictorTip(snap, eng) {
  const total = _predModels.reduce((s, m) => s + (m.size || 0), 0);
  const mPeak = _predModels.length > 0 ? Math.max(..._predModels.map(m => m.size || 0)) : 0;
  const pred  = calcPrediction(total, mPeak, snap);
  const divider = `<div style="border-top:1px solid rgba(255,255,255,0.1);margin:5px 0"></div>`;

  // ── 标题 ──
  let html = tipTitle(eng ? "🎯 Current Load List" : "🎯 当前加载清单");

  // ── 成功率输入参数 ──
  const vendorName = pred.gpuVendor === "nvidia" ? "NVIDIA UVM" : "Intel Arc";
  const overflowTol = pred.gamma.toFixed(1) + "x";
  if (eng) {
    html += tipRow("Overflow Tolerance", overflowTol + " (" + vendorName + ")", "#36cfc9");
    html += tipRow("Eff. VRAM Cap",      pred.vEff.toFixed(2)  + " GB", "#36cfc9");
    html += tipRow("Peak Model",         mPeak.toFixed(2)      + " GB", pred.dPeak > 0 ? "#ff4d4f" : "#52c41a");
    html += tipRow("  VRAM Gap",         pred.dPeak.toFixed(2) + " GB", pred.dPeak > 0 ? "#faad14" : "#555");
    html += tipRow("  P_peak",           (pred.pPeak * 100).toFixed(0) + " %", pred.dPeak > 0 ? "#faad14" : "#52c41a");
    html += tipRow("Total Models",       total.toFixed(2)      + " GB", pred.color);
    html += tipRow("  Load Gap",         pred.dLoad.toFixed(2) + " GB", pred.dLoad > 0 ? "#faad14" : "#555");
    html += tipRow("  Avail. RAM",       pred.cRam.toFixed(2)  + " GB", "#b37feb");
    html += tipRow("  Avail. Commit",    pred.sVirt.toFixed(2) + " GB", "#888");
    html += tipRow("  P_load",           (pred.pLoad * 100).toFixed(0) + " %", pred.dLoad > 0 ? "#faad14" : "#52c41a");
    html += tipRow("Success Rate",       pred.rate + " %",               pred.color);
  } else {
    html += tipRow("溢出容忍",           overflowTol + " (" + vendorName + ")", "#36cfc9");
    html += tipRow("显存上限",           pred.vEff.toFixed(2)  + " GB", "#36cfc9");
    html += tipRow("峰值模型",           mPeak.toFixed(2)      + " GB", pred.dPeak > 0 ? "#ff4d4f" : "#52c41a");
    html += tipRow("  显存缺口",         pred.dPeak.toFixed(2) + " GB", pred.dPeak > 0 ? "#faad14" : "#555");
    html += tipRow("  显存压力",         (pred.pPeak * 100).toFixed(0) + " %", pred.dPeak > 0 ? "#faad14" : "#52c41a");
    html += tipRow("模型总量",           total.toFixed(2)      + " GB", pred.color);
    html += tipRow("  负载缺口",         pred.dLoad.toFixed(2) + " GB", pred.dLoad > 0 ? "#faad14" : "#555");
    html += tipRow("  可用内存",         pred.cRam.toFixed(2)  + " GB", "#b37feb");
    html += tipRow("  可用虚拟内存",     pred.sVirt.toFixed(2) + " GB", "#888");
    html += tipRow("  负载压力",         (pred.pLoad * 100).toFixed(0) + " %", pred.dLoad > 0 ? "#faad14" : "#52c41a");
    html += tipRow("预测成功率",         pred.rate + " %",               pred.color);
  }

  // ── 分隔线 + 模型列表 ──
  html += divider;
  const sorted = [..._predModels].sort((a, b) => b.size - a.size);
  if (sorted.length === 0) {
    html += `<div class="xpusys-tooltip-note">${eng ? "No active models detected." : "无活跃模型"}</div>`;
  } else {
    for (const m of sorted) {
      const short = m.name.split(/[\\/]/).pop();
      html += tipRow(short, m.size.toFixed(2) + " GB", "#52c41a");
    }
  }

  html += tipNote(eng ? "Source: disk file size · /xpusys/model_sizes"
                      : "来源: 磁盘文件大小 · /xpusys/model_sizes");
  return html;
}

// 给节点的模型 widget 挂 callback 钩子，切换模型时立即触发更新
const MODEL_EXTS = [".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".pkl"];

function applyModelHook(node) {
  let hasModel = false;
  node.widgets?.forEach(w => {
    if (w.type !== "combo" || w._xpusysPredHooked) return;
    const wn = w.name?.toLowerCase() || "";
    const isModel =
      ["model","ckpt","vae","lora","control","clip","unet"].some(k => wn.includes(k)) ||
      w.options?.values?.some(v => {
        const s = String(v).toLowerCase();
        return MODEL_EXTS.some(ext => s.endsWith(ext));
      });
    if (!isModel) return;
    hasModel = true;
    const origCb = w.callback;
    w.callback = function () {
      const r = origCb ? origCb.apply(this, arguments) : undefined;
      updatePredictor();
      return r;
    };
    w._xpusysPredHooked = true;
  });

  // 只对含模型 widget 的节点挂 bypass / 删除钩子
  if (hasModel && !node._xpusysNodeHooked) {
    // 监听节点被移除
    const origRemoved = node.onRemoved;
    node.onRemoved = function () {
      if (origRemoved) origRemoved.apply(this, arguments);
      updatePredictor();
    };
    // 使用 Object.defineProperty 监听 mode 属性变化
    let _mode = node.mode;
    Object.defineProperty(node, "mode", {
      get: function() { return _mode; },
      set: function(v) {
        if (_mode !== v) {
          _mode = v;
          updatePredictor();
        }
      },
      configurable: true
    });
    node._xpusysNodeHooked = true;
  }
}

// Debounced entry point — called by graph event hooks
function updatePredictor() {
  if (_predTimer) clearTimeout(_predTimer);
  _predTimer = setTimeout(_doPredictorFetch, 150);
}

async function _doPredictorFetch() {
  const nodes = app.graph?._nodes;
  if (!nodes) return;

  // 后端支持的模型文件后缀
  const ALLOWED_EXTS = [".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".onnx", ".pkl"];

  // 按模型文件名去重的 Map
  const uniqueModels = new Map();

  nodes.forEach(node => {
    if (node.mode !== 0) return;                      // skip bypassed / muted
    const nodeType = node.type?.toLowerCase() || "";

    // 遍历所有 widget，查找符合后缀的模型文件
    node.widgets?.forEach(w => {
      if (typeof w.value !== "string") return;
      const value = w.value.trim();
      if (!value) return;

      // 检查是否为已登记后缀的模型文件
      const ext = value.substring(value.lastIndexOf(".")).toLowerCase();
      if (!ALLOWED_EXTS.includes(ext)) return;

      // 按文件名去重，只保留第一次出现的记录
      if (!uniqueModels.has(value)) {
        // 根据 widget 名称推断模型类型
        const wn = w.name?.toLowerCase() || "";
        let hint = "checkpoints";
        if (nodeType.includes("vae") || wn.includes("vae"))            hint = "vae";
        else if (nodeType.includes("lora") || wn.includes("lora"))     hint = "loras";
        else if (nodeType.includes("control") || wn.includes("control")) hint = "controlnet";
        else if (nodeType.includes("clip") || wn.includes("clip"))     hint = "clip";
        else if (nodeType.includes("unet") || wn.includes("unet"))     hint = "unet";
        else if (nodeType.includes("upscale") || wn.includes("upscale")) hint = "upscale_models";

        uniqueModels.set(value, { type: hint, name: value });
      }
    });
  });

  const activeModels = Array.from(uniqueModels.values());

  try {
    const r = await api.fetchApi("/xpusys/model_sizes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: activeModels }),
    });
    if (r.ok) {
      const data   = await r.json();
      _predModels  = data.models || [];
      renderPredictor();
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

let _pollTimer = null;

function onWsMessage(e) {
  if (e?.detail?.type !== "xpusys_stats") return;
  renderSnap(e.detail.data);
}

async function pollOnce() {
  try {
    const r = await api.fetchApi("/xpusys/stats");
    if (r.ok) renderSnap(await r.json());
  } catch (_) {}
}

function startPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  const ms = Math.max(200, getSetting(S.refreshMs, 1000));
  _pollTimer = setInterval(pollOnce, ms);
  pollOnce();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

app.registerExtension({
  name: `${NS}.Monitor`,

  async setup() {
    injectStyles();
    createTooltip();

    // ── 0 关于 ────────────────────────────────────────────────────────────
    app.ui.settings.addSetting({
      id: `${NS}.About`,
      name: t("关于插件", "About"),
      type: (_name, _setter, _value) => {
        const wrap = document.createElement("div");
        wrap.style.cssText =
          "line-height:1.7;color:#ccc;font-size:15px;padding:4px 0 2px;max-width:520px;";
        const zhText =
          `本插件源于对 Intel Arc (XPU) 生态的支持。虽由「少数派」发起，但遵循底层标准，现已实现对 Intel (XPU) 与 NVIDIA (CUDA) 的完美兼容（AMD 支持已在计划中）。<br><br>` +
          `<span style="color:#36cfc9;font-weight:600;">核心亮点：</span>` +
          `独家支持模型运行显存预测，在生成前预判硬件压力；提供精准的跨平台硬件监测。填补工具空白，追求极致稳定。希望你喜欢。`;
        const enText =
          `Born from the Intel Arc (XPU) ecosystem. While built by the "minority," this plugin follows standard specs for seamless Intel (XPU) and NVIDIA (CUDA) support (AMD in progress).<br><br>` +
          `<span style="color:#36cfc9;font-weight:600;">Highlight:</span> ` +
          `Exclusive Model VRAM Prediction to anticipate hardware strain before generation. We aim to fill the gap in XPU monitoring with stable, cross-platform insights. Enjoy!`;
        wrap.innerHTML = en() ? enText : zhText;

        // ── 版本号 + GitHub 按钮 ──────────────────────────────────────────
        const bar = document.createElement("div");
        bar.style.cssText =
          "display:flex;align-items:center;justify-content:flex-end;gap:8px;" +
          "margin-top:16px;flex-wrap:wrap;border-top:1px solid #333;padding-top:10px;";

        // 版本徽章
        const verBadge = document.createElement("span");
        verBadge.style.cssText =
          "display:inline-flex;align-items:center;gap:0;border-radius:4px;overflow:hidden;" +
          "font-size:12px;font-weight:600;line-height:1;";
        verBadge.innerHTML =
          `<span style="background:#555;color:#fff;padding:4px 7px;">${t("版本", "Version")}</span>` +
          `<span style="background:#4caf50;color:#fff;padding:4px 7px;">${VERSION}</span>`;

        // GitHub 按钮
        const ghBtn = document.createElement("a");
        ghBtn.href   = GITHUB;
        ghBtn.target = "_blank";
        ghBtn.rel    = "noopener noreferrer";
        ghBtn.style.cssText =
          "display:inline-flex;align-items:center;gap:5px;padding:4px 10px;" +
          "background:#24292e;color:#fff;border-radius:4px;font-size:12px;font-weight:600;" +
          "text-decoration:none;line-height:1;transition:background .15s;";
        ghBtn.onmouseenter = () => { ghBtn.style.background = "#444d56"; };
        ghBtn.onmouseleave = () => { ghBtn.style.background = "#24292e"; };
        ghBtn.innerHTML =
          `<svg width="14" height="14" viewBox="0 0 16 16" fill="#fff" style="flex-shrink:0;">` +
          `<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38` +
          `0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52` +
          `-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07` +
          `-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12` +
          `0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82` +
          ` 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95` +
          `.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8` +
          `c0-4.42-3.58-8-8-8z"/></svg>` +
          `GitHub`;

        bar.appendChild(verBadge);
        bar.appendChild(ghBtn);
        wrap.appendChild(bar);

        return wrap;
      },
      defaultValue: "",
      category: [NS, t("\uE000关于", "\uE000About"), t("\uE000简介", "\uE000Introduction")],
    });

    // ── 1 通用设置 ────────────────────────────────────────────────────────
    app.ui.settings.addSetting({
      id: S.lang, name: t("界面语言", "Interface Language"),
      tooltip: t("切换悬浮窗与状态栏的显示语言", "Switch display language for overlay and status bar"),
      type: makeLangSelectType(), defaultValue: "system",
      category: [NS, t("\uE001通用设置", "\uE001General"), t("\uE003语言", "\uE003Language")],
    });

    app.ui.settings.addSetting({
      id: S.fontSize, name: t("字体大小 (px)", "Font Size (px)"),
      tooltip: t("状态栏字体大小，范围 12–22 px", "Status bar font size, range 12–22 px"),
      type: makeSliderType(12, 22, 1, false), defaultValue: 16,
      category: [NS, t("\uE001通用设置", "\uE001General"), t("\uE002字体大小", "\uE002Font Size")],
      onChange: applyFontSize,
    });
    app.ui.settings.addSetting({
      id: S.refreshMs, name: t("刷新间隔 (ms)", "Refresh Interval (ms)"),
      tooltip: t("状态栏数据更新频率，范围 200–5000 ms", "Status bar update frequency, range 200–5000 ms"),
      type: makeSliderType(200, 5000, 100), defaultValue: 1000,
      category: [NS, t("\uE001通用设置", "\uE001General"), t("\uE001刷新间隔", "\uE001Refresh Interval")],
      onChange: startPolling,
    });

    // ── 2 工作流预测 ──────────────────────────────────────────────────────
    app.ui.settings.addSetting({
      id: S.showPredictor, name: t("显示显存预测（PRED）", "Show VRAM Predictor (PRED)"),
      tooltip: t("在状态栏最左侧显示工作流模型显存预估值与成功率", "Show estimated VRAM usage and workflow success rate in the status bar"),
      type: "boolean", defaultValue: true,
      category: [NS, t("\uE002工作流预测", "\uE002Workflow Predictor"), t("\uE001显示显存预测", "\uE001Show VRAM Predictor")],
      onChange: applyVisibility,
    });

    // ── 3 CPU监控 ─────────────────────────────────────────────────────────
    app.ui.settings.addSetting({
      id: S.showCPU, name: t("显示 CPU 负载", "Show CPU Load"),
      tooltip: t("在状态栏显示 CPU 占用率与频率", "Show CPU usage and frequency in the status bar"),
      type: "boolean", defaultValue: false,
      category: [NS, t("\uE003CPU监控", "\uE003CPU Monitor"), t("\uE001显示CPU负载", "\uE001Show CPU Load")],
      onChange: applyVisibility,
    });

    // ── 4 内存监控 ────────────────────────────────────────────────────────
    app.ui.settings.addSetting({
      id: S.showRAM, name: t("显示内存占用", "Show RAM Usage"),
      tooltip: t("在状态栏显示系统内存使用率", "Show system RAM usage in the status bar"),
      type: "boolean", defaultValue: true,
      category: [NS, t("\uE004内存监控", "\uE004RAM Monitor"), t("\uE001显示内存占用", "\uE001Show RAM Usage")],
      onChange: applyVisibility,
    });

    // ── 5 显卡监控 ────────────────────────────────────────────────────────
    app.ui.settings.addSetting({
      id: S.showEngine, name: t("显示 GPU 引擎（负载 / 频率 / 温度）", "Show GPU Engine (Load / Freq / Temp)"),
      tooltip: t("在状态栏显示 GPU 负载百分比、时钟频率和核心温度", "Show GPU load, clock frequency and core temperature in the status bar"),
      type: "boolean", defaultValue: true,
      category: [NS, t("\uE005显卡监控", "\uE005GPU Monitor"), t("\uE001GPU引擎", "\uE001GPU Engine")],
      onChange: applyVisibility,
    });
    app.ui.settings.addSetting({
      id: S.showVRAM, name: t("显示显存用量", "Show VRAM Usage"),
      tooltip: t("在状态栏显示驱动层显存占用", "Show driver-level VRAM usage in the status bar"),
      type: "boolean", defaultValue: true,
      category: [NS, t("\uE005显卡监控", "\uE005GPU Monitor"), t("\uE002显存用量", "\uE002VRAM Usage")],
      onChange: applyVisibility,
    });
    app.ui.settings.addSetting({
      id: S.showRSV, name: t("显示 PyTorch 缓存池（RSV）", "Show PyTorch Cache Pool (RSV)"),
      tooltip: t("在状态栏显示 torch.xpu.memory_reserved() 缓存大小", "Show torch.xpu.memory_reserved() cache size in the status bar"),
      type: "boolean", defaultValue: false,
      category: [NS, t("\uE005显卡监控", "\uE005GPU Monitor"), t("\uE003缓存池", "\uE003Cache Pool")],
      onChange: applyVisibility,
    });
    app.ui.settings.addSetting({
      id: S.showPower, name: t("显示功率（需要管理员权限）", "Show Power (Admin Required)"),
      tooltip: t("在状态栏显示瞬时功耗与 TGP 负载比例", "Show instantaneous power consumption and TGP load ratio in the status bar"),
      type: "boolean", defaultValue: true,
      category: [NS, t("\uE005显卡监控", "\uE005GPU Monitor"), t("\uE004功率", "\uE004Power")],
      onChange: applyVisibility,
    });

    const bar = buildBar();
    mountBar(bar);
    applyVisibility();
    applyFontSize();
    setTimeout(applyFontSize, 0);

    api.addEventListener("message", onWsMessage);
    startPolling();

    // 对已存在节点补挂 widget 钩子，然后初始扫描
    app.graph._nodes?.forEach(n => applyModelHook(n));
    updatePredictor();
  },

  // ── 显存预测 — 官方扩展钩子，安全无冲突 ──────────────────────────────
  nodeCreated(node) {
    setTimeout(() => { applyModelHook(node); updatePredictor(); }, 200);
  },

  loadedGraphNode(node) {
    applyModelHook(node);
  },

  async afterConfigureGraph() {
    // 对所有节点应用 hook，然后更新预测
    app.graph._nodes?.forEach(n => applyModelHook(n));
    updatePredictor();
  },
});

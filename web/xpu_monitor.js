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
const VERSION = "1.0.8";
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
  showSpecs:     `${NS}.ShowSpecs`,
  gpuIndex:      `${NS}.GPUIndex`,
  sparkCharts:   `${NS}.SparkCharts`,
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

// ---------------------------------------------------------------------------
// ComfyUI theme detection — plugin colour scheme follows ComfyUI's theme
// ---------------------------------------------------------------------------
// 浅色主题 id 集合：Light + Mike White (Milk White)，其余 (dark/arc/nord/
// solarized/github 等) 一律视为深色。读取设置值为主，body class 为兜底，
// 并用 MutationObserver 监听 body class 变化，实现自动跟随。
const LIGHT_THEME_IDS = new Set(["light", "milk_white", "mikey", "mike-white"]);
let _curTheme = "dark";          // "dark" | "light"
let _themeObserver = null;

function detectComfyTheme() {
  // 1) 优先读 ComfyUI 设置
  try {
    const id = app.ui.settings.getSettingValue("Comfy.ColorPalette", "dark");
    if (typeof id === "string" && id) return LIGHT_THEME_IDS.has(id) ? "light" : "dark";
  } catch (_) {}
  // 2) 兜底：body class 是否带浅色主题 id
  try {
    const cls = document.body.className || "";
    for (const id of LIGHT_THEME_IDS) {
      if (cls.includes(id)) return "light";
    }
  } catch (_) {}
  return "dark";
}

function applyTheme() {
  const theme = detectComfyTheme();
  if (theme !== _curTheme) {
    _curTheme = theme;
    // 通知全局 CSS（injectStyles 里的变量都挂在 :root 上）
    document.documentElement.dataset.xpusysTheme = theme;
    updateThemeStatusUI();
  }
}

function startThemeWatcher() {
  applyTheme();                      // 初始化
  // body class 变化（ComfyUI 切主题时会 add/remove 主题 id class）
  try {
    _themeObserver = new MutationObserver(applyTheme);
    _themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  } catch (_) {}
  // 兜底轮询（设置变化不一定改 body class）
  setInterval(applyTheme, 2000);
}

// 设置面板中的只读主题状态显示
let _themeStatusEl = null;
function updateThemeStatusUI() {
  if (!_themeStatusEl) return;
  try {
    const comfyId = app.ui.settings.getSettingValue("Comfy.ColorPalette", "dark") || "dark";
    const isLight = _curTheme === "light";
    const label   = isLight ? t("浅色", "Light") : t("深色", "Dark");
    _themeStatusEl.innerHTML =
      `<span style="display:inline-flex;align-items:center;gap:6px;font-size:14px;">` +
      `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;` +
      `background:${isLight ? "#f5f5f5" : "#2a2a2a"};` +
      `border:1px solid ${isLight ? "#999" : "#555"};"></span>` +
      `${t("跟随 ComfyUI 主题：", "Follows ComfyUI theme: ")}` +
      `<b style="color:${isLight ? "#333" : "#ccc"}">${label}</b>` +
      ` <span style="color:var(--xpusys-text-faint);font-size:12px;">(${comfyId})</span>` +
      `</span>`;
  } catch (_) {}
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
                        "border:1px solid var(--xpusys-tooltip-border);border-radius:3px;color:inherit;" +
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
    sel.style.cssText = "background:var(--xpusys-capsule-bg);border:1px solid var(--xpusys-tooltip-border);" +
                        "border-radius:4px;color:inherit;padding:3px 8px;font-size:inherit;cursor:pointer;";
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

// GPU 选择下拉：列出后端可见的显卡，切换后调用 /xpusys/select
function makeGPUIndexType() {
  let deviceList = [];      // [{index, name}]
  let sel = null;
  async function refreshOptions(currentVal) {
    try {
      const r = await api.fetchApi("/xpusys/devices");
      if (r.ok) {
        const data = await r.json();
        deviceList = data.devices || [];
        if (deviceList.length === 0) deviceList = [{ index: 0, name: "GPU0" }];
        // 后端返回的当前选中优先于设置里存的值
        const cur = (data.selected != null) ? data.selected : (currentVal ?? 0);
        sel.innerHTML = "";
        deviceList.forEach(d => {
          const opt = document.createElement("option");
          opt.value = String(d.index);
          opt.textContent = `${t("GPU", "GPU")}${d.index} · ${d.name}`;
          if (String(d.index) === String(cur)) opt.selected = true;
          sel.appendChild(opt);
        });
      }
    } catch (_) {}
  }
  return (_name, setter, value) => {
    sel = document.createElement("select");
    sel.style.cssText = "background:var(--xpusys-capsule-bg);border:1px solid var(--xpusys-tooltip-border);" +
                        "border-radius:4px;color:inherit;padding:3px 8px;font-size:inherit;cursor:pointer;";
    refreshOptions(value);
    sel.addEventListener("change", async () => {
      const idx = Number(sel.value);
      setter(idx);
      try {
        const r = await api.fetchApi("/xpusys/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index: idx }),
        });
        if (r.ok) pollOnce();     // 立即刷新数据
      } catch (_) {}
    });
    return sel;
  };
}

// 火花监控排序/开关设置 UI：5 行（开关 + 拖拽排序），变更即时生效
function makeSparkSortType() {
  return (_name, setter, value) => {
    const wrap = document.createElement("div");
    wrap.className = "xpusys-spark-sort";

    const apply = (order) => {
      try { setter(JSON.stringify(order)); } catch (_) {}
      rebuildDockCharts(order);     // 立即重建窗口 box（含当前已打开状态）
    };

    const render = () => {
      wrap.innerHTML = "";
      const order = getSparkOrder();
      let dragIdx = -1;

      order.forEach((item, idx) => {
        const cfg = DOCK_CHARTS.find((c) => c.key === item.key);
        if (!cfg) return;

        const row = document.createElement("div");
        row.className = "xpusys-spark-row";
        row.draggable = true;
        row.dataset.key = item.key;

        const handle = document.createElement("span");
        handle.className = "xpusys-spark-drag";
        handle.textContent = "≡";

        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = item.on !== false;
        cb.addEventListener("change", () => {
          item.on = cb.checked;
          apply(order);
          render();               // 重绘保持视觉同步
        });
        const span = document.createElement("span");
        span.textContent = cfg.title();
        label.appendChild(cb);
        label.appendChild(span);

        row.appendChild(handle);
        row.appendChild(label);

        // HTML5 拖拽排序
        row.addEventListener("dragstart", (e) => {
          dragIdx = idx;
          row.classList.add("xpusys-spark-dragging");
          try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", item.key); } catch (_) {}
        });
        row.addEventListener("dragend", () => row.classList.remove("xpusys-spark-dragging"));
        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          if (dragIdx === idx) return;
          row.classList.add("xpusys-spark-over");
        });
        row.addEventListener("dragleave", () => row.classList.remove("xpusys-spark-over"));
        row.addEventListener("drop", (e) => {
          e.preventDefault();
          row.classList.remove("xpusys-spark-over");
          if (dragIdx < 0 || dragIdx === idx) { dragIdx = -1; return; }
          const [moved] = order.splice(dragIdx, 1);
          order.splice(idx, 0, moved);
          dragIdx = -1;
          apply(order);
          render();
        });

        wrap.appendChild(row);
      });
    };

    render();
    return wrap;
  };
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
    /* ══ 主题变量（深色为默认；浅色由 html[data-xpusys-theme=light] 覆盖）══ */
    :root {
      --xpusys-capsule-bg:      rgba(255,255,255,0.05);   /* 胶囊底 */
      --xpusys-capsule-border:  rgba(255,255,255,0.08);   /* 胶囊边框 */
      --xpusys-capsule-hover:   rgba(255,255,255,0.08);   /* 胶囊 hover */
      --xpusys-capsule-divider: rgba(255,255,255,0.10);   /* 胶囊内分隔线 */
      --xpusys-specs-bg:        rgba(54,207,201,0.10);    /* PRED 胶囊底 */
      --xpusys-specs-border:    rgba(54,207,201,0.22);    /* PRED 胶囊边框 */
      --xpusys-specs-hover:     rgba(54,207,201,0.18);    /* PRED hover */
      --xpusys-text:            #e8e8e8;                  /* 主文字 */
      --xpusys-text-dim:        #888;                     /* 次要文字 */
      --xpusys-text-faint:      #666;                     /* 更次要文字 */
      --xpusys-na:              #555;                     /* N/A / 不可用 */
      --xpusys-tooltip-bg:      rgba(18,18,24,0.97);      /* 浮层底 */
      --xpusys-tooltip-border:  rgba(255,255,255,0.15);   /* 浮层边框 */
      --xpusys-tooltip-text:    #ccc;                     /* 浮层文字 */
      --xpusys-tooltip-title:   #fff;                     /* 浮层标题 */
      --xpusys-tooltip-key:     #888;                     /* 浮层键名 */
      --xpusys-tooltip-val:     #e8e8e8;                  /* 浮层值 */
      --xpusys-tooltip-note:    #666;                     /* 浮层注脚 */
      --xpusys-ok:       #52c41a;   --xpusys-ok-dim:  #52c41a;
      --xpusys-warn:     #faad14;   --xpusys-warn-dim:#faad14;
      --xpusys-crit:     #ff4d4f;   --xpusys-crit-dim:#ff4d4f;
      --xpusys-cyan:     #36cfc9;   --xpusys-cyan-dim:#36cfc9;
      --xpusys-purple:   #b37feb;   --xpusys-purple-dim:#b37feb;
      --xpusys-blue:     #597ef7;   --xpusys-blue-dim:#597ef7;
      --xpusys-orange:   #ff7a00;
      --xpusys-lime:     #afff00;   /* PRED 安全标签 */
      --xpusys-shadow:   -2px -2px 5px rgba(255,255,255,0.03),
                         2px 2px 6px rgba(0,0,0,0.5);
      --xpusys-shadow-hover: -2px -2px 5px rgba(255,255,255,0.05),
                             2px 2px 6px rgba(0,0,0,0.6);
      --xpusys-shadow-tip: 0 4px 16px rgba(0,0,0,0.6);
      /* 监控面板时序图（Sparkline） */
      --xpusys-chart-bg:   #1c2128;   /* 深色轨道背景 */
      --xpusys-chart-line: #00e5ff;   /* 青蓝折线 */
    }
    html[data-xpusys-theme="light"] {
      --xpusys-capsule-bg:      rgba(0,0,0,0.04);
      --xpusys-capsule-border:  rgba(0,0,0,0.12);
      --xpusys-capsule-hover:   rgba(0,0,0,0.08);
      --xpusys-capsule-divider: rgba(0,0,0,0.12);
      --xpusys-specs-bg:        rgba(54,207,201,0.14);
      --xpusys-specs-border:    rgba(54,207,201,0.35);
      --xpusys-specs-hover:     rgba(54,207,201,0.25);
      --xpusys-text:            #333;
      --xpusys-text-dim:        #666;
      --xpusys-text-faint:      #888;
      --xpusys-na:              #999;
      --xpusys-tooltip-bg:      rgba(255,255,255,0.98);
      --xpusys-tooltip-border:  rgba(0,0,0,0.15);
      --xpusys-tooltip-text:    #444;
      --xpusys-tooltip-title:   #111;
      --xpusys-tooltip-key:     #777;
      --xpusys-tooltip-val:     #222;
      --xpusys-tooltip-note:    #999;
      --xpusys-ok:       #389e0d;   --xpusys-ok-dim:  #237804;
      --xpusys-warn:     #d48806;   --xpusys-warn-dim:#ad6800;
      --xpusys-crit:     #cf1322;   --xpusys-crit-dim:#a8071a;
      --xpusys-cyan:     #08979c;   --xpusys-cyan-dim:#006d75;
      --xpusys-purple:   #9254de;   --xpusys-purple-dim:#722ed1;
      --xpusys-blue:     #2f54eb;   --xpusys-blue-dim:#1d39c4;
      --xpusys-orange:   #d46b08;
      --xpusys-lime:     #7cb305;   /* PRED 安全标签（浅色加深保证可读） */
      --xpusys-chart-bg:   #eef1f5; /* 浅色轨道背景 */
      --xpusys-chart-line: #08979c; /* 浅色下折线加深 */
      --xpusys-shadow:   -2px -2px 5px rgba(255,255,255,0.6),
                         2px 2px 6px rgba(0,0,0,0.12);
      --xpusys-shadow-hover: -2px -2px 5px rgba(255,255,255,0.8),
                             2px 2px 6px rgba(0,0,0,0.18);
      --xpusys-shadow-tip: 0 4px 16px rgba(0,0,0,0.18);
    }
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
    .n-val   { display: inline-block; min-width: 5ch; text-align: right; }
    .n-bw    { display: inline-block; min-width: 6ch; text-align: right; }
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
      background: var(--xpusys-specs-bg);
      border: 1px solid var(--xpusys-specs-border);
      border-radius: 8px;
      padding: 10px 0.6em;
      margin: 0 2px;
      cursor: default;
      position: relative;
      transition: background 0.15s, box-shadow 0.15s;
      box-shadow: var(--xpusys-shadow);
    }
    .vram-predictor-section:hover {
      background: var(--xpusys-specs-hover);
      box-shadow: var(--xpusys-shadow-hover);
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
      background: var(--xpusys-capsule-bg);
      border: 1px solid var(--xpusys-capsule-border);
      border-radius: 8px;
      padding: 10px 0.6em;
      margin: 0 1.5px;
      cursor: default;
      position: relative;
      transition: background 0.15s, box-shadow 0.15s;
      box-shadow: var(--xpusys-shadow);
    }
    /* cpu: "CPU"(3) + n-pct(6) + "@"(1) + n-ghz(6) = 16ch */
    .cpu-section { min-width: 16ch; }
    /* ram: "RAM"(3) + n-pct(6) = 9ch */
    .ram-section { min-width: 9ch; }
    .cpu-section:hover, .ram-section:hover {
      background: var(--xpusys-capsule-hover);
      box-shadow: var(--xpusys-shadow-hover);
    }

    /* ── GPU 综合体强化 ── */
    .gpu-composite-group {
      display: flex;
      align-items: center;
      background: var(--xpusys-capsule-bg);
      border: 1px solid var(--xpusys-capsule-border);
      border-radius: 8px;
      padding: 0 4px;
      margin: 0 1.5px;
      gap: 0;
      box-shadow: var(--xpusys-shadow);
    }

    /* ── GPU 子项 ── */
    .gpu-engine, .gpu-vram, .gpu-rsv, .gpu-pwr, .gpu-specs {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px 0.6em;
      border-right: 1px solid var(--xpusys-capsule-divider);
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
    /* specs: "SPEC"(4)+"FP16"(4)+n-val(5)+n-bw(6)+"GB"(2) = 21ch */
    .gpu-specs  { min-width: 21ch; }
    .gpu-specs { border-right: none; }
    .gpu-engine:hover, .gpu-vram:hover, .gpu-rsv:hover, .gpu-pwr:hover, .gpu-specs:hover {
      background: var(--xpusys-capsule-hover);
      border-radius: 3px;
    }

    /* ── tools：独立胶囊（不并入 GPU 组），只放一个按钮，无浮层 ── */
    .xpusys-tools-section {
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--xpusys-capsule-bg);
      border: 1px solid var(--xpusys-capsule-border);
      border-radius: 8px;
      padding: 10px 0.6em;
      margin: 0 1.5px;
      cursor: pointer;
      position: relative;
      transition: background 0.15s, box-shadow 0.15s;
      box-shadow: var(--xpusys-shadow);
    }
    .xpusys-tools-section:hover {
      background: var(--xpusys-capsule-hover);
      box-shadow: var(--xpusys-shadow-hover);
    }
    .xpusys-tools-btn {
      background: transparent;
      border: 0;
      color: var(--xpusys-text-dim);
      font-size: var(--xpusys-fs, 18px);
      line-height: 1;
      padding: 0 2px;
      cursor: pointer;
    }
    .xpusys-tools-btn:hover { color: var(--xpusys-text); }

    /* ── 监视面板窗口（点击 tools 按钮打开，头部风格同 ADLX Monitor）── */
    .xpusys-dock {
      position: fixed;
      top: 52px;
      right: 12px;
      width: 360px;
      max-width: calc(100vw - 24px);
      background: var(--xpusys-tooltip-bg);
      border: 1px solid var(--xpusys-tooltip-border);
      border-radius: 14px;
      box-shadow: var(--xpusys-shadow-tip);
      color: var(--xpusys-tooltip-text);
      z-index: 9998;
      overflow: hidden;
      backdrop-filter: blur(12px);
    }
    .xpusys-dock[hidden] { display: none; }
    .xpusys-dock-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      background: linear-gradient(135deg,
                  color-mix(in srgb, var(--xpusys-cyan) 18%, transparent),
                  color-mix(in srgb, var(--xpusys-purple) 12%, transparent));
      border-bottom: 1px solid var(--xpusys-tooltip-border);
      cursor: move;
      user-select: none;
    }
    .xpusys-dock-titlewrap { min-width: 0; }
    .xpusys-dock-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--xpusys-tooltip-title);
    }
    .xpusys-dock-subtitle {
      margin-top: 4px;
      font-size: 12px;
      color: var(--xpusys-tooltip-note);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .xpusys-dock-close {
      border: 0;
      background: rgba(255, 255, 255, 0.08);
      color: #d8d8d8;
      width: 28px;
      height: 28px;
      border-radius: 999px;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      flex-shrink: 0;
    }
    .xpusys-dock-close:hover {
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
    }
    .xpusys-dock-body {
      min-height: 120px;
      padding: 12px 14px;
      font-size: 13px;
      line-height: 1.6;
      display: grid;
      gap: 10px;
    }
    /* ── 监控面板：时序图 box（图撑满整个 box，标题 overlay 左上角）── */
    .xpusys-dock-chart-box {
      position: relative;
      overflow: hidden;              /* 圆角裁剪 svg 直角 */
      background: var(--xpusys-chart-bg);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      height: 96px;
      padding: 0;
    }
    html[data-xpusys-theme="light"] .xpusys-dock-chart-box {
      border-color: rgba(0, 0, 0, 0.10);
    }
    /* 标题 overlay 在火花图左上角（chip 有独立背景，折线从下方穿过也可读） */
    .xpusys-dock-chart-title {
      position: absolute;
      top: 6px;
      left: 6px;
      z-index: 1;
      font-size: 13px;
      letter-spacing: 0.04em;
      color: var(--xpusys-text-dim);
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 5px;
      background: color-mix(in srgb, var(--xpusys-chart-bg) 60%, transparent);
      pointer-events: none;
      white-space: nowrap;
    }
    /* 多 box 配色：data-color 局部覆盖折线色（SVG 继承局部变量） */
    .xpusys-dock-chart-box[data-color="green"]  { --xpusys-chart-line: var(--xpusys-ok); }
    .xpusys-dock-chart-box[data-color="purple"] { --xpusys-chart-line: var(--xpusys-purple); }
    .xpusys-dock-chart-box[data-color="blue"]   { --xpusys-chart-line: var(--xpusys-blue); }
    .xpusys-dock-chart-box[data-color="orange"] { --xpusys-chart-line: var(--xpusys-orange); }
    /* 临界告警：对应指标达到临界阈值时，该 box 出现统一半透明红背景
       （::before 在背景之上、SVG/标题之下，不遮挡图与文字） */
    .xpusys-dock-chart-box.is-critical::before {
      content: "";
      position: absolute;
      inset: 0;
      background: rgba(255, 77, 79, 0.15);
      pointer-events: none;
    }
    .xpusys-dock-spark {
      width: 100%;
      height: 100%;
      display: block;
    }
    /* 面积渐变（顶部亮 → 底部融入背景）；fill 的 url(#id) 由 JS 按实例动态设置 */
    .xpusys-dock-spark .spark-stop-a { stop-color: var(--xpusys-chart-line); stop-opacity: 0.35; }
    .xpusys-dock-spark .spark-stop-b { stop-color: var(--xpusys-chart-line); stop-opacity: 0; }
    /* 微光层（模糊亮线，Glow）；filter 的 url(#id) 由 JS 按实例动态设置 */
    .xpusys-dock-spark .spark-glow {
      fill: none;
      stroke: var(--xpusys-chart-line);
      stroke-opacity: 0.55;
      stroke-width: 2.5;
      vector-effect: non-scaling-stroke;
    }
    /* 主折线（平滑，2px，无数据点） */
    .xpusys-dock-spark .spark-line {
      fill: none;
      stroke: var(--xpusys-chart-line);
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
    }
    /* ── 设置：火花监控排序与开关 ── */
    .xpusys-spark-sort { display: flex; flex-direction: column; gap: 6px; min-width: 260px; }
    .xpusys-spark-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border: 1px solid var(--xpusys-capsule-border);
      border-radius: 8px;
      background: var(--xpusys-capsule-bg);
      cursor: grab;
    }
    .xpusys-spark-row:hover { background: var(--xpusys-capsule-hover); }
    .xpusys-spark-row.dragging { opacity: 0.5; }
    .xpusys-spark-row.over { border-color: var(--xpusys-cyan); }
    .xpusys-spark-drag {
      color: var(--xpusys-text-faint);
      cursor: grab;
      user-select: none;
      font-size: 14px;
      line-height: 1;
    }
    .xpusys-spark-row label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 13px;
      color: var(--xpusys-text);
    }
    .xpusys-spark-row input[type="checkbox"] { cursor: pointer; }

    .xpusys-value    { font-weight: 600; letter-spacing: 0.02em; }
    .xpusys-ok       { color: var(--xpusys-ok); }
    .xpusys-warn     { color: var(--xpusys-warn); }
    .xpusys-critical { color: var(--xpusys-crit); }
    .xpusys-vram-ok  { color: var(--xpusys-text); }
    .xpusys-vram-warn{ color: var(--xpusys-orange); }
    .xpusys-vram-crit{ color: var(--xpusys-crit); }
    .xpusys-pwr-ok   { color: var(--xpusys-cyan); }
    .xpusys-pwr-warn { color: var(--xpusys-purple); }
    .xpusys-pwr-crit { color: var(--xpusys-crit); }
    .xpusys-specs-ok { color: var(--xpusys-blue); }
    .xpusys-na       { color: var(--xpusys-na); }

    .xpusys-lock {
      font-size: 10px; color: var(--xpusys-text-faint); cursor: pointer;
      border: 1px solid var(--xpusys-na); border-radius: 3px;
      padding: 0 3px; line-height: 14px; margin-left: 4px;
      transition: color 0.15s, border-color 0.15s;
    }
    .xpusys-lock:hover { color: var(--xpusys-text-dim); border-color: var(--xpusys-text-dim); }

    .xpusys-tooltip {
      position: fixed;
      background: var(--xpusys-tooltip-bg);
      border: 1px solid var(--xpusys-tooltip-border);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 14px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--xpusys-tooltip-text);
      line-height: 1.7;
      pointer-events: none;
      z-index: 99999;
      min-width: 190px;
      max-width: 320px;
      box-shadow: var(--xpusys-shadow-tip);
      /* pre-wrap: 保留来源多行的 \n 换行，同时允许超宽内容折行 */
      white-space: pre-wrap;
      word-break: break-word;
    }
    /* SPEC 规格浮层内容多，保持更宽 */
    .xpusys-tooltip-spec { min-width: 250px; }
    /* VRAM 浮层文案已精简，宽度回归默认；行内容放不下时自然折行而非省略号 */
    .xpusys-tooltip-vram .xpusys-tooltip-key {
      max-width: none; white-space: normal; text-overflow: clip;
    }
    .xpusys-tooltip-title {
      color: var(--xpusys-tooltip-title); font-weight: 700; font-size: 15px; margin-bottom: 4px;
      border-bottom: 1px solid var(--xpusys-tooltip-border); padding-bottom: 3px;
    }
    .xpusys-tooltip-row { display: flex; justify-content: space-between; gap: 16px; }
    .xpusys-tooltip-key {
      color: var(--xpusys-tooltip-key);
      /* 长内容（如预测胶囊的模型名）放不下时省略号缩略 */
      max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 子级条目缩进（显存缺口/压力等，配合 tipRow 第 4 参数） */
    .xpusys-tip-sub { padding-left: 1.4em; }
    .xpusys-tooltip-val { color: var(--xpusys-tooltip-val); font-weight: 600; }
    .xpusys-tooltip-note{ color: var(--xpusys-tooltip-note); font-size: 12px; margin-top: 4px; }
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

function tipRow(key, val, color, sub) {
  const kc = sub ? ' class="xpusys-tooltip-key xpusys-tip-sub"' : ' class="xpusys-tooltip-key"';
  const vc = color ? ` style="color:${color}"` : "";
  return `<div class="xpusys-tooltip-row">` +
         `<span${kc}>${key}</span>` +
         `<span class="xpusys-tooltip-val"${vc}>${val}</span>` +
         `</div>`;
}
function tipTitle(t) { return `<div class="xpusys-tooltip-title">${t}</div>`; }
function tipNote(t)  { return `<div class="xpusys-tooltip-note">${t}</div>`; }

// ---------------------------------------------------------------------------
// DOM — bar builder
// ---------------------------------------------------------------------------

let _sec = {};   // { predictor, cpu, ram, engine, vram, rsv, pwr, specs } each { el, valEl }

// ---------------------------------------------------------------------------
// GPU specs cache — loaded once from gpu_specs.json at init
// ---------------------------------------------------------------------------
let GPU_SPECS    = null;  // { "0x2684": { vendor, name, arch, specs }, ... }
let GPU_PENDING  = null;  // [{ vendor, name, arch, specs }, ...]
let GPU_FORMATS  = null;  // { "Ada Lovelace": "**=-*=", ... }

// Format display order: FP32 FP16 BF16 FP8 FP4 INT8 INT4
const FORMAT_KEYS  = ["fp32","fp16","bf16","fp8","fp4","int8","int4"];
const FORMAT_UNITS = ["TFLOPS","TFLOPS","TFLOPS","TFLOPS","TOPS","TOPS","TOPS"];

function initSpecs() {
  fetch("/xpusys/specs")
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => {
      GPU_SPECS   = data.cards   || {};
      GPU_PENDING = data.pending || [];
      GPU_FORMATS = data.formats || {};
      if (_snap) renderSpec(_snap);
    })
    .catch(() => { /* silent — no specs available */ });
}

function resolveSpec(snap) {
  // ① PCI ID 精确匹配（优先）
  const entries = GPU_SPECS?.[snap.pci_id];
  if (entries) {
    if (entries.length === 1) return entries[0];
    // Multiple entries for the same PCI ID → filter by name_match
    if (!snap.device_name) return entries[0];
    const dn = snap.device_name.toLowerCase();
    const sorted = [...entries].sort((a, b) => (b.name_match?.length || 0) - (a.name_match?.length || 0));
    for (const e of sorted) {
      if (e.name_match && dn.includes(e.name_match.toLowerCase())) return e;
    }
    return entries[0]; // fallback
  }
  // ② 名称兜底：整个 cards 表按 device_name 模糊匹配
  //    （某些驱动 device_name 无 [0x...] 后缀导致 pci_id 读不到，如部分 A770）
  const byName = matchSpecByName(snap);
  if (byName) return byName;
  // ③ 最后：pending 表（暂无 PCI ID 的卡）
  return matchPending(snap);
}

// 在整个 cards 表里按 device_name 子串匹配（不依赖 pci_id）
function matchSpecByName(snap) {
  if (!GPU_SPECS || !snap.device_name) return null;
  const dn = snap.device_name.toLowerCase();
  let best = null, bestLen = 0;
  for (const id of Object.keys(GPU_SPECS)) {
    const arr = GPU_SPECS[id];
    for (const e of arr) {
      const nm = e.name_match || e.name || "";
      const key = nm.toLowerCase();
      if (key && dn.includes(key)) {
        // 取最长匹配（更精确）
        if (key.length > bestLen) {
          bestLen = key.length;
          best = e;
        }
      }
    }
  }
  return best;
}

function matchPending(snap) {
  if (!GPU_PENDING || !snap.device_name) return null;
  const dn = snap.device_name.toLowerCase();
  for (const p of GPU_PENDING) {
    const nm = p.name.toLowerCase();
    const fragments = nm.replace(/[^a-z0-9\s]/g, "").split(/\s+/);
    if (dn.includes(nm)) return p;
    let hits = 0;
    for (const f of fragments) {
      if (f.length > 2 && dn.includes(f)) hits++;
    }
    if (hits >= Math.max(2, fragments.length - 1)) return p;
  }
  return null;
}

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
  _sec.specs  = makeSection("gpu-specs",  "SPC ---");

  gpuGroup.appendChild(_sec.engine.el);
  gpuGroup.appendChild(_sec.vram.el);
  gpuGroup.appendChild(_sec.rsv.el);
  gpuGroup.appendChild(_sec.pwr.el);
  gpuGroup.appendChild(_sec.specs.el);
  bar.appendChild(gpuGroup);

  // tools：独立胶囊（不并入 GPU 组）——点击胶囊任意位置打开监视面板窗口。
  // 注意：不在 showTip 的 builders 里注册，因此鼠标悬停不会出现浮层。
  const toolsEl  = document.createElement("div");
  toolsEl.className = "xpusys-tools-section";
  const toolsBtn = document.createElement("button");
  toolsBtn.type = "button";
  toolsBtn.className = "xpusys-tools-btn";
  toolsBtn.textContent = "☰";
  toolsEl.appendChild(toolsBtn);
  toolsEl.addEventListener("click", toggleDock);   // 整体点击触发（含 padding 区域）
  _sec.tools = { el: toolsEl, valEl: toolsBtn };
  bar.appendChild(toolsEl);

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
// 监视面板窗口（点击 tools 按钮打开；风格参考 ADLX Monitor 面板）
// 窗口内容后续按需求填充（时序曲线等），当前仅标题栏 + 关闭按钮 + 空 body
// ---------------------------------------------------------------------------

let _dock = null;

function buildDock() {
  if (_dock) return _dock;

  const dock = document.createElement("div");
  dock.className = "xpusys-dock";
  dock.hidden    = true;

  // Header: 标题 + 副标题（设备名）+ 关闭按钮（可拖动，ADLX 风格）
  const header = document.createElement("div");
  header.className = "xpusys-dock-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "xpusys-dock-titlewrap";

  const title = document.createElement("div");
  title.className   = "xpusys-dock-title";
  title.textContent = t("火花监控", "Spark Monitor");

  const subtitle = document.createElement("div");
  subtitle.className = "xpusys-dock-subtitle";
  // 显卡全名（无 id 后缀）+ 刷新间隔
  const dev0 = _snap ? resolveDeviceName(_snap.device_name || "") : "";
  const ms0  = Math.max(200, Number(getSetting(S.refreshMs, 1000)) || 1000);
  subtitle.textContent = dev0
    ? `${dev0} · ${t("刷新", "Refresh")} ${ms0}ms`
    : "";

  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);

  const close = document.createElement("button");
  close.type        = "button";
  close.className   = "xpusys-dock-close";
  close.textContent = "×";
  close.addEventListener("click", () => setDockOpen(false));

  header.appendChild(titleWrap);
  header.appendChild(close);

  // Body: 按用户配置（排序 + 开关）创建时序图 box
  const body = document.createElement("div");
  body.className = "xpusys-dock-body";
  buildDockCharts(body);

  dock.appendChild(header);
  dock.appendChild(body);
  document.body.appendChild(dock);

  dock._subtitle = subtitle;   // 供 renderSnap 实时更新设备名
  enableDockDrag(dock, header);
  _dock = dock;
  return dock;
}

// 按顺序（顺序 + 开关）创建 box 列表；order 缺省时读设置
function buildDockCharts(body, order) {
  _dockCharts.length = 0;
  const list = order || getSparkOrder();
  list.forEach((item, i) => {
    if (item.on === false) return;                  // 已关闭的监控不显示
    const cfg = DOCK_CHARTS.find((c) => c.key === item.key);
    if (!cfg) return;
    const box = document.createElement("div");
    box.className = "xpusys-dock-chart-box";
    box.dataset.color = cfg.color;

    const titleEl = document.createElement("div");
    titleEl.className = "xpusys-dock-chart-title";
    titleEl.textContent = cfg.title();

    const spark = makeDockSparkline(String(i));
    box.appendChild(titleEl);      // 标题 overlay 在火花图左上角
    box.appendChild(spark.svg);    // 火花图撑满整个 box

    body.appendChild(box);
    _dockCharts.push({ cfg, box, titleEl, spark, history: [] });
  });
}

// 设置中开关/排序变化后，立即重建窗口内的 box（保留窗口与标题栏）
function rebuildDockCharts(order) {
  if (!_dock) return;
  const body = _dock.querySelector(".xpusys-dock-body");
  if (!body) return;
  body.innerHTML = "";
  buildDockCharts(body, order);
  if (!_dock.hidden) {
    for (const c of _dockCharts) renderDockSparkline(c);
  }
}

// ---------------------------------------------------------------------------
// Sparkline：实时时序平滑折线图（SVG），支持多 box
//   · 无坐标轴 · 平滑曲线（Catmull-Rom → Bezier）· 2px 亮色线 · 渐变面积 + 微光
//   · 每 box 独立：配置（标题/配色/数据源）+ 历史缓冲 + SVG 实例
// ---------------------------------------------------------------------------

// 时序图配置：新增指标只需在此追加一项
// critical(s) 与胶囊颜色阈值一致——true 时对应 box 显示统一半透明红背景
const DOCK_CHARTS = [
  { key: "load",  color: "cyan",   title: () => t("GPU 负载", "GPU Load"),
    value: (s) => s.gpu_load_pct ?? 0,
    critical: (s) => (s.gpu_load_pct ?? 0) > 95 },
  { key: "vram",  color: "green",  title: () => t("显存占用", "VRAM Usage"),
    value: (s) => (s.vram_total_gb > 0 ? (s.vram_driver_used_gb / s.vram_total_gb) * 100 : 0),
    critical: (s) => s.vram_total_gb > 0 && (s.vram_driver_used_gb / s.vram_total_gb) > 0.95 },
  { key: "power", color: "purple", title: () => t("功耗", "Power"),
    value: (s) => (s.power_available && s.tgp_w > 0 ? (s.power_w / s.tgp_w) * 100 : -1),
    critical: (s) => s.power_available && s.tgp_w > 0 && (s.power_w / s.tgp_w) > 0.95 },
  { key: "cpu",   color: "blue",   title: () => t("CPU 占用", "CPU Usage"),
    value: (s) => s.cpu_pct ?? 0,
    critical: (s) => (s.cpu_pct ?? 0) > 80 },
  { key: "ram",   color: "orange", title: () => t("内存占用", "Memory Usage"),
    value: (s) => s.ram_pct ?? 0,
    critical: (s) => (s.ram_pct ?? 0) > 90 },
];

// 火花监控显示配置：默认全部开启，顺序即 DOCK_CHARTS 顺序
const SPARK_CHART_DEFAULTS = DOCK_CHARTS.map((c) => ({ key: c.key, on: true }));

// 读取用户配置（顺序 + 开关），校验 key 合法性并补齐缺失项
function getSparkOrder() {
  let raw;
  try { raw = getSetting(S.sparkCharts, ""); } catch (_) {}
  if (raw) {
    try {
      const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(arr) && arr.length) {
        const keys = DOCK_CHARTS.map((c) => c.key);
        const valid = arr.filter((x) => x && keys.includes(x.key));
        for (const c of DOCK_CHARTS) {
          if (!valid.some((x) => x.key === c.key)) valid.push({ key: c.key, on: true });
        }
        return valid;
      }
    } catch (_) {}
  }
  return SPARK_CHART_DEFAULTS.map((x) => ({ ...x }));
}

const _dockCharts = [];   // 实例列表：{ cfg, box, titleEl, spark, history }

function pushChartHistory(inst, snap) {
  const v = inst.cfg.value(snap);
  if (!Number.isFinite(v) || v < 0) return;   // 指标不可用（如功耗不支持）跳过
  // 采样节奏跟随设置的刷新间隔（与胶囊同 tick）；点数动态保持 ~60s 窗口
  const ms = Math.max(200, Number(getSetting(S.refreshMs, 1000)) || 1000);
  const limit = Math.max(15, Math.round(60000 / ms));
  inst.history.push(v);
  if (inst.history.length > limit)
    inst.history.splice(0, inst.history.length - limit);
}

// suffix 保证多个 sparkline 的 SVG id（gradient/filter）全局唯一
function makeDockSparkline(suffix) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 300 80");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "xpusys-dock-spark");

  const defs = document.createElementNS(NS, "defs");

  const grad = document.createElementNS(NS, "linearGradient");
  grad.id = `xpusys-spark-grad-${suffix}`;
  grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
  const gTop = document.createElementNS(NS, "stop");
  gTop.setAttribute("offset", "0%");
  gTop.setAttribute("class", "spark-stop-a");
  const gBot = document.createElementNS(NS, "stop");
  gBot.setAttribute("offset", "100%");
  gBot.setAttribute("class", "spark-stop-b");
  grad.appendChild(gTop);
  grad.appendChild(gBot);

  const glowF = document.createElementNS(NS, "filter");
  glowF.id = `xpusys-spark-glow-${suffix}`;
  glowF.setAttribute("x", "-20%"); glowF.setAttribute("y", "-20%");
  glowF.setAttribute("width", "140%"); glowF.setAttribute("height", "140%");
  const blur = document.createElementNS(NS, "feGaussianBlur");
  blur.setAttribute("stdDeviation", "2.5");
  glowF.appendChild(blur);

  defs.appendChild(grad);
  defs.appendChild(glowF);

  const area = document.createElementNS(NS, "path");
  area.setAttribute("class", "spark-area");
  area.setAttribute("fill", `url(#xpusys-spark-grad-${suffix})`);
  const glow = document.createElementNS(NS, "path");
  glow.setAttribute("class", "spark-glow");
  glow.setAttribute("filter", `url(#xpusys-spark-glow-${suffix})`);
  const line = document.createElementNS(NS, "path");
  line.setAttribute("class", "spark-line");

  svg.appendChild(defs);
  svg.appendChild(area);
  svg.appendChild(glow);
  svg.appendChild(line);
  return { svg, area, glow, line };
}

const SPARK_W = 300, SPARK_H = 80;
// 折线跑满全图：标题是带背景的 chip（z-index 盖在折线上层），
// 折线最高点穿过标题区域也保持可读，因此顶部不再避让。
const SPARK_TOP = 4, SPARK_BOT = 4;

function sparkPoints(values) {
  const n = values.length;
  if (n === 0) return [];
  return values.map((v, i) => {
    const x = n === 1 ? SPARK_W / 2 : (i / (n - 1)) * SPARK_W;
    const norm = Math.min(100, Math.max(0, v));
    const y = SPARK_H - SPARK_BOT - (norm / 100) * (SPARK_H - SPARK_TOP - SPARK_BOT);
    return { x, y };
  });
}

// Catmull-Rom 样条 → 三次贝塞尔，实现平滑曲线
function sparkSmoothPath(points) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function renderDockSparkline(inst) {
  if (!inst?.spark) return;
  const spark = inst.spark;
  const pts = sparkPoints(inst.history);
  if (pts.length === 0) {
    spark.area.setAttribute("d", "");
    spark.glow.setAttribute("d", "");
    spark.line.setAttribute("d", "");
    return;
  }
  const lineD = sparkSmoothPath(pts);
  spark.line.setAttribute("d", lineD);
  spark.glow.setAttribute("d", lineD);
  const last = pts[pts.length - 1];
  const first = pts[0];
  spark.area.setAttribute("d",
    lineD + ` L ${last.x.toFixed(2)} ${SPARK_H} L ${first.x.toFixed(2)} ${SPARK_H} Z`);
}

// ---------------------------------------------------------------------------
// 窗口定位：首次（无存档）左缘对齐 ☰ 胶囊下方智能弹出；
// 拖动后写入 localStorage，刷新/重开后恢复上次位置（对齐 ADLX 面板行为）
// ---------------------------------------------------------------------------

const DOCK_POS_KEY = "XPUSYS_Mon.DockPosition";

function applyDockPosition(dock, left, top, save) {
  const w = dock.offsetWidth  || 360;
  const h = dock.offsetHeight || 320;
  const maxL = Math.max(8, window.innerWidth  - w - 8);
  const maxT = Math.max(8, window.innerHeight - h - 8);
  const cl = Math.min(Math.max(8, left), maxL);
  const ct = Math.min(Math.max(8, top),  maxT);
  dock.style.left  = cl + "px";
  dock.style.top   = ct + "px";
  dock.style.right = "auto";
  dock._posRestored = true;
  if (save) {
    try { localStorage.setItem(DOCK_POS_KEY, JSON.stringify({ left: cl, top: ct })); } catch (_) {}
  }
}

function restoreDockPosition(dock) {
  try {
    const raw = localStorage.getItem(DOCK_POS_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.left !== "number" || typeof parsed?.top !== "number") return false;
    applyDockPosition(dock, parsed.left, parsed.top, false);
    return true;
  } catch (_) {}
  return false;
}

// 首次打开：左缘对齐 ☰ 胶囊；胶囊在下半屏 → 弹上方，否则弹下方（不写存档）
function anchorDockToCapsule(dock) {
  const btn = document.querySelector(".xpusys-tools-section");
  if (!btn) return;
  const aRect = btn.getBoundingClientRect();
  const w = dock.offsetWidth  || 360;
  const h = dock.offsetHeight || 320;
  let left = aRect.left;                                  // 左边缘对齐
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  const inBottomHalf = aRect.top > window.innerHeight / 2;
  let top;
  if (inBottomHalf) {
    top = Math.max(8, aRect.top - h - 8);                 // 弹上方
  } else {
    top = Math.min(aRect.bottom + 8, window.innerHeight - h - 8);  // 弹下方
  }
  applyDockPosition(dock, left, top, false);
}

function positionDock(dock) {
  if (dock._posRestored) return;        // 本次会话已定位过，保持
  if (restoreDockPosition(dock)) return; // localStorage 有存档 → 恢复
  anchorDockToCapsule(dock);             // 无存档 → 对齐胶囊
}

function setDockOpen(open) {
  const dock = buildDock();
  dock.hidden = !open;
  if (open) {
    requestAnimationFrame(() => {
      if (!_dock || _dock.hidden) return;
      positionDock(dock);
    });
  }
}

function toggleDock() {
  const dock = buildDock();
  setDockOpen(dock.hidden);
}

function enableDockDrag(dock, handle) {
  let dragState = null;

  const onMove = (event) => {
    if (!dragState) return;
    applyDockPosition(dock, event.clientX - dragState.ox, event.clientY - dragState.oy, true);  // 拖动即存档
  };
  const stopDrag = () => {
    if (!dragState) return;
    dragState = null;
    window.removeEventListener("pointermove",   onMove);
    window.removeEventListener("pointerup",     stopDrag);
    window.removeEventListener("pointercancel", stopDrag);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;   // 点关闭按钮不触发拖动
    const rect = dock.getBoundingClientRect();
    dragState = { ox: event.clientX - rect.left, oy: event.clientY - rect.top };
    handle.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove",   onMove);
    window.addEventListener("pointerup",     stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    event.preventDefault();
  });

  // 窗口尺寸变化时把位置 clamp 回视口内
  window.addEventListener("resize", () => {
    if (!_dock || _dock.hidden) return;
    const r = _dock.getBoundingClientRect();
    applyDockPosition(_dock, r.left, r.top, false);
  });
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
  renderSpec(snap);
  renderPredictor();   // re-render with latest vram_total_gb from snap
  applyVisibility();

  // 监视面板窗口标题栏：显卡全名（无 id）+ 刷新间隔，实时跟随
  if (_dock && !_dock.hidden && _dock._subtitle) {
    const dev = resolveDeviceName(snap.device_name || "");
    const ms  = Math.max(200, Number(getSetting(S.refreshMs, 1000)) || 1000);
    const txt = dev ? `${dev} · ${t("刷新", "Refresh")} ${ms}ms` : "";
    if (_dock._subtitle.textContent !== txt) _dock._subtitle.textContent = txt;
  }

  // 时序数据始终记录（节奏跟随设置的刷新间隔），窗口打开时渲染全部折线
  const titleSep = en() ? ": " : "：";
  for (const c of _dockCharts) {
    pushChartHistory(c, snap);
    c.box.classList.toggle("is-critical", !!c.cfg.critical(snap));   // 临界告警背景
    // 标题实时数值：如 "GPU 负载：45%"（功耗不可用时 N/A）
    const v = c.cfg.value(snap);
    const valTxt = v >= 0 ? Math.round(v) + "%" : "N/A";
    const titleTxt = c.cfg.title() + titleSep + valTxt;
    if (c.titleEl.textContent !== titleTxt) c.titleEl.textContent = titleTxt;
  }
  if (_dock && !_dock.hidden) {
    for (const c of _dockCharts) renderDockSparkline(c);
  }
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
    "xpusys-pwr-warn");
}

function renderPWR(snap) {
  const sec = _sec.pwr;
  if (!sec) return;

  const existing = sec.el.querySelector(".xpusys-lock");
  if (existing) existing.remove();

  if (!snap.power_available) {
    setVal("pwr", "PWR N/A", "xpusys-na");
    // "需要管理员权限"提示仅 Intel 适用——AMD(ADLX/amdsmi)/NVIDIA 的功耗读取
    // 不需要提权，不可用是驱动能力问题，因此非 Intel 不显示 🔒
    if (snap.gpu_vendor === "intel") {
      const lock = document.createElement("span");
      lock.className   = "xpusys-lock";
      lock.textContent = "🔒";
      lock.title       = en() ? "Click for details" : "点击了解详情";
      lock.addEventListener("click", e => {
        e.stopPropagation();
        const dev = shortDeviceName(snap.device_name);
        let title, msg;
        if (en()) {
          title = "⚡ XPUSYSMonitor — Power Notice\n\n";
          msg = snap.is_admin
            ? "No power domains found — please check your driver version."
            : `${dev} power data requires administrator privileges.\n\nRun ComfyUI as administrator to enable real-time power monitoring.`;
        } else {
          title = "⚡ XPUSYSMonitor — 功率说明\n\n";
          msg = snap.is_admin
            ? "未找到功率域 — 请检查驱动版本。"
            : `${dev} 功率数据需要管理员权限。\n\n以管理员身份运行 ComfyUI 即可启用实时功率监控。`;
        }
        alert(title + msg);
      });
      sec.el.appendChild(lock);
    }
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
    ? `Success Rate:<span style="color:${c}">${rate}%</span>`
      + ` | <span style="color:${c}">${risk}</span>`
      + ` | Model:<span style="color:${c}">${total.toFixed(2)}G</span>/${vEff}G`
    : `<span class="pred-zh">成功率:</span><span style="color:${c}">${rate}%</span>`
      + ` | <span class="pred-zh" style="color:${c}">${risk}</span>`
      + ` | <span class="pred-zh">模型:</span><span style="color:${c}">${total.toFixed(2)}G</span>/${vEff}G`;
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
    color = "var(--xpusys-ok)"; label = { zh: "轻松",   en: "Smooth"   };
  } else if (rate >= 80) {
    color = "var(--xpusys-lime)"; label = { zh: "安全",   en: "Safe"     };
  } else if (rate >= 40) {
    color = "var(--xpusys-warn)"; label = { zh: "预警",   en: "Warning"  };
  } else {
    color = "var(--xpusys-crit)"; label = { zh: "危险",   en: "Critical" };
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
  _sec.specs.el.style.display  = getSetting(S.showSpecs, true) ? "" : "none";
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
  // SPEC 规格浮层内容多保持更宽；VRAM 行内容长加宽且不缩略；其余收窄
  if (_tipEl) {
    let cls = "xpusys-tooltip";
    if (key === "specs") cls += " xpusys-tooltip-spec";
    else if (key === "vram") cls += " xpusys-tooltip-vram";
    _tipEl.className = cls;
  }
  const builders = { predictor: buildPredictorTip,
                     cpu: buildCPUTip, ram: buildRAMTip, engine: buildEngineTip,
                     vram: buildVRAMTip, rsv: buildRSVTip, pwr: buildPWRTip,
                     specs: buildSpecTip };
  const html = builders[key]?.(snap, en());
  if (html) showTooltip(el, html);
}

function buildCPUTip(snap, eng) {
  const pct  = snap.cpu_pct      ?? 0;
  const freq = snap.cpu_freq_ghz ?? 0;
  const c    = pct > 80 ? "var(--xpusys-crit)" : pct > 50 ? "var(--xpusys-warn)" : "var(--xpusys-ok)";
  // 型号只保留前面部分：去掉 " CPU @ 2.90GHz" 后缀（频率已有单独一行）
  const model = (snap.cpu_model || "").replace(/\s*CPU\s*@[\s\S]*$/i, "").trim();
  if (eng) {
    return tipTitle("🖥️ CPU")
      + tipRow("Utilisation", pct.toFixed(1) + " %", c)
      + (model         ? tipRow("Model",   model) : "")
      + (freq > 0      ? tipRow("Freq",    freq.toFixed(2) + " GHz") : "")
      + (snap.cpu_threads ? tipRow("Threads", String(snap.cpu_threads)) : "");
  }
  return tipTitle("🖥️ 处理器")
    + tipRow("占用率",  pct.toFixed(1) + " %", c)
    + (model         ? tipRow("型号",   model) : "")
    + (freq > 0      ? tipRow("频率",   freq.toFixed(2) + " GHz") : "")
    + (snap.cpu_threads ? tipRow("线程数", String(snap.cpu_threads)) : "");
}

function buildRAMTip(snap, eng) {
  const pct         = snap.ram_pct          ?? 0;
  const total       = snap.ram_total_gb     ?? 0;
  const used        = snap.ram_used_gb      ?? 0;
  const free        = snap.ram_free_gb      ?? 0;
  const commitUsed  = snap.commit_used_gb   ?? 0;
  const commitLimit = snap.commit_limit_gb  ?? 0;
  const c     = pct > 90 ? "var(--xpusys-crit)" : pct > 70 ? "var(--xpusys-warn)" : "var(--xpusys-ok)";
  const commitStr = commitLimit > 0
    ? `${commitUsed.toFixed(1)} / ${commitLimit.toFixed(1)} GB`
    : `${commitUsed.toFixed(1)} GB`;
  if (eng) {
    return tipTitle("💾 System RAM")
      + tipRow("Total",   total.toFixed(1) + " GB")
      + tipRow("Used",    used.toFixed(1)  + " GB", c)
      + tipRow("Free",    free.toFixed(1)  + " GB", "var(--xpusys-ok)")
      + (commitUsed > 0 ? tipRow("Commit", commitStr, "var(--xpusys-purple)") : "");
  }
  return tipTitle("💾 系统内存")
    + tipRow("总量",   total.toFixed(1) + " GB")
    + tipRow("已用",   used.toFixed(1)  + " GB", c)
    + tipRow("空闲",   free.toFixed(1)  + " GB", "var(--xpusys-ok)")
    + (commitUsed > 0 ? tipRow("虚拟内存", commitStr, "var(--xpusys-purple)") : "");
}

function buildEngineTip(snap, eng) {
  const load = snap.gpu_load_pct ?? 0;
  const freq = snap.gpu_freq_mhz ?? 0;
  const temp = snap.gpu_temp_c   ?? -1;
  const c    = load > 95 ? "var(--xpusys-crit)" : load > 80 ? "var(--xpusys-warn)" : "var(--xpusys-ok)";
  const tc   = temp > 85 ? "var(--xpusys-crit)" : temp > 70 ? "var(--xpusys-warn)" : "var(--xpusys-cyan)";
  if (eng) {
    return tipTitle("📊 GPU Engine")
      + tipRow("Load",  load.toFixed(1) + " %", c)
      + (freq > 0  ? tipRow("Clock", Math.round(freq) + " MHz") : "")
      + (temp >= 0 ? tipRow("Temp",  Math.round(temp) + " °C", tc) : "");
  }
  return tipTitle("📊 GPU 引擎")
    + tipRow("负载", load.toFixed(1) + " %", c)
    + (freq > 0  ? tipRow("频率", Math.round(freq) + " MHz") : "")
    + (temp >= 0 ? tipRow("温度", Math.round(temp) + " °C", tc) : "");
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
  const c      = pct > 0.95 ? "var(--xpusys-crit)" : pct > 0.85 ? "var(--xpusys-orange)" : "var(--xpusys-text)";
  // 统一用 GB（2位小数）显示，与 bar 上的 toFixed(1) 对齐，避免 MB÷1000 的心算误差
  const g2     = gb => gb.toFixed(2) + " GB";
  if (eng) {
    return tipTitle("🧠 VRAM Breakdown")
      + tipRow("Total",             g2(total))
      + tipRow("Current Used",      g2(used),   c)
      + tipRow("Display & Driver Usage",         g2(sysEnv), "var(--xpusys-text-dim)", true)
      + tipRow("Model Load & Compute Usage",     g2(alloc),  "var(--xpusys-cyan)",     true)
      + tipRow("PyTorch Pre-allocated",          g2(buf),    "var(--xpusys-purple)",   true)
      + tipRow("Free",              g2(free),   "var(--xpusys-ok)");
  }
  return tipTitle("🧠 显存详情")
    + tipRow("总量",       g2(total))
    + tipRow("当前占用",   g2(used),   c)
    + tipRow("显示与驱动占用",       g2(sysEnv), "var(--xpusys-text-dim)", true)
    + tipRow("模型加载运算占用",     g2(alloc),  "var(--xpusys-cyan)",     true)
    + tipRow("Pytorch预占用",        g2(buf),    "var(--xpusys-purple)",   true)
    + tipRow("空闲",       g2(free),   "var(--xpusys-ok)");
}

function buildRSVTip(snap, eng) {
  const rsv   = snap.vram_reserved_gb  ?? 0;
  const alloc = snap.vram_allocated_gb ?? 0;
  const buf   = Math.max(0, rsv - alloc);
  if (eng) {
    return tipTitle("💾 Reserved (PyTorch Cache)")
      + tipRow("Cache Pool",  (rsv   * 1024).toFixed(0) + " MB", "var(--xpusys-purple)")
      + tipRow("In Use",    (alloc * 1024).toFixed(0) + " MB", "var(--xpusys-cyan)",     true)
      + tipRow("Free Buf",  (buf   * 1024).toFixed(0) + " MB", "var(--xpusys-text-dim)", true);
  }
  return tipTitle("💾 PyTorch 缓存池")
    + tipRow("缓存总量",   (rsv   * 1024).toFixed(0) + " MB", "var(--xpusys-purple)")
    + tipRow("实际占用", (alloc * 1024).toFixed(0) + " MB", "var(--xpusys-cyan)",     true)
    + tipRow("空闲缓存", (buf   * 1024).toFixed(0) + " MB", "var(--xpusys-text-dim)", true);
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
  const c   = (tgp > 0 && pct > 0.95) ? "var(--xpusys-crit)"
            : (tgp > 0 && pct > 0.80) ? "var(--xpusys-purple)"
            : snap.power_w > 170       ? "var(--xpusys-crit)"
            : snap.power_w > 120       ? "var(--xpusys-purple)"
            : "var(--xpusys-cyan)";
  if (eng) {
    let html = tipTitle(`⚡ ${dev} Power`)
      + tipRow("Instant Power", snap.power_w.toFixed(1) + " W", c);
    if (tgp > 0) html += tipRow("TGP Limit",  tgp.toFixed(0) + " W", "var(--xpusys-text-faint)")
                       + tipRow("Load Ratio", (pct * 100).toFixed(0) + " %", c);
    return html;
  }
  let html = tipTitle(`⚡ ${dev} 实时功率`)
    + tipRow("瞬时功率", snap.power_w.toFixed(1) + " W", c);
  if (tgp > 0) html += tipRow("TGP 上限",  tgp.toFixed(0) + " W", "var(--xpusys-text-faint)")
                     + tipRow("负载比例", (pct * 100).toFixed(0) + " %", c);
  return html;
}

function fmtTflops(v) {
  if (v == null || v <= 0) return "---";
  return Math.round(v) + "";
}

function fmtBw(v) {
  if (v == null || v <= 0) return "---";
  if (v >= 1000) return (v / 1000).toFixed(1);
  return Math.round(v) + "";
}

function renderSpec(snap) {
  const spec = resolveSpec(snap);
  if (!spec) {
    setHTML("specs", "SPEC ---", "xpusys-na");
    return;
  }
  const s = spec.specs;
  let compute = s.fp16_tflops;
  if (!compute && s.fp8_tflops)  compute = s.fp8_tflops / 2;
  if (!compute && s.int8_tops)   compute = s.int8_tops / 2;
  if (!compute && s.fp32_tflops) compute = s.fp32_tflops * 2;
  const bw      = s.bw_gbs || 0;
  const cComp   = compute > 0 ? "xpusys-specs-ok" : "xpusys-na";
  const bwUnit  = bw >= 1000 ? "TB/s" : "GB/s";
  const html    = `SPEC FP16<span class="n-val">${fmtTflops(compute)}T</span> <span class="n-bw">${fmtBw(bw)}${bwUnit}</span>`;
  setHTML("specs", html, cComp);
}

function formatRow(label, val, unit, cls) {
  const prefix = label + " ";
  if (val == null) return tipRow(label, unit, "var(--xpusys-na)");
  const c = cls ? ` style="color:${cls}"` : "";
  return tipRow(label, `<span${c}>${val} ${unit}</span>`);
}

function buildSpecTip(snap, eng) {
  const spec = resolveSpec(snap);
  if (!spec) return null;
  const s     = spec.specs;
  const dev   = shortDeviceName(snap.device_name) || spec.name;
  const arch  = spec.arch || "";
  const fmts  = GPU_FORMATS ? GPU_FORMATS[arch] : null;

  // Estimate helpers for formats supported but without explicit blog data
  function _est(fmt) {
    if (fmt === "fp16" || fmt === "bf16") {
      if (s.fp16_tflops) return { v: s.fp16_tflops, official: true };
      if (s.fp8_tflops)  return { v: s.fp8_tflops / 2,  est: true };
      if (s.int8_tops)   return { v: s.int8_tops / 2,  est: true };
      if (s.fp32_tflops) return { v: s.fp32_tflops * 2, est: true };
    }
    if (fmt === "fp8") {
      if (s.fp8_tflops)  return { v: s.fp8_tflops, official: true };
      if (s.int8_tops)   return { v: s.int8_tops / 2,  est: true };
      if (s.fp16_tflops) return { v: s.fp16_tflops * 2,  est: true };
    }
    if (fmt === "int8") {
      if (s.int8_tops)   return { v: s.int8_tops, official: true };
      if (s.fp8_tflops)  return { v: s.fp8_tflops * 2,  est: true };
      if (s.fp16_tflops) return { v: s.fp16_tflops * 2,  est: true };
      if (s.fp32_tflops) return { v: s.fp32_tflops * 2,  est: true };
    }
    if (fmt === "int4") {
      if (s.int4_tops)   return { v: s.int4_tops, official: true };
      if (s.int8_tops)   return { v: s.int8_tops * 2,    est: true };
      if (s.fp8_tflops)  return { v: s.fp8_tflops * 4,  est: true };
    }
    return null;
  }

  function _fmt(n) {
    if (n == null || n <= 0) return "—";
    if (n >= 1000) return (n / 1000).toFixed(2) + "K";
    return n.toFixed(1);
  }

  const title  = eng ? "📋 GPU Specs && AI Performance" : "📋 GPU规格 && AI性能";
  const lblMdl = eng ? "Model" : "型号";
  const lblArc = eng ? "Architecture" : "架构";
  const lblVR  = eng ? "VRAM" : "显存";
  const lblBW  = eng ? "Bandwidth" : "带宽";
  const lblTGP = "TGP";

  let html = tipTitle(title)
    + tipRow(lblMdl, spec.name)
    + (s.tgp_w   ? tipRow(lblTGP, s.tgp_w + " W") : "")
    + (arch      ? tipRow(lblArc, arch) : "")
    + (s.vram_gb ? tipRow(lblVR,  s.vram_gb + " GB") : "")
    + (s.bw_gbs  ? tipRow(lblBW,  s.bw_gbs + " GB/s") : "");

  // ── AI format support rows ──
  if (fmts) {
    html += `<div style="border-top:1px solid rgba(255,255,255,0.08);margin:4px 0"></div>`;
    for (let i = 0; i < FORMAT_KEYS.length; i++) {
      const key  = FORMAT_KEYS[i];
      const unit = FORMAT_UNITS[i];
      const disp = FORMAT_KEYS[i].toUpperCase();
      const symb = fmts[i];

      // FP32: always from blog spec
      if (key === "fp32") {
        if (s.fp32_tflops) html += tipRow("FP32", _fmt(s.fp32_tflops) + " TFLOPS" + (eng ? " (Official)" : " (官方)"));
        else html += tipRow("FP32", "—", "var(--xpusys-na)");
        continue;
      }

      if (symb === "-") {
        html += tipRow(disp, "不支持", "var(--xpusys-na)");
        continue;
      }
      if (symb === "?") {
        html += tipRow(disp, "未知", "var(--xpusys-text-faint)");
        continue;
      }

      const est = _est(key);
      if (est) {
        const suffix = eng
          ? (est.official ? " (Official)" : est.est ? " (Est.)" : "")
          : (est.official ? " (官方)" : est.est ? " (推测)" : "");
        const valStr = _fmt(est.v);
        const hl = key === "fp16" ? "var(--xpusys-blue)" : null;
        html += tipRow(disp, valStr + " " + unit + suffix, hl);
      } else if (symb === "*" || symb === "+" || symb === "=") {
        html += tipRow(disp, eng ? "Supported" : "支持", "var(--xpusys-text-faint)");
      }
    }
  }

  return html + tipNote(eng ? "Source: Blackwood's Blogs" : "数据来源：Blackwood's Blog");
}

function buildPredictorTip(snap, eng) {
  const total = _predModels.reduce((s, m) => s + (m.size || 0), 0);
  const mPeak = _predModels.length > 0 ? Math.max(..._predModels.map(m => m.size || 0)) : 0;
  const pred  = calcPrediction(total, mPeak, snap);

  // ── 标题 ──
  let html = tipTitle(eng ? "🎯 Current Load List" : "🎯 当前加载清单");

  // ── 成功率输入参数（先结论后细节：成功率置顶 → 约束明细 → 计算参数沉底）──
  const vendorName = pred.gpuVendor === "nvidia" ? "NVIDIA UVM" : "Intel Arc";
  const overflowTol = pred.gamma.toFixed(1) + "x";
  const divider = `<div style="border-top:1px solid var(--xpusys-tooltip-border);margin:4px 0"></div>`;
  if (eng) {
    // ① 结论
    html += tipRow("Success Rate",       pred.rate + " %",               pred.color);
    html += divider;
    // ② 硬约束（单模型能否装入）
    html += tipRow("Peak Model",         mPeak.toFixed(2)      + " GB", pred.dPeak > 0 ? "var(--xpusys-crit)" : "var(--xpusys-ok)");
    html += tipRow("VRAM Gap",           pred.dPeak.toFixed(2) + " GB", pred.dPeak > 0 ? "var(--xpusys-warn)" : "var(--xpusys-na)", true);
    html += tipRow("P_peak",             (pred.pPeak * 100).toFixed(0) + " %", pred.dPeak > 0 ? "var(--xpusys-warn)" : "var(--xpusys-ok)", true);
    // ③ 软约束（总量能否周转）
    html += tipRow("Total Models",       total.toFixed(2)      + " GB", pred.color);
    html += tipRow("Load Gap",           pred.dLoad.toFixed(2) + " GB", pred.dLoad > 0 ? "var(--xpusys-warn)" : "var(--xpusys-na)", true);
    html += tipRow("P_load",             (pred.pLoad * 100).toFixed(0) + " %", pred.dLoad > 0 ? "var(--xpusys-warn)" : "var(--xpusys-ok)", true);
    // ④ 可用资源
    html += tipRow("Avail. RAM",         pred.cRam.toFixed(2)  + " GB", "var(--xpusys-purple)");
    html += tipRow("Avail. Commit",      pred.sVirt.toFixed(2) + " GB", "var(--xpusys-text-dim)");
    html += divider;
    // ⑤ 计算参数（技术细节沉底）
    html += tipRow("Eff. VRAM Cap",      pred.vEff.toFixed(2)  + " GB", "var(--xpusys-cyan)");
    html += tipRow("Overflow Tolerance", overflowTol + " (" + vendorName + ")", "var(--xpusys-cyan)");
  } else {
    // ① 结论
    html += tipRow("预测成功率",         pred.rate + " %",               pred.color);
    html += divider;
    // ② 硬约束（单模型能否装入）
    html += tipRow("峰值模型",           mPeak.toFixed(2)      + " GB", pred.dPeak > 0 ? "var(--xpusys-crit)" : "var(--xpusys-ok)");
    html += tipRow("显存缺口",           pred.dPeak.toFixed(2) + " GB", pred.dPeak > 0 ? "var(--xpusys-warn)" : "var(--xpusys-na)", true);
    html += tipRow("显存压力",           (pred.pPeak * 100).toFixed(0) + " %", pred.dPeak > 0 ? "var(--xpusys-warn)" : "var(--xpusys-ok)", true);
    // ③ 软约束（总量能否周转）
    html += tipRow("模型总量",           total.toFixed(2)      + " GB", pred.color);
    html += tipRow("负载缺口",           pred.dLoad.toFixed(2) + " GB", pred.dLoad > 0 ? "var(--xpusys-warn)" : "var(--xpusys-na)", true);
    html += tipRow("负载压力",           (pred.pLoad * 100).toFixed(0) + " %", pred.dLoad > 0 ? "var(--xpusys-warn)" : "var(--xpusys-ok)", true);
    // ④ 可用资源
    html += tipRow("可用内存",           pred.cRam.toFixed(2)  + " GB", "var(--xpusys-purple)");
    html += tipRow("可用虚拟内存",       pred.sVirt.toFixed(2) + " GB", "var(--xpusys-text-dim)");
    html += divider;
    // ⑤ 计算参数（技术细节沉底）
    html += tipRow("显存上限",           pred.vEff.toFixed(2)  + " GB", "var(--xpusys-cyan)");
    html += tipRow("溢出容忍",           overflowTol + " (" + vendorName + ")", "var(--xpusys-cyan)");
  }

  // ── 分隔线 + 模型列表 ──
  html += `<div style="border-top:1px solid var(--xpusys-tooltip-border);margin:5px 0"></div>`;
  const sorted = [..._predModels].sort((a, b) => b.size - a.size);
  if (sorted.length === 0) {
    html += `<div class="xpusys-tooltip-note">${eng ? "No active models detected." : "无活跃模型"}</div>`;
  } else {
    for (const m of sorted) {
      const short = m.name.split(/[\\/]/).pop();
      // 固定字数缩略：超过 24 字符截断并加省略号（配合 CSS ellipsis 双保险）
      const display = short.length > 24 ? short.slice(0, 24) + "…" : short;
      html += tipRow(display, m.size.toFixed(2) + " GB", "var(--xpusys-ok)");
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
        // value 可能包含子文件夹路径，如 "子文件夹/model.safetensors"
        // 分离路径和文件名：path 用于查找，name 用于显示
        const lastSlash = value.lastIndexOf("/");
        const lastBackslash = value.lastIndexOf("\\");
        const sepIndex = Math.max(lastSlash, lastBackslash);
        const modelPath = value;  // 完整相对路径，用于后端查找
        const modelName = sepIndex >= 0 ? value.substring(sepIndex + 1) : value;  // 纯文件名，用于显示

        uniqueModels.set(value, { path: modelPath, name: modelName });
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
          "line-height:1.7;color:var(--xpusys-tooltip-text);font-size:15px;padding:4px 0 2px;max-width:520px;";
        const zhText =
          `本插件源于对 Intel Arc (XPU) 生态的支持。虽由「少数派」发起，但遵循底层标准，现已实现对 Intel (XPU) 与 NVIDIA (CUDA) 的完美兼容（AMD 支持已在计划中）。<br><br>` +
          `<span style="color:var(--xpusys-cyan);font-weight:600;">核心亮点：</span>` +
          `独家支持模型运行显存预测，在生成前预判硬件压力；提供精准的跨平台硬件监测。填补工具空白，追求极致稳定。希望你喜欢。`;
        const enText =
          `Born from the Intel Arc (XPU) ecosystem. While built by the "minority," this plugin follows standard specs for seamless Intel (XPU) and NVIDIA (CUDA) support (AMD in progress).<br><br>` +
          `<span style="color:var(--xpusys-cyan);font-weight:600;">Highlight:</span> ` +
          `Exclusive Model VRAM Prediction to anticipate hardware strain before generation. We aim to fill the gap in XPU monitoring with stable, cross-platform insights. Enjoy!`;
        wrap.innerHTML = en() ? enText : zhText;

        // ── 版本号 + GitHub 按钮 ──────────────────────────────────────────
        const bar = document.createElement("div");
        bar.style.cssText =
          "display:flex;align-items:center;justify-content:flex-end;gap:8px;" +
          "margin-top:16px;flex-wrap:wrap;border-top:1px solid var(--xpusys-capsule-divider);padding-top:10px;";

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
      id: `${NS}.ThemeStatus`,
      name: t("插件色彩主题", "Plugin Colour Theme"),
      tooltip: t("插件配色自动跟随 ComfyUI 当前色彩主题（仅显示，不可手动调整）",
                 "Plugin colours automatically follow ComfyUI's active colour palette (read-only, not adjustable)"),
      type: (_name, _setter, _value) => {
        const wrap = document.createElement("div");
        _themeStatusEl = wrap;
        updateThemeStatusUI();
        return wrap;
      },
      defaultValue: "",
      category: [NS, t("\uE001通用设置", "\uE001General"), t("\uE004主题", "\uE004Theme")],
    });

    app.ui.settings.addSetting({
      id: S.lang, name: t("界面语言", "Interface Language"),
      tooltip: t("切换悬浮窗与状态栏的显示语言", "Switch display language for overlay and status bar"),
      type: makeLangSelectType(), defaultValue: "system",
      category: [NS, t("\uE001通用设置", "\uE001General"), t("\uE003语言", "\uE003Language")],
      // reload 逻辑在 makeLangSelectType 的用户 change 事件里（初始化不触发，
      // 避免 onChange 在设置恢复时触发导致无限 reload 卡在 logo）
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
    app.ui.settings.addSetting({
      id: S.showSpecs, name: t("显示 GPU 规格（SPC）", "Show GPU Specs (SPC)"),
      tooltip: t("在状态栏显示 GPU 理论算力与带宽规格", "Show theoretical GPU compute and bandwidth specs in the status bar"),
      type: "boolean", defaultValue: true,
      category: [NS, t("\uE005显卡监控", "\uE005GPU Monitor"), t("\uE005GPU规格", "\uE005GPU Specs")],
      onChange: applyVisibility,
    });
    app.ui.settings.addSetting({
      id: S.gpuIndex, name: t("监视显卡", "Monitored GPU"),
      tooltip: t("选择要监视的显卡（多卡环境）。默认跟随 ComfyUI 日志中选中的主显卡（Device: xpu:N）；手工切换后会被记住，下次启动保持",
                 "Choose which GPU to monitor (multi-GPU). Defaults to ComfyUI's primary device shown in the log (Device: xpu:N); manual choice is remembered across restarts"),
      type: makeGPUIndexType(), defaultValue: -1,
      category: [NS, t("\uE005显卡监控", "\uE005GPU Monitor"), t("\uE006监视显卡", "\uE006Monitored GPU")],
    });

    app.ui.settings.addSetting({
      id: S.sparkCharts,
      name: t("火花监控排序与显示", "Spark Charts Order & Visibility"),
      tooltip: t("开关各监控图，按住 ≡ 上下拖拽调整顺序（即时生效）",
                 "Toggle charts on/off and drag ≡ to reorder (applies instantly)"),
      type: makeSparkSortType(),
      defaultValue: JSON.stringify(SPARK_CHART_DEFAULTS),
      category: [NS, t("\uE005火花监控", "\uE005Spark Monitor"), t("\uE006排序与显示", "\uE006Order & Visibility")],
    });

    // 启动时应用已保存的显卡选择：
    //   -1（默认）→ 跟随 ComfyUI 主设备，后端已自动对齐，无需调用
    //   ≥0（手工选过）→ 恢复用户选择
    (async () => {
      try {
        const saved = Number(getSetting(S.gpuIndex, -1));
        if (saved >= 0) {
          const r = await api.fetchApi("/xpusys/select", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ index: saved }),
          });
          if (r.ok) pollOnce();
        }
      } catch (_) {}
    })();

    const bar = buildBar();
    mountBar(bar);
    applyVisibility();
    applyFontSize();
    setTimeout(applyFontSize, 0);

    startThemeWatcher();             // 跟随 ComfyUI 色彩主题（自动切换深浅配色）

    api.addEventListener("message", onWsMessage);
    startPolling();
    initSpecs();

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

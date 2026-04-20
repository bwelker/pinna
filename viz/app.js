// ============================================================
// Pinna -- live DOA + transcript visualization
// ============================================================

// ---- Config ------------------------------------------------
// Available sounds (filenames under viz/assets/sounds/<Name>.wav).
const SOUND_OPTIONS = ["Glass", "Hero", "Submarine", "Sosumi", "Ping"];
const DEFAULT_SOUND = "Glass";

// Default keyword set, seeded into localStorage on first run.
const DEFAULT_KEYWORDS = [
  { text: "pete",      sound: "Glass" },
  { text: "emergency", sound: "Hero"  },
  { text: "hotdog",    sound: "Submarine" },
];

// In-memory keyword list. Each entry: { text: string, sound: string }.
// text is stored lowercase; matching is case-insensitive via toLowerCase().
let KEYWORDS = [];

// Reference coordinates on the floor plan image (pixels, native image space).
// The floor plan is 529 x 528 px.
// Mic sits between the two leftmost chairs, at the left end of the table.
// Teams dock sits at the center of the table.
const IMAGE_NATIVE_W = 529;
const IMAGE_NATIVE_H = 528;
const MIC_POS_PX = { x: 195, y: 264 };
const TEAMS_POS_PX = { x: 290, y: 264 };

// WebSocket endpoint
const WS_URL = `ws://${window.location.hostname || "localhost"}:8765`;

// Speaker palette (stable by speaker_id: 1..5 cycle)
const SPEAKER_COLORS = [
  null,  // index 0 unused (speaker IDs start at 1)
  "#4a9eff",  // Speaker 1 -- blue
  "#ff9f43",  // Speaker 2 -- orange
  "#4ade80",  // Speaker 3 -- green
  "#a78bfa",  // Speaker 4 -- purple
  "#ff6b6b",  // Speaker 5 -- red
];

// Beam metadata. Order matches the XVF3800 AEC_AZIMUTH_VALUES slot order:
// beam1, beam2, free, auto. Color/label/desc are purely display.
const BEAMS = [
  { key: "beam1", label: "Beam 1 (locked)", desc: "holds on tracked voices",          color: "#4a9eff" },
  { key: "beam2", label: "Beam 2 (locked)", desc: "holds on tracked voices",          color: "#4ecdc4" },
  { key: "free",  label: "Free (scan)",     desc: "continuously searches for new sound", color: "#ffe66d" },
  { key: "auto",  label: "Auto (primary)",  desc: "currently loudest speaker",        color: "#a78bfa" },
];
const AUTO_IDX = 3;

// Dead-zone: real readings almost never sit exactly at 0 deg. When a beam
// returns a value within this band while the room is not silent, it's the
// "unused slot returns 0 rad" firmware quirk, so we hide it.
const DEAD_ZONE_DEG = 3.0;

// localStorage keys
const LS_KEY_SENSITIVITY = "pinna:rms_threshold";
const LS_KEY_VAD_THRESHOLD = "pinna:vad_threshold";
const LS_KEY_BEAM_ENABLED = "pinna:beams_enabled";   // {beam1:bool,...}
const LS_KEY_HEADING_OFFSET = "pinna:heading_offset_deg";
const LS_KEY_HANDEDNESS = "pinna:handedness";        // +1 or -1
const LS_KEY_KEYWORDS_V2 = "pinna:keywords_v2";      // [{text, sound}, ...]
const LS_KEY_KEYWORDS_V1 = "pinna:keywords";         // legacy string array
const LS_KEY_ACTIVE_TAB = "pinna:active_tab";        // "controls" | "transcript"

// ---- State -------------------------------------------------
let ws = null;
let connState = "connecting";

let latestAngles = [0, 0, 0, 0];
let smoothAngles = [0, 0, 0, 0];
let strongestIdx = AUTO_IDX;

let reconnectTimer = null;

// Sensitivity slider state
let rmsThreshold = 120;
let vadThreshold = 0.25;
let latestRms = 0;
// Rolling window of recent RMS samples -- used to fade the beams when the
// room has been quiet for a stretch.
const RMS_HISTORY_LEN = 8;
let rmsHistory = [];
let beamOpacityFactor = 1;  // 1 = full, fades toward 0.15 when below threshold

// Per-beam enable toggles (default all on)
let beamEnabled = { beam1: true, beam2: true, free: true, auto: true };

// Client-side mic heading offset (degrees). Rotates all rendered beams so
// the mic's reference direction lands where the user intends in the room
// frame. Calibrated by the user via the Calibrate button; purely a viz concern.
let headingOffsetDeg = 0;

// Client-side handedness. +1 = mic's azimuth rotates the same direction as
// the room frame (both CCW-positive). -1 = mic reports the mirror image
// (e.g. firmware is CW-positive). Captured by the two-point calibration.
let handedness = 1;

// Calibration flow state. Two-point click+clap: user clicks a floor-plan
// spot, then claps at that spot; we capture two such pairs and solve for
// (offset, handedness).
let calibrating = false;              // true while any phase is active
let calibrationStep = 0;              // 1 or 2 = current sampling step
let calibrationSampling = false;      // true while actively buffering mic samples
let calibrationSamples = [];
let calibrationTimers = [];
let calibrationPicks = [];            // [{worldThetaRad, svgX, svgY, micThetaDeg}]

// ---- DOM refs ----------------------------------------------
const connDot = document.getElementById("conn-dot");
const connLabel = document.getElementById("conn-label");
const keywordListEl = document.getElementById("keyword-list");
const keywordInputEl = document.getElementById("keyword-input");
const keywordAddBtn = document.getElementById("keyword-add-btn");
const transcriptEl = document.getElementById("transcript");
const transcriptWrap = document.getElementById("transcript-container");
const beamReadoutEl = document.getElementById("beam-readout");
const legendEl = document.getElementById("speaker-legend");
const legendTranscriptEl = document.getElementById("speaker-legend-transcript");
const floorplanEl = document.getElementById("floorplan");
const overlaySvg = document.getElementById("overlay");
const keywordAudioEl = document.getElementById("keyword-audio");
const sensitivitySlider = document.getElementById("sensitivity-slider");
const vadSlider = document.getElementById("vad-slider");
const vadReadoutEl = document.getElementById("vad-threshold-readout");
const rmsLiveEl = document.getElementById("rms-live");
const rmsThresholdEl = document.getElementById("rms-threshold");
const beamsListEl = document.getElementById("beams-list");
const calibrateBtn = document.getElementById("calibrate-btn");
const calibrateResetEl = document.getElementById("calibrate-reset");
const calibrateOffsetEl = document.getElementById("calibrate-offset");
const calibrateOffsetInput = document.getElementById("calibrate-offset-input");
const calibrateMirrorEl = document.getElementById("calibrate-mirror");
const calibrateOverlay = document.getElementById("calibrate-overlay");
const calibrateBody = document.getElementById("calibrate-body");
const calibrateCount = document.getElementById("calibrate-count");
const calibrateHint = document.getElementById("calibrate-hint");
const calibrateCancel = document.getElementById("calibrate-cancel");
const canvasWrap = document.getElementById("canvas-wrap");

// ---- Sensitivity slider ------------------------------------
function initSensitivity() {
  // Load persisted threshold
  const stored = localStorage.getItem(LS_KEY_SENSITIVITY);
  if (stored != null && !Number.isNaN(Number(stored))) {
    rmsThreshold = Number(stored);
  }
  sensitivitySlider.value = String(rmsThreshold);
  rmsThresholdEl.textContent = String(Math.round(rmsThreshold));

  let debounceTimer = null;
  sensitivitySlider.addEventListener("input", () => {
    rmsThreshold = Number(sensitivitySlider.value);
    rmsThresholdEl.textContent = String(Math.round(rmsThreshold));
    try { localStorage.setItem(LS_KEY_SENSITIVITY, String(rmsThreshold)); } catch {}
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      sendConfig({ rms_threshold: rmsThreshold });
    }, 100);
  });
}

function initVadSlider() {
  const stored = localStorage.getItem(LS_KEY_VAD_THRESHOLD);
  if (stored != null && !Number.isNaN(Number(stored))) {
    vadThreshold = Number(stored);
  }
  vadSlider.value = String(vadThreshold);
  vadReadoutEl.textContent = vadThreshold.toFixed(2);

  let debounceTimer = null;
  vadSlider.addEventListener("input", () => {
    vadThreshold = Number(vadSlider.value);
    vadReadoutEl.textContent = vadThreshold.toFixed(2);
    try { localStorage.setItem(LS_KEY_VAD_THRESHOLD, String(vadThreshold)); } catch {}
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      sendConfig({ vad_threshold: vadThreshold });
    }, 100);
  });
}

function sendConfig(patch) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "config", ...patch }));
  } catch (err) {
    console.warn("config send failed", err);
  }
}

function updateRmsReadout() {
  rmsLiveEl.textContent = String(Math.round(latestRms));
  if (latestRms >= rmsThreshold) {
    rmsLiveEl.classList.add("hot");
    rmsLiveEl.classList.remove("cold");
  } else {
    rmsLiveEl.classList.add("cold");
    rmsLiveEl.classList.remove("hot");
  }
}

function recentlyAboveThreshold() {
  if (rmsHistory.length === 0) return false;
  for (const r of rmsHistory) if (r >= rmsThreshold) return true;
  return false;
}

// ---- Beam toggle persistence -------------------------------
function loadBeamEnabled() {
  try {
    const raw = localStorage.getItem(LS_KEY_BEAM_ENABLED);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const b of BEAMS) {
      if (typeof parsed[b.key] === "boolean") beamEnabled[b.key] = parsed[b.key];
    }
  } catch {}
}

function saveBeamEnabled() {
  try { localStorage.setItem(LS_KEY_BEAM_ENABLED, JSON.stringify(beamEnabled)); } catch {}
}

function loadHeadingOffset() {
  const raw = localStorage.getItem(LS_KEY_HEADING_OFFSET);
  if (raw != null && !Number.isNaN(Number(raw))) {
    headingOffsetDeg = Number(raw);
  }
  const rawH = localStorage.getItem(LS_KEY_HANDEDNESS);
  if (rawH === "-1" || rawH === "1") {
    handedness = Number(rawH);
  }
  renderOffsetReadout();
}

function saveHeadingOffset() {
  try { localStorage.setItem(LS_KEY_HEADING_OFFSET, String(headingOffsetDeg)); } catch {}
  try { localStorage.setItem(LS_KEY_HANDEDNESS, String(handedness)); } catch {}
  renderOffsetReadout();
}

function renderOffsetReadout() {
  // Normalize to [-180, 180] for the compact status readout.
  let d = ((headingOffsetDeg + 180) % 360 + 360) % 360 - 180;
  const mark = handedness === -1 ? " (mirrored)" : "";
  calibrateOffsetEl.innerHTML = `${d.toFixed(0)}&deg;${mark}`;

  // Sync the manual controls too. The numeric input uses [0, 359] range,
  // so normalize positively for display. Only update the input's value if
  // the user isn't mid-edit (document.activeElement check) to avoid
  // clobbering their typing.
  if (calibrateOffsetInput && document.activeElement !== calibrateOffsetInput) {
    const pos = Math.round(((headingOffsetDeg % 360) + 360) % 360);
    calibrateOffsetInput.value = String(pos);
  }
  if (calibrateMirrorEl) {
    calibrateMirrorEl.checked = (handedness === -1);
  }
}

// Wire the manual Offset input and Mirror checkbox. The input debounces at
// ~100ms so dragging the number spinner doesn't thrash localStorage; the
// checkbox applies immediately.
function initManualCalibrateControls() {
  if (calibrateOffsetInput) {
    let debounceTimer = null;
    const applyFromInput = () => {
      const raw = Number(calibrateOffsetInput.value);
      if (!Number.isFinite(raw)) return;
      // Clamp into [0, 359]; leave the displayed string alone while the
      // user is actively typing so we don't fight their cursor.
      const clamped = ((Math.round(raw) % 360) + 360) % 360;
      headingOffsetDeg = clamped;
      saveHeadingOffset();
    };
    calibrateOffsetInput.addEventListener("input", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applyFromInput, 100);
    });
    // On blur, normalize the visible string so "-30" becomes "330" etc.
    calibrateOffsetInput.addEventListener("blur", () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      applyFromInput();
      const pos = Math.round(((headingOffsetDeg % 360) + 360) % 360);
      calibrateOffsetInput.value = String(pos);
    });
  }

  if (calibrateMirrorEl) {
    calibrateMirrorEl.addEventListener("change", () => {
      handedness = calibrateMirrorEl.checked ? -1 : 1;
      saveHeadingOffset();
    });
  }
}

// ---- Keyword persistence + UI ------------------------------
function loadKeywords() {
  // Preferred: v2 object-array format.
  try {
    const raw = localStorage.getItem(LS_KEY_KEYWORDS_V2);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        KEYWORDS = parsed
          .filter((k) => k && typeof k.text === "string" && k.text.trim())
          .map((k) => ({
            text: k.text.trim().toLowerCase(),
            sound: SOUND_OPTIONS.includes(k.sound) ? k.sound : DEFAULT_SOUND,
          }));
        KEYWORDS = dedupeKeywords(KEYWORDS);
        return;
      }
    }
  } catch {}

  // Legacy migration: v1 was a plain string array under "pinna:keywords".
  try {
    const rawV1 = localStorage.getItem(LS_KEY_KEYWORDS_V1);
    if (rawV1) {
      const parsed = JSON.parse(rawV1);
      if (Array.isArray(parsed)) {
        KEYWORDS = dedupeKeywords(
          parsed
            .filter((s) => typeof s === "string" && s.trim())
            .map((s) => ({ text: s.trim().toLowerCase(), sound: DEFAULT_SOUND }))
        );
        saveKeywords();
        // Drop the legacy key so we don't keep re-migrating.
        try { localStorage.removeItem(LS_KEY_KEYWORDS_V1); } catch {}
        return;
      }
    }
  } catch {}

  // Fresh install: seed defaults.
  KEYWORDS = DEFAULT_KEYWORDS.map((k) => ({ ...k }));
  saveKeywords();
}

function saveKeywords() {
  try {
    localStorage.setItem(LS_KEY_KEYWORDS_V2, JSON.stringify(KEYWORDS));
  } catch {}
}

function dedupeKeywords(list) {
  const seen = new Set();
  const out = [];
  for (const k of list) {
    const key = k.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: key, sound: k.sound });
  }
  return out;
}

function addKeyword(rawText) {
  const text = (rawText || "").trim().toLowerCase();
  if (!text) return false;
  if (KEYWORDS.some((k) => k.text === text)) return false;  // silent dedupe
  KEYWORDS.push({ text, sound: DEFAULT_SOUND });
  saveKeywords();
  renderKeywordChips();
  return true;
}

function removeKeyword(text) {
  const before = KEYWORDS.length;
  KEYWORDS = KEYWORDS.filter((k) => k.text !== text);
  if (KEYWORDS.length !== before) {
    saveKeywords();
    renderKeywordChips();
  }
}

function setKeywordSound(text, sound) {
  const kw = KEYWORDS.find((k) => k.text === text);
  if (!kw) return;
  if (!SOUND_OPTIONS.includes(sound)) return;
  kw.sound = sound;
  saveKeywords();
}

// ---- Init UI chrome ----------------------------------------
function renderKeywordChips() {
  keywordListEl.innerHTML = "";
  for (const kw of KEYWORDS) {
    const row = document.createElement("div");
    row.className = "keyword-row";
    row.dataset.text = kw.text;

    const label = document.createElement("span");
    label.className = "keyword-row-text";
    label.textContent = kw.text;
    row.appendChild(label);

    const sel = document.createElement("select");
    sel.className = "keyword-sound-select";
    sel.title = "Alert sound";
    for (const s of SOUND_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      if (s === kw.sound) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      setKeywordSound(kw.text, sel.value);
    });
    row.appendChild(sel);

    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "keyword-preview-btn";
    preview.title = "Preview sound";
    preview.textContent = "\u25B6";   // black right-pointing triangle
    preview.addEventListener("click", () => {
      playSound(sel.value);
    });
    row.appendChild(preview);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "keyword-delete-btn";
    del.title = "Remove keyword";
    del.textContent = "\u00D7";       // multiplication sign
    del.addEventListener("click", () => {
      removeKeyword(kw.text);
    });
    row.appendChild(del);

    keywordListEl.appendChild(row);
  }
}

function initKeywordInput() {
  const submit = () => {
    const val = keywordInputEl.value;
    if (addKeyword(val)) {
      keywordInputEl.value = "";
    } else {
      // duplicate or empty -- just clear so user sees the no-op
      keywordInputEl.value = "";
    }
    keywordInputEl.focus();
  };
  keywordAddBtn.addEventListener("click", submit);
  keywordInputEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      submit();
    }
  });
}

function renderBeamReadout() {
  beamReadoutEl.innerHTML = "";
  for (let i = 0; i < BEAMS.length; i++) {
    const b = BEAMS[i];
    const el = document.createElement("div");
    el.id = `beam-readout-${i}`;
    el.className = "beam-val" + (i === strongestIdx ? " primary" : "");
    el.innerHTML = `
      <span class="beam-swatch" style="background:${b.color}"></span>
      ${b.label.replace(/\s*\(.*$/, "")}: <span id="beam-angle-${i}">${latestAngles[i].toFixed(0)}&deg;</span>
    `;
    beamReadoutEl.appendChild(el);
  }
}

function renderBeamsPanel() {
  beamsListEl.innerHTML = "";
  for (let i = 0; i < BEAMS.length; i++) {
    const b = BEAMS[i];
    const row = document.createElement("label");
    row.className = "beam-row" + (beamEnabled[b.key] ? "" : " disabled");
    row.id = `beam-row-${i}`;
    row.innerHTML = `
      <input type="checkbox" data-beam-idx="${i}" ${beamEnabled[b.key] ? "checked" : ""}>
      <span class="beam-row-dot" style="background:${b.color}"></span>
      <span class="beam-row-text">
        <span class="beam-row-label">${b.label}</span>
        <span class="beam-row-desc">${b.desc}</span>
      </span>
      <span class="beam-row-angle" id="beam-row-angle-${i}">--</span>
    `;
    beamsListEl.appendChild(row);
  }
  beamsListEl.addEventListener("change", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement)) return;
    const idx = Number(t.dataset.beamIdx);
    if (!Number.isInteger(idx)) return;
    const key = BEAMS[idx].key;
    beamEnabled[key] = t.checked;
    saveBeamEnabled();
    applyBeamToggleUI(idx);
  });
}

function applyBeamToggleUI(i) {
  const key = BEAMS[i].key;
  const row = document.getElementById(`beam-row-${i}`);
  if (row) row.classList.toggle("disabled", !beamEnabled[key]);
  const readout = document.getElementById(`beam-readout-${i}`);
  if (readout) readout.classList.toggle("hidden", !beamEnabled[key]);
}

function applyAllBeamToggleUI() {
  for (let i = 0; i < BEAMS.length; i++) applyBeamToggleUI(i);
}

const seenSpeakers = new Set();
function ensureSpeakerInLegend(speakerId) {
  if (seenSpeakers.has(speakerId)) return;
  seenSpeakers.add(speakerId);
  const color = SPEAKER_COLORS[speakerId] || "#888";
  const html = `<span class="legend-swatch" style="background:${color}"></span>Speaker ${speakerId}`;
  for (const host of [legendEl, legendTranscriptEl]) {
    if (!host) continue;
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = html;
    host.appendChild(item);
  }
}

function speakerColor(id) {
  return SPEAKER_COLORS[id] || "#888";
}

// ---- Connection status -------------------------------------
function setConnState(state) {
  connState = state;
  connDot.className = "dot " + state;
  if (state === "connected") connLabel.textContent = "connected";
  else if (state === "connecting") connLabel.textContent = "connecting...";
  else if (state === "disconnected") connLabel.textContent = "disconnected -- retrying";
}

// ---- WebSocket ---------------------------------------------
function connect() {
  setConnState("connecting");
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error("WS construct failed:", err);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    setConnState("connected");
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (localStorage.getItem(LS_KEY_SENSITIVITY) != null) {
      sendConfig({ rms_threshold: rmsThreshold });
    }
    if (localStorage.getItem(LS_KEY_VAD_THRESHOLD) != null) {
      sendConfig({ vad_threshold: vadThreshold });
    }
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleEvent(msg);
  });

  ws.addEventListener("close", () => {
    setConnState("disconnected");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // close will follow
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1500);
}

// ---- Event handling ----------------------------------------
function handleEvent(msg) {
  if (msg.type === "doa") {
    // Prefer the named `beams` dict if the server emitted it; fall back to
    // the raw `angles_deg` array for backward compatibility.
    if (msg.beams && typeof msg.beams === "object") {
      latestAngles = BEAMS.map((b) => {
        const v = msg.beams[b.key];
        return typeof v === "number" ? v : 0;
      });
    } else {
      latestAngles = (msg.angles_deg || [0, 0, 0, 0]).slice(0, 4);
      while (latestAngles.length < 4) latestAngles.push(0);
    }
    // Auto beam is the firmware's primary. Stop second-guessing it.
    strongestIdx = AUTO_IDX;
    if (typeof msg.rms === "number") {
      latestRms = msg.rms;
      rmsHistory.push(msg.rms);
      if (rmsHistory.length > RMS_HISTORY_LEN) rmsHistory.shift();
      updateRmsReadout();
    }
    updateBeamReadout();

    if (calibrating) collectCalibrationSample(latestAngles[AUTO_IDX]);
  } else if (msg.type === "transcript") {
    addUtterance(msg);
  } else if (msg.type === "hello") {
    if (localStorage.getItem(LS_KEY_SENSITIVITY) == null
        && typeof msg.rms_threshold === "number") {
      rmsThreshold = msg.rms_threshold;
      sensitivitySlider.value = String(rmsThreshold);
      rmsThresholdEl.textContent = String(Math.round(rmsThreshold));
    } else if (typeof msg.rms_threshold === "number"
               && Number(sensitivitySlider.value) !== rmsThreshold) {
      sendConfig({ rms_threshold: rmsThreshold });
    }
    if (localStorage.getItem(LS_KEY_VAD_THRESHOLD) == null
        && typeof msg.vad_threshold === "number") {
      vadThreshold = msg.vad_threshold;
      vadSlider.value = String(vadThreshold);
      vadReadoutEl.textContent = vadThreshold.toFixed(2);
    } else if (typeof msg.vad_threshold === "number"
               && localStorage.getItem(LS_KEY_VAD_THRESHOLD) != null) {
      sendConfig({ vad_threshold: vadThreshold });
    }
  } else if (msg.type === "config") {
    // Broadcast echo -- nothing to do for now.
  }
}

function updateBeamReadout() {
  for (let i = 0; i < BEAMS.length; i++) {
    const el = document.getElementById(`beam-angle-${i}`);
    if (el) el.innerHTML = `${latestAngles[i].toFixed(0)}&deg;`;
    const rowAngle = document.getElementById(`beam-row-angle-${i}`);
    if (rowAngle) rowAngle.innerHTML = `${latestAngles[i].toFixed(0)}&deg;`;
  }
  const items = beamReadoutEl.querySelectorAll(".beam-val");
  items.forEach((el, i) => el.classList.toggle("primary", i === strongestIdx));
}

// ---- Transcript + keyword alerts --------------------------
function addUtterance(evt) {
  const { text, speaker_id, angle_deg } = evt;
  ensureSpeakerInLegend(speaker_id);

  const { html, hasHit, firstHitKeyword } = highlightKeywords(text);

  const isQuiet = !recentlyAboveThreshold() && !hasHit;

  const el = document.createElement("div");
  el.className = "utterance" + (hasHit ? " alert" : "") + (isQuiet ? " quiet" : "");
  el.style.borderLeftColor = hasHit ? "var(--alert)" : speakerColor(speaker_id);

  // Transcript angle is already the auto beam; display with the calibration
  // transform applied so it matches the floor plan.
  const displayedAngle = (angle_deg != null)
    ? Math.round(normalizeDeg(handedness * angle_deg + headingOffsetDeg))
    : null;
  const angleStr = (displayedAngle != null) ? ` at ${displayedAngle}&deg;` : "";
  el.innerHTML = `
    <div class="utterance-header">
      <span class="utterance-speaker" style="color:${speakerColor(speaker_id)}">Speaker ${speaker_id}</span>
      <span>${angleStr}</span>
    </div>
    <div class="utterance-text">${html}</div>
  `;

  transcriptEl.appendChild(el);
  transcriptWrap.scrollTop = transcriptWrap.scrollHeight;

  if (hasHit && firstHitKeyword) {
    playSound(firstHitKeyword.sound || DEFAULT_SOUND);
  }
}

function highlightKeywords(text) {
  if (!text) return { html: "", hasHit: false, firstHitKeyword: null };
  const safe = escapeHtml(text);
  let hasHit = false;
  let firstHitKeyword = null;
  let out = safe;
  // Substring, case-insensitive. Supports multi-word keywords like "code red".
  for (const kw of KEYWORDS) {
    const re = new RegExp(`(${escapeRegex(kw.text)})`, "gi");
    if (re.test(out)) {
      if (!firstHitKeyword) firstHitKeyword = kw;
      hasHit = true;
      out = out.replace(re, '<span class="kw-hit">$1</span>');
    }
  }
  return { html: out, hasHit, firstHitKeyword };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function playSound(name) {
  const safe = SOUND_OPTIONS.includes(name) ? name : DEFAULT_SOUND;
  const url = `assets/sounds/${safe}.wav`;
  try {
    // Swap the src so the browser loads the right clip, then play from start.
    if (keywordAudioEl.getAttribute("src") !== url) {
      keywordAudioEl.setAttribute("src", url);
    }
    keywordAudioEl.currentTime = 0;
    const p = keywordAudioEl.play();
    if (p && p.catch) p.catch(() => { beep(); });
  } catch {
    beep();
  }
}

let audioCtx = null;
function beep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.15;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.18);
  } catch {}
}

// Unlock audio on first user interaction (Chrome autoplay policy)
function primeAudio() {
  try {
    keywordAudioEl.setAttribute("src", `assets/sounds/${DEFAULT_SOUND}.wav`);
    keywordAudioEl.play().then(() => {
      keywordAudioEl.pause();
      keywordAudioEl.currentTime = 0;
    }).catch(() => {});
  } catch {}
  window.removeEventListener("click", primeAudio);
  window.removeEventListener("keydown", primeAudio);
}
window.addEventListener("click", primeAudio);
window.addEventListener("keydown", primeAudio);

// ---- Floor plan overlay rendering --------------------------
function layoutOverlay() {
  const wrap = document.getElementById("canvas-wrap");
  const wrapRect = wrap.getBoundingClientRect();
  const imgRect = floorplanEl.getBoundingClientRect();
  overlaySvg.style.position = "absolute";
  overlaySvg.style.left = (imgRect.left - wrapRect.left) + "px";
  overlaySvg.style.top = (imgRect.top - wrapRect.top) + "px";
  overlaySvg.style.width = imgRect.width + "px";
  overlaySvg.style.height = imgRect.height + "px";
  overlaySvg.setAttribute("viewBox", `0 0 ${IMAGE_NATIVE_W} ${IMAGE_NATIVE_H}`);
  overlaySvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
}

window.addEventListener("resize", layoutOverlay);
floorplanEl.addEventListener("load", layoutOverlay);
setTimeout(layoutOverlay, 50);

function buildStaticOverlay() {
  // Teams dock rect + label
  const dockW = 42, dockH = 16;
  const dock = document.createElementNS("http://www.w3.org/2000/svg", "g");
  dock.setAttribute("id", "teams-dock");

  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", TEAMS_POS_PX.x - dockW / 2);
  rect.setAttribute("y", TEAMS_POS_PX.y - dockH / 2);
  rect.setAttribute("width", dockW);
  rect.setAttribute("height", dockH);
  rect.setAttribute("rx", 3);
  rect.setAttribute("fill", "#4a9eff");
  rect.setAttribute("fill-opacity", "0.25");
  rect.setAttribute("stroke", "#4a9eff");
  rect.setAttribute("stroke-width", "1.2");
  dock.appendChild(rect);

  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", TEAMS_POS_PX.x);
  label.setAttribute("y", TEAMS_POS_PX.y - dockH / 2 - 4);
  label.setAttribute("fill", "#4a9eff");
  label.setAttribute("font-size", "9");
  label.setAttribute("font-family", "-apple-system, sans-serif");
  label.setAttribute("text-anchor", "middle");
  label.textContent = "Teams dock";
  dock.appendChild(label);

  overlaySvg.appendChild(dock);
}

function buildBeamGroup() {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("id", "beam-group");

  for (let i = 0; i < BEAMS.length; i++) {
    const cone = document.createElementNS("http://www.w3.org/2000/svg", "path");
    cone.setAttribute("id", `beam-cone-${i}`);
    cone.setAttribute("fill", BEAMS[i].color);
    cone.setAttribute("fill-opacity", "0.1");
    cone.setAttribute("stroke", "none");
    g.appendChild(cone);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("id", `beam-line-${i}`);
    line.setAttribute("stroke", BEAMS[i].color);
    line.setAttribute("stroke-width", "1");
    line.setAttribute("stroke-opacity", "0.35");
    line.setAttribute("stroke-linecap", "round");
    g.appendChild(line);
  }

  const micDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  micDot.setAttribute("id", "mic-dot");
  micDot.setAttribute("cx", MIC_POS_PX.x);
  micDot.setAttribute("cy", MIC_POS_PX.y);
  micDot.setAttribute("r", 5);
  micDot.setAttribute("fill", "#fff");
  micDot.setAttribute("stroke", "#4a9eff");
  micDot.setAttribute("stroke-width", "2");
  g.appendChild(micDot);

  overlaySvg.appendChild(g);
}

function normalizeDeg(a) {
  let d = ((a % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

function isNearDeadZone(angleDeg) {
  // Within DEAD_ZONE_DEG of 0 deg (raw mic frame, before offset).
  const d = Math.abs(normalizeDeg(angleDeg));
  return d <= DEAD_ZONE_DEG;
}

function hideBeam(i) {
  const cone = document.getElementById(`beam-cone-${i}`);
  const line = document.getElementById(`beam-line-${i}`);
  if (cone) cone.setAttribute("fill-opacity", "0");
  if (line) line.setAttribute("stroke-opacity", "0");
}

function updateBeam(i, angleDeg, isPrimary) {
  const cone = document.getElementById(`beam-cone-${i}`);
  const line = document.getElementById(`beam-line-${i}`);
  if (!cone || !line) return;

  // Map the mic's azimuth into the room frame:
  //   renderedDeg = handedness * rawDeg + headingOffsetDeg
  // where handedness = -1 reflects the mirror case (CW-positive firmware).
  // The rendered angle is then drawn using the canonical math convention:
  //   x = cx + r*cos(a); y = cy - r*sin(a)   (SVG y grows downward, so
  // the minus on sin gives us CCW-positive rotation: 0 = east, 90 = north,
  // 180 = west, 270 = south).
  const renderedDeg = handedness * angleDeg + headingOffsetDeg;
  const rad = renderedDeg * Math.PI / 180;

  const beamLen = 360;
  const halfCone = isPrimary ? 14 : 8;
  const halfRad = halfCone * Math.PI / 180;

  const cx = MIC_POS_PX.x;
  const cy = MIC_POS_PX.y;

  // Arc sweep direction: since we draw with y-flip, a CCW-in-math sweep
  // becomes a CW sweep on screen; use sweep-flag 0 so the arc hugs the
  // outside of the cone triangle regardless of which edge is "first".
  const x1 = cx + Math.cos(rad - halfRad) * beamLen;
  const y1 = cy - Math.sin(rad - halfRad) * beamLen;
  const x2 = cx + Math.cos(rad + halfRad) * beamLen;
  const y2 = cy - Math.sin(rad + halfRad) * beamLen;

  cone.setAttribute("d", `M ${cx} ${cy} L ${x1} ${y1} A ${beamLen} ${beamLen} 0 0 0 ${x2} ${y2} Z`);
  const baseConeOp = isPrimary ? 0.22 : 0.06;
  cone.setAttribute("fill-opacity", baseConeOp * beamOpacityFactor);

  const ex = cx + Math.cos(rad) * beamLen;
  const ey = cy - Math.sin(rad) * beamLen;
  line.setAttribute("x1", cx);
  line.setAttribute("y1", cy);
  line.setAttribute("x2", ex);
  line.setAttribute("y2", ey);
  const baseStrokeOp = isPrimary ? 0.9 : 0.25;
  line.setAttribute("stroke-opacity", baseStrokeOp * beamOpacityFactor);
  line.setAttribute("stroke-width", isPrimary ? 2.5 : 1);
}

// Animation loop -- smoothly interpolate toward latest angles
function animate() {
  const target = recentlyAboveThreshold() ? 1.0 : 0.15;
  beamOpacityFactor += (target - beamOpacityFactor) * 0.08;

  for (let i = 0; i < BEAMS.length; i++) {
    let diff = latestAngles[i] - smoothAngles[i];
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    smoothAngles[i] += diff * 0.18;

    const key = BEAMS[i].key;
    const disabled = !beamEnabled[key];
    // Hide the "0-rad null slot" when the room is not silent -- those
    // readings are firmware artifacts, not real sources.
    const nullSlot = isNearDeadZone(latestAngles[i]) && recentlyAboveThreshold();
    if (disabled || nullSlot) {
      hideBeam(i);
      continue;
    }
    updateBeam(i, smoothAngles[i], i === strongestIdx);
  }
  requestAnimationFrame(animate);
}

// ---- Calibration -------------------------------------------
// Two-point click+clap flow:
//   1. User clicks a spot on the floor plan -> we compute the world-frame
//      angle from the mic origin to that spot.
//   2. User claps from that spot -> we capture the mic's reported `auto`
//      angle over ~2 seconds and take the circular mean.
// Repeat for a second spot at a different angle. The pair solves for both
// rotation offset and handedness (mic may be CCW- or CW-positive).
const CALIBRATION_SAMPLE_MS = 2000;

function openCalibrateOverlay() {
  calibrateOverlay.classList.remove("hidden");
  calibrateOverlay.setAttribute("aria-hidden", "false");
}

function closeCalibrateOverlay() {
  calibrateOverlay.classList.add("hidden");
  calibrateOverlay.classList.remove("picking");
  calibrateOverlay.setAttribute("aria-hidden", "true");
}

function clearCalibrationTimers() {
  for (const t of calibrationTimers) clearTimeout(t);
  calibrationTimers = [];
}

function clearCalibrationDots() {
  const existing = overlaySvg.querySelectorAll(".calibration-dot");
  existing.forEach((el) => el.remove());
}

function cancelCalibration() {
  calibrating = false;
  calibrationSampling = false;
  calibrationStep = 0;
  calibrationSamples = [];
  calibrationPicks = [];
  clearCalibrationTimers();
  clearCalibrationDots();
  canvasWrap.classList.remove("calibrating");
  closeCalibrateOverlay();
  calibrateBtn.disabled = false;
}

function startCalibration() {
  if (calibrating) return;
  calibrating = true;
  calibrationSampling = false;
  calibrationStep = 1;
  calibrationSamples = [];
  calibrationPicks = [];
  clearCalibrationTimers();
  clearCalibrationDots();
  calibrateBtn.disabled = true;
  openCalibrateOverlay();
  promptForClick();
}

function promptForClick() {
  calibrateBody.textContent =
    `Calibration step ${calibrationStep}/2: Click the floor plan where you'll make a noise, then clap.`;
  calibrateCount.textContent = "";
  if (calibrateHint) calibrateHint.textContent = "Press Esc to abort.";
  calibrateOverlay.classList.add("picking");
  canvasWrap.classList.add("calibrating");
}

// Convert an SVG overlay click to (worldThetaRad, svgX, svgY).
// Use the mic origin as the reference. SVG y is inverted (grows down), so
// the math-convention atan2 uses (cy_svg - click_y, click_x - cx_svg).
function worldAngleFromSvgPoint(svgX, svgY) {
  const dx = svgX - MIC_POS_PX.x;
  const dy = MIC_POS_PX.y - svgY;
  return Math.atan2(dy, dx);
}

function handleOverlayClick(ev) {
  if (!calibrating || calibrationSampling) return;
  // Translate the pointer event into the SVG's native viewBox coordinates.
  const rect = overlaySvg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const localX = ev.clientX - rect.left;
  const localY = ev.clientY - rect.top;
  const svgX = (localX / rect.width) * IMAGE_NATIVE_W;
  const svgY = (localY / rect.height) * IMAGE_NATIVE_H;

  // Clamp to the floor plan (paranoia; preserveAspectRatio should keep us in).
  if (svgX < 0 || svgY < 0 || svgX > IMAGE_NATIVE_W || svgY > IMAGE_NATIVE_H) return;

  // Don't accept a click that's effectively on top of the mic -- no angle.
  const dx = svgX - MIC_POS_PX.x;
  const dy = svgY - MIC_POS_PX.y;
  if (dx * dx + dy * dy < 16 * 16) return;

  const worldThetaRad = worldAngleFromSvgPoint(svgX, svgY);
  drawCalibrationDot(svgX, svgY, calibrationStep);

  calibrationPicks.push({ worldThetaRad, svgX, svgY, micThetaDeg: null });
  calibrateOverlay.classList.remove("picking");
  canvasWrap.classList.remove("calibrating");
  beginClapSampling();
}

function drawCalibrationDot(svgX, svgY, stepIdx) {
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("class", "calibration-dot");
  dot.setAttribute("cx", svgX);
  dot.setAttribute("cy", svgY);
  dot.setAttribute("r", 6);
  dot.setAttribute("fill", "#4ade80");
  dot.setAttribute("fill-opacity", "0.85");
  dot.setAttribute("stroke", "#0a0a0f");
  dot.setAttribute("stroke-width", "1.5");
  overlaySvg.appendChild(dot);

  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("class", "calibration-dot");
  label.setAttribute("x", svgX + 9);
  label.setAttribute("y", svgY + 4);
  label.setAttribute("fill", "#4ade80");
  label.setAttribute("font-size", "11");
  label.setAttribute("font-family", "-apple-system, sans-serif");
  label.setAttribute("font-weight", "600");
  label.textContent = String(stepIdx);
  overlaySvg.appendChild(label);
}

function beginClapSampling() {
  calibrationSamples = [];
  calibrateBody.textContent = `Step ${calibrationStep}: Clap now.`;
  let count = 3;
  calibrateCount.textContent = String(count);

  calibrationTimers.push(setTimeout(() => {
    count = 2;
    calibrateCount.textContent = String(count);
  }, 700));
  calibrationTimers.push(setTimeout(() => {
    count = 1;
    calibrateCount.textContent = String(count);
  }, 1400));
  calibrationTimers.push(setTimeout(() => {
    calibrationSampling = true;
    calibrateCount.textContent = "";
    calibrateBody.textContent = `Step ${calibrationStep}: Listening...`;
  }, 2100));
  calibrationTimers.push(setTimeout(() => {
    finishSamplingStep();
  }, 2100 + CALIBRATION_SAMPLE_MS));
}

function collectCalibrationSample(angleDeg) {
  if (!calibrating || !calibrationSampling) return;
  calibrationSamples.push(angleDeg);
}

function circularMeanDeg(samples) {
  if (!samples.length) return 0;
  let sx = 0, sy = 0;
  for (const a of samples) {
    const r = a * Math.PI / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  return Math.atan2(sy / samples.length, sx / samples.length) * 180 / Math.PI;
}

// Smallest signed angular difference a-b in degrees, wrapped to [-180, 180].
function circularDiffDeg(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function finishSamplingStep() {
  calibrationSampling = false;
  const samples = calibrationSamples.slice();
  calibrationSamples = [];

  if (samples.length === 0) {
    calibrateBody.textContent = "No samples captured. Try again.";
    calibrationTimers.push(setTimeout(() => {
      // Back up to re-pick the same step
      calibrationPicks.pop();
      clearCalibrationDots();
      // Redraw dots for prior successful steps
      calibrationPicks.forEach((p, idx) => drawCalibrationDot(p.svgX, p.svgY, idx + 1));
      promptForClick();
    }, 1200));
    return;
  }

  const micThetaDeg = circularMeanDeg(samples);
  calibrationPicks[calibrationPicks.length - 1].micThetaDeg = micThetaDeg;

  if (calibrationStep === 1) {
    calibrationStep = 2;
    promptForClick();
    return;
  }

  computeAndCommitTransform();
}

function computeAndCommitTransform() {
  const [p1, p2] = calibrationPicks;
  const worldDeg1 = p1.worldThetaRad * 180 / Math.PI;
  const worldDeg2 = p2.worldThetaRad * 180 / Math.PI;
  const micDeg1 = p1.micThetaDeg;
  const micDeg2 = p2.micThetaDeg;

  const dWorld = circularDiffDeg(worldDeg2, worldDeg1);
  const dMic = circularDiffDeg(micDeg2, micDeg1);

  // Guard: if the two points are angularly indistinguishable from the mic
  // origin (either in world or in mic frame), we can't resolve handedness.
  const MIN_SEPARATION_DEG = 15;
  if (Math.abs(dWorld) < MIN_SEPARATION_DEG || Math.abs(dMic) < MIN_SEPARATION_DEG) {
    calibrateBody.innerHTML =
      `Those two points are too close in angle (&Delta;world=${Math.round(dWorld)}&deg;, ` +
      `&Delta;mic=${Math.round(dMic)}&deg;). Try again with a wider spread.`;
    calibrationTimers.push(setTimeout(() => { cancelCalibration(); }, 2200));
    return;
  }

  const newHandedness = Math.sign(dWorld) === Math.sign(dMic) ? 1 : -1;
  // renderedDeg = handedness * micDeg + offset   =>   offset = worldDeg - handedness * micDeg
  const rawOffset = worldDeg1 - newHandedness * micDeg1;
  const newOffsetDeg = normalizeDeg(rawOffset);

  handedness = newHandedness;
  headingOffsetDeg = newOffsetDeg;
  saveHeadingOffset();

  const handText = handedness === -1 ? "mirrored" : "matched";
  calibrateBody.innerHTML =
    `Offset: <b>${Math.round(headingOffsetDeg)}&deg;</b>, Handedness: <b>${handText}</b>.`;
  calibrateCount.textContent = "";
  if (calibrateHint) calibrateHint.textContent = "";

  calibrationTimers.push(setTimeout(() => {
    clearCalibrationDots();
    calibrating = false;
    calibrationStep = 0;
    calibrationPicks = [];
    closeCalibrateOverlay();
    calibrateBtn.disabled = false;
  }, 1600));
}

function resetCalibration() {
  headingOffsetDeg = 0;
  handedness = 1;
  saveHeadingOffset();
}

// ---- Tabs --------------------------------------------------
function initTabs() {
  const panels = {
    controls: document.getElementById("tab-controls"),
    transcript: document.getElementById("tab-transcript"),
  };
  const buttons = document.querySelectorAll(".tab-btn");

  let active = "controls";
  try {
    const stored = localStorage.getItem(LS_KEY_ACTIVE_TAB);
    if (stored === "controls" || stored === "transcript") active = stored;
  } catch {}

  function setActive(name) {
    if (!panels[name]) return;
    active = name;
    for (const key of Object.keys(panels)) {
      panels[key].classList.toggle("hidden", key !== name);
    }
    buttons.forEach((btn) => {
      const is = btn.dataset.tab === name;
      btn.classList.toggle("active", is);
      btn.setAttribute("aria-selected", is ? "true" : "false");
    });
    try { localStorage.setItem(LS_KEY_ACTIVE_TAB, name); } catch {}
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => setActive(btn.dataset.tab));
  });

  setActive(active);
}

// ---- Boot --------------------------------------------------
loadBeamEnabled();
loadHeadingOffset();
loadKeywords();
initSensitivity();
initVadSlider();
initManualCalibrateControls();
renderKeywordChips();
initKeywordInput();
renderBeamsPanel();
renderBeamReadout();
applyAllBeamToggleUI();
buildStaticOverlay();
buildBeamGroup();
initTabs();

calibrateBtn.addEventListener("click", startCalibration);
calibrateCancel.addEventListener("click", cancelCalibration);
calibrateResetEl.addEventListener("click", (ev) => {
  ev.preventDefault();
  resetCalibration();
});

// Calibration picks a point from the floor plan. Listen on the overlay SVG
// (which covers the floor plan exactly). The `.calibrating` class on the
// canvas wrapper flips pointer-events on, so this only fires during a pick.
overlaySvg.addEventListener("click", handleOverlayClick);

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && calibrating) {
    ev.preventDefault();
    cancelCalibration();
  }
});

connect();
requestAnimationFrame(animate);

"use strict";

const ai = { modelCache: {}, modalPid: null, status: null, range: "today", running: false, ctrl: null, text: "", lastOpts: null, byAuthor: false, renderPending: false };

async function postJson(path, body) {
  let r;
  try {
    r = await fetch(`/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error("本地服务未运行，请双击 启动.bat");
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

async function refreshAiStatus() {
  try {
    ai.status = await api("ai/status", {});
  } catch (e) {
    return;
  }
  const s = ai.status;
  const n = $("#aiNotice");
  n.classList.toggle("ok", s.configured);
  n.innerHTML = s.configured
    ? `当前：${esc(s.provider_name)} · ${esc(s.model)}`
    : `「${esc(s.provider_name)}」还没配置，<a href="#" id="aiNoticeSet">去设置</a>`;
  n.classList.remove("hidden");
  const link = $("#aiNoticeSet");
  if (link) link.onclick = (e) => { e.preventDefault(); openAiModal(); };
}

// ---------- Markdown ----------
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/楼主第(\d+)帖/g, (m, n) => `<a href="#" class="ref" data-op="1" data-lou="${n}">${m}</a>`)
    .replace(/主楼(?![\u4e00-\u9fa5])/g, (m) => (ai.byAuthor ? `<a href="#" class="ref" data-op="1" data-lou="0">${m}</a>` : m))
    .replace(/#(\d{1,7})(?!\d)/g, (m, n) => `<a href="#" class="ref" data-lou="${n}">#${n}</a>`);
}

function mdRender(src) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of esc(src).split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      close();
      const tag = m[1].length >= 4 ? "h4" : "h3";
      out.push(`<${tag}>${mdInline(m[2])}</${tag}>`);
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${mdInline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.、)]\s+(.*)$/))) {
      if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${mdInline(m[1])}</li>`);
    } else if (!line.trim()) {
      close();
    } else {
      close();
      out.push(`<p>${mdInline(line)}</p>`);
    }
  }
  close();
  return out.join("");
}

function renderAi() {
  if (ai.renderPending) return;
  ai.renderPending = true;
  requestAnimationFrame(() => {
    ai.renderPending = false;
    const el = $("#aiOutput");
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.innerHTML = mdRender(ai.text) + (ai.running ? '<span class="cursor-blink"></span>' : "");
    if (ai.running && nearBottom) el.scrollTop = el.scrollHeight;
  });
}

// ---------- 运行 ----------
function aiRange() {
  const n = nowTs();
  switch (ai.range) {
    case "today": return [startOfDay(0), 0];
    case "3d": return [n - 3 * 86400, 0];
    case "7d": return [n - 7 * 86400, 0];
    default: return [state.from, state.to || 0];
  }
}

const PRESET_TITLES = { summary: "总结观点", change: "观点变化", plan: "预判与计划" };

async function runAnalysis(opts) {
  if (ai.running) return toast("已有分析在进行中");
  if (!ai.status || !ai.status.configured) return openAiModal();
  if (!state.topic) return toast("帖子还没加载完");
  const [from, to] = aiRange();
  if (!from) return toast("「筛选范围」需要先在上面的「按时间筛选」里设置开始时间");

  ai.byAuthor = $("#aiOpOnly").checked;
  ai.lastOpts = opts;
  const body = {
    tid: state.tid, authorid: ai.byAuthor ? state.topic.authorid : "", from, to,
    preset: opts.preset, question: opts.question, force: !!opts.force,
  };

  $("#aiPanel").classList.remove("hidden");
  document.body.classList.add("ai-open");
  $("#aiPanelTitle").textContent = opts.preset ? PRESET_TITLES[opts.preset] : `提问：${opts.question}`;
  $("#aiPanelMeta").textContent = "";
  $("#aiFoot").textContent = "";
  $("#aiProgress").innerHTML = '<span class="spinner"></span>准备中…';
  ai.text = "";
  ai.running = true;
  setAiBusy(true);
  renderAi();

  ai.ctrl = new AbortController();
  try {
    const r = await fetch("/api/ai/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ai.ctrl.signal,
    });
    if (!(r.headers.get("content-type") || "").includes("event-stream")) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith("data: ")) handleAiEvent(JSON.parse(chunk.slice(6)));
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") $("#aiProgress").innerHTML = `<span class="err">${esc(e.message)}</span>`;
  } finally {
    ai.running = false;
    ai.ctrl = null;
    setAiBusy(false);
    renderAi();
  }
}

function handleAiEvent(ev) {
  switch (ev.type) {
    case "progress":
      $("#aiProgress").innerHTML = `<span class="spinner"></span>${esc(ev.text)}`;
      break;
    case "meta":
      $("#aiPanelMeta").textContent = [ev.scope, `${ev.count} 楼`, ev.model, ev.cached ? "来自缓存" : "", ev.truncated ? "楼层过多已截断" : ""]
        .filter(Boolean).join(" · ");
      break;
    case "text":
      if (!ai.text) $("#aiProgress").textContent = "";
      ai.text += ev.text;
      renderAi();
      break;
    case "done":
      $("#aiProgress").textContent = "";
      $("#aiFoot").textContent = ev.cached ? "结果来自缓存，点「重新生成」可重新分析"
        : ev.usage ? `用量：输入 ${ev.usage.input} tokens · 输出 ${ev.usage.output} tokens` : "";
      break;
    case "error":
      $("#aiProgress").innerHTML = `<span class="err">${esc(ev.message)}</span>`;
      break;
  }
}

function setAiBusy(busy) {
  $$("[data-preset], #aiAskBtn, #aiRegenBtn").forEach((b) => { b.disabled = busy; });
}

function jumpToRef(lou, op) {
  const opMode = !!op;
  if (opMode === !!state.authorid && document.getElementById(`l${lou}`)) return scrollToFloor(lou);
  state.authorid = opMode && state.topic ? state.topic.authorid : null;
  setMode();
  setRange(null, null);
  $$("[data-range]").forEach((x) => x.classList.remove("active"));
  state.order = "asc";
  $$(".order").forEach((x) => x.classList.toggle("active", x.dataset.order === "asc"));
  const per = (state.topic && state.topic.perPage) || 20;
  startView({ page: Math.floor(lou / per) + 1, scrollTo: lou });
}

// ---------- 设置 ----------
async function openAiModal(pid) {
  $("#aiModal").classList.remove("hidden");
  await refreshAiStatus();
  if (!ai.status) return;
  const keep = ai.modalPid;
  $("#aiProvider").innerHTML = ai.status.providers.map((p) =>
    `<option value="${p.id}">${p.configured ? "✓ " : "　"}${esc(p.name)}${p.id === ai.status.active ? "（当前使用）" : ""}</option>`).join("");
  showProvider(pid || keep || ai.status.active);
}

const providerById = (id) => ai.status.providers.find((p) => p.id === id);

function showProvider(pid) {
  const p = providerById(pid);
  if (!p) return;
  ai.modalPid = pid;
  $("#aiProvider").value = pid;
  const cursor = p.kind === "cursor";
  $("#aiBaseRow").classList.toggle("hidden", cursor);
  $("#aiBaseUrl").value = p.base_url;
  $("#aiBaseUrl").placeholder = p.default_base_url || "https://example.com/v1";
  $("#aiKeyLabel").textContent = cursor ? "Cursor API Key" : p.key_optional ? "API Key（可选）" : "API Key";
  $("#aiKeyInput").value = "";
  $("#aiKeyInput").placeholder = p.key_hint ? `已保存 ${p.key_hint}，留空表示不修改` : p.key_optional ? "不需要可留空" : "粘贴 API Key";
  $("#aiKeyLink").href = p.key_url || "#";
  $("#aiKeyLink").parentElement.classList.toggle("hidden", !p.key_url);
  fillModels(ai.modelCache[pid] || [], p.model);
  if (!ai.modelCache[pid] && (p.configured || p.id === "opencode_go")) loadModels(true);
  const st = cursor && !p.installed ? "未安装 cursor-sdk（pip install cursor-sdk）"
    : p.configured ? `已配置${p.user ? "：" + p.user : ""}${p.id === ai.status.active ? "，当前使用中" : "，保存后切换为当前使用"}`
    : "尚未配置";
  setModalStatus(st);
  $("#aiNote").textContent = p.note || "";
  $("#aiNote").classList.toggle("hidden", !p.note);
  $("#aiSafeNote").textContent = cursor
    ? "Cursor 以本地 Agent 方式运行，已隔离：不给任何工具（不能执行命令、不能读写文件）、空工作目录、不加载本机规则和插件。"
    : "只调用纯文本对话接口，不给模型任何工具。";
}

function setModalStatus(text, isErr) {
  const el = $("#aiStatusLine");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

const CUSTOM_MODEL = "__custom__";

function fillModels(models, current) {
  const sel = $("#aiModelSelect");
  const list = models.slice();
  if (current && !list.some((m) => m.id === current)) list.unshift({ id: current, name: current });
  sel.innerHTML = list.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}${m.name && m.name !== m.id ? `（${esc(m.name)}）` : ""}</option>`).join("")
    + `<option value="${CUSTOM_MODEL}">✎ 手动输入其他模型…</option>`;
  sel.value = current || (list[0] ? list[0].id : CUSTOM_MODEL);
  $("#aiModelInput").value = "";
  $("#aiModelInput").classList.toggle("hidden", sel.value !== CUSTOM_MODEL);
}

function currentModel() {
  const v = $("#aiModelSelect").value;
  return v === CUSTOM_MODEL ? $("#aiModelInput").value.trim() : v;
}

async function loadModels(silent) {
  const pid = ai.modalPid;
  $("#aiModelLoad").disabled = true;
  try {
    const { models } = await api("ai/models", { provider: pid });
    ai.modelCache[pid] = models;
    if (ai.modalPid === pid) fillModels(models, currentModel());
    if (!silent) toast(models.length ? `共 ${models.length} 个模型` : "该服务不提供模型列表，请手动输入");
  } catch (e) {
    if (!silent) toast(`${e.message}（新填的 Key 需要先保存）`, 5000);
  } finally {
    $("#aiModelLoad").disabled = false;
  }
}

function bindAi() {
  $("#aiSettingsLink").onclick = (e) => { e.preventDefault(); openAiModal(); };
  $("#aiModalClose").onclick = (e) => { e.preventDefault(); $("#aiModal").classList.add("hidden"); };
  $("#aiModal").onclick = (e) => { if (e.target.id === "aiModal") $("#aiModal").classList.add("hidden"); };
  $("#aiProvider").onchange = () => showProvider($("#aiProvider").value);
  $("#aiSave").onclick = async () => {
    const p = providerById(ai.modalPid);
    const model = currentModel();
    if (!model) return setModalStatus("请填写或选择模型", true);
    const body = { provider: p.id, key: $("#aiKeyInput").value.trim(), model, activate: true };
    if (p.kind !== "cursor") body.base_url = $("#aiBaseUrl").value.trim();
    $("#aiSave").disabled = true;
    setModalStatus("正在验证…");
    try {
      const d = await postJson("ai/config", body);
      toast(d.info || "已保存并设为当前使用", 3000);
      await openAiModal(p.id);
    } catch (e) {
      setModalStatus(e.message, true);
    } finally {
      $("#aiSave").disabled = false;
    }
  };
  $("#aiKeyClear").onclick = async () => {
    await postJson("ai/clear", { provider: ai.modalPid });
    toast("已清除该服务商的配置");
    openAiModal(ai.modalPid);
  };
  $("#aiModelLoad").onclick = () => loadModels(false);
  $("#aiModelSelect").onchange = () => {
    const custom = $("#aiModelSelect").value === CUSTOM_MODEL;
    $("#aiModelInput").classList.toggle("hidden", !custom);
    if (custom) $("#aiModelInput").focus();
  };

  $$("[data-ai-range]").forEach((b) => b.onclick = () => {
    ai.range = b.dataset.aiRange;
    $$("[data-ai-range]").forEach((x) => x.classList.toggle("active", x === b));
  });
  $$("[data-preset]").forEach((b) => b.onclick = () => runAnalysis({ preset: b.dataset.preset }));
  const ask = () => {
    const q = $("#aiQuestion").value.trim();
    if (!q) return toast("先输入问题");
    runAnalysis({ question: q });
  };
  $("#aiAskBtn").onclick = ask;
  $("#aiQuestion").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) ask(); });

  $("#aiCloseBtn").onclick = () => {
    if (ai.ctrl) ai.ctrl.abort();
    $("#aiPanel").classList.add("hidden");
    document.body.classList.remove("ai-open");
  };
  $("#aiRegenBtn").onclick = () => ai.lastOpts && runAnalysis({ ...ai.lastOpts, force: true });
  $("#aiCopyBtn").onclick = async () => {
    try { await navigator.clipboard.writeText(ai.text); toast("已复制"); } catch (e) { toast("复制失败"); }
  };
  $("#aiOutput").addEventListener("click", (e) => {
    const a = e.target.closest(".ref");
    if (!a) return;
    e.preventDefault();
    jumpToRef(+a.dataset.lou, a.dataset.op);
  });
}

bindAi();
refreshAiStatus().then(() => {
  const want = new URLSearchParams(location.search).get("ai");
  if (want) openAiModal(want === "settings" ? undefined : want);
});

const $ = (id) => document.getElementById(id);
const amalkaEl = document.querySelector(".amalka");
const head = $("head");
const mouth = $("mouth");
const micBtn = $("mic");
const ringEl = document.querySelector(".ring");
const statusEl = $("status");
const imgOverlay = $("imgOverlay");
const storyImg = $("storyImg");

let pc = null;
let dataCh = null;
let mediaStream = null;
let audioCtx = null;
let outAnalyser = null;
let inAnalyser = null;
let rafId = null;
let inRafId = null;
let smoothed = 0;
let inSmoothed = 0;
let inPeak = 0;
let inSpeakingSince = 0;
let sessionId = null;
let usageKey = null;
let nonce = null;
let isPaused = false;
let isConnecting = false;
let lastTapAt = 0;
let activeImageTimer = null;
let greetingStarted = false;
let micUnlocked = false;
let sessionExpiryTimer = null;
let softWarnTimer = null;
let iceGraceTimer = null;
let cumulativeUsage = null;
let lastSpeechStartedAt = 0;
// Client-owned turn taking. The session is created with create_response:false,
// so the server never answers on its own — WE decide when Anežka is done.
// After speech_stopped we wait `patienceMs`; if she starts speaking again the
// timer is cancelled and her continuation joins the same turn. This is the
// anti-interruption core: a 6yo's mid-sentence thinking pause no longer
// triggers an answer.
let patienceMs = 1200;
let serverCreatesResponse = false;
let patienceTimer = null;
let responseActive = false; // a response is being generated/spoken right now
let responseQueued = false; // patience expired while a response was active
// Bumped on every connect(); async callbacks (image gen, timers) capture the
// era and bail if it changed, so stale state from a prior session never leaks
// into a fresh one (e.g. old image showing up after a reconnect).
let sessionEra = 0;
// Function-call args buffered between response.function_call_arguments.done
// and response.done. We only execute when the response actually completes —
// otherwise a cancelled/interrupted call could still trigger image gen.
const pendingToolCalls = new Map();
const IMAGE_OVERLAY_MS = 90_000;

function setStatus(text) {
  statusEl.textContent = text;
}
function setState(s) {
  micBtn.dataset.state = s;
}
function speakClass(on) {
  head.classList.toggle("speaking", on);
}
function showImagePlaceholder() {
  storyImg.removeAttribute("src");
  imgOverlay.classList.add("placeholder", "show");
  amalkaEl.classList.add("shrink");
  clearTimeout(activeImageTimer);
}
function showImage(url) {
  imgOverlay.classList.remove("placeholder");
  storyImg.src = url;
  storyImg.onload = () => {
    amalkaEl.classList.add("shrink");
    imgOverlay.classList.add("show");
  };
  clearTimeout(activeImageTimer);
  activeImageTimer = setTimeout(() => hideImage(), IMAGE_OVERLAY_MS);
}
function hideImage() {
  imgOverlay.classList.remove("show", "placeholder");
  amalkaEl.classList.remove("shrink");
  clearTimeout(activeImageTimer);
}
imgOverlay.addEventListener("click", (e) => {
  e.stopPropagation();
  hideImage();
});

function scheduleBlink() {
  setTimeout(() => {
    head.classList.add("blinking");
    setTimeout(() => head.classList.remove("blinking"), 130);
    scheduleBlink();
  }, 3500 + Math.random() * 2500);
}
scheduleBlink();

function disconnect(reason) {
  if (reason) console.log("[Amálka] disconnect:", reason);
  // Invalidate any in-flight async work captured under the old era.
  sessionEra++;
  pendingToolCalls.clear();
  clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = null;
  clearTimeout(softWarnTimer);
  softWarnTimer = null;
  clearTimeout(iceGraceTimer);
  iceGraceTimer = null;
  clearTimeout(patienceTimer);
  patienceTimer = null;
  responseActive = false;
  responseQueued = false;
  clearTimeout(activeImageTimer);
  activeImageTimer = null;
  hideImage();
  amalkaEl?.classList.remove("paused");
  cancelAnimationFrame(rafId);
  cancelAnimationFrame(inRafId);
  rafId = null;
  inRafId = null;
  if (dataCh) {
    try { dataCh.close(); } catch {}
    dataCh = null;
  }
  if (pc) {
    try { pc.close(); } catch {}
    pc = null;
  }
  if (mediaStream) {
    stopMediaStream(mediaStream);
    mediaStream = null;
  }
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
    audioCtx = null;
  }
  outAnalyser = null;
  inAnalyser = null;
  smoothed = 0;
  inSmoothed = 0;
  inPeak = 0;
  inSpeakingSince = 0;
  isPaused = false;
  greetingStarted = false;
  micUnlocked = false;
  ringEl?.classList.remove("listening");
  if (ringEl) ringEl.style.removeProperty("--lvl");
  // Flush final usage if we have any.
  sendUsageBeacon();
  sessionId = null;
  usageKey = null;
  nonce = null;
  isConnecting = false;
  setState("off");
}

function stopMediaStream(stream) {
  for (const t of stream.getTracks()) {
    try { t.stop(); } catch {}
  }
}

async function fetchSessionToken() {
  const r = await fetch("/api/realtime/session", { method: "POST" });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const reason = err.reason || "unavailable";
    const e = new Error(reason);
    e.reason = reason;
    throw e;
  }
  return r.json();
}

async function getMicStream() {
  // Constraints tuned for a 6yo child voice + speakerphone playback:
  // - echoCancellation: ON — assistant audio plays through device speaker.
  // - noiseSuppression: OFF — Chrome's NS gates soft Czech consonants (š/ř/ž)
  //   and is the most common cause of "she spoke and Amálka didn't hear".
  // - autoGainControl: ON — child voice is 10–20 dB quieter than adult;
  //   AGC brings level above OpenAI's energy-based VAD threshold. On iOS,
  //   AGC is also bundled with AEC — disabling it breaks echo cancellation.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: false },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
    },
  });
  const settings = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
  console.log("[Amálka] mic settings", JSON.stringify({
    ec: settings.echoCancellation,
    ns: settings.noiseSuppression,
    agc: settings.autoGainControl,
    sr: settings.sampleRate,
    ch: settings.channelCount,
    dev: settings.deviceId ? "ok" : "?",
  }));
  return stream;
}

function statusForSessionError(reason) {
  if (reason === "budget_exceeded") return "amálka má dnes pauzu, zkus to zítra";
  if (reason === "rate_limited") return "amálka odpočívá, počkej chvilku";
  return "amálka má potíže, zkus to znovu";
}

async function connect() {
  if (isConnecting || pc) return;
  isConnecting = true;
  setState("loading");
  setStatus("propojuji se s amálkou…");

  const tokenTask = fetchSessionToken();
  const micTask = getMicStream();
  const [tokenResult, micResult] = await Promise.allSettled([tokenTask, micTask]);

  if (tokenResult.status === "rejected" || micResult.status === "rejected") {
    if (micResult.status === "fulfilled") stopMediaStream(micResult.value);
    setState("off");
    isConnecting = false;
    if (micResult.status === "rejected") {
      setStatus("povol mikrofon, prosím");
    } else {
      setStatus(statusForSessionError(tokenResult.reason?.reason));
    }
    return;
  }

  const token = tokenResult.value;
  sessionId = token.sessionId;
  usageKey = token.usageKey;
  nonce = token.nonce;
  patienceMs = Math.max(150, Number(token.patienceMs ?? 1200) || 1200);
  serverCreatesResponse = !!token.serverCreatesResponse;
  cumulativeUsage = null;
  mediaStream = micResult.value;

  try {
  pc = new RTCPeerConnection();
  for (const track of mediaStream.getAudioTracks()) {
    // Do NOT disable the track here. iOS Safari has a known WebRTC bug where
    // re-enabling a track outside a user gesture leaves the sender silent
    // even though track.enabled reads `true` — the symptom is "Amálka
    // greets but never hears me until I press pause+play". The greeting is
    // protected on the server side via input_audio_buffer.clear sent right
    // before response.create (below).
    pc.addTrack(track, mediaStream);
  }
  micUnlocked = true;
  greetingStarted = false;

  const audioEl = $("amalkaAudio");
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
    setupOutputAnalyser(e.streams[0]);
    // iOS Safari sometimes blocks autoplay even with `playsinline`; if play()
    // rejects, surface a clear "klepni znovu" instead of silently showing
    // "mluvím" with no audio.
    const p = audioEl.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        console.warn("[Amálka] audio play blocked", err);
        setStatus("klepni znovu, prosím");
      });
    }
  };
  setupInputAnalyser(mediaStream);

  dataCh = pc.createDataChannel("oai-events");
  dataCh.onopen = () => {
    setStatus("amálka začíná…");
    try {
      // Flush any audio buffered between datachannel open and response start,
      // so ambient noise doesn't accidentally interrupt the greeting via VAD.
      dataCh.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      // Persona's ZAČÁTEK rule produces the greeting. (create_response is
      // off server-side, so the greeting — like every reply — is client-made.)
      requestResponse();
    } catch (e) {
      console.warn("initial response.create failed", e);
    }
  };
  dataCh.onmessage = (ev) => {
    try { handleEvent(JSON.parse(ev.data)); }
    catch (e) { console.warn("event parse failed", e); }
  };

  pc.oniceconnectionstatechange = () => {
    if (!pc) return;
    const s = pc.iceConnectionState;
    if (s === "failed" || s === "closed") {
      setStatus("ztratila jsem signál, klikni znovu");
      disconnect(`ice=${s}`);
    } else if (s === "disconnected") {
      // Brief network handoffs (Wi-Fi → cellular, walking through a hallway)
      // routinely flap ICE through "disconnected" for 1-3 s. Tearing down
      // immediately means Anežka loses Amálka every time. Give it a grace
      // window; tear down only if still disconnected after.
      clearTimeout(iceGraceTimer);
      iceGraceTimer = setTimeout(() => {
        if (pc && pc.iceConnectionState === "disconnected") {
          setStatus("ztratila jsem signál, klikni znovu");
          disconnect("ice=disconnected_grace");
        }
      }, 8000);
    } else if (s === "connected" || s === "completed") {
      clearTimeout(iceGraceTimer);
      iceGraceTimer = null;
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Model is encoded in the ephemeral client_secret session; no ?model= needed.
  const baseUrl = "https://api.openai.com/v1/realtime";
  const sdpRes = await fetch(`${baseUrl}/calls`, {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${token.clientSecret}`,
      "Content-Type": "application/sdp",
    },
  });
  if (!sdpRes.ok) {
    const t = await sdpRes.text();
    console.error("SDP exchange failed", sdpRes.status, t);
    setStatus("amálka se neozvala");
    disconnect("sdp_failed");
    return;
  }
  const answer = { type: "answer", sdp: await sdpRes.text() };
  await pc.setRemoteDescription(answer);
  setState("on");

  // Realtime WebRTC sessions can run for ~60 min — client_secret expiry
  // (typically 10 min) only blocks RE-handshake, not the live call. So
  // the app timer is bounded ONLY by the server's configured
  // MAX_SESSION_MINUTES, not by client_secret TTL. Capping by token
  // expiry was hard-cutting Anežka at ~9 min mid-story.
  const configuredMs = Number(token.maxSessionSeconds ?? 30 * 60) * 1000;
  const expiryMs = Math.max(60_000, configuredMs);
  sessionExpiryTimer = setTimeout(() => {
    setStatus("amálka si odpočine, klikni znovu");
    disconnect("expiry");
  }, expiryMs);
  // Soft pre-warning at ~85% of session. Anežka doesn't read, but the parent
  // can pick it up, and the status change is a cue she's getting close to a
  // natural ending. Skip if total session is too short for the warning to
  // be useful (< 2 min total).
  if (expiryMs > 120_000) {
    softWarnTimer = setTimeout(() => {
      setStatus("za chvilku si dáme pauzu, abych si oddychla");
    }, Math.max(30_000, expiryMs * 0.85));
  }
  isConnecting = false;
  } catch (e) {
    console.error("connect failed", e);
    setStatus("amálka se neozvala");
    disconnect("connect_failed");
  }
}

function ensureAudioCtx() {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function setupOutputAnalyser(stream) {
  const ctx = ensureAudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  outAnalyser = ctx.createAnalyser();
  outAnalyser.fftSize = 256;
  outAnalyser.smoothingTimeConstant = 0.4;
  src.connect(outAnalyser);
  const buf = new Uint8Array(outAnalyser.frequencyBinCount);
  cancelAnimationFrame(rafId);
  function tick() {
    if (!outAnalyser) return;
    outAnalyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const m = Math.min(1, rms * 5);
    smoothed = smoothed * 0.6 + m * 0.4;
    const heightPct = 6 + smoothed * 18;
    mouth.style.height = heightPct.toFixed(2) + "%";
    speakClass(smoothed > 0.04);
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
}

// Input analyser drives the ring around the mic button — gives the child
// immediate visual feedback that her mic is being heard. Also feeds a
// client-side "she's speaking but server VAD didn't fire" diagnostic so we
// can spot config regressions in production.
function setupInputAnalyser(stream) {
  const ctx = ensureAudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  inAnalyser = ctx.createAnalyser();
  inAnalyser.fftSize = 1024;
  inAnalyser.smoothingTimeConstant = 0.6;
  src.connect(inAnalyser);
  const buf = new Float32Array(inAnalyser.fftSize);
  cancelAnimationFrame(inRafId);
  function tick() {
    if (!inAnalyser) return;
    inAnalyser.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / buf.length);
    // Child voice rarely exceeds 0.2 RMS even with AGC — gain up.
    const lvl = Math.min(1, rms * 6);
    inSmoothed = inSmoothed * 0.55 + lvl * 0.45;
    inPeak = peak;

    // Drive the ring's CSS var; CSS scales/opacity from --lvl 0..1.
    if (ringEl && !isPaused && micUnlocked) {
      ringEl.style.setProperty("--lvl", inSmoothed.toFixed(3));
      ringEl.classList.toggle("listening", inSmoothed > 0.08);
    } else if (ringEl) {
      ringEl.style.removeProperty("--lvl");
      ringEl.classList.remove("listening");
    }

    // Diagnostic: track sustained input without server speech_started.
    const now = performance.now();
    if (inSmoothed > 0.12 && micUnlocked && !isPaused) {
      if (!inSpeakingSince) inSpeakingSince = now;
      // If the kid has been talking for 1.5s and the server VAD has not fired
      // since at least 2s before now, log it — surfaces VAD threshold misses
      // without spamming the console.
      if (
        now - inSpeakingSince > 1500 &&
        now - lastSpeechStartedAt > 3500
      ) {
        console.warn(
          "[Amálka] input audible ~1.5s but no speech_started — VAD may be too strict",
          { lvl: inSmoothed.toFixed(3), peak: inPeak.toFixed(3) },
        );
        inSpeakingSince = now;
      }
    } else {
      inSpeakingSince = 0;
    }
    inRafId = requestAnimationFrame(tick);
  }
  inRafId = requestAnimationFrame(tick);
}

// Bounded LRU of tool-call IDs to avoid unbounded growth in long sessions.
const handledCalls = new Map();
const HANDLED_CALLS_MAX = 200;
function markHandled(callId) {
  if (handledCalls.has(callId)) return false;
  handledCalls.set(callId, Date.now());
  if (handledCalls.size > HANDLED_CALLS_MAX) {
    const oldest = handledCalls.keys().next().value;
    handledCalls.delete(oldest);
  }
  return true;
}

function handleToolCall(call) {
  const callId = call.call_id;
  if (!callId || !markHandled(callId)) return;

  if (call.name === "wait_for_user") {
    sendToolAck(callId, { success: true }, false);
    setStatus("povídej!");
    return;
  }

  if (call.name !== "nakresli_obrazek") {
    sendToolAck(callId, { success: false, message: "Neznámý nástroj." });
    return;
  }

  let args = {};
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {}

  sendToolAck(callId, {
    success: true,
    message:
      "Obrázek se kreslí, zobrazí se sám. Pokračuj v povídání bez popisu kreslení.",
  });

  showImagePlaceholder();

  // Capture the era this call belongs to; image gen can take 60-120s and the
  // child may have already disconnected/reconnected by the time it resolves.
  const era = sessionEra;
  fetch("/api/image/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      popis: args.popis ?? "",
      nalada: args.nalada ?? "veselá",
      nonce,
    }),
  })
    .then((r) => r.json())
    .then((out) => {
      if (era !== sessionEra) return; // stale: a new session is active
      if (out.ok && out.url) {
        showImage(out.url);
      } else {
        console.warn("image gen failed", out);
        hideImage();
      }
    })
    .catch((e) => {
      if (era !== sessionEra) return;
      console.error("image generate failed", e);
      hideImage();
    });
}

function sendToolAck(callId, output, createResponse = true) {
  if (!dataCh || dataCh.readyState !== "open") return;
  dataCh.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    }),
  );
  // Route through requestResponse so a tool ack can't collide with an
  // already-active response (the API rejects concurrent response.create).
  if (createResponse) requestResponse();
}

// Legacy no-op: kept so we don't accidentally re-introduce iOS WebRTC track
// disable/enable issues. Mic stays live from connection start.
function unlockMic() {}

function accumulateUsage(usage) {
  if (!usage || typeof usage !== "object") return;
  if (!cumulativeUsage) {
    cumulativeUsage = {
      input_tokens: 0,
      output_tokens: 0,
      input_token_details: { text_tokens: 0, audio_tokens: 0, cached_tokens: 0 },
      output_token_details: { text_tokens: 0, audio_tokens: 0 },
    };
  }
  cumulativeUsage.input_tokens += Number(usage.input_tokens ?? 0) || 0;
  cumulativeUsage.output_tokens += Number(usage.output_tokens ?? 0) || 0;
  const ind = usage.input_token_details ?? {};
  const outd = usage.output_token_details ?? {};
  cumulativeUsage.input_token_details.text_tokens += Number(ind.text_tokens ?? 0) || 0;
  cumulativeUsage.input_token_details.audio_tokens += Number(ind.audio_tokens ?? 0) || 0;
  cumulativeUsage.input_token_details.cached_tokens += Number(ind.cached_tokens ?? 0) || 0;
  cumulativeUsage.output_token_details.text_tokens += Number(outd.text_tokens ?? 0) || 0;
  cumulativeUsage.output_token_details.audio_tokens += Number(outd.audio_tokens ?? 0) || 0;
}

function reportUsage(usage) {
  if (!usage) return;
  // Per-turn usage event from OpenAI response.done — bill it immediately so
  // mid-session budget enforcement can fire.
  fetch("/api/session/usage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, usageKey, ...usage }),
  })
    .then((r) => r.json())
    .then((out) => {
      if (out && out.overBudget) {
        setStatus("amálka má dnes hotovo, zkus zítra");
        disconnect("over_budget");
      }
    })
    .catch((e) => console.warn("usage report failed", e));
}

function sendUsageBeacon() {
  if (!sessionId || !cumulativeUsage) return;
  try {
    navigator.sendBeacon(
      "/api/session/end",
      new Blob(
        [JSON.stringify({ sessionId, usageKey, ...cumulativeUsage })],
        { type: "application/json" },
      ),
    );
  } catch {}
  cumulativeUsage = null;
}

// Ask the model to answer — but never while another response is active
// (the API rejects concurrent responses). If one is active, queue: the
// pending flag is flushed from response.done, which also covers the
// barge-in path (child interrupts → response cancelled → done → new answer).
function requestResponse() {
  if (!dataCh || dataCh.readyState !== "open") return;
  if (responseActive) {
    responseQueued = true;
    return;
  }
  responseQueued = false;
  try {
    dataCh.send(JSON.stringify({ type: "response.create" }));
  } catch (e) {
    console.warn("response.create failed", e);
  }
}

function schedulePatienceResponse() {
  if (serverCreatesResponse) return; // legacy mode: server answers on its own
  clearTimeout(patienceTimer);
  const era = sessionEra;
  patienceTimer = setTimeout(() => {
    patienceTimer = null;
    if (era !== sessionEra || isPaused) return;
    requestResponse();
  }, patienceMs);
}

function handleEvent(ev) {
  if (ev.type === "input_audio_buffer.speech_started") {
    lastSpeechStartedAt = performance.now();
    // She's speaking (again) — whatever reply was brewing, hold it. Her new
    // audio joins the same turn once she's really done.
    clearTimeout(patienceTimer);
    patienceTimer = null;
    responseQueued = false;
    setStatus("poslouchám tě");
  } else if (ev.type === "input_audio_buffer.speech_stopped") {
    // Don't answer yet — give her the patience window to finish the thought.
    schedulePatienceResponse();
    setStatus("poslouchám tě");
  } else if (ev.type === "response.created") {
    // OpenAI started generating — earliest signal that Amálka is "thinking".
    responseActive = true;
    setStatus("přemýšlím");
  } else if (
    ev.type === "response.audio.delta" ||
    ev.type === "response.output_audio.delta"
  ) {
    greetingStarted = true;
    setStatus("mluvím");
  } else if (ev.type === "response.function_call_arguments.done") {
    // Buffer the call — only execute when response.done confirms it completed.
    // response.function_call_arguments.done can also fire when a response is
    // cancelled or interrupted; firing the tool eagerly here causes phantom
    // image generations.
    if (ev.call_id) {
      pendingToolCalls.set(ev.call_id, {
        name: ev.name,
        arguments: ev.arguments,
      });
    }
  } else if (
    ev.type === "response.done" ||
    ev.type === "response.completed"
  ) {
    responseActive = false;
    const status = ev.response?.status ?? "completed";
    const outputs = ev.response?.output ?? [];
    if (status === "completed") {
      for (const item of outputs) {
        if (item?.type !== "function_call") continue;
        if (item.status && item.status !== "completed") continue;
        const buffered = pendingToolCalls.get(item.call_id);
        pendingToolCalls.delete(item.call_id);
        handleToolCall({
          call_id: item.call_id,
          name: item.name || buffered?.name,
          arguments: item.arguments || buffered?.arguments,
        });
      }
    }
    // Drop anything left orphaned (response cancelled / failed).
    if (status !== "completed") pendingToolCalls.clear();
    setStatus("povídej!");
    const usage = ev.response?.usage ?? ev.usage;
    if (usage) {
      accumulateUsage(usage);
      reportUsage(usage);
    }
    // A reply request landed while this response was still active (e.g. she
    // finished a sentence while Amálka was being interrupted) — answer now.
    if (responseQueued && !isPaused) requestResponse();
  } else if (
    ev.type === "response.output_audio.done" ||
    ev.type === "response.audio.done"
  ) {
    // Amálka finished her turn — flip mouth/status back from "mluvím".
    setStatus("povídej!");
  } else if (ev.type === "error") {
    console.error("Realtime error", ev);
    setStatus("něco se pokazilo");
  }
}

async function togglePause() {
  if (!mediaStream) return;
  isPaused = !isPaused;
  for (const t of mediaStream.getAudioTracks()) t.enabled = !isPaused;
  if (isPaused) {
    // No reply should fire out of a pause — drop the patience timer and any
    // queued response along with the active one.
    clearTimeout(patienceTimer);
    patienceTimer = null;
    responseQueued = false;
    // Stop Amálka mid-sentence: cancel any active response and drop her
    // queued audio. Without this, pause just mutes the kid — Amálka keeps
    // talking, which is exactly NOT what "pause" means to a 6yo.
    try {
      dataCh?.send(JSON.stringify({ type: "response.cancel" }));
      dataCh?.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
    } catch {}
    amalkaEl?.classList.add("paused");
    head?.classList.remove("speaking");
    setStatus("amálka spinká, klepni");
  } else {
    // Resume — flush any input that piled up while paused so we don't
    // process old audio as the next turn.
    try {
      dataCh?.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    } catch {}
    amalkaEl?.classList.remove("paused");
    setStatus("povídej!");
  }
}

async function onMicTap() {
  const now = Date.now();
  if (now - lastTapAt < 450) return;
  lastTapAt = now;
  console.log("[Amálka] mic tap, pc?", !!pc);
  setStatus("...");
  if (!pc && !isConnecting) {
    await connect();
    return;
  }
  if (isConnecting) return;
  await togglePause();
}

micBtn.addEventListener("click", onMicTap);
micBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  onMicTap();
}, { passive: false });

console.log("[Amálka] app.js loaded, mic listener attached", !!micBtn);

window.addEventListener("beforeunload", () => {
  sendUsageBeacon();
});

// Page-hide is more reliable than beforeunload on mobile.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") sendUsageBeacon();
});

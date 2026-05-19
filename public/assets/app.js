const $ = (id) => document.getElementById(id);
const amalkaEl = document.querySelector(".amalka");
const head = $("head");
const mouth = $("mouth");
const micBtn = $("mic");
const statusEl = $("status");
const imgOverlay = $("imgOverlay");
const storyImg = $("storyImg");

let pc = null;
let dataCh = null;
let mediaStream = null;
let audioCtx = null;
let analyser = null;
let rafId = null;
let smoothed = 0;
let sessionId = null;
let nonce = null;
let isPaused = false;
let activeImageTimer = null;
let greetingStarted = false;
let micUnlocked = false;
let sessionExpiryTimer = null;
let cumulativeUsage = null;

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
  activeImageTimer = setTimeout(() => hideImage(), 45000);
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
  clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = null;
  cancelAnimationFrame(rafId);
  rafId = null;
  if (dataCh) {
    try { dataCh.close(); } catch {}
    dataCh = null;
  }
  if (pc) {
    try { pc.close(); } catch {}
    pc = null;
  }
  if (mediaStream) {
    for (const t of mediaStream.getTracks()) {
      try { t.stop(); } catch {}
    }
    mediaStream = null;
  }
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
    audioCtx = null;
  }
  analyser = null;
  smoothed = 0;
  isPaused = false;
  greetingStarted = false;
  micUnlocked = false;
  // Flush final usage if we have any.
  sendUsageBeacon();
  setState("off");
}

async function connect() {
  setState("loading");
  setStatus("propojuji se s amálkou…");
  let token;
  try {
    const r = await fetch("/api/realtime/session", { method: "POST" });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      if (err.reason === "budget_exceeded") {
        setStatus("amálka má dnes pauzu, zkus to zítra");
      } else if (err.reason === "rate_limited") {
        setStatus("amálka odpočívá, počkej chvilku");
      } else {
        setStatus("amálka má potíže, zkus to znovu");
      }
      setState("off");
      return;
    }
    token = await r.json();
    sessionId = token.sessionId;
    nonce = token.nonce;
    cumulativeUsage = null;
  } catch (e) {
    setStatus("nepodařilo se spojit");
    setState("off");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    setStatus("povol mikrofon, prosím");
    setState("off");
    return;
  }

  pc = new RTCPeerConnection();
  for (const track of mediaStream.getAudioTracks()) {
    track.enabled = false;
    pc.addTrack(track, mediaStream);
  }
  micUnlocked = false;
  greetingStarted = false;

  const audioEl = $("amalkaAudio");
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
    setupAnalyser(e.streams[0]);
  };

  dataCh = pc.createDataChannel("oai-events");
  dataCh.onopen = () => {
    setStatus("amálka začíná…");
    try {
      dataCh.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions:
              "Pozdrav Anežku přesně touto větou a nic jiného nepřidávej: 'Ahoj Anežko, tady Amálka! O čem si dneska budeme povídat?' Pak počkej na její odpověď.",
          },
        }),
      );
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
    if (s === "failed" || s === "closed" || s === "disconnected") {
      setStatus("ztratila jsem signál, klikni znovu");
      disconnect(`ice=${s}`);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const baseUrl = "https://api.openai.com/v1/realtime";
  const model = "gpt-realtime";
  const sdpRes = await fetch(`${baseUrl}/calls?model=${model}`, {
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

  // Watchdog: client secret expires after 600s on OpenAI side. Tear down
  // gracefully ~30s before, so the child doesn't experience a hard cutoff.
  const maxMin = Number(token.maxSessionMinutes ?? 30);
  const expiryMs = Math.min(maxMin * 60_000, 9 * 60_000 + 30_000);
  sessionExpiryTimer = setTimeout(() => {
    setStatus("amálka si odpočine, klikni znovu");
    disconnect("expiry");
  }, expiryMs);
}

function setupAnalyser(stream) {
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.4;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  cancelAnimationFrame(rafId);
  function tick() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
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
      if (out.ok && out.url) {
        showImage(out.url);
      } else {
        console.warn("image gen failed", out);
        hideImage();
      }
    })
    .catch((e) => {
      console.error("image generate failed", e);
      hideImage();
    });
}

function sendToolAck(callId, output) {
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
  dataCh.send(JSON.stringify({ type: "response.create" }));
}

function unlockMic() {
  if (micUnlocked) return;
  micUnlocked = true;
  if (!mediaStream) return;
  for (const t of mediaStream.getAudioTracks()) t.enabled = !isPaused;
  console.log("[Amálka] mic unlocked");
}

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
    body: JSON.stringify({ sessionId, ...usage }),
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
        [JSON.stringify({ sessionId, ...cumulativeUsage })],
        { type: "application/json" },
      ),
    );
  } catch {}
  cumulativeUsage = null;
}

function handleEvent(ev) {
  if (ev.type === "input_audio_buffer.speech_started") {
    setStatus("poslouchám tě");
  } else if (ev.type === "input_audio_buffer.speech_stopped") {
    setStatus("přemýšlím");
  } else if (
    ev.type === "response.audio.delta" ||
    ev.type === "response.output_audio.delta"
  ) {
    if (!greetingStarted) {
      greetingStarted = true;
      setTimeout(unlockMic, 600);
    }
    setStatus("mluvím");
  } else if (ev.type === "response.function_call_arguments.done") {
    handleToolCall({
      call_id: ev.call_id,
      name: ev.name,
      arguments: ev.arguments,
    });
  } else if (
    ev.type === "response.done" ||
    ev.type === "response.completed"
  ) {
    setStatus("povídej!");
    const usage = ev.response?.usage ?? ev.usage;
    if (usage) {
      accumulateUsage(usage);
      reportUsage(usage);
    }
  } else if (ev.type === "error") {
    console.error("Realtime error", ev);
    setStatus("něco se pokazilo");
  }
}

async function togglePause() {
  if (!mediaStream) return;
  isPaused = !isPaused;
  for (const t of mediaStream.getAudioTracks()) t.enabled = !isPaused;
  setStatus(isPaused ? "amálka spinká, klikni" : "povídej!");
}

async function onMicTap() {
  console.log("[Amálka] mic tap, pc?", !!pc);
  setStatus("...");
  if (!pc) {
    await connect();
    return;
  }
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

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

setInterval(() => {
  head.classList.add("blinking");
  setTimeout(() => head.classList.remove("blinking"), 130);
}, 3500 + Math.random() * 2500);

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
  } catch (e) {
    setStatus("nepodařilo se spojit");
    setState("off");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setStatus("povol mikrofon, prosím");
    setState("off");
    return;
  }

  pc = new RTCPeerConnection();
  for (const track of mediaStream.getAudioTracks()) {
    pc.addTrack(track, mediaStream);
  }

  const audioEl = $("amalkaAudio");
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
    setupAnalyser(e.streams[0]);
  };

  dataCh = pc.createDataChannel("oai-events");
  dataCh.onopen = () => setStatus("povídej!");
  dataCh.onmessage = (ev) => handleEvent(JSON.parse(ev.data));

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      setStatus("ztratila jsem signál");
      setState("off");
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
    setState("off");
    return;
  }
  const answer = { type: "answer", sdp: await sdpRes.text() };
  await pc.setRemoteDescription(answer);
  setState("on");
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

const handledCalls = new Set();

function handleToolCall(call) {
  const callId = call.call_id;
  if (!callId || handledCalls.has(callId)) return;
  handledCalls.add(callId);

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
      "Obrázek se mi kreslí na pozadí — Anežce se zobrazí sám za chvilku. Ty pokračuj v povídání, ne v popisu toho co kreslíš.",
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

function handleEvent(ev) {
  if (ev.type === "input_audio_buffer.speech_started") {
    setStatus("poslouchám tě");
  } else if (ev.type === "input_audio_buffer.speech_stopped") {
    setStatus("přemýšlím");
  } else if (
    ev.type === "response.audio.delta" ||
    ev.type === "response.output_audio.delta"
  ) {
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
  if (sessionId) {
    try {
      navigator.sendBeacon(
        "/api/session/end",
        new Blob([JSON.stringify({ sessionId })], { type: "application/json" }),
      );
    } catch {}
  }
});

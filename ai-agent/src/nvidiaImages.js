import { boundedText } from "./liveSearch.js";

export const NVIDIA_IMAGE_MODEL = "black-forest-labs/flux.1-dev";
const GENERATION_URL = `https://ai.api.nvidia.com/v1/genai/${NVIDIA_IMAGE_MODEL}`;
const POLL_BASE = "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function generateNvidiaImage(prompt, { fetchImpl = fetch, signal, timeoutMs = 150_000 } = {}) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4096) throw new Error("Invalid image prompt");
  if (!process.env.NVIDIA_API_KEY) throw new Error("NVIDIA is not configured");
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = {
    authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, "content-type": "application/json",
    accept: "application/json", "NVCF-POLL-SECONDS": "5"
  };
  let response = await fetchImpl(GENERATION_URL, {
    method: "POST", redirect: "error", headers, signal: requestSignal,
    body: JSON.stringify({
      prompt, mode: "base", width: 1024, height: 1024, cfg_scale: 5,
      samples: 1, seed: 0, steps: 28
    })
  });
  let requestId = response.headers.get("nvcf-reqid");
  while (response.status === 202) {
    if (!/^[a-z0-9-]{1,80}$/i.test(requestId || "")) throw new Error("NVIDIA returned an invalid image job identifier");
    await boundedText(response, 16384);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requestSignal.removeEventListener("abort", abort); resolve(); }, 1500);
      const abort = () => { clearTimeout(timer); reject(requestSignal.reason); };
      if (requestSignal.aborted) abort();
      else requestSignal.addEventListener("abort", abort, { once: true });
    });
    response = await fetchImpl(`${POLL_BASE}${requestId}`, {
      headers, redirect: "error", signal: requestSignal
    });
    requestId = response.headers.get("nvcf-reqid") || requestId;
  }
  if (!response.ok) {
    const error = new Error(`NVIDIA image generation returned ${response.status}`);
    error.publicMessage = "NVIDIA's image-generation endpoint is unavailable or rejected this request. No image was delivered and this request was not charged. Please try again later.";
    throw error;
  }
  const body = JSON.parse(await boundedText(response, 12 * 1024 * 1024));
  const artifact = body?.artifacts?.[0];
  const encoded = artifact?.base64;
  if (artifact?.finishReason && !["SUCCESS", "success"].includes(artifact.finishReason)) {
    const error = new Error("Image generation was filtered");
    error.publicMessage = "NVIDIA did not return an image for this prompt. Try a different, safe image description. This request was not charged.";
    throw error;
  }
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) {
    throw new Error("NVIDIA returned an invalid image");
  }
  const bytes = Buffer.from(encoded, "base64");
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || (!isPng && !isJpeg)) throw new Error("NVIDIA returned an unsupported image");
  return { bytes, mimeType: isPng ? "image/png" : "image/jpeg", model: NVIDIA_IMAGE_MODEL };
}
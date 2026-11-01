import crypto from "node:crypto";

export const DEFAULTS = Object.freeze({
  enabled: false, welcome: true, links: true, ai: true, compliance: true,
  languages: ["en", "sw"], keywords: [], patterns: [], whitelist: [], trusted: [],
  windowDays: 7, muteSeconds: 172800, kickSeconds: 0, threshold: 0.9,
  aiPerMinute: 30, userAiPerMinute: 6,
  rules: "No spam, scams, illegal sales, threats, adult content or piracy. Links require approval.",
  privacy: "Messages may be checked by AI. Queued text is encrypted and expires after 5 minutes; warning metadata is retained for 30 days."
});
export const CATEGORIES = ["safe", "spam", "scam", "phishing", "illegal_sales", "violence", "adult", "piracy", "abuse"];
const KEYWORDS = { en: ["kill yourself", "buy stolen cards", "free money guaranteed", "child pornography"],
  sw: ["nitakuua", "pesa za bure hakika"] };
const RISK = /\b(password|otp|investment|crypto|weapon|porn|nude|torrent|crack|stolen|kill|pesa|dawa|ua|sex|ngono|mtusi)\b/iu;
const SAFE = /^(?:hi|hey|hello|good morning|good afternoon|good evening|how are you|thanks|thank you|ok|okay|yes|no|asante|asante sana|sawa|habari|habari yako|salama|mambo|poa|karibu|all good)[.!?\s]*$/iu;
export function id(value, group = false) {
  const s = String(value ?? "");
  if (!(group ? /^-[1-9]\d{0,15}$/ : /^[1-9]\d{0,15}$/).test(s)) throw new Error("Invalid identifier");
  return s;
}
export function settings(value = {}) { return { ...DEFAULTS, ...value }; }
export function messageType(m) {
  return ["photo","video","animation","document","audio","voice","sticker"].find(k => m[k]) || "text";
}
export function linksIn(m) {
  const text = String(m.text || m.caption || "");
  const found = [...text.matchAll(/(?:https?:\/\/|www\.|(?:t|telegram)\.me\/)[^\s<>]+|(?:\b[a-z0-9-]+\.)+(?:com|net|org|io|xyz|ke|co|me)(?:\/[^\s<>]*)?/giu)].map(x => x[0]);
  for (const e of [...(m.entities || []), ...(m.caption_entities || [])].slice(0,100)) {
    if (e.type === "text_link" && typeof e.url === "string") found.push(e.url);
    if (e.type === "url" && Number.isInteger(e.offset) && Number.isInteger(e.length)) found.push(text.slice(e.offset, e.offset + e.length));
  }
  return found.map(raw => {
    try { return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./,""); }
    catch { return "!invalid"; }
  });
}
export function prefilter(m, s) {
  if (s.links && linksIn(m).some(host => !s.whitelist.includes(host))) return { category:"spam", rule:"link", confidence:1 };
  const text = String(m.text || m.caption || "").normalize("NFKC").toLowerCase();
  if (!text) return { category:"safe", rule:"unsupported_media", confidence:0 };
  for (const term of [...s.languages.flatMap(l => KEYWORDS[l] || []), ...s.keywords]) {
    if (text.includes(term.toLowerCase())) return { category:"abuse", rule:"keyword", confidence:1 };
  }
  for (const p of s.patterns) if (new RegExp(p, "iu").test(text)) return { category:"abuse",rule:"pattern",confidence:1 };
  if (/(.)\1{20,}/u.test(text)) return { category:"spam",rule:"repetition",confidence:1 };
  if(!RISK.test(text) && (SAFE.test(text) || /^\s*(?:https?:\/\/|www\.)\S+\s*$/iu.test(text)
      && linksIn(m).length>0 && linksIn(m).every(host=>s.whitelist.includes(host)))) {
    return {category:"safe",rule:"prefilter_clear",confidence:1};
  }
  return null; // Unknown content is not silently declared safe.
}
export function verdict(value) {
  return value && CATEGORIES.includes(value.category) && Number.isFinite(value.confidence)
    && value.confidence >= 0 && value.confidence <= 1
    ? {category:value.category,confidence:value.confidence,rule:"ai"} : null;
}
export function safePattern(p) {
  // Deliberately restricted regex grammar: no groups, alternation, repetition,
  // backreferences or lookaround. Avoid user-configured catastrophic backtracking.
  return typeof p === "string" && p.length > 0 && p.length <= 100 && !/[()*+?{}|\\]/.test(p);
}
export function fieldValue(field, text) {
  const t = String(text).trim();
  const list = () => t === "-" ? [] : t.split(",").map(v=>v.trim()).filter(Boolean);
  if (field === "languages") {
    const v=[...new Set(list())]; if (!v.length || v.length>8 || v.some(x=>!/^[a-z]{2}$/.test(x))) throw new Error("Use up to 8 two-letter language codes.");
    return v;
  }
  if (field === "whitelist") {
    const v=list().map(x=>x.toLowerCase().replace(/^www\./,""));
    if (v.length>50 || v.some(x=>! /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(x))) throw new Error("Use comma-separated domains only.");
    return v;
  }
  if (field === "trusted") { const v=list(); if(v.length>50) throw new Error("Maximum 50 trusted IDs."); return v.map(x=>id(x)); }
  if (field === "keywords") { const v=list(); if(v.length>50 || v.some(x=>x.length>100)) throw new Error("Maximum 50 short keywords."); return v; }
  if (field === "patterns") { const v=list(); if(v.length>20 || v.some(x=>!safePattern(x))) throw new Error("Use simple patterns without groups, repetition or backslashes."); return v; }
  if (["rules"].includes(field)) { if(!t || t.length>1000) throw new Error("Use 1–1000 characters."); return t.replace(/[\r\n]+/g," "); }
  const ranges={windowDays:[1,30],muteSeconds:[30,2592000],kickSeconds:[0,2592000],aiPerMinute:[1,120],threshold:[0.5,1],globalCap:[1,1000]};
  const range=ranges[field], n=Number(t);
  if (!range || !t || !Number.isFinite(n) || n<range[0] || n>range[1] || (field!=="threshold" && !Number.isInteger(n))) throw new Error("Invalid setting value.");
  return n;
}
export function escalation(n) { return n >= 3 ? "kick" : n === 2 ? "mute" : "warn"; }
export function fingerprint(m,s) {
  return crypto.createHash("sha256").update(JSON.stringify([String(m.text||m.caption||"").normalize("NFKC"),s.languages,s.keywords,s.patterns,s.threshold])).digest("hex");
}
export function encryptPayload(data, secret) {
  if (!secret || secret.length<32) throw new Error("Group Manager requires a strong SESSION_SECRET");
  const key=crypto.hkdfSync("sha256",secret,"nemotron","group-manager-queue-v1",32), iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",key,iv);
  const bytes=Buffer.concat([cipher.update(JSON.stringify(data),"utf8"),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString("base64");
}
export function decryptPayload(value,secret) {
  const bytes=Buffer.from(value,"base64"), key=crypto.hkdfSync("sha256",secret,"nemotron","group-manager-queue-v1",32);
  const decipher=crypto.createDecipheriv("aes-256-gcm",key,bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString("utf8"));
}

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { nanoid } = require('nanoid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
// 🔒 सर्वर का कोड/सेटिंग फाइलें ब्राउज़र से डाउनलोड न हो सकें
app.use((req, res, next) => {
  if (/^\/(server\.js|package(-lock)?\.json|\.env|node_modules|projects|uploads)(\/|$)/i.test(req.path)) return res.status(404).end();
  next();
});
app.use(express.static(__dirname));

const PROJECT_DIR = path.join(__dirname, 'projects');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR, PROJECT_DIR].forEach(d => fs.existsSync(d) || fs.mkdirSync(d, { recursive: true }));
app.use('/outputs', express.static(OUTPUT_DIR));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 30 * 1024 * 1024 } });
// 🔥 इमेज + ब्राउज़र में बनी नाम की PNG (nameImage) दोनों एक साथ लेने के लिए
const uploadWithName = [
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'nameImage', maxCount: 1 }]),
  (req, res, next) => {
    req.file = req.files && req.files.image ? req.files.image[0] : undefined;
    req.nameFile = req.files && req.files.nameImage ? req.files.nameImage[0] : undefined;
    res.on('finish', () => { try { if (req.nameFile) fs.unlinkSync(req.nameFile.path); } catch (e) {} });
    next();
  }
];
const GEM_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

// ================= API KEYS =================
const KEYS = {
  REMOVEBG: process.env.REMOVEBG_KEY,
  DEEPAI: process.env.DEEPAI_KEY,
  GEMINI: process.env.GEMINI_KEY,
  VEC_ID: process.env.VECTORIZER_ID,
  VEC_SECRET: process.env.VECTORIZER_SECRET,
  // वैकल्पिक (हों तो इस्तेमाल होंगी)
  CLIPDROP: process.env.CLIPDROP_KEY,
  PHOTOROOM: process.env.PHOTOROOM_KEY,
  RECRAFT: process.env.RECRAFT_KEY
};

// Gemini इमेज मॉडल (एक-एक करके आज़माए जाएँगे). .env में GEMINI_IMAGE_MODEL डालकर पहला मॉडल बदल सकते हैं
const GEMINI_IMAGE_MODELS = [
  process.env.GEMINI_IMAGE_MODEL,
  'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-image'
].filter(Boolean);

// 🔥 नए प्रिंट-साइज़ (card/wedding/banner) के लिए Gemini का सबसे नज़दीकी aspect ratio
const ASPECT_TO_GEMINI = { card: '16:9', wedding: '3:4', banner: '21:9' };

// 🔥 आखिरी बैकग्राउंड कहाँ से आया (gemini / pollinations / gradient) - स्क्रीन पर दिखाने के लिए
let lastBgSource = 'unknown';

// ================= HELPERS =================
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rmFile(p) {
  try { if (p) fs.unlinkSync(p); } catch (e) {}
}

// 🔥 Gemini से इमेज बनाने का कॉमन फंक्शन (बैकग्राउंड और 3D टेक्स्ट दोनों यही इस्तेमाल करते हैं)
async function callGeminiImage(prompt, aspect = null) {
  if (!KEYS.GEMINI) throw new Error('GEMINI_KEY .env फाइल में नहीं मिली');

  let lastErr = new Error('कोई Gemini मॉडल उपलब्ध नहीं');
  for (const model of GEMINI_IMAGE_MODELS) {
    try {
      const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
      if (aspect) generationConfig.imageConfig = { aspectRatio: aspect };

      const payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig };

      const r = await axios.post(`${GEM_URL}${model}:generateContent`, payload, {
        headers: { 'x-goog-api-key': KEYS.GEMINI, 'Content-Type': 'application/json' },
        timeout: 60000
      });

      for (const cand of r.data.candidates || []) {
        for (const part of cand.content?.parts || []) {
          const inl = part.inlineData || part.inline_data;
          if (inl?.data) return Buffer.from(inl.data, 'base64');
        }
      }
      throw new Error('जवाब में इमेज नहीं थी');
    } catch (e) {
      const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 400) : e.message;
      console.error(`❌ Gemini (${model}) फेल:`, detail);
      lastErr = new Error(`${model}: ${detail}`);
    }
  }
  throw lastErr;
}

// ================= AI FUNCTIONS =================

// 1. Remove Background (Remove.bg)
async function callRemoveBgAPI(buffer, person = false) {
  const fd = new FormData();
  fd.append('image_file', buffer, { filename: 'img.png' });
  fd.append('size', 'auto');
  // person=true (पुराना) या type = auto | graphic | person | product ...
  const rbType = person === true ? 'person' : (typeof person === 'string' && person !== 'auto' && person !== 'local' ? person : null);
  if (rbType) fd.append('type', rbType);
  try {
    const r = await axios.post('https://api.remove.bg/v1.0/removebg', fd, {
      headers: { 'X-Api-Key': KEYS.REMOVEBG, ...fd.getHeaders() },
      responseType: 'arraybuffer', timeout: 120000
    });
    return Buffer.from(r.data, 'binary');
  } catch (e) {
    let d = e.message;
    try { if (e.response && e.response.data) d = Buffer.from(e.response.data).toString().slice(0, 250); } catch (_) {}
    console.error('❌ remove.bg error:', d);
    throw new Error("Background removal failed.");
  }
}

// ================= 🔥 अतिरिक्त AI सेवाएँ (वैकल्पिक - सिर्फ तब चलेंगी जब उनकी key .env/Render में डाली हो) =================
// नोट: Clipdrop/Photoroom/Recraft के endpoint अलग-अलग वर्ज़न में बदलते रहते हैं, इसलिए .env से बदले जा सकते हैं:
// CLIPDROP_REMOVEBG_URL, CLIPDROP_UPSCALE_URL, PHOTOROOM_URL, RECRAFT_URL

// Clipdrop - बैकग्राउंड हटाना
async function callClipdropRemoveBg(buffer) {
  const fd = new FormData();
  fd.append('image_file', await sharp(buffer).png().toBuffer(), { filename: 'img.png' });
  const r = await axios.post(process.env.CLIPDROP_REMOVEBG_URL || 'https://clipdrop-api.co/remove-background/v1', fd, {
    headers: { 'x-api-key': KEYS.CLIPDROP, ...fd.getHeaders() },
    responseType: 'arraybuffer', timeout: 120000
  });
  return Buffer.from(r.data);
}

// Photoroom - बैकग्राउंड हटाना
async function callPhotoroomRemoveBg(buffer) {
  const fd = new FormData();
  fd.append('image_file', await sharp(buffer).png().toBuffer(), { filename: 'img.png' });
  const r = await axios.post(process.env.PHOTOROOM_URL || 'https://sdk.photoroom.com/v1/segment', fd, {
    headers: { 'x-api-key': KEYS.PHOTOROOM, ...fd.getHeaders() },
    responseType: 'arraybuffer', timeout: 120000
  });
  return Buffer.from(r.data);
}

// Clipdrop - असली AI अपस्केल (छोटी इमेज के लिए: लंबी साइड ≤ 1024px)
async function callClipdropUpscale(buffer) {
  const meta = await sharp(buffer).metadata();
  if (Math.max(meta.width, meta.height) > 1024) return null; // बड़ी इमेज पर यह तरीका नहीं
  const scale = Math.min(4, 4096 / Math.max(meta.width, meta.height));
  const fd = new FormData();
  fd.append('image_file', await sharp(buffer).png().toBuffer(), { filename: 'img.png' });
  fd.append('target_width', String(Math.round(meta.width * scale)));
  fd.append('target_height', String(Math.round(meta.height * scale)));
  const r = await axios.post(process.env.CLIPDROP_UPSCALE_URL || 'https://clipdrop-api.co/image-upscaling/v1/upscale', fd, {
    headers: { 'x-api-key': KEYS.CLIPDROP, ...fd.getHeaders() },
    responseType: 'arraybuffer', timeout: 180000
  });
  return await restoreAlpha(Buffer.from(r.data), buffer);
}

// 🔥 कई AI अपस्केल के बाद पारदर्शिता (transparent कटआउट) खो देते हैं - ओरिजिनल की पारदर्शिता वापस लगाना
async function restoreAlpha(up, orig) {
  try {
    const om = await sharp(orig).metadata();
    if (!om.hasAlpha) return up;
    const um = await sharp(up).metadata();
    // ओरिजिनल को नए साइज़ में खींचकर उसकी पारदर्शिता को mask की तरह लगाना (dest-in)
    const mask = await sharp(orig).resize(um.width, um.height, { kernel: 'lanczos3' }).png().toBuffer();
    return await sharp(up).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  } catch (e) { return up; }
}

// 🔥 प्रिंट के लिए 300 DPI मेटाडेटा (Photoshop/CorelDRAW/प्रिंटर सही साइज़ पहचानें)
async function withDpi(buf, dpi = 300) {
  try { return await sharp(buf).withMetadata({ density: dpi }).png().toBuffer(); }
  catch (e) { return buf; }
}

// 2. HD Upscale (Clipdrop → DeepAI → sharp)
async function callHDUpscaleAPI(buffer) {
  // 🔥 पहले Clipdrop का असली AI अपस्केल (अगर key हो और इमेज छोटी हो)
  if (KEYS.CLIPDROP) {
    try { const up = await callClipdropUpscale(buffer); if (up) return up; }
    catch (e) { console.error('⚠️ Clipdrop अपस्केल फेल:', e.message); }
  }
  try {
    const src = await sharp(buffer).resize({ width: 1200, withoutEnlargement: true }).png().toBuffer();
    const fd = new FormData();
    fd.append('image', src, { filename: 'in.png' });
    const r = await axios.post('https://api.deepai.org/api/torch-srgan', fd, {
      headers: { 'api-key': KEYS.DEEPAI, ...fd.getHeaders() }, timeout: 180000
    });
    if (!r.data.output_url) throw new Error("DeepAI failed");
    const hd = await axios.get(r.data.output_url, { responseType: 'arraybuffer' });
    return await restoreAlpha(Buffer.from(hd.data), buffer); // पारदर्शिता सुरक्षित
  } catch (e) {
    return await sharp(buffer).resize({ width: 3000, withoutEnlargement: true, kernel: 'lanczos3' }).sharpen().png().toBuffer();
  }
}

// 3. Vectorize (Vectorizer.AI)
async function callVectorizerAPI(buffer) {
  const fd = new FormData();
  fd.append('image', await sharp(buffer).flatten({ background: '#ffffff' }).png().toBuffer(), { filename: 'design.png' });
  fd.append('output.file_format', 'pdf');
  fd.append('mode', 'test'); // ⚠️ असली उपयोग के लिए 'production' करें (test में वॉटरमार्क आता है)
  const auth = Buffer.from(`${KEYS.VEC_ID}:${KEYS.VEC_SECRET}`).toString('base64');
  try {
    const r = await axios.post('https://api.vectorizer.ai/api/v1/vectorize', fd, {
      headers: { 'Authorization': `Basic ${auth}`, ...fd.getHeaders() },
      responseType: 'arraybuffer', timeout: 240000
    });
    return Buffer.from(r.data);
  } catch (e) { throw new Error("Vectorizer API failed."); }
}

// 🔥 कटआउट के चारों तरफ की खाली (transparent) जगह हटाना - ताकि डिज़ाइन canvas पर सही साइज़ में बैठे
async function trimTransparent(buf) {
  try {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (data[row + x * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return buf; // पूरा पारदर्शी है तो जैसा है वैसा रहने दें
    if (minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) return buf;
    return await sharp(buf).extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }).png().toBuffer();
  } catch (e) { return buf; }
}

// 🔥 फ्री लोकल कटिंग (कोई API नहीं): सादे/एक रंग के बैकग्राउंड (जैसे सफेद) वाले डिज़ाइन के लिए
// किनारों से शुरू करके बैकग्राउंड रंग वाला हिस्सा हटाता है, इसलिए डिज़ाइन के अंदर की सफेदी सुरक्षित रहती है
async function localColorCut(buffer, tol = 38) {
  const { data, info } = await sharp(buffer).rotate()
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;

  const px = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  const diffTo = (i) => {
    if (data[i + 3] < 10) return 0; // पहले से पारदर्शी
    let best = 999;
    for (const c of corners) {
      const d = Math.max(Math.abs(data[i] - c[0]), Math.abs(data[i + 1] - c[1]), Math.abs(data[i + 2] - c[2]));
      if (d < best) best = d;
    }
    return best;
  };

  const removed = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const tryPush = (x, y) => {
    const p = y * w + x;
    if (removed[p]) return;
    if (diffTo(p * 4) <= tol) { removed[p] = 1; stack[sp++] = p; }
  };
  for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1); }
  for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y); }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w, y = (p - x) / w;
    if (x > 0) tryPush(x - 1, y);
    if (x < w - 1) tryPush(x + 1, y);
    if (y > 0) tryPush(x, y - 1);
    if (y < h - 1) tryPush(x, y + 1);
  }

  // किनारे की हल्की धार (halo) को नरम करना
  const soft = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (removed[p]) continue;
      const nearRemoved = (x > 0 && removed[p - 1]) || (x < w - 1 && removed[p + 1]) || (y > 0 && removed[p - w]) || (y < h - 1 && removed[p + w]);
      if (!nearRemoved) continue;
      const d = diffTo(p * 4);
      if (d <= tol * 2.5) soft.push(p, Math.round(255 * Math.min(1, Math.max(0, (d - tol) / (tol * 1.5)))));
    }
  }
  for (let p = 0; p < w * h; p++) if (removed[p]) data[p * 4 + 3] = 0;
  for (let k = 0; k < soft.length; k += 2) data[soft[k] * 4 + 3] = Math.min(data[soft[k] * 4 + 3], soft[k + 1]);

  return await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

// 🔥 कटी हुई डिज़ाइन को अलग-अलग पार्ट्स (फूल, पट्टी, अक्षर आदि) में बाँटना
// तरीका: पारदर्शिता (alpha) से जुड़े हुए (connected) हिस्से ढूँढना - जो टुकड़े आपस में छू नहीं रहे, वे अलग-अलग पार्ट बनते हैं
// gapPct: पास-पास के टुकड़ों को एक में जोड़ने की दूरी (इमेज के % में); 0 = हर टुकड़ा अलग
// ⚠️ जो हिस्से आपस में छू रहे/ओवरलैप हैं (जैसे फूल के ऊपर पट्टी) वे एक ही पार्ट रहेंगे - उसके लिए SAM जैसा AI चाहिए
async function splitIntoParts(cutBuf, opts = {}) {
  const gapPct = opts.gapPct != null ? opts.gapPct : 0.4;
  const minPct = opts.minPct != null ? opts.minPct : 0.1;
  const maxParts = opts.maxParts || 30;

  const meta = await sharp(cutBuf).metadata();
  const sc = Math.min(1, 3200 / Math.max(meta.width, meta.height));
  const W = Math.max(1, Math.round(meta.width * sc)), H = Math.max(1, Math.round(meta.height * sc));
  const { data } = await sharp(cutBuf).ensureAlpha().resize(W, H).raw().toBuffer({ resolveWithObject: true });

  // छोटा "लेबल-नक्शा" (तेज़ी के लिए)
  const ls = Math.min(1, 700 / Math.max(W, H));
  const lw = Math.max(1, Math.round(W * ls)), lh = Math.max(1, Math.round(H * ls));
  const cellOf = (x, y) => Math.min(lh - 1, Math.floor(y * ls)) * lw + Math.min(lw - 1, Math.floor(x * ls));
  let mask = new Uint8Array(lw * lh);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 8) mask[cellOf(x, y)] = 1;
    }
  }

  // पास-पास के टुकड़े जोड़ने के लिए फैलाव (dilation)
  const r = Math.round((gapPct / 100) * Math.max(lw, lh));
  if (r > 0) {
    const tmp = new Uint8Array(lw * lh), out = new Uint8Array(lw * lh);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      if (!mask[y * lw + x]) continue;
      for (let dx = Math.max(0, x - r); dx <= Math.min(lw - 1, x + r); dx++) tmp[y * lw + dx] = 1;
    }
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      if (!tmp[y * lw + x]) continue;
      for (let dy = Math.max(0, y - r); dy <= Math.min(lh - 1, y + r); dy++) out[dy * lw + x] = 1;
    }
    mask = out;
  }

  // जुड़े हुए हिस्से (connected components)
  const label = new Int32Array(lw * lh);
  const stack = new Int32Array(lw * lh);
  const comps = [];
  for (let s = 0; s < lw * lh; s++) {
    if (!mask[s] || label[s]) continue;
    const id = comps.length + 1;
    let sp = 0, area = 0;
    stack[sp++] = s; label[s] = id;
    while (sp > 0) {
      const p = stack[--sp];
      area++;
      const x = p % lw, y = (p - x) / lw;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < lw - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - lw] && !label[p - lw]) { label[p - lw] = id; stack[sp++] = p - lw; }
      if (y < lh - 1 && mask[p + lw] && !label[p + lw]) { label[p + lw] = id; stack[sp++] = p + lw; }
    }
    comps.push({ id, area });
  }

  const totalArea = comps.reduce((a, c) => a + c.area, 0) || 1;
  const keep = comps.filter(c => c.area / totalArea * 100 >= minPct)
    .sort((a, b) => b.area - a.area).slice(0, maxParts);

  // हर पार्ट की असली (पूरे रेज़ोल्यूशन वाली) इमेज बनाना
  const bbox = new Map(keep.map(c => [c.id, { minX: W, minY: H, maxX: -1, maxY: -1 }]));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] <= 8) continue;
      const b = bbox.get(label[cellOf(x, y)]);
      if (!b) continue;
      if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
    }
  }
  const parts = [];
  for (const c of keep) {
    const b = bbox.get(c.id);
    if (b.maxX < 0) continue;
    const pw = b.maxX - b.minX + 1, ph = b.maxY - b.minY + 1;
    const buf = Buffer.alloc(pw * ph * 4);
    for (let y = b.minY; y <= b.maxY; y++) {
      for (let x = b.minX; x <= b.maxX; x++) {
        const si = (y * W + x) * 4;
        if (data[si + 3] <= 8 || label[cellOf(x, y)] !== c.id) continue;
        const di = ((y - b.minY) * pw + (x - b.minX)) * 4;
        buf[di] = data[si]; buf[di + 1] = data[si + 1]; buf[di + 2] = data[si + 2]; buf[di + 3] = data[si + 3];
      }
    }
    const png = await sharp(buf, { raw: { width: pw, height: ph, channels: 4 } }).png().toBuffer();
    parts.push({ buf: png, x: b.minX, y: b.minY, w: pw, h: ph });
  }
  // पढ़ने के क्रम में (ऊपर से नीचे, बाएँ से दाएँ)
  parts.sort((a, b) => (Math.round(a.y / (H / 12)) - Math.round(b.y / (H / 12))) || (a.x - b.x));
  return { parts, W, H, found: comps.length };
}

// ================= 🔎 "सिर्फ यही हिस्सा अलग करो" - हिस्से का नाम लिखकर (Gemini Vision से जगह ढूँढना) =================
// उदाहरण: "फूल", "heart", "butterfly", "नाम/text" (कॉमा लगाकर कई भी लिख सकते हैं). खाली छोड़ें तो पूरा पहले जैसा कटेगा.
const GEMINI_VISION_MODELS = [process.env.GEMINI_VISION_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean);

function parsePartList(s) {
  return String(s || '').split(/[,;\n،|]+/).map(x => x.trim()).filter(Boolean).slice(0, 8);
}

// Gemini के जवाब (JSON) से बॉक्स निकालना. box_2d = [ymin, xmin, ymax, xmax], 0-1000 के पैमाने पर
function parseBoxes(text) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  let arr;
  try { arr = JSON.parse(t); }
  catch (e) {
    const m = t.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try { arr = JSON.parse(m[0]); } catch (e2) { return []; }
  }
  if (!Array.isArray(arr)) arr = (arr && (arr.items || arr.boxes || arr.detections)) || [];
  const clamp = n => Math.max(0, Math.min(1000, n)) / 1000;
  const boxes = [];
  for (const it of arr) {
    const b = it && (it.box_2d || it.box);
    if (!Array.isArray(b) || b.length !== 4) continue;
    const v = b.map(Number);
    if (v.some(n => !isFinite(n))) continue;
    const y0 = clamp(v[0]), x0 = clamp(v[1]), y1 = clamp(v[2]), x1 = clamp(v[3]);
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) continue;
    boxes.push({ label: String(it.label || '').slice(0, 60), x0, y0, x1, y1 });
  }
  return boxes;
}

async function geminiDetectParts(origBuf, labels) {
  if (!KEYS.GEMINI) throw new Error('GEMINI_KEY नहीं मिली - हिस्से का नाम पहचानने के लिए Gemini चाहिए');
  const small = await sharp(origBuf).rotate().flatten({ background: '#ffffff' })
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const prompt = `This is a design / artwork image. The user typed (in Hindi or English) which part of the design they want to separate: ${labels.map(l => `"${l}"`).join(', ')}. ` +
    `Treat each phrase as a description of an object or part in the image; ignore command words like "अलग करें", "काटें", "separate", "cut". ` +
    `Return ONLY a JSON array. Each item: {"label": "<the part you found>", "box_2d": [ymin, xmin, ymax, xmax]} ` +
    `with coordinates normalized to 0-1000. If a part appears several times, return one item per instance. ` +
    `Do not include parts that are not in the image. If nothing matches, return [].`;
  let lastErr = new Error('कोई Gemini मॉडल उपलब्ध नहीं');
  for (const model of GEMINI_VISION_MODELS) {
    try {
      const r = await axios.post(`${GEM_URL}${model}:generateContent`, {
        contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: small.toString('base64') } }, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 }
      }, { headers: { 'x-goog-api-key': KEYS.GEMINI, 'Content-Type': 'application/json' }, timeout: 60000 });
      const parts = (r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts) || [];
      return parseBoxes(parts.map(p => p.text || '').join(''));
    } catch (e) {
      const detail = e.response && e.response.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
      console.error(`❌ Gemini Vision (${model}) फेल:`, detail);
      lastErr = new Error(`${model}: ${detail}`);
    }
  }
  throw new Error('Gemini से हिस्सा पहचान नहीं हो पाया: ' + lastErr.message);
}

// पारदर्शी हिस्सा काटकर, कहाँ से कटा (x, y) भी बताना
async function trimWithOffset(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pw = maxX - minX + 1, ph = maxY - minY + 1;
  const out = (pw === w && ph === h) ? await sharp(buf).png().toBuffer()
    : await sharp(buf).extract({ left: minX, top: minY, width: pw, height: ph }).png().toBuffer();
  return { buf: out, x: minX, y: minY, w: pw, h: ph };
}

// बाकी हिस्से से चुने हुए टुकड़ों के पिक्सल पूरी तरह हटाना (किनारे की धार भी नहीं बचती)
async function eraseContribs(baseBuf, W, H, contribs) {
  const { data } = await sharp(baseBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const c of contribs) {
    const { data: cd, info } = await sharp(c.buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < info.height; y++) {
      const by = y + c.top;
      if (by < 0 || by >= H) continue;
      for (let x = 0; x < info.width; x++) {
        if (cd[(y * info.width + x) * 4 + 3] === 0) continue;
        const bx = x + c.left;
        if (bx < 0 || bx >= W) continue;
        data[(by * W + bx) * 4 + 3] = 0;
      }
    }
  }
  return await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

// कौन-सा टुकड़ा किस बॉक्स में आता है (बॉक्स 0-1 के पैमाने पर, टुकड़े पिक्सल में)
function selectPiecesByBoxes(pieces, boxes, W, H) {
  const bpx = boxes.map((b, i) => ({ i, label: b.label, x0: b.x0 * W, y0: b.y0 * H, x1: b.x1 * W, y1: b.y1 * H }));
  return pieces.map(p => {
    const pa = p.w * p.h;
    for (const b of bpx) {
      const ix0 = Math.max(p.x, b.x0), iy0 = Math.max(p.y, b.y0);
      const ix1 = Math.min(p.x + p.w, b.x1), iy1 = Math.min(p.y + p.h, b.y1);
      if (ix1 <= ix0 || iy1 <= iy0) continue;
      const inter = (ix1 - ix0) * (iy1 - iy0), ba = (b.x1 - b.x0) * (b.y1 - b.y0);
      const ratioP = inter / pa, ratioB = inter / ba;
      // टुकड़ा ज़्यादातर बॉक्स के अंदर → पूरा टुकड़ा चुना
      if (ratioP >= 0.7) return { sel: true, crop: null, label: b.label, boxIndex: b.i };
      // टुकड़ा बॉक्स से बड़ा है (कई चीज़ें आपस में जुड़ी हैं) → सिर्फ बॉक्स वाला हिस्सा काटो
      if (ratioB >= 0.4 && pa > 1.25 * ba) {
        return { sel: true, label: b.label, boxIndex: b.i,
          crop: { x: Math.round(ix0), y: Math.round(iy0), w: Math.max(1, Math.round(ix1 - ix0)), h: Math.max(1, Math.round(iy1 - iy0)) } };
      }
      // बराबर साइज़ का टुकड़ा, आधा-ज़्यादा बॉक्स में → पूरा टुकड़ा
      if (ratioP >= 0.5) return { sel: true, crop: null, label: b.label, boxIndex: b.i };
    }
    return { sel: false };
  });
}

// चुने हुए हिस्से (हर बॉक्स का एक अलग हिस्सा) + बाकी हिस्सा (जैसा था वैसा)
async function assemblePartResult(pieces, boxes, W, H, baseBuf) {
  const sel = selectPiecesByBoxes(pieces, boxes, W, H);
  const groups = new Map();
  for (let i = 0; i < pieces.length; i++) {
    const s = sel[i];
    if (!s.sel) continue;
    const p = pieces[i];
    let contrib;
    if (s.crop) {
      const left = Math.max(0, s.crop.x - p.x), top = Math.max(0, s.crop.y - p.y);
      const cw = Math.min(p.w - left, s.crop.w), ch = Math.min(p.h - top, s.crop.h);
      if (cw < 1 || ch < 1) continue;
      const sub = await sharp(p.buf).extract({ left, top, width: cw, height: ch }).png().toBuffer();
      contrib = { buf: sub, left: p.x + left, top: p.y + top };
    } else {
      contrib = { buf: p.buf, left: p.x, top: p.y };
    }
    if (!groups.has(s.boxIndex)) groups.set(s.boxIndex, { label: s.label, list: [] });
    groups.get(s.boxIndex).list.push(contrib);
  }

  const selected = [];
  const erase = [];
  for (const g of groups.values()) {
    const union = await sharp(await blankCanvas(W, H))
      .composite(g.list.map(c => ({ input: c.buf, left: c.left, top: c.top }))).png().toBuffer();
    const t = await trimWithOffset(union);
    if (t) selected.push({ buf: t.buf, x: t.x, y: t.y, w: t.w, h: t.h, label: g.label });
    for (const c of g.list) erase.push({ buf: c.buf, left: c.left, top: c.top });
  }

  let restImg = baseBuf;
  if (erase.length) restImg = await eraseContribs(baseBuf, W, H, erase);
  const rest = await trimWithOffset(restImg);
  return { selected, rest, W, H };
}

// सारे चुने हुए हिस्से एक ही इमेज में (जैसे "सिर्फ कटिंग" के लिए)
async function unionSelected(selected, W, H) {
  const u = await sharp(await blankCanvas(W, H))
    .composite(selected.map(p => ({ input: p.buf, left: p.x, top: p.y }))).png().toBuffer();
  return await trimWithOffset(u);
}

const NOT_FOUND_MSG = labels => `"${labels.join(', ')}" इमेज में नहीं मिला। दूसरा शब्द लिखकर देखें (अंग्रेज़ी में भी चलेगा), जैसे: flower, heart, butterfly, text`;

// कटी हुई पूरी डिज़ाइन (cutBuf, बिना trim) से सिर्फ लिखा हुआ हिस्सा अलग करना
async function extractNamedParts(origBuf, cutBuf, partText) {
  const labels = parsePartList(partText);
  const boxes = await geminiDetectParts(origBuf, labels);
  if (!boxes.length) throw new Error(NOT_FOUND_MSG(labels));
  const { parts: pieces, W, H } = await splitIntoParts(cutBuf, { gapPct: 0.4, minPct: 0.02, maxParts: 80 });
  const base = await sharp(cutBuf).ensureAlpha().resize(W, H, { fit: 'fill' }).png().toBuffer();
  const r = await assemblePartResult(pieces, boxes, W, H, base);
  if (!r.selected.length) throw new Error(`"${labels.join(', ')}" की जगह मिली, पर कटी हुई डिज़ाइन में वहाँ कोई टुकड़ा नहीं मिला। कटिंग का तरीका बदलकर देखें।`);
  return Object.assign({ found: boxes.length }, r);
}

// 🔥 स्मार्ट कटिंग: चुना हुआ तरीका → remove.bg फेल हो तो फ्री लोकल कटिंग → फिर भी न हो तो मूल इमेज
// mode: auto | graphic | person | local
async function smartCut(buf, mode = 'auto', opts = {}) {
  // 'none' = फाइल पहले से कटी हुई (transparent PNG) है, कटिंग छोड़ दो
  if (mode === 'none') {
    try { const png = await sharp(buf).ensureAlpha().png().toBuffer(); return opts.trim === false ? png : await trimTransparent(png); } catch (e) { return buf; }
  }
  let out = null;
  if (mode !== 'local') {
    // जिस-जिस सेवा की key लगी है, उसी क्रम में आज़माएँगे
    const chain = [];
    if (KEYS.REMOVEBG) chain.push(['remove.bg', () => callRemoveBgAPI(buf, mode)]);
    if (KEYS.CLIPDROP) chain.push(['Clipdrop', () => callClipdropRemoveBg(buf)]);
    if (KEYS.PHOTOROOM) chain.push(['Photoroom', () => callPhotoroomRemoveBg(buf)]);
    for (const [label, fn] of chain) {
      try { out = await fn(); if (out) { console.log('✂️ कटिंग हुई:', label); break; } }
      catch (e) { console.error(`⚠️ ${label} फेल:`, e.message); out = null; }
    }
  }
  if (!out) {
    console.log('✂️ फ्री लोकल कटिंग आज़मा रहे हैं...');
    try { out = await localColorCut(buf); }
    catch (e) { console.error('⚠️ लोकल कटिंग भी फेल:', e.message); }
  }
  if (!out) return buf;
  return opts.trim === false ? out : await trimTransparent(out); // trim:false = फ्रेम वैसा ही (हिस्से की जगह पहचानने के लिए)
}

// Recraft - AI बैकग्राउंड/डिज़ाइन बनाना (वैकल्पिक)
async function callRecraftAPI(prompt, aspect) {
  const sizeMap = { '2:3': '1024x1536', '3:2': '1536x1024', '1:1': '1024x1024', 'card': '1536x1024', 'wedding': '1024x1536', 'banner': '2048x1024' };
  const r = await axios.post(process.env.RECRAFT_URL || 'https://external.api.recraft.ai/v1/images/generations', {
    prompt: String(prompt).slice(0, 950),
    style: 'digital_illustration',
    size: sizeMap[aspect] || '1024x1536',
    n: 1
  }, { headers: { 'Authorization': `Bearer ${KEYS.RECRAFT}`, 'Content-Type': 'application/json' }, timeout: 90000 });
  const url = r.data && r.data.data && r.data.data[0] && r.data.data[0].url;
  if (!url) throw new Error('Recraft ने इमेज नहीं दी');
  const img = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(img.data);
}

// 4. AI Background Generator (पहले Gemini → फिर Pollinations → फिर ग्रेडिएंट)
async function callRecraftStabilityAPI(prompt, aspect = '2:3') {
  const BG_SUFFIX = '. Background design only, vibrant, professional, no people, no text.';
  const finalPrompt = (prompt && prompt.trim() !== '') ? prompt : 'luxury royal gold background, professional poster design';

  // 🔥 1. सबसे पहले Gemini
  try {
    console.log("⏳ Gemini से बैकग्राउंड माँग रहे हैं...");
    const validAspects = ['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'];
    const mappedAspect = ASPECT_TO_GEMINI[aspect] || aspect;
    const geminiAspect = validAspects.includes(mappedAspect) ? mappedAspect : null; // 'custom' जैसी वैल्यू Gemini में चलती नहीं
    const img = await callGeminiImage(finalPrompt + BG_SUFFIX, geminiAspect);
    if (img && img.length > 1000) {
      console.log("✅ Gemini से बैकग्राउंड मिल गया!");
      lastBgSource = 'gemini';
      return img;
    }
    throw new Error("Gemini की इमेज बहुत छोटी/खाली है");
  } catch (geminiError) {
    console.error("❌ Gemini फेल:", geminiError.message);

    // 🔥 2. Gemini फेल हो तो Recraft (अगर key हो)
    if (KEYS.RECRAFT) {
      try {
        console.log("⏳ अब Recraft से बैकग्राउंड माँग रहे हैं...");
        const rimg = await callRecraftAPI(finalPrompt + BG_SUFFIX, aspect);
        if (rimg && rimg.length > 1000) { lastBgSource = 'recraft'; return rimg; }
      } catch (re) { console.error("❌ Recraft फेल:", re.message); }
    }

    // 🔥 3. फिर Pollinations
    try {
      console.log("⏳ अब Pollinations.ai से बैकग्राउंड माँग रहे हैं...");
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(finalPrompt + BG_SUFFIX) +
        '?width=1024&height=1536&nologo=true&seed=' + Math.floor(Math.random() * 100000);

      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });

      if (r.data && r.data.byteLength > 1000) {
        console.log("✅ Pollinations.ai से बैकग्राउंड मिल गया!");
        lastBgSource = 'pollinations';
        return Buffer.from(r.data);
      }
      throw new Error("Pollinations returned empty image");
    } catch (pollError) {
      // 🔥 3. दोनों फेल → सुंदर ग्रेडिएंट (ताकि सफेद न दिखे)
      console.error("❌ Pollinations भी फेल:", pollError.message, "→ डिफ़ॉल्ट ग्रेडिएंट बना रहे हैं।");
      lastBgSource = 'gradient';
      const svgGradient = `<svg width="1024" height="1536" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)" />
      </svg>`;
      return await sharp(Buffer.from(svgGradient)).png().toBuffer();
    }
  }
}

// 5. 3D स्टाइलिश टेक्स्ट बनाना
async function generateStylishText(text, style = '3D golden') {
  try {
    const prompt = `Generate a beautiful, high quality, transparent PNG (no background) of the text "${text}" written in ${style} font style. Make it look premium, 3D, and print-ready. The text should be perfectly aligned and centered.`;
    return await callGeminiImage(prompt);
  } catch (e) {
    console.error("Stylish Text Error:", e.message);
    return null;
  }
}

// ================= 🔥 HELPER: DYNAMIC FULL CIRCLE PATH =================
function buildFullCirclePath(text, fontSizePx, centerX, centerY) {
  const textWidth = text.length * fontSizePx * 0.6;
  let r = textWidth / (2 * Math.PI);
  if (r < 10) r = 10;
  const top = centerY - r;
  const bottom = centerY + r;
  return {
    radius: r,
    path: `M ${centerX} ${top} A ${r} ${r} 0 1 1 ${centerX} ${bottom} A ${r} ${r} 0 1 1 ${centerX} ${top}`
  };
}

// 6. Compose
// 🔥 पूरे canvas जितनी खाली (transparent) PNG - लेयर्स अलग-अलग सेव करने के लिए
async function blankCanvas(W, H) {
  return await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
}

// 🔥 ब्राउज़र में बनी नाम की PNG को सही जगह/साइज़ में बैठाने के लिए (canvas से बाहर निकला हिस्सा पहले ही काट देता है)
async function buildNameOverlay(nameBuf, W, H, xPct, yPct, wFrac) {
  const meta = await sharp(nameBuf).metadata();
  const sw = meta.width, sh = meta.height;
  const k = (parseFloat(wFrac) * W) / sw;
  if (!isFinite(k) || k <= 0) return null;

  const cx = (parseFloat(xPct) / 100) * W;
  const cy = (parseFloat(yPct) / 100) * H;
  const left = cx - (k * sw) / 2, top = cy - (k * sh) / 2;
  const right = left + k * sw, bottom = top + k * sh;

  const vl = Math.max(0, left), vt = Math.max(0, top);
  const vr = Math.min(W, right), vb = Math.min(H, bottom);
  const dw = Math.floor(vr - vl), dh = Math.floor(vb - vt);
  if (dw < 1 || dh < 1) return null;

  const sx = Math.max(0, Math.floor((vl - left) / k));
  const sy = Math.max(0, Math.floor((vt - top) / k));
  const cw = Math.max(1, Math.min(sw - sx, Math.ceil((vr - vl) / k)));
  const ch = Math.max(1, Math.min(sh - sy, Math.ceil((vb - vt) / k)));

  const input = await sharp(nameBuf)
    .extract({ left: sx, top: sy, width: cw, height: ch })
    .resize({ width: dw, height: dh, fit: 'fill' })
    .png().toBuffer();
  return { input, left: Math.floor(vl), top: Math.floor(vt) };
}

async function callKittlComposeAPI(bgBuf, cutBuf, aspect, name, textImageBuf = null, customW = null, customH = null, curveVal = 0, angleVal = 0, textColor = '#ffffff', fontSizeVal = 10, boldVal = 'normal', italicVal = 'normal', textStyle = 'normal', fontFamilyVal = 'Arial, sans-serif', textXVal = 50, textYVal = 25, nameLayerBuf = null, nameWFrac = 0, layersOut = null) {
  let W, H;
  if (customW && customH) {
    W = parseInt(customW);
    H = parseInt(customH);
  } else {
    // 300 DPI पर: card = 3.5x2 इंच, wedding = 5x7 इंच, banner = 3:1
    const sizeMap = { '2:3': [2000, 3000], '1:1': [2400, 2400], '3:2': [3000, 2000], 'card': [1050, 600], 'wedding': [1500, 2100], 'banner': [3600, 1200] };
    [W, H] = sizeMap[aspect] || sizeMap['2:3'];
  }

  // 🔥 बहुत बड़ा/गलत साइज़ सर्वर की मेमोरी न खा ले
  if (!(W > 0 && H > 0)) { W = 2000; H = 3000; }
  const MAXSIDE = 8000, MAXPIX = 30e6;
  let shrink = Math.min(1, MAXSIDE / Math.max(W, H), Math.sqrt(MAXPIX / (W * H)));
  if (shrink < 1) { W = Math.floor(W * shrink); H = Math.floor(H * shrink); }

  let bgCanvas = bgBuf ? await sharp(bgBuf).resize(W, H, { fit: 'cover', position: 'center' }).png().toBuffer()
    : await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).png().toBuffer();

  const cutMeta = await sharp(cutBuf).metadata();
  let targetH = Math.floor(H * 0.74);
  let targetW = Math.floor(cutMeta.width * (targetH / cutMeta.height));
  // अगर कटआउट canvas से चौड़ा हो जाए तो चौड़ाई के हिसाब से छोटा करें
  if (targetW > W * 0.92) {
    targetW = Math.floor(W * 0.92);
    targetH = Math.floor(cutMeta.height * (targetW / cutMeta.width));
  }
  const cutResized = await sharp(cutBuf).resize({ width: targetW, height: targetH, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

  const x = Math.max(0, Math.floor((W - targetW) / 2));
  const y = Math.max(0, Math.min(Math.floor((H - targetH) / 2 + H * 0.05), H - targetH));
  let composed = await sharp(bgCanvas).composite([{ input: cutResized, left: x, top: y }]).png().toBuffer();

  let textLayerInput = null; // नाम/3D टेक्स्ट की इमेज + पोज़िशन (अलग लेयर बनाने के लिए)
  let svgLayer = null;       // सर्वर-SVG वाले नाम की लेयर

  if (textImageBuf) {
    try {
      const textResized = await sharp(textImageBuf).resize({ width: Math.floor(W * 0.7) }).png().toBuffer();
      const textMeta = await sharp(textResized).metadata();
      const tx = Math.max(0, Math.floor((W - textMeta.width) / 2));
      const ty = Math.floor(H * 0.15);
      composed = await sharp(composed).composite([{ input: textResized, left: tx, top: ty }]).png().toBuffer();
      textLayerInput = { input: textResized, left: tx, top: ty };
    } catch (err) {
      console.error("3D Text Compose Failed, skipping...");
      textImageBuf = null;
    }
  }

  // 🔥 नाम - पहला तरीका: ब्राउज़र में बनी PNG (हिंदी/कोई भी फॉन्ट, कर्व, रोटेशन सब हूबहू एडिटर जैसा)
  let nameDrawn = false;
  if (!textImageBuf && nameLayerBuf) {
    try {
      const ov = await buildNameOverlay(nameLayerBuf, W, H, textXVal, textYVal, nameWFrac);
      if (ov) {
        composed = await sharp(composed).composite([ov]).png().toBuffer();
        textLayerInput = ov;
        nameDrawn = true;
      }
    } catch (err) {
      console.error("नाम की PNG लगाने में दिक्कत:", err.message);
    }
  }

  // 🔥 नाम - दूसरा तरीका (बैकअप): सर्वर पर SVG से
  if (!textImageBuf && !nameDrawn && name) {
    const safeName = escapeXml(name);
    // हिंदी/Noto फॉन्ट फॉलबैक जोड़ा ताकि चुना हुआ फॉन्ट न मिले तो भी अक्षर गायब न हों
    const safeFont = escapeXml(fontFamilyVal + ", 'Noto Sans Devanagari', 'Noto Sans', sans-serif");
    if (/[\u0900-\u097F]/.test(name)) console.log('ℹ️ नाम हिंदी (Devanagari) में है - सर्वर में Noto Sans Devanagari फॉन्ट होना ज़रूरी है');

    let fs2 = Math.floor(H * (parseFloat(fontSizeVal) / 100));
    if (isNaN(fs2) || fs2 < 10) fs2 = 100;

    // नाम वहीं छपेगा जहाँ एडिटर में ड्रैग करके रखा था (textXVal/textYVal = % में)
    const tx0 = parseFloat(textXVal), ty0 = parseFloat(textYVal);
    const pxX = ((isNaN(tx0) ? 50 : tx0) / 100) * W;
    const pxY = ((isNaN(ty0) ? 25 : ty0) / 100) * H;

    const maxWidth = W * 0.9;
    let estWidth = name.length * fs2 * 0.6;
    if (estWidth > maxWidth) fs2 = Math.floor(fs2 * (maxWidth / estWidth));

    let pathD = "";
    const curve = parseFloat(curveVal) || 0;
    const uniqueId = "path_" + Date.now();
    let extraTransform = "";

    // एडिटर का angle भी लागू होता है ('तिरछा' = angle + 45)
    const angNum = parseFloat(angleVal) || 0;
    const totalAngle = angNum + (textStyle === 'rotate' ? 45 : 0);
    if (totalAngle !== 0) {
      extraTransform = `transform="rotate(${totalAngle} ${pxX} ${pxY})"`;
    }

    if (textStyle === 'full_circle') {
      const circle = buildFullCirclePath(name, fs2, pxX, pxY);
      pathD = circle.path;
    } else if (textStyle === 'round') {
      const controlY = pxY - (50 * 3);
      const startX = pxX - 200;
      const endX = pxX + 200;
      pathD = `M ${startX} ${pxY} Q ${pxX} ${controlY} ${endX} ${pxY}`;
    } else if (curve === 0) {
      const textLength = name.length * fs2 * 0.6;
      const startX = pxX - textLength / 2;
      const endX = pxX + textLength / 2;
      pathD = `M ${startX} ${pxY} L ${endX} ${pxY}`;
    } else {
      const textLength = name.length * fs2 * 0.6;
      const startX = pxX - textLength / 2;
      const endX = pxX + textLength / 2;
      const controlY = pxY - (curve * 3);
      pathD = `M ${startX} ${pxY} Q ${pxX} ${controlY} ${endX} ${pxY}`;
    }

    let svgText = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <path id="${uniqueId}" d="${pathD}" fill="transparent" />
      <text font-family="${safeFont}" font-weight="${escapeXml(boldVal)}" font-style="${escapeXml(italicVal)}" font-size="${fs2}" fill="${escapeXml(textColor)}" ${extraTransform}>
        <textPath href="#${uniqueId}" xlink:href="#${uniqueId}" startOffset="50%" text-anchor="middle">${safeName}</textPath>
      </text>
    </svg>`;

    // सीधा नाम (बिना curve) - textPath की जगह साधारण <text>, जो हर SVG रेंडरर में पक्का चलता है
    if (textStyle !== 'full_circle' && textStyle !== 'round' && textStyle !== 'vertical' && curve === 0) {
      svgText = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <text x="${pxX}" y="${pxY}" text-anchor="middle" font-family="${safeFont}" font-weight="${escapeXml(boldVal)}" font-style="${escapeXml(italicVal)}" font-size="${fs2}" fill="${escapeXml(textColor)}" ${extraTransform}>${safeName}</text>
      </svg>`;
    }

    // खड़ा (vertical) स्टाइल
    if (textStyle === 'vertical') {
      svgText = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <text x="${pxX}" y="${pxY}" text-anchor="middle" font-family="${safeFont}" font-weight="${escapeXml(boldVal)}" font-style="${escapeXml(italicVal)}" font-size="${fs2}" fill="${escapeXml(textColor)}" transform="rotate(${90 + angNum} ${pxX} ${pxY})">${safeName}</text>
      </svg>`;
    }

    composed = await sharp(composed).composite([{ input: Buffer.from(svgText), top: 0, left: 0 }]).png().toBuffer();
    svgLayer = svgText;
  }

  // 🔥 अलग-अलग लेयर्स (सब एक ही साइज़ के, ताकि Photoshop/Canva में एक के ऊपर एक ठीक बैठें)
  if (layersOut) {
    layersOut.bg = bgCanvas;
    layersOut.cut = await sharp(await blankCanvas(W, H)).composite([{ input: cutResized, left: x, top: y }]).png().toBuffer();
    if (textLayerInput) {
      layersOut.text = await sharp(await blankCanvas(W, H)).composite([textLayerInput]).png().toBuffer();
    } else if (svgLayer) {
      layersOut.text = await sharp(await blankCanvas(W, H)).composite([{ input: Buffer.from(svgLayer), top: 0, left: 0 }]).png().toBuffer();
    }
  }

  return composed;
}

// 7. Watermark
async function addWatermark(buffer, text = "PREVIEW - AI DESIGN STUDIO") {
  try {
    const meta = await sharp(buffer).metadata();
    const W = meta.width, H = meta.height;
    const fontSize = Math.max(28, Math.floor(H * 0.045));
    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
    for (let y = 40; y < H; y += 200) {
      for (let x = -100; x < W; x += 300) {
        svg += `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" fill="rgba(255,40,40,0.3)" transform="rotate(-25 ${x + 80} ${y})">${escapeXml(text)}</text>`;
      }
    }
    svg += `</svg>`;
    return await sharp(buffer).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  } catch (e) { return buffer; }
}

// 8. Python SAM Server से लेयर्स लाना
async function splitIntoLayersUsingPython(buffer) {
  try {
    const fd = new FormData();
    fd.append('file', buffer, { filename: 'design.png' });

    const PYTHON_SAM_URL = process.env.SAM_SERVER_URL || 'http://localhost:8000/split-layers';
    console.log("⏳ Python SAM सर्वर से लेयर्स माँग रहे हैं...");

    const r = await axios.post(PYTHON_SAM_URL, fd, {
      headers: { ...fd.getHeaders() },
      timeout: 300000
    });

    if (!r.data.success) throw new Error(r.data.error || "SAM failed");

    const layerBuffers = r.data.layers.map(base64Str => Buffer.from(base64Str, 'base64'));
    console.log(`✅ SAM से ${layerBuffers.length} लेयर्स मिल गईं!`);
    return layerBuffers;
  } catch (e) {
    console.error("❌ SAM सर्वर एरर:", e.message);
    throw new Error("SAM सर्वर से कनेक्ट नहीं हो पाया। क्या Python सर्वर चालू है?");
  }
}

function saveOut(buf, prefix, ext = 'png') {
  const name = `${prefix}_${Date.now()}_${nanoid(6)}.${ext}`;
  fs.writeFileSync(path.join(OUTPUT_DIR, name), buf);
  return '/outputs/' + name;
}

// ================= API ROUTES =================

// 1. FULL AUTO (सभी फीचर्स के साथ)
app.post('/api/auto', uploadWithName, async (req, res) => {
  try {
    const { prompt = '', name = '', aspect = '2:3', customW, customH, use3d = 'false', curve = 0, angle = 0, textColor = '#ffffff', fontSize = 10, isBold = 'normal', isItalic = 'normal', textStyle = 'normal', fontFamily = 'Arial, sans-serif', textX = 50, textY = 25, nameWFrac = 0, cutMode = 'auto' } = req.body;
    const inputBuf = fs.readFileSync(req.file.path);
    const nameBuf = req.nameFile ? fs.readFileSync(req.nameFile.path) : null;
    const layers = {};
    const steps = {};
    console.log('📝 /api/auto → नाम:', JSON.stringify(name), '| ब्राउज़र-PNG:', nameBuf ? 'हाँ' : 'नहीं', '| पोज़िशन:', textX, textY, '| स्टाइल:', textStyle, '| 3D:', use3d);

    let cut;
    cut = await smartCut(inputBuf, cutMode); // इंसान ही नहीं, कोई भी डिज़ाइन/लोगो/ग्राफिक
    steps.cutPreview = saveOut(await addWatermark(cut), 'cut');
    steps.cutRaw = saveOut(cut, 'cut_raw'); // बिना वॉटरमार्क, transparent कटआउट

    let hd;
    try { hd = await callHDUpscaleAPI(cut); } catch (e) { hd = cut; }
    steps.hdPreview = saveOut(await addWatermark(hd), 'hd');

    let bg = null;
    try { bg = await callRecraftStabilityAPI(prompt, aspect); } catch (e) {}
    if (bg) steps.bgPreview = saveOut(bg, 'bg');
    steps.bgSource = lastBgSource;

    let textImg = null;
    if (name && use3d === 'true') {
      textImg = await generateStylishText(name);
    }

    const final = await callKittlComposeAPI(bg, hd, aspect, name, textImg, customW, customH, curve, angle, textColor, fontSize, isBold, isItalic, textStyle, fontFamily, textX, textY, nameBuf, nameWFrac, layers);
    steps.finalPreview = saveOut(await addWatermark(final), 'final_wm');
    steps.finalRaw = saveOut(await withDpi(final), 'final'); // 300 DPI
    const fm = await sharp(final).metadata();
    steps.size = { W: fm.width, H: fm.height };

    // 🔥 अलग-अलग लेयर्स (सब एक ही साइज़ की transparent PNG)
    if (layers.cut) steps.layerCut = saveOut(await withDpi(layers.cut), 'layer_cut');
    if (layers.bg) steps.layerBg = saveOut(await withDpi(layers.bg), 'layer_bg');
    if (layers.text) steps.layerText = saveOut(await withDpi(layers.text), 'layer_text');

    res.json({ success: true, steps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// 2. SPLIT + TRACE (Python SAM + Vectorizer)
// SAM सर्वर न चले तो मुख्य ऐप के अंदर वाला फ्री तरीका अपने आप चलता है. "part" लिखा हो तो सिर्फ वही हिस्सा अलग + वेक्टर होता है.
app.post('/api/split-and-trace', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const partText = String(req.body.part || '').trim();
    const cutMode = req.body.cutMode || 'auto';

    // 1) लेयर्स: पहले SAM सर्वर, न चले तो फ्री तरीका
    let layers = null, FW = 0, FH = 0, usedSam = false;
    try {
      const raw = await splitIntoLayersUsingPython(buf);
      if (raw.length > 0) {
        const m = await sharp(raw[0]).metadata();
        FW = m.width; FH = m.height; usedSam = true;
        layers = raw.map(b => ({ buf: b, x: 0, y: 0, w: FW, h: FH, full: true }));
      }
    } catch (samErr) {
      console.error('⚠️ SAM सर्वर नहीं चला → मुख्य ऐप वाला फ्री तरीका आज़मा रहे हैं:', samErr.message);
    }
    if (!layers) {
      const cutFull = await smartCut(buf, cutMode, { trim: false });
      const small = await sharp(cutFull).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      const sp = await splitIntoParts(small, { gapPct: 0.4, maxParts: 12 });
      FW = sp.W; FH = sp.H;
      layers = sp.parts.map(p => ({ buf: p.buf, x: p.x, y: p.y, w: p.w, h: p.h, full: false }));
    }
    if (layers.length === 0) {
      throw new Error("कोई भी लेयर नहीं बन पाई।");
    }

    const results = [];
    const editorList = [];
    const vectorize = async (b, name) => {
      try { return saveOut(await callVectorizerAPI(b), name, 'pdf'); } catch (e) { return null; }
    };

    if (partText) {
      // 2अ) सिर्फ लिखा हुआ हिस्सा अलग (और सिर्फ उसी का वेक्टर); बाकी हिस्सा जैसा था वैसा
      const pieces = [];
      for (const l of layers) {
        if (!l.full) { pieces.push(l); continue; }
        const t = await trimWithOffset(l.buf);
        if (t) pieces.push(t);
      }
      const labels = parsePartList(partText);
      const boxes = await geminiDetectParts(buf, labels);
      if (!boxes.length) throw new Error(NOT_FOUND_MSG(labels));
      const base = await sharp(await blankCanvas(FW, FH))
        .composite(pieces.map(p => ({ input: p.buf, left: p.x, top: p.y }))).png().toBuffer();
      const r = await assemblePartResult(pieces, boxes, FW, FH, base);
      if (!r.selected.length) throw new Error(`"${labels.join(', ')}" की जगह मिली, पर वहाँ कोई लेयर नहीं मिली।`);

      for (let i = 0; i < r.selected.length; i++) {
        const p = r.selected[i];
        const previewPng = saveOut(await addWatermark(p.buf), `layer_part_${i + 1}_wm`);
        const rawPng = saveOut(p.buf, `layer_part_${i + 1}_raw`);
        const vectorPdf = await vectorize(p.buf, `vector_part_${i + 1}`);
        results.push({ layerNumber: i + 1, previewPng, rawPng, vectorPdf, label: p.label ? `सिर्फ: ${p.label}` : `चुना हुआ हिस्सा ${i + 1}` });
        editorList.push({ url: rawPng, x: p.x, y: p.y, w: p.w, h: p.h, label: p.label });
      }
      if (r.rest) {
        const previewPng = saveOut(await addWatermark(r.rest.buf), 'layer_rest_wm');
        const rawPng = saveOut(r.rest.buf, 'layer_rest_raw');
        results.push({ layerNumber: results.length + 1, previewPng, rawPng, vectorPdf: null, label: 'बाकी हिस्सा (जैसा था)' });
        editorList.push({ url: rawPng, x: r.rest.x, y: r.rest.y, w: r.rest.w, h: r.rest.h, label: 'बाकी हिस्सा' });
      }
    } else {
      // 2ब) पहले जैसा: हर लेयर अलग + वेक्टर
      for (let i = 0; i < layers.length; i++) {
        const l = layers[i];
        const wmPng = await addWatermark(l.buf);

        const previewPng = saveOut(wmPng, `layer_${i + 1}_wm`);
        const rawPng = saveOut(l.buf, `layer_${i + 1}_raw`);
        const vectorPdf = await vectorize(l.buf, `vector_layer_${i + 1}`);

        results.push({ layerNumber: i + 1, previewPng, rawPng, vectorPdf });
        editorList.push({ url: rawPng, x: l.x, y: l.y, w: l.w, h: l.h });
      }
    }

    res.json({ success: true, total: results.length, usedSam, results, editorParts: { cw: FW, ch: FH, parts: editorList } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// 3. CUTOUT ONLY
app.post('/api/cutout', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const cutMode = req.body.cutMode || (req.body.person === 'true' ? 'person' : 'auto');

    // 🔎 हिस्से का नाम लिखा हो तो सिर्फ वही हिस्सा कटेगा (और बाकी हिस्सा अलग से, जैसा था वैसा)
    const partText = String(req.body.part || '').trim();
    if (partText) {
      const cutFull = await smartCut(buf, cutMode, { trim: false });
      const r = await extractNamedParts(buf, cutFull, partText);
      const u = await unionSelected(r.selected, r.W, r.H);
      const preview = saveOut(await addWatermark(u.buf), 'cutpart_wm');
      const finalRaw = saveOut(await withDpi(u.buf), 'cutpart_raw');
      const parts = r.selected.map((p, i) => ({ url: saveOut(p.buf, `part_${i + 1}`), x: p.x, y: p.y, w: p.w, h: p.h, label: p.label }));
      let restRaw = null;
      if (r.rest) {
        restRaw = saveOut(await withDpi(r.rest.buf), 'cut_rest');
        parts.push({ url: restRaw, x: r.rest.x, y: r.rest.y, w: r.rest.w, h: r.rest.h, label: 'बाकी हिस्सा' });
      }
      return res.json({ success: true, preview, finalRaw, restRaw, found: r.selected.length, editorParts: { cw: r.W, ch: r.H, parts } });
    }

    const out = await smartCut(buf, cutMode);

    const preview = saveOut(await addWatermark(out), 'cut_wm');
    const finalRaw = saveOut(out, 'cut_raw');

    res.json({ success: true, preview, finalRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// 4. UPSCALE ONLY
app.post('/api/upscale', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const out = await callHDUpscaleAPI(buf);

    const preview = saveOut(await addWatermark(out), 'hd_wm');
    const finalRaw = saveOut(out, 'hd_raw');

    res.json({ success: true, preview, finalRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// 5. VECTORIZE ONLY
app.post('/api/vectorize', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const out = await callVectorizerAPI(buf);
    const url = saveOut(out, 'vector', 'pdf');
    res.json({ success: true, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// 6. BACKGROUND ONLY
app.post('/api/background', async (req, res) => {
  try {
    const { prompt = '', aspect = '2:3' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const out = await callRecraftStabilityAPI(prompt, aspect);
    const preview = saveOut(out, 'bg');
    res.json({ success: true, preview });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. AUTO VARIATIONS (5 नए डिज़ाइन - साइज़/उपयोग के हिसाब से अलग-अलग स्टाइल)
const STYLE_SETS = {
  default: [
    "luxury royal gold background, professional poster design",
    "modern minimalist gradient background, clean design",
    "vintage floral pattern background, traditional design",
    "cyberpunk neon dark background, futuristic design",
    "elegant marble texture background, luxury design"
  ],
  wedding: [
    "royal red and gold mandala floral background, indian wedding card style",
    "elegant ivory paisley pattern background with fine gold border",
    "traditional marigold flower border background, festive indian wedding",
    "soft pastel watercolor floral background, elegant invitation",
    "dark maroon velvet background with gold ornaments, luxury invitation"
  ],
  card: [
    "clean modern geometric background, corporate, subtle",
    "dark navy gradient background with thin gold lines, premium business card",
    "minimal white marble texture background, elegant",
    "bold abstract colour blocks background, creative studio",
    "soft pastel gradient background, modern and clean"
  ],
  banner: [
    "vibrant festive celebration background with light rays, wide banner",
    "bold sale promotion abstract background in red and yellow, wide banner",
    "dark premium background with golden glow, wide banner",
    "colourful gradient bokeh background, wide banner",
    "traditional indian festival background with blurred diyas and flowers, wide banner"
  ]
};

app.post('/api/variations', uploadWithName, async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const { name = '', aspect = '2:3', prompt = '', cutMode = 'auto', customW, customH, curve = 0, angle = 0, textColor = '#ffffff', fontSize = 10, isBold = 'normal', isItalic = 'normal', textStyle = 'normal', fontFamily = 'Arial, sans-serif', textX = 50, textY = 25, nameWFrac = 0 } = req.body;
    const nameBuf = req.nameFile ? fs.readFileSync(req.nameFile.path) : null;

    const styles = STYLE_SETS[aspect] || STYLE_SETS.default;
    const extra = String(prompt || '').trim(); // आपका प्रॉम्प्ट हर डिज़ाइन में जुड़ेगा (जैसे "theme: Ganesh puja")

    // 🔥 पहले डिज़ाइन की कटिंग (पहले यहाँ कटिंग होती ही नहीं थी, इसलिए ओरिजिनल बैकग्राउंड साथ चिपक जाता था)
    const cutBuf = await smartCut(buf, cutMode);

    const results = new Array(styles.length).fill(null);
    const makeOne = async (i) => {
      try {
        const bg = await callRecraftStabilityAPI(styles[i] + (extra ? '. ' + extra : ''), aspect);
        if (!bg || bg.length < 500) return;
        const finalDesign = await callKittlComposeAPI(bg, cutBuf, aspect, name, null, customW, customH, curve, angle, textColor, fontSize, isBold, isItalic, textStyle, fontFamily, textX, textY, nameBuf, nameWFrac);
        const wmDesign = await addWatermark(finalDesign);
        results[i] = {
          wmUrl: saveOut(wmDesign, `variation_${i + 1}_wm`),
          rawUrl: saveOut(await withDpi(finalDesign), `variation_${i + 1}_raw`)
        };
      } catch (err) {
        console.error(`डिज़ाइन ${i + 1} फेल:`, err.message);
      }
    };

    // एक बार में 2 डिज़ाइन (तेज़ भी, और Render की मेमोरी पर बोझ भी कम)
    for (let i = 0; i < styles.length; i += 2) {
      await Promise.all([makeOne(i), i + 1 < styles.length ? makeOne(i + 1) : Promise.resolve()]);
    }

    res.json({ success: true, variations: results.filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// 8b. 🧩 पार्ट्स में बाँटना: कटिंग (या पहले से कटी PNG) → वैकल्पिक HD → अलग-अलग पार्ट्स
app.post('/api/split-parts', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const { cutMode = 'auto', hd = 'false', gap = 'small' } = req.body;
    const partText = String(req.body.part || '').trim(); // 🔎 सिर्फ यही हिस्सा अलग करो

    let cut = await smartCut(buf, cutMode, { trim: !partText }); // 'none' = पहले से कटी PNG
    if (hd === 'true') {
      try { const up = await callHDUpscaleAPI(cut); cut = partText ? up : await trimTransparent(up); }
      catch (e) { console.error('HD फेल, बिना HD आगे बढ़ रहे हैं:', e.message); }
    }

    if (partText) {
      const r = await extractNamedParts(buf, cut, partText);
      const cutUrlP = saveOut(await withDpi(cut), 'cut_full');
      const out = r.selected.map((p, i) => ({ url: saveOut(p.buf, `part_${i + 1}`), x: p.x, y: p.y, w: p.w, h: p.h, label: p.label ? `सिर्फ: ${p.label}` : `चुना हुआ हिस्सा ${i + 1}` }));
      if (r.rest) out.push({ url: saveOut(r.rest.buf, 'part_rest'), x: r.rest.x, y: r.rest.y, w: r.rest.w, h: r.rest.h, label: 'बाकी हिस्सा (जैसा था)' });
      return res.json({ success: true, cutUrl: cutUrlP, cw: r.W, ch: r.H, found: r.found, parts: out });
    }

    const gapMap = { none: 0, small: 0.4, medium: 1.2, large: 3 };
    const gapPct = Object.prototype.hasOwnProperty.call(gapMap, gap) ? gapMap[gap] : 0.4;
    const { parts, W, H, found } = await splitIntoParts(cut, { gapPct });
    console.log(`🧩 ${found} टुकड़े मिले, ${parts.length} पार्ट रखे (gap=${gap})`);

    const cutUrl = saveOut(await withDpi(cut), 'cut_full');
    const results = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      results.push({ url: saveOut(p.buf, `part_${i + 1}`), x: p.x, y: p.y, w: p.w, h: p.h });
    }
    res.json({ success: true, cutUrl, cw: W, ch: H, found, parts: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// 8. 3D TEXT ONLY ROUTE
app.post('/api/3d-text', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const { name = '', style = '3D golden', aspect = '2:3', customW, customH } = req.body;

    if (!name) throw new Error("कृपया नाम लिखें");

    const textImgBuf = await generateStylishText(name, style);
    if (!textImgBuf) throw new Error("3D टेक्स्ट नहीं बन पाया।");

    const finalDesign = await callKittlComposeAPI(null, buf, aspect, null, textImgBuf, customW, customH);
    const wmDesign = await addWatermark(finalDesign);

    const finalPreview = saveOut(wmDesign, '3d_design_wm');
    const finalRaw = saveOut(finalDesign, '3d_design_raw');

    res.json({ success: true, finalPreview, finalRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// 9. MANUAL TEXT PLACEMENT
app.post('/api/manual-text', uploadWithName, async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const { name = '', textX = 50, textY = 20, textStyle = 'normal', textColor = '#ffffff', curve = 0, angle = 0, fontSize = 10, isBold = 'normal', isItalic = 'normal', fontFamily = 'Arial, sans-serif' } = req.body;

    if (!name) throw new Error("कृपया नाम लिखें");

    const safeName = escapeXml(name);
    const safeFont = escapeXml(fontFamily);

    const imgMeta = await sharp(buf).metadata();
    const W = imgMeta.width;
    const H = imgMeta.height;

    // 🔥 ब्राउज़र में बनी नाम की PNG आई हो तो उसी को सही जगह पर लगाएँ (हिंदी/कर्व/रोटेशन हूबहू एडिटर जैसा)
    if (req.nameFile) {
      const nBuf = fs.readFileSync(req.nameFile.path);
      const ov = await buildNameOverlay(nBuf, W, H, textX, textY, req.body.nameWFrac);
      if (ov) {
        const finalImg2 = await sharp(buf).composite([ov]).png().toBuffer();
        const preview2 = saveOut(await addWatermark(finalImg2), 'manual_text_wm');
        const finalRaw2 = saveOut(finalImg2, 'manual_text_raw');
        return res.json({ success: true, preview: preview2, finalRaw: finalRaw2 });
      }
    }

    const pxX = Math.floor((parseFloat(textX) / 100) * W);
    const pxY = Math.floor((parseFloat(textY) / 100) * H);

    let fs2 = Math.floor(H * (parseFloat(fontSize) / 100));
    if (isNaN(fs2) || fs2 < 10) fs2 = 100;

    const maxWidth = W * 0.9;
    let estWidth = name.length * fs2 * 0.6;
    if (estWidth > maxWidth) {
      fs2 = Math.floor(fs2 * (maxWidth / estWidth));
    }

    let finalTransform = `rotate(${parseFloat(angle) || 0} ${pxX} ${pxY})`;
    let svgText = "";

    if (textStyle === 'vertical') {
      svgText = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <text x="${pxX}" y="${pxY}" text-anchor="middle" font-family="${safeFont}" font-weight="${escapeXml(isBold)}" font-style="${escapeXml(isItalic)}" font-size="${fs2}" fill="${escapeXml(textColor)}" transform="rotate(90 ${pxX} ${pxY})">${safeName}</text>
      </svg>`;
    } else {
      const textLength = name.length * fs2 * 0.6;
      const startX = pxX - textLength / 2;
      const endX = pxX + textLength / 2;
      let pathD = `M ${startX} ${pxY} L ${endX} ${pxY}`;

      const curveFloat = parseFloat(curve);
      const uniqueId = "manual_path_" + Date.now();

      if (textStyle === 'full_circle') {
        const circle = buildFullCirclePath(name, fs2, pxX, pxY);
        pathD = circle.path;
      } else if (textStyle === 'round') {
        const controlY = pxY - (50 * 3);
        pathD = `M ${startX} ${pxY} Q ${pxX} ${controlY} ${endX} ${pxY}`;
      } else if (textStyle === 'rotate') {
        finalTransform = `rotate(45 ${pxX} ${pxY})`;
      } else if (curveFloat !== 0) {
        const controlY = pxY - (curveFloat * 3);
        pathD = `M ${startX} ${pxY} Q ${pxX} ${controlY} ${endX} ${pxY}`;
      }

      svgText = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <path id="${uniqueId}" d="${pathD}" fill="transparent" />
        <text font-family="${safeFont}" font-weight="${escapeXml(isBold)}" font-style="${escapeXml(isItalic)}" font-size="${fs2}" fill="${escapeXml(textColor)}" transform="${finalTransform}">
          <textPath href="#${uniqueId}" xlink:href="#${uniqueId}" startOffset="50%" text-anchor="middle">${safeName}</textPath>
        </text>
      </svg>`;
    }

    const finalImg = await sharp(buf).composite([{ input: Buffer.from(svgText), top: 0, left: 0 }]).png().toBuffer();

    const preview = saveOut(await addWatermark(finalImg), 'manual_text_wm');
    const finalRaw = saveOut(finalImg, 'manual_text_raw');

    res.json({ success: true, preview, finalRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// 🔥 10. DIRECT CUT + VECTOR
app.post('/api/direct-vector', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const results = [];

    // 🔎 हिस्से का नाम लिखा हो तो सिर्फ वही हिस्सा कटेगा और सिर्फ उसी का वेक्टर बनेगा
    const partText = String(req.body.part || '').trim();
    if (partText) {
      const cutFull = await smartCut(buf, req.body.cutMode || 'auto', { trim: false });
      const r = await extractNamedParts(buf, cutFull, partText);
      const u = await unionSelected(r.selected, r.W, r.H);
      const wm = saveOut(await addWatermark(u.buf), 'layer_part_wm');
      const raw = saveOut(await withDpi(u.buf), 'layer_part_raw');
      let vec = null;
      try { vec = saveOut(await callVectorizerAPI(u.buf), 'vector_part', 'pdf'); }
      catch (e) { console.log('Vectorizer फेल हुआ:', e.message); }
      results.push({ layerNumber: 1, previewPng: wm, rawPng: raw, vectorPdf: vec, label: 'सिर्फ चुना हुआ हिस्सा' });

      const parts = r.selected.map((p, i) => ({ url: saveOut(p.buf, `part_${i + 1}`), x: p.x, y: p.y, w: p.w, h: p.h, label: p.label }));
      if (r.rest) {
        const rr = saveOut(await withDpi(r.rest.buf), 'layer_rest_raw');
        results.push({ layerNumber: 2, previewPng: saveOut(await addWatermark(r.rest.buf), 'layer_rest_wm'), rawPng: rr, vectorPdf: null, label: 'बाकी हिस्सा (जैसा था)' });
        parts.push({ url: rr, x: r.rest.x, y: r.rest.y, w: r.rest.w, h: r.rest.h, label: 'बाकी हिस्सा' });
      }
      return res.json({ success: true, total: results.length, results, editorParts: { cw: r.W, ch: r.H, parts } });
    }

    let cutImage;
    try {
      cutImage = await smartCut(buf, req.body.cutMode || 'auto');
    } catch (e) {
      throw new Error("बैकग्राउंड हटाने में समस्या आई");
    }

    const wmPng = saveOut(await addWatermark(cutImage), `layer_cut_wm`);
    const rawPng = saveOut(cutImage, `layer_cut_raw`);

    let vectorPdf = null;
    try {
      const vectorBuf = await callVectorizerAPI(cutImage);
      vectorPdf = saveOut(vectorBuf, `vector_layer`, 'pdf');
    } catch (e) {
      console.log("Vectorizer फेल हुआ:", e.message);
    }

    results.push({ layerNumber: 1, previewPng: wmPng, rawPng: rawPng, vectorPdf });

    res.json({ success: true, total: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// 🔍 कौन-कौन सी सेवा सच में जुड़ी है (सिर्फ हाँ/नहीं, keys नहीं दिखतीं): /api/status
app.get('/api/status', (req, res) => {
  res.json({
    connected: {
      'remove.bg (कटिंग)': !!KEYS.REMOVEBG,
      'Clipdrop (कटिंग + HD)': !!KEYS.CLIPDROP,
      'Photoroom (कटिंग)': !!KEYS.PHOTOROOM,
      'DeepAI (HD)': !!KEYS.DEEPAI,
      'Vectorizer.AI (वेक्टर)': !!(KEYS.VEC_ID && KEYS.VEC_SECRET),
      'Gemini (बैकग्राउंड + 3D नाम)': !!KEYS.GEMINI,
      'Recraft (बैकग्राउंड)': !!KEYS.RECRAFT,
      'Pollinations (फ्री बैकग्राउंड)': true,
      'फ्री लोकल कटिंग': true
    },
    note: 'Kittl की कोई सार्वजनिक API नहीं है, इसलिए वह यहाँ जुड़ा नहीं है। कोड का callKittlComposeAPI नाम सिर्फ फंक्शन का नाम है (असल में sharp से डिज़ाइन जोड़ता है)।'
  });
});

// 📤 300 DPI प्रिंट एक्सपोर्ट (एडिटर से बनी इमेज में DPI जोड़कर लौटाता है)
app.post('/api/print-export', upload.single('image'), async (req, res) => {
  try {
    const dpi = Math.min(600, Math.max(72, parseInt(req.body.dpi) || 300));
    const buf = fs.readFileSync(req.file.path);
    const out = await withDpi(buf, dpi);
    res.json({ success: true, url: saveOut(out, 'print_' + dpi + 'dpi') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
});

// ================= 🔗 क्लाइंट को भेजने वाला एडिट-लिंक (प्रोजेक्ट) =================
// ⚠️ Render के फ्री प्लान में फाइलें restart/redeploy पर मिट जाती हैं, इसलिए लिंक हमेशा के लिए नहीं है
const okOutUrl = u => typeof u === 'string' && /^\/outputs\/[A-Za-z0-9_.\-]+$/.test(u);
const okHex = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : d;
const okNum = (v, d, lo, hi) => { v = parseFloat(v); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };

app.post('/api/project', (req, res) => {
  try {
    const b = req.body || {};
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 60).filter(i => i && okOutUrl(i.url)).map(i => ({
      url: i.url,
      cx: okNum(i.cx, 50, -50, 150), cy: okNum(i.cy, 50, -50, 150),
      wFrac: okNum(i.wFrac, 0.3, 0.01, 3), angle: okNum(i.angle, 0, -360, 360), flip: !!i.flip
    }));
    const hasBg = okOutUrl(b.bg), hasCut = okOutUrl(b.cut);
    if (!items.length && !hasCut && !b.blank) return res.status(400).json({ error: 'लेयर्स की जानकारी सही नहीं है' });
    const W = parseInt(b.W), H = parseInt(b.H);
    if (!(W > 0 && H > 0 && W <= 8000 && H <= 8000)) return res.status(400).json({ error: 'साइज़ सही नहीं है' });

    const texts = (Array.isArray(b.texts) ? b.texts : []).slice(0, 30).map(t => ({
      text: String((t && t.text) || '').slice(0, 200),
      x: okNum(t && t.x, 50, -50, 150),
      y: okNum(t && t.y, 20, -50, 150),
      sizeFrac: okNum(t && t.sizeFrac, 0.1, 0.01, 0.6),
      color: okHex(t && t.color, '#ffffff'),
      bold: !!(t && t.bold),
      italic: !!(t && t.italic),
      font: String((t && t.font) || 'Arial, sans-serif').replace(/[^A-Za-z0-9 ,'"\-]/g, '').slice(0, 100) || 'Arial, sans-serif',
      angle: okNum(t && t.angle, 0, -360, 360),
      effect3d: !!(t && t.effect3d),
      depth: okNum(t && t.depth, 12, 0, 60),
      extrude: okHex(t && t.extrude, '#8a6d00'),
      outline: !!(t && t.outline),
      outlineColor: okHex(t && t.outlineColor, '#000000'),
      maxW: okNum(t && t.maxW, 0, 0, 1.5),
      align: (t && (t.align === 'left' || t.align === 'right')) ? t.align : 'center'
    }));

    const id = nanoid(10);
    const project = {
      id, title: String(b.title || 'डिज़ाइन').slice(0, 100), W, H,
      bg: hasBg ? b.bg : null, cut: hasCut ? b.cut : null, items, final: okOutUrl(b.final) ? b.final : null,
      texts, useBgColor: !!b.useBgColor || !hasBg, bgColor: okHex(b.bgColor, '#ffffff'), created: Date.now()
    };
    fs.writeFileSync(path.join(PROJECT_DIR, id + '.json'), JSON.stringify(project));
    res.json({ success: true, id, url: '/p/' + id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/project/:id', (req, res) => {
  try {
    if (!/^[A-Za-z0-9_\-]{6,32}$/.test(req.params.id)) return res.status(400).json({ error: 'गलत लिंक' });
    const f = path.join(PROJECT_DIR, req.params.id + '.json');
    if (!fs.existsSync(f)) return res.status(404).json({ error: 'यह प्रोजेक्ट नहीं मिला (शायद सर्वर restart में मिट गया)' });
    res.json(JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// क्लाइंट का एडिट-पेज
app.get('/p/:id', (req, res) => { res.sendFile(path.join(__dirname, 'project.html')); });

// 🔍 Gemini जाँच: ब्राउज़र में खोलें → http://localhost:3000/api/gemini-check
app.get('/api/gemini-check', async (req, res) => {
  const out = { keyPresent: !!KEYS.GEMINI, modelsTried: GEMINI_IMAGE_MODELS };
  try {
    const r = await axios.get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': KEYS.GEMINI }, timeout: 30000
    });
    out.availableImageModels = (r.data.models || []).map(m => m.name.replace('models/', '')).filter(n => /image/i.test(n));
  } catch (e) { out.listError = e.response?.data || e.message; }
  try {
    const img = await callGeminiImage('simple blue sky background', '2:3');
    out.generate = 'OK ' + img.length + ' bytes';
  } catch (e) { out.generate = 'FAIL: ' + e.message; }
  res.json(out);
});

// ✅ Serve HTML (यह हमेशा सबसे आखिर में होना चाहिए) — Express 4 और 5 दोनों में चलता है
app.use((req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// ✅ सर्वर शुरू करें (यह सबसे आखिरी लाइन होनी चाहिए)
app.listen(PORT, () => { console.log(`🚀 AI Studio → http://localhost:${PORT}`); });

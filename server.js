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
app.use(express.static(__dirname)); 

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.existsSync(d) || fs.mkdirSync(d, { recursive: true }));
app.use('/outputs', express.static(OUTPUT_DIR));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 30 * 1024 * 1024 } });
const GEM_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

// ================= API KEYS =================
const KEYS = {
  REMOVEBG: process.env.REMOVEBG_KEY,
  DEEPAI: process.env.DEEPAI_KEY,
  GEMINI: process.env.GEMINI_KEY,
  VEC_ID: process.env.VECTORIZER_ID,
  VEC_SECRET: process.env.VECTORIZER_SECRET
};

// ================= AI FUNCTIONS =================

// 1. Remove Background
async function callRemoveBgAPI(buffer, person = false) {
  const fd = new FormData();
  fd.append('image_file', buffer, { filename: 'img.png' });
  fd.append('size', 'auto');
  if (person) fd.append('type', 'person');
  try {
    const r = await axios.post('https://api.remove.bg/v1.0/removebg', fd, {
      headers: { 'X-Api-Key': KEYS.REMOVEBG, ...fd.getHeaders() },
      responseType: 'arraybuffer', timeout: 120000
    });
    return Buffer.from(r.data, 'binary');
  } catch (e) { throw new Error("Background removal failed."); }
}

// 2. HD Upscale
async function callHDUpscaleAPI(buffer) {
  try {
    const src = await sharp(buffer).resize({ width: 1200, withoutEnlargement: true }).png().toBuffer();
    const fd = new FormData();
    fd.append('image', src, { filename: 'in.png' });
    const r = await axios.post('https://api.deepai.org/api/torch-srgan', fd, {
      headers: { 'api-key': KEYS.DEEPAI, ...fd.getHeaders() }, timeout: 180000
    });
    if (!r.data.output_url) throw new Error("DeepAI failed");
    const hd = await axios.get(r.data.output_url, { responseType: 'arraybuffer' });
    return Buffer.from(hd.data);
  } catch (e) {
    return await sharp(buffer).resize({ width: 3000, withoutEnlargement: true, kernel: 'lanczos3' }).sharpen().png().toBuffer();
  }
}

// 3. Vectorize (Tracing)
async function callVectorizerAPI(buffer) {
  const fd = new FormData();
  fd.append('image', await sharp(buffer).flatten({ background: '#ffffff' }).png().toBuffer(), { filename: 'design.png' });
  fd.append('output.file_format', 'pdf');
  const auth = Buffer.from(`${KEYS.VEC_ID}:${KEYS.VEC_SECRET}`).toString('base64');
  try {
    const r = await axios.post('https://api.vectorizer.ai/api/v1/vectorize', fd, {
      headers: { 'Authorization': `Basic ${auth}`, ...fd.getHeaders() },
      responseType: 'arraybuffer', timeout: 240000
    });
    return Buffer.from(r.data);
  } catch (e) { throw new Error("Vectorizer API failed."); }
}

// 4. AI Background Generator
async function callRecraftStabilityAPI(prompt, aspect = '2:3') {
  const BG_SUFFIX = '. Background design only, vibrant, professional, no people, no text.';
  try {
    const payload = {
      contents: [{ parts: [{ text: prompt + BG_SUFFIX }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect } }
    };
    const r = await axios.post(`${GEM_URL}gemini-3.1-flash-image:generateContent`, payload, {
      headers: { 'x-goog-api-key': KEYS.GEMINI, 'Content-Type': 'application/json' }, timeout: 180000
    });
    for (const cand of r.data.candidates || []) {
      for (const part of cand.content?.parts || []) {
        const inl = part.inlineData || part.inline_data;
        if (inl?.data) return Buffer.from(inl.data, 'base64');
      }
    }
    throw new Error("No image returned");
  } catch (e) {
    const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt + BG_SUFFIX) + '?width=1024&height=1536&nologo=true';
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
    return Buffer.from(r.data);
  }
}

// 5. Compose (Background + Cutout + Name)
async function callKittlComposeAPI(bgBuf, cutBuf, aspect, name) {
  const sizeMap = { '2:3': [2000, 3000], '1:1': [2400, 2400], '3:2': [3000, 2000] };
  const [W, H] = sizeMap[aspect] || sizeMap['2:3'];

  let bgCanvas = bgBuf ? await sharp(bgBuf).resize(W, H, { fit: 'cover', position: 'center' }).toBuffer()
    : await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).png().toBuffer();

  const cutMeta = await sharp(cutBuf).metadata();
  const targetH = Math.floor(H * 0.74);
  const targetW = Math.floor(cutMeta.width * (targetH / cutMeta.height));
  const cutResized = await sharp(cutBuf).resize({ width: targetW, height: targetH, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();

  const x = Math.floor((W - targetW) / 2);
  const y = Math.floor((H - targetH) / 2 + H * 0.05);
  let composed = await sharp(bgCanvas).composite([{ input: cutResized, left: x, top: y }]).png().toBuffer();

  if (name) {
    const fs2 = Math.floor(H * 0.09);
    const svgText = `<svg width="${W}" height="${fs2 + 80}" xmlns="http://www.w3.org/2000/svg">
      <text x="${W/2}" y="${fs2 + 30}" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="${fs2}" fill="white" stroke="black" stroke-width="4">${name}</text>
    </svg>`;
    composed = await sharp(composed).composite([{ input: Buffer.from(svgText), top: 30, left: 0 }]).png().toBuffer();
  }
  return composed;
}

// 6. Watermark
async function addWatermark(buffer, text = "PREVIEW - AI DESIGN STUDIO") {
  try {
    const meta = await sharp(buffer).metadata();
    const W = meta.width, H = meta.height;
    const fontSize = Math.max(28, Math.floor(H * 0.045));
    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
    for (let y = 40; y < H; y += 200) {
      for (let x = -100; x < W; x += 300) {
        svg += `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" fill="rgba(255,40,40,0.3)" transform="rotate(-25 ${x + 80} ${y})">${text}</text>`;
      }
    }
    svg += `</svg>`;
    return await sharp(buffer).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  } catch (e) { return buffer; }
}

// 7. SAM Layer Splitter (Smart Divide)
async function splitIntoLayers(buffer) {
  const meta = await sharp(buffer).metadata();
  const W = meta.width, H = meta.height;
  const layersBuf = [];
  
  // डिज़ाइन को 4 हिस्सों में बांटें
  const regions = [
    { left: 0, top: 0, width: Math.floor(W/2), height: Math.floor(H/2) },
    { left: Math.floor(W/2), top: 0, width: Math.floor(W/2), height: Math.floor(H/2) },
    { left: 0, top: Math.floor(H/2), width: Math.floor(W/2), height: Math.floor(H/2) },
    { left: Math.floor(W/2), top: Math.floor(H/2), width: Math.floor(W/2), height: Math.floor(H/2) }
  ];

  for (const r of regions) {
    let part = await sharp(buffer).extract(r).png().toBuffer();
    try { part = await callRemoveBgAPI(part, false); } catch(e) {}
    layersBuf.push(part);
  }
  return layersBuf;
}

function saveOut(buf, prefix, ext = 'png') {
  const name = `${prefix}_${Date.now()}_${nanoid(6)}.${ext}`;
  fs.writeFileSync(path.join(OUTPUT_DIR, name), buf);
  return '/outputs/' + name;
}

// ================= API ROUTES =================

// 1. FULL AUTO
app.post('/api/auto', upload.single('image'), async (req, res) => {
  try {
    const { prompt = '', name = '', aspect = '2:3' } = req.body;
    const inputBuf = fs.readFileSync(req.file.path);
    const steps = {};

    let cut;
    try { cut = await callRemoveBgAPI(inputBuf, true); } catch (e) { cut = inputBuf; }
    steps.cutPreview = saveOut(await addWatermark(cut), 'cut');

    let hd;
    try { hd = await callHDUpscaleAPI(cut); } catch (e) { hd = cut; }
    steps.hdPreview = saveOut(await addWatermark(hd), 'hd');

    let bg = null;
    try { bg = await callRecraftStabilityAPI(prompt, aspect); } catch (e) {}
    if (bg) steps.bgPreview = saveOut(bg, 'bg');

    const final = await callKittlComposeAPI(bg, hd, aspect, name);
    steps.finalPreview = saveOut(await addWatermark(final), 'final_wm');
    steps.finalRaw = saveOut(final, 'final');

    fs.unlinkSync(req.file.path);
    res.json({ success: true, steps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. SPLIT + TRACE (लाइब्रेरी अलग + वेक्टर)
app.post('/api/split-and-trace', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const rawLayers = await splitIntoLayers(buf);
    const results = [];

    for (let i = 0; i < rawLayers.length; i++) {
      const layerBuf = rawLayers[i];
      const wmPng = await addWatermark(layerBuf);
      const previewPng = saveOut(wmPng, `layer_${i+1}`);

      let vectorPdf = null;
      try {
        const vectorBuf = await callVectorizerAPI(layerBuf);
        vectorPdf = saveOut(vectorBuf, `vector_layer_${i+1}`, 'pdf');
      } catch (e) {}

      results.push({ layerNumber: i + 1, previewPng, vectorPdf });
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. CUTOUT
app.post('/api/cutout', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const person = req.body.person === 'true';
    const out = await callRemoveBgAPI(buf, person);
    const preview = saveOut(await addWatermark(out), 'cut');
    fs.unlinkSync(req.file.path);
    res.json({ success: true, preview });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. UPSCALE
app.post('/api/upscale', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const out = await callHDUpscaleAPI(buf);
    const preview = saveOut(await addWatermark(out), 'hd');
    fs.unlinkSync(req.file.path);
    res.json({ success: true, preview });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. VECTORIZE ONLY
app.post('/api/vectorize', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const out = await callVectorizerAPI(buf);
    const url = saveOut(out, 'vector', 'pdf');
    fs.unlinkSync(req.file.path);
    res.json({ success: true, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// 7. AUTO VARIATIONS (4 डिज़ाइन)
app.post('/api/variations', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const { name = '', aspect = '2:3' } = req.body;
    const styles = [
      "luxury royal gold background, professional poster design",
      "modern minimalist gradient background, clean design",
      "vintage floral pattern background, traditional design",
      "cyberpunk neon dark background, futuristic design"
    ];
    const variations = [];

    for (let i = 0; i < styles.length; i++) {
      try {
        const bg = await callRecraftStabilityAPI(styles[i], aspect);
        const finalDesign = await callKittlComposeAPI(bg, buf, aspect, name);
        const wmDesign = await addWatermark(finalDesign);
        variations.push(saveOut(wmDesign, `variation_${i+1}`));
      } catch (err) {}
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, variations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ✅ Serve HTML
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.listen(PORT, () => { console.log(`🚀 AI Studio → http://localhost:${PORT}`); });

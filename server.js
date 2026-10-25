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

// 1. Remove Background (Clipdrop / Remove.bg)
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

// 2. HD Upscale (Topaz / DeepAI)
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

// 3. Vectorize (Vectorizer.AI)
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

// 4. AI Background Generator (Recraft / Gemini / Pollinations)
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

// 5. 3D स्टाइलिश टेक्स्ट बनाना
async function generateStylishText(text, style = '3D golden') {
  try {
    const prompt = `Generate a beautiful, high quality, transparent PNG (no background) of the text "${text}" written in ${style} font style. Make it look premium, 3D, and print-ready. The text should be perfectly aligned and centered.`;

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    };

    const r = await axios.post(`${GEM_URL}gemini-3.1-flash-image:generateContent`, payload, {
      headers: { 'x-goog-api-key': KEYS.GEMINI, 'Content-Type': 'application/json' }, timeout: 180000
    });

    for (const cand of r.data.candidates || []) {
      for (const part of cand.content?.parts || []) {
        const inl = part.inlineData || part.inline_data;
        if (inl?.data) {
          return Buffer.from(inl.data, 'base64');
        }
      }
    }
    throw new Error("AI ने कोई टेक्स्ट इमेज नहीं दी");
  } catch (e) {
    console.error("Stylish Text Error:", e.message);
    return null; // Fallback के लिए null भेजेगा
  }
}

// ================= 🔥 HELPER: DYNAMIC FULL CIRCLE PATH =================
function buildFullCirclePath(text, fontSizePx, centerX, centerY) {
  const textWidth = text.length * fontSizePx * 0.6;   // approx text width in px
  let r = textWidth / (2 * Math.PI);
  if (r < 10) r = 10; // safety only — 1-2 अक्षर पर path degenerate न हो
  const top = centerY - r;
  const bottom = centerY + r;
  return {
    radius: r,
    path: `M ${centerX} ${top} A ${r} ${r} 0 1 1 ${centerX} ${bottom} A ${r} ${r} 0 1 1 ${centerX} ${top}`
  };
}

// 6. Compose (Auto के लिए - अब 100% क्रैश-फ्री)
async function callKittlComposeAPI(bgBuf, cutBuf, aspect, name, textImageBuf = null, customW = null, customH = null, curveVal = 0, angleVal = 0, textColor = '#ffffff', fontSizeVal = 10, boldVal = 'normal', italicVal = 'normal', textStyle = 'normal', fontFamilyVal = 'Arial, sans-serif') {
  let W, H;
  if (customW && customH) {
    W = parseInt(customW);
    H = parseInt(customH);
  } else {
    const sizeMap = { '2:3': [2000, 3000], '1:1': [2400, 2400], '3:2': [3000, 2000] };
    [W, H] = sizeMap[aspect] || sizeMap['2:3'];
  }

  let bgCanvas = bgBuf ? await sharp(bgBuf).resize(W, H, { fit: 'cover', position: 'center' }).toBuffer()
    : await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).png().toBuffer();

  const cutMeta = await sharp(cutBuf).metadata();
  const targetH = Math.floor(H * 0.74);
  const targetW = Math.floor(cutMeta.width * (targetH / cutMeta.height));
  const cutResized = await sharp(cutBuf).resize({ width: targetW, height: targetH, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();

  const x = Math.floor((W - targetW) / 2);
  const y = Math.floor((H - targetH) / 2 + H * 0.05);
  let composed = await sharp(bgCanvas).composite([{ input: cutResized, left: x, top: y }]).png().toBuffer();

  // 🔥 3D टेक्स्ट (AI द्वारा बनाया गया)
  if (textImageBuf) {
    try {
      const textResized = await sharp(textImageBuf).resize({ width: Math.floor(W * 0.7) }).png().toBuffer();
      const textMeta = await sharp(textResized).metadata();
      const tx = Math.floor((W - textMeta.width) / 2);
      const ty = Math.floor(H * 0.15);
      composed = await sharp(composed).composite([{ input: textResized, left: tx, top: ty }]).png().toBuffer();
    } catch (err) {
      console.error("3D Text Compose Failed, skipping...");
      textImageBuf = null; // फेल होने पर null कर दें ताकि नीचे वाला सामान्य टेक्स्ट चल जाए
    }
  }
  
  // सिंपल टेक्स्ट (अगर 3D नहीं बना या नहीं माँगा गया)
  if (!textImageBuf && name) {
    let fs2 = Math.floor(H * (parseFloat(fontSizeVal) / 100));
    if (isNaN(fs2) || fs2 < 10) fs2 = 100; // Safety

    const pxX = W / 2;
    const pxY = H * 0.25;   

    // Auto-Fit (साइज़ छोटा करना ताकि बाहर न जाए)
    const maxWidth = W * 0.9;
    let estWidth = name.length * fs2 * 0.6;
    if (estWidth > maxWidth) fs2 = Math.floor(fs2 * (maxWidth / estWidth));

    let pathD = "";
    const curve = parseFloat(curveVal) || 0;
    const uniqueId = "path_" + Date.now();
    let extraTransform = "";

    if (textStyle === 'rotate') {
      extraTransform = `transform="rotate(45 ${pxX} ${pxY})"`;
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

    const svgText = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <path id="${uniqueId}" d="${pathD}" fill="transparent" />
      <text font-family="${fontFamilyVal}" font-weight="${boldVal}" font-style="${italicVal}" font-size="${fs2}" fill="${textColor}" ${extraTransform}>
        <textPath href="#${uniqueId}" startOffset="50%" text-anchor="middle">${name}</textPath>
      </text>
    </svg>`;

    composed = await sharp(composed).composite([{ input: Buffer.from(svgText), top: 0, left: 0 }]).png().toBuffer();
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
        svg += `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" fill="rgba(255,40,40,0.3)" transform="rotate(-25 ${x + 80} ${y})">${text}</text>`;
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
app.post('/api/auto', upload.single('image'), async (req, res) => {
  try {
    const { prompt = '', name = '', aspect = '2:3', customW, customH, use3d = 'false', curve = 0, angle = 0, textColor = '#ffffff', fontSize = 10, isBold = 'normal', isItalic = 'normal', textStyle = 'normal', fontFamily = 'Arial, sans-serif' } = req.body;
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

    let textImg = null;
    if (name && use3d === 'true') {
      textImg = await generateStylishText(name);
    }

    const final = await callKittlComposeAPI(bg, hd, aspect, name, textImg, customW, customH, curve, angle, textColor, fontSize, isBold, isItalic, textStyle, fontFamily);
    steps.finalPreview = saveOut(await addWatermark(final), 'final_wm');
    steps.finalRaw = saveOut(final, 'final');

    fs.unlinkSync(req.file.path);
    res.json({ success: true, steps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. SPLIT + TRACE (Python SAM + Vectorizer)
app.post('/api/split-and-trace', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const rawLayers = await splitIntoLayersUsingPython(buf);

    if (rawLayers.length === 0) {
      throw new Error("SAM कोई भी लेयर नहीं बना पाया।");
    }

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
    res.json({ success: true, total: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. CUTOUT ONLY
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

// 4. UPSCALE ONLY
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

    fs.unlinkSync(req.file.path);
    res.json({ success: true, finalPreview, finalRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 9. MANUAL TEXT PLACEMENT (फॉन्ट और स्टाइल के साथ - 100% ऑटो-फिट)
app.post('/api/manual-text', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const { name = '', textX = 50, textY = 20, textStyle = 'normal', textColor = '#ffffff', curve = 0, angle = 0, fontSize = 10, isBold = 'normal', isItalic = 'normal', fontFamily = 'Arial, sans-serif' } = req.body;

    if (!name) throw new Error("कृपया नाम लिखें");

    const imgMeta = await sharp(buf).metadata();
    const W = imgMeta.width;
    const H = imgMeta.height;

    const pxX = Math.floor((parseFloat(textX) / 100) * W);
    const pxY = Math.floor((parseFloat(textY) / 100) * H);
    
    let fs2 = Math.floor(H * (parseFloat(fontSize) / 100));
    if (isNaN(fs2) || fs2 < 10) fs2 = 100;

    // 🔥 Auto-Fit (साइज़ छोटा करना ताकि बॉक्स से बाहर न जाए)
    const maxWidth = W * 0.9;
    let estWidth = name.length * fs2 * 0.6;
    if (estWidth > maxWidth) {
      fs2 = Math.floor(fs2 * (maxWidth / estWidth));
    }

    let finalTransform = `rotate(${angle} ${pxX} ${pxY})`;
    let svgText = "";

    if (textStyle === 'vertical') {
      svgText = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <text x="${pxX}" y="${pxY}" text-anchor="middle" font-family="${fontFamily}" font-weight="${isBold}" font-style="${isItalic}" font-size="${fs2}" fill="${textColor}" transform="rotate(90 ${pxX} ${pxY})">${name}</text>
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

      svgText = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <path id="${uniqueId}" d="${pathD}" fill="transparent" />
        <text font-family="${fontFamily}" font-weight="${isBold}" font-style="${isItalic}" font-size="${fs2}" fill="${textColor}" transform="${finalTransform}">
          <textPath href="#${uniqueId}" startOffset="50%" text-anchor="middle">${name}</textPath>
        </text>
      </svg>`;
    }

    const finalImg = await sharp(buf).composite([{ input: Buffer.from(svgText), top: 0, left: 0 }]).png().toBuffer();

    const preview = saveOut(await addWatermark(finalImg), 'manual_text_wm');
    const finalRaw = saveOut(finalImg, 'manual_text_raw');

    fs.unlinkSync(req.file.path);
    res.json({ success: true, preview, finalRaw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Serve HTML (यह हमेशा सबसे आखिर में होना चाहिए)
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// ✅ सर्वर शुरू करें (यह सबसे आखिरी लाइन होनी चाहिए)
app.listen(PORT, () => { console.log(`🚀 AI Studio → http://localhost:${PORT}`); });

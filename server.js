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

// Gemini इमेज मॉडल (एक-एक करके आज़माए जाएँगे). .env में GEMINI_IMAGE_MODEL डालकर पहला मॉडल बदल सकते हैं
const GEMINI_IMAGE_MODELS = [
  process.env.GEMINI_IMAGE_MODEL,
  'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-image'
].filter(Boolean);

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
        timeout: 120000
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
      lastErr = new Error(`${model}: ${e.message}`);
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
  if (person) fd.append('type', 'person');
  try {
    const r = await axios.post('https://api.remove.bg/v1.0/removebg', fd, {
      headers: { 'X-Api-Key': KEYS.REMOVEBG, ...fd.getHeaders() },
      responseType: 'arraybuffer', timeout: 120000
    });
    return Buffer.from(r.data, 'binary');
  } catch (e) { throw new Error("Background removal failed."); }
}

// 2. HD Upscale (DeepAI)
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

// 4. AI Background Generator (पहले Gemini → फिर Pollinations → फिर ग्रेडिएंट)
async function callRecraftStabilityAPI(prompt, aspect = '2:3') {
  const BG_SUFFIX = '. Background design only, vibrant, professional, no people, no text.';
  const finalPrompt = (prompt && prompt.trim() !== '') ? prompt : 'luxury royal gold background, professional poster design';

  // 🔥 1. सबसे पहले Gemini
  try {
    console.log("⏳ Gemini से बैकग्राउंड माँग रहे हैं...");
    const validAspects = ['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'];
    const geminiAspect = validAspects.includes(aspect) ? aspect : null; // 'custom' जैसी वैल्यू Gemini में चलती नहीं
    const img = await callGeminiImage(finalPrompt + BG_SUFFIX, geminiAspect);
    if (img && img.length > 1000) {
      console.log("✅ Gemini से बैकग्राउंड मिल गया!");
      return img;
    }
    throw new Error("Gemini की इमेज बहुत छोटी/खाली है");
  } catch (geminiError) {
    console.error("❌ Gemini फेल:", geminiError.message);

    // 🔥 2. Gemini फेल हो तो Pollinations
    try {
      console.log("⏳ अब Pollinations.ai से बैकग्राउंड माँग रहे हैं...");
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(finalPrompt + BG_SUFFIX) +
        '?width=1024&height=1536&nologo=true&seed=' + Math.floor(Math.random() * 100000);

      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });

      if (r.data && r.data.byteLength > 1000) {
        console.log("✅ Pollinations.ai से बैकग्राउंड मिल गया!");
        return Buffer.from(r.data);
      }
      throw new Error("Pollinations returned empty image");
    } catch (pollError) {
      // 🔥 3. दोनों फेल → सुंदर ग्रेडिएंट (ताकि सफेद न दिखे)
      console.error("❌ Pollinations भी फेल:", pollError.message, "→ डिफ़ॉल्ट ग्रेडिएंट बना रहे हैं।");
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
async function callKittlComposeAPI(bgBuf, cutBuf, aspect, name, textImageBuf = null, customW = null, customH = null, curveVal = 0, angleVal = 0, textColor = '#ffffff', fontSizeVal = 10, boldVal = 'normal', italicVal = 'normal', textStyle = 'normal', fontFamilyVal = 'Arial, sans-serif', textXVal = 50, textYVal = 25) {
  let W, H;
  if (customW && customH) {
    W = parseInt(customW);
    H = parseInt(customH);
  } else {
    const sizeMap = { '2:3': [2000, 3000], '1:1': [2400, 2400], '3:2': [3000, 2000] };
    [W, H] = sizeMap[aspect] || sizeMap['2:3'];
  }

  let bgCanvas = bgBuf ? await sharp(bgBuf).resize(W, H, { fit: 'cover', position: 'center' }).png().toBuffer()
    : await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).png().toBuffer();

  const cutMeta = await sharp(cutBuf).metadata();
  let targetH = Math.floor(H * 0.74);
  let targetW = Math.floor(cutMeta.width * (targetH / cutMeta.height));
  // 🔥 अगर कटआउट canvas से चौड़ा हो जाए तो चौड़ाई के हिसाब से छोटा करें
  if (targetW > W) {
    targetW = W;
    targetH = Math.floor(cutMeta.height * (W / cutMeta.width));
  }
  const cutResized = await sharp(cutBuf).resize({ width: targetW, height: targetH, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

  const x = Math.max(0, Math.floor((W - targetW) / 2));
  const y = Math.max(0, Math.min(Math.floor((H - targetH) / 2 + H * 0.05), H - targetH));
  let composed = await sharp(bgCanvas).composite([{ input: cutResized, left: x, top: y }]).png().toBuffer();

  if (textImageBuf) {
    try {
      const textResized = await sharp(textImageBuf).resize({ width: Math.floor(W * 0.7) }).png().toBuffer();
      const textMeta = await sharp(textResized).metadata();
      const tx = Math.max(0, Math.floor((W - textMeta.width) / 2));
      const ty = Math.floor(H * 0.15);
      composed = await sharp(composed).composite([{ input: textResized, left: tx, top: ty }]).png().toBuffer();
    } catch (err) {
      console.error("3D Text Compose Failed, skipping...");
      textImageBuf = null;
    }
  }

  if (!textImageBuf && name) {
    const safeName = escapeXml(name);
    const safeFont = escapeXml(fontFamilyVal);

    let fs2 = Math.floor(H * (parseFloat(fontSizeVal) / 100));
    if (isNaN(fs2) || fs2 < 10) fs2 = 100;

    // 🔥 अब नाम वहीं छपेगा जहाँ एडिटर में ड्रैग करके रखा था (textXVal/textYVal = % में)
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

    // 🔥 एडिटर का angle भी अब लागू होता है ('तिरछा' = angle + 45)
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

    // 🔥 खड़ा (vertical) स्टाइल
    if (textStyle === 'vertical') {
      svgText = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <text x="${pxX}" y="${pxY}" text-anchor="middle" font-family="${safeFont}" font-weight="${escapeXml(boldVal)}" font-style="${escapeXml(italicVal)}" font-size="${fs2}" fill="${escapeXml(textColor)}" transform="rotate(${90 + angNum} ${pxX} ${pxY})">${safeName}</text>
      </svg>`;
    }

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
app.post('/api/auto', upload.single('image'), async (req, res) => {
  try {
    const { prompt = '', name = '', aspect = '2:3', customW, customH, use3d = 'false', curve = 0, angle = 0, textColor = '#ffffff', fontSize = 10, isBold = 'normal', isItalic = 'normal', textStyle = 'normal', fontFamily = 'Arial, sans-serif', textX = 50, textY = 25 } = req.body;
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

    const final = await callKittlComposeAPI(bg, hd, aspect, name, textImg, customW, customH, curve, angle, textColor, fontSize, isBold, isItalic, textStyle, fontFamily, textX, textY);
    steps.finalPreview = saveOut(await addWatermark(final), 'final_wm');
    steps.finalRaw = saveOut(final, 'final');

    res.json({ success: true, steps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (req.file) rmFile(req.file.path);
  }
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

      const previewPng = saveOut(wmPng, `layer_${i + 1}_wm`);
      const rawPng = saveOut(layerBuf, `layer_${i + 1}_raw`);

      let vectorPdf = null;
      try {
        const vectorBuf = await callVectorizerAPI(layerBuf);
        vectorPdf = saveOut(vectorBuf, `vector_layer_${i + 1}`, 'pdf');
      } catch (e) {}

      results.push({ layerNumber: i + 1, previewPng, rawPng, vectorPdf });
    }

    res.json({ success: true, total: results.length, results });
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
    const person = req.body.person === 'true';
    const out = await callRemoveBgAPI(buf, person);

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

// 7. AUTO VARIATIONS (5 डिज़ाइन)
app.post('/api/variations', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const { name = '', aspect = '2:3', customW, customH, curve = 0, angle = 0, textColor = '#ffffff', fontSize = 10, isBold = 'normal', isItalic = 'normal', textStyle = 'normal', fontFamily = 'Arial, sans-serif', textX = 50, textY = 25 } = req.body;
    const styles = [
      "luxury royal gold background, professional poster design",
      "modern minimalist gradient background, clean design",
      "vintage floral pattern background, traditional design",
      "cyberpunk neon dark background, futuristic design",
      "elegant marble texture background, luxury design"
    ];
    const variations = [];

    for (let i = 0; i < styles.length; i++) {
      try {
        // callRecraftStabilityAPI के अंदर पहले से Gemini → Pollinations → ग्रेडिएंट फॉलबैक है, इसलिए यहाँ अलग retry नहीं चाहिए
        const bg = await callRecraftStabilityAPI(styles[i], aspect);

        if (bg && bg.length > 500) {
          const finalDesign = await callKittlComposeAPI(bg, buf, aspect, name, null, customW, customH, curve, angle, textColor, fontSize, isBold, isItalic, textStyle, fontFamily, textX, textY);

          const wmDesign = await addWatermark(finalDesign);
          variations.push({
            wmUrl: saveOut(wmDesign, `variation_${i + 1}_wm`),
            rawUrl: saveOut(finalDesign, `variation_${i + 1}_raw`)
          });
        }
      } catch (err) {
        console.error("डिज़ाइन फेल:", err.message);
      }
    }

    res.json({ success: true, variations });
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
app.post('/api/manual-text', upload.single('image'), async (req, res) => {
  try {
    const buf = fs.readFileSync(req.file.path);
    const { name = '', textX = 50, textY = 20, textStyle = 'normal', textColor = '#ffffff', curve = 0, angle = 0, fontSize = 10, isBold = 'normal', isItalic = 'normal', fontFamily = 'Arial, sans-serif' } = req.body;

    if (!name) throw new Error("कृपया नाम लिखें");

    const safeName = escapeXml(name);
    const safeFont = escapeXml(fontFamily);

    const imgMeta = await sharp(buf).metadata();
    const W = imgMeta.width;
    const H = imgMeta.height;

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

    let cutImage;
    try {
      cutImage = await callRemoveBgAPI(buf, false);
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

// ✅ Serve HTML (यह हमेशा सबसे आखिर में होना चाहिए) — Express 4 और 5 दोनों में चलता है
app.use((req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// ✅ सर्वर शुरू करें (यह सबसे आखिरी लाइन होनी चाहिए)
app.listen(PORT, () => { console.log(`🚀 AI Studio → http://localhost:${PORT}`); });


// 🔥 नया फंक्शन (बिना SAM के - फ्री तरीका)
const SAM_BACKEND_URL = "https://sam-server-new.onrender.com";

async function runDirectVector() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('सीधा कट + वेक्टर बन रहा है...'); toggleButtons(true);
  const fd = new FormData(); 
  fd.append('image', currentFile);
  
  try {
    fd.append('cutMode', $('cutModeSelect') ? $('cutModeSelect').value : 'auto');
    const r = await fetch('/api/direct-vector', { method: 'POST', body: fd });
    
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    
    const grid = $('layerResults');
    data.results.forEach(res => {
      // 🔥 यहाँ res.rawPng पास किया गया है ताकि बिना वॉटरमार्क वाला बटन काम करे
      const div = createThumbCard(res.previewPng, res.rawPng, res.vectorPdf, 'कट + वेक्टर', true);
      grid.appendChild(div);
    });
    setStatus('✅ कट + वेक्टर तैयार!', 'ok');
  } catch (e) { 
    setStatus('❌ ' + e.message, 'err'); 
  } finally { 
    toggleButtons(false); 
  }
}

const $ = id => document.getElementById(id);
let currentFile = null;

// ड्रैग एंड ड्रॉप और स्लाइडर्स के लिए वेरिएबल्स
let currentX = 50, currentY = 20;
let isDragging = false;
let currentCurve = 0;
let currentAngle = 0;
let isBold = false;
let isItalic = false;
let currentFontSize = 10;

// बटन (handles) के लिए वेरिएबल्स
let isResizing = false;
let isRotating = false;
let startDist = 0;
let startFontSize = 10;

// 🔥 नाम में <, >, & जैसे अक्षर SVG/HTML को तोड़ें नहीं, इसलिए सुरक्षित बनाने का फंक्शन
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 🔥 कस्टम साइज़: px / इंच / सेमी - इंच और सेमी को 300 DPI पर पिक्सल में बदलता है (प्रिंट के लिए)
function getCustomSize() {
  const unit = $('customUnit') ? $('customUnit').value : 'px';
  const f = unit === 'inch' ? 300 : (unit === 'cm' ? 300 / 2.54 : 1);
  const w = parseFloat($('customW').value), h = parseFloat($('customH').value);
  if (!(w > 0 && h > 0)) return { w: '', h: '' };
  return { w: Math.round(w * f), h: Math.round(h * f) };
}

// 🔥 नाम की सारी सेटिंग्स (पोज़िशन, स्टाइल, रंग, साइज़) एक जगह से सर्वर को भेजने के लिए
// (पहले Auto और Variations में textX/textY जा ही नहीं रहे थे, इसलिए नाम गलत जगह छपता था/छूट जाता था)
async function appendTextSettings(fd) {
  fd.append('name', $('nameInput').value);
  fd.append('textX', currentX);
  fd.append('textY', currentY);
  fd.append('curve', currentCurve);
  fd.append('angle', currentAngle);
  fd.append('textColor', $('textColorPicker').value);
  fd.append('fontSize', currentFontSize);
  fd.append('isBold', isBold ? 'bold' : 'normal');
  fd.append('isItalic', isItalic ? 'italic' : 'normal');
  fd.append('textStyle', $('textStyleSelect').value);
  if ($('fontFamilySelect')) fd.append('fontFamily', $('fontFamilySelect').value);
  fd.append('cutMode', $('cutModeSelect') ? $('cutModeSelect').value : 'auto'); // कटिंग का तरीका

  // 🔥 नाम फोन के ब्राउज़र में ही PNG बनाकर भेजें - इससे हिंदी नाम, कर्व, रोटेशन सब हूबहू एडिटर जैसा छपता है
  // (सर्वर पर हिंदी फॉन्ट नहीं होता, इसीलिए पहले नाम गायब हो जाता था)
  const layer = await renderNameLayer();
  if (layer) {
    fd.append('nameImage', layer.blob, 'name.png');
    fd.append('nameWFrac', layer.wFrac);
  }
}

// --- Tab Switching ---
function openTab(tabId, btn) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  $(tabId).classList.add('active');
  btn.classList.add('active');
}

// --- File Upload ---
const dropzone = $('dropzone'), fileInput = $('fileInput'), previewImg = $('previewImg'), dropText = $('dropText');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', e => {
  e.preventDefault(); dropzone.classList.remove('drag');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

function handleFile(file) {
  currentFile = file;
  const reader = new FileReader();
  reader.onload = ev => {
    previewImg.src = ev.target.result;
    previewImg.classList.remove('hidden');

    const editorBg = $('editorBg');
    editorBg.src = ev.target.result;
    editorBg.style.display = 'block';

    dropText.textContent = `✅ ${file.name}`;
  };
  reader.readAsDataURL(file);
}

// --- 🔥 Live Drag, Resize, Rotate Logic ---
const draggableText = $('draggableText');
const editorContainer = $('editorContainer');

if (draggableText && editorContainer) {
  // 🔥 मोबाइल पर टेक्स्ट खींचते समय पेज स्क्रॉल न हो
  draggableText.style.touchAction = 'none';

  // टेक्स्ट पर क्लिक करने पर सेलेक्ट (बॉर्डर और बटन दिखें)
  draggableText.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('handle')) return;
    draggableText.classList.add('selected');
    isDragging = true;
    draggableText.style.cursor = 'grabbing';
    e.preventDefault();
  });

  // बाहर क्लिक करने पर सेलेक्शन हटाएँ
  document.addEventListener('pointerdown', (e) => {
    if (!draggableText.contains(e.target) && e.target !== draggableText) {
      draggableText.classList.remove('selected');
    }
  });

  document.addEventListener('pointermove', (e) => {
    const rect = editorContainer.getBoundingClientRect();
    const centerX = rect.left + (currentX / 100) * rect.width;
    const centerY = rect.top + (currentY / 100) * rect.height;

    // 🔥 ड्रैग (Drag) करना
    if (isDragging) {
      let x = e.clientX - rect.left;
      let y = e.clientY - rect.top;
      x = Math.max(0, Math.min(x, rect.width));
      y = Math.max(0, Math.min(y, rect.height));

      currentX = (x / rect.width) * 100;
      currentY = (y / rect.height) * 100;

      draggableText.style.left = currentX + '%';
      draggableText.style.top = currentY + '%';
    }

    // 🔥 छोटा-बड़ा करना (Resize)
    if (isResizing) {
      let dist = Math.hypot(e.clientX - centerX, e.clientY - centerY);
      let scaleFactor = dist / startDist;
      let newSize = Math.round(startFontSize * scaleFactor);
      newSize = Math.max(2, Math.min(50, newSize));

      currentFontSize = newSize;
      $('fontSizeSlider').value = currentFontSize;
      $('fontSizeVal').textContent = currentFontSize;
      updateEditorText();
    }

    // 🔥 घुमाना (Rotate)
    if (isRotating) {
      let angleRad = Math.atan2(e.clientY - centerY, e.clientX - centerX);
      let angleDeg = (angleRad * 180) / Math.PI;

      currentAngle = Math.round(angleDeg + 90);

      $('angleSlider').value = currentAngle;
      $('angleVal').textContent = currentAngle;
      updateEditorText();
    }
  });

  document.addEventListener('pointerup', () => {
    isDragging = false;
    isResizing = false;
    isRotating = false;
    draggableText.style.cursor = 'grab';
  });
}

// बटन (Handles) बनाना
function setupHandles() {
  if (document.querySelector('.handle')) return;

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'handle resize';
  resizeHandle.style.touchAction = 'none';

  const rotateHandle = document.createElement('div');
  rotateHandle.className = 'handle rotate';
  rotateHandle.style.touchAction = 'none';

  // Resize (छोटा-बड़ा) बटन का लॉजिक
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const rect = editorContainer.getBoundingClientRect();
    const centerX = rect.left + (currentX / 100) * rect.width;
    const centerY = rect.top + (currentY / 100) * rect.height;

    isResizing = true;
    startDist = Math.hypot(e.clientX - centerX, e.clientY - centerY);
    startFontSize = currentFontSize;
    e.preventDefault();
  });

  // Rotate (घुमाने) बटन का लॉजिक
  rotateHandle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    isRotating = true;
    e.preventDefault();
  });

  draggableText.appendChild(resizeHandle);
  draggableText.appendChild(rotateHandle);
}

// --- 🔥 स्लाइडर फंक्शन्स ---
function syncColorPicker() {
  const selectedColor = $('textColorSelect').value;
  $('textColorPicker').value = selectedColor;
  updateEditorText();
}

function updateCurveValue() {
  currentCurve = parseFloat($('curveSlider').value) || 0;
  $('curveVal').textContent = currentCurve;
  updateEditorText();
}

function updateAngleValue() {
  // 🔥 Number में बदला ताकि 'तिरछा' में "30"+45 = "3045" जैसी गड़बड़ी न हो
  currentAngle = parseFloat($('angleSlider').value) || 0;
  $('angleVal').textContent = currentAngle;
  updateEditorText();
}

function updateFontSize() {
  currentFontSize = parseFloat($('fontSizeSlider').value) || 10;
  $('fontSizeVal').textContent = currentFontSize;
  updateEditorText();
}

function toggleBold() {
  isBold = !isBold;
  $('boldBtn').style.background = isBold ? '#fbbf24' : '#334155';
  $('boldBtn').style.color = isBold ? '#000' : '#fff';
  updateEditorText();
}

function toggleItalic() {
  isItalic = !isItalic;
  $('italicBtn').style.background = isItalic ? '#fbbf24' : '#334155';
  $('italicBtn').style.color = isItalic ? '#000' : '#fff';
  updateEditorText();
}

function applyCMYK() {
  const c = parseFloat($('cmykC').value) / 100;
  const m = parseFloat($('cmykM').value) / 100;
  const y = parseFloat($('cmykY').value) / 100;
  const k = parseFloat($('cmykK').value) / 100;

  let r = Math.round(255 * (1 - c) * (1 - k));
  let g = Math.round(255 * (1 - m) * (1 - k));
  let b = Math.round(255 * (1 - y) * (1 - k));

  const hex = "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toUpperCase();
  $('textColorPicker').value = hex;
  updateEditorText();
}

// ============================================================
// 🔥 HELPER: DYNAMIC FULL CIRCLE (छोटा/बड़ा अपने आप fit)
// ============================================================
function calcCircleRadius(text, fontSizePx) {
  const approxTextWidth = text.length * fontSizePx * 0.6;
  let r = approxTextWidth / (2 * Math.PI);
  if (r < 10) r = 10; 
  return r;
}

// 🔥 टेक्स्ट हटाने का फंक्शन (नया जोड़ा गया है)
function clearText() {
  $('nameInput').value = '';
  updateEditorText();
}

// 🔥 नाम का SVG (एडिटर की लाइव प्रीव्यू और सर्वर को भेजी जाने वाली PNG - दोनों यही इस्तेमाल करते हैं)
function buildTextSvgParts() {
  // 🔥 यहाँ 'RAHUL' हटा दिया गया है ताकि खाली होने पर कुछ न दिखे
  const rawName = $('nameInput').value; 
  if (!rawName) return null;

  const name = escapeHtml(rawName); // SVG में डालने के लिए सुरक्षित नाम
  const style = $('textStyleSelect').value;
  const color = $('textColorPicker').value;
  const fontWeight = isBold ? 'bold' : 'normal';
  const fontStyle = isItalic ? 'italic' : 'normal';
  
  // 🔥 फॉन्ट फैमिली लें (अगर ड्रॉपडाउन नहीं है तो Arial ले लो)
  const fontFamily = $('fontFamilySelect') ? $('fontFamilySelect').value : 'Arial, sans-serif';

  const w = 400;
  const h = 150;
  const pxY = h / 2;
  const fontSize = currentFontSize * 4;

  // बॉक्स का रोटेशन (अगर 'तिरछा' चुना है तो 45 डिग्री तिरछा करें)
  let boxRotation = Number(currentAngle) || 0;
  if (style === 'rotate') {
    boxRotation = boxRotation + 45; 
  }

  let pathD = "";
  const startX = 30;
  const endX = w - 30;
  const centerX = w / 2;
  const curveVal = parseFloat(currentCurve);

  let svgContent = "";

  // 🔥 1. Vertical (खड़ा) का लॉजिक
  if (style === 'vertical') {
    svgContent = `
      <text x="${centerX}" y="${pxY}" text-anchor="middle" dominant-baseline="middle" 
            font-family="${fontFamily}" font-size="${fontSize}" 
            font-weight="${fontWeight}" font-style="${fontStyle}" 
            fill="${color}" transform="rotate(90 ${centerX} ${pxY})">
        ${name}
      </text>`;
  } 
  // 🔥 बाकी सभी स्टाइल्स (Normal, Horizontal, Round, Full Circle) पाथ (Path) पर चलते हैं
  else {
    if (style === 'full_circle') {
      // पूरा गोल (Zero) - बिल्कुल सीधा और परफेक्ट
      const r = calcCircleRadius(rawName, fontSize);
      pathD = `M ${centerX} ${pxY - r} a ${r},${r} 0 1,1 0,${r * 2} a ${r},${r} 0 1,1 0,${-r * 2}`;
    } 
    else if (style === 'round') {
      // गोल (Round) - पूरा ऊपर की तरफ मुड़ा हुआ, एकदम सीधा
      let controlY = pxY - (50 * 2); // ऊपर की तरफ मोड़
      pathD = `M ${startX} ${pxY} Q ${centerX} ${controlY} ${endX} ${pxY}`;
    } 
    else if (curveVal !== 0 && !isNaN(curveVal)) {
      // कर्व स्लाइडर
      let controlY = pxY - (curveVal * 1.5);
      pathD = `M ${startX} ${pxY} Q ${centerX} ${controlY} ${endX} ${pxY}`;
    } 
    else {
      // सीधा (Normal और Horizontal)
      pathD = `M ${startX} ${pxY} L ${endX} ${pxY}`;
    }

    // 🔥 यहाँ से 'stroke="black"' हटा दिया गया है ताकि अक्षर कटे नहीं
    svgContent = `
      <path id="livePath" d="${pathD}" fill="transparent" />
      <text font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" font-style="${fontStyle}" fill="${color}" pointer-events="none">
        <textPath href="#livePath" startOffset="50%" text-anchor="middle">${name}</textPath>
      </text>
    `;
  }

  return { svgContent, boxRotation, w, h };
}

// 🔥 नाम की पारदर्शी (transparent) PNG बनाना - फोन के ब्राउज़र में ही, ताकि हिंदी फॉन्ट सही आए
// रोटेशन PNG के अंदर ही जुड़ा होता है; चारों तरफ खाली जगह (padding) रखी है ताकि कर्व/घुमाव कटे नहीं
async function renderNameLayer() {
  try {
    const parts = buildTextSvgParts();
    if (!parts) return null;

    const PAD_X = 300, PAD_Y = 300, RATIO = 2;
    const vbW = parts.w + 2 * PAD_X;
    const vbH = parts.h + 2 * PAD_Y;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vbW * RATIO}" height="${vbH * RATIO}" viewBox="${-PAD_X} ${-PAD_Y} ${vbW} ${vbH}">
      <g transform="rotate(${parts.boxRotation} ${parts.w / 2} ${parts.h / 2})">${parts.svgContent}</g>
    </svg>`;

    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('नाम की इमेज नहीं बन पाई'));
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = vbW * RATIO;
    canvas.height = vbH * RATIO;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const cw = editorContainer ? editorContainer.getBoundingClientRect().width : 0;
    if (!blob || !cw) return null;

    // wFrac = यह PNG एडिटर की चौड़ाई का कितना गुना है (सर्वर इसी अनुपात में फाइनल डिज़ाइन पर लगाता है)
    return { blob, wFrac: vbW / cw };
  } catch (e) {
    console.log('नाम की PNG नहीं बनी, सर्वर वाला तरीका चलेगा:', e.message);
    return null;
  }
}

// 🔥 टेक्स्ट और स्टाइल अपडेट करने का सही लॉजिक (सभी स्टाइल्स के साथ)
function updateEditorText() {
  if (!draggableText) return;

  const parts = buildTextSvgParts();

  // अगर नाम खाली है, तो कुछ भी मत दिखाओ (सिर्फ बटन रहने दो)
  if (!parts) {
    const oldSvg = draggableText.querySelector('svg');
    if (oldSvg) oldSvg.remove();
    setupHandles();
    return;
  }

  draggableText.style.transform = `translate(-50%, -50%) rotate(${parts.boxRotation}deg)`;

  const svgWrapper = document.createElement('div');
  svgWrapper.innerHTML = `
    <svg width="${parts.w}" height="${parts.h}" xmlns="http://www.w3.org/2000/svg" style="pointer-events: none; overflow: visible;">
      ${parts.svgContent}
    </svg>
  `;

  // पुराने SVG को हटाकर नया लगाएँ (बटन्स को बचाकर)
  const oldSvg = draggableText.querySelector('svg');
  if (oldSvg) oldSvg.remove();
  draggableText.insertBefore(svgWrapper.firstElementChild, draggableText.firstChild);

  setupHandles();
}

document.getElementById('aspectSelect').addEventListener('change', function () {
  const box = document.getElementById('customSizeBox');
  if (this.value === 'custom') {
    box.style.display = 'block';
  } else {
    box.style.display = 'none';
  }
});

async function applyManualText() {
  const name = $('nameInput').value;
  if (!name) return alert('पहले नाम लिखें');
  if (!currentFile) return alert('पहले फोटो अपलोड करें');

  clearGrid(); setStatus('टेक्स्ट सेट हो रहा है...'); toggleButtons(true);

  const fd = new FormData();
  fd.append('image', currentFile);
  fd.append('name', name);
  fd.append('textX', currentX);
  fd.append('textY', currentY);
  fd.append('textStyle', $('textStyleSelect').value);
  fd.append('textColor', $('textColorPicker').value);
  fd.append('curve', currentCurve);
  fd.append('angle', currentAngle);
  fd.append('fontSize', currentFontSize);
  fd.append('isBold', isBold ? 'bold' : 'normal');
  fd.append('isItalic', isItalic ? 'italic' : 'normal');
  
  // अगर फॉन्ट ड्रॉपडाउन है तो सर्वर पर भी भेजें
  if ($('fontFamilySelect')) {
    fd.append('fontFamily', $('fontFamilySelect').value);
  }

  // 🔥 नाम की PNG भी भेजें (हिंदी फॉन्ट के लिए)
  const layer = await renderNameLayer();
  if (layer) {
    fd.append('nameImage', layer.blob, 'name.png');
    fd.append('nameWFrac', layer.wFrac);
  }

  fetch('/api/manual-text', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      // 🔥 यहाँ नए कार्ड फंक्शन का इस्तेमाल हुआ है
      const div = createThumbCard(data.preview, data.finalRaw, null, '✅ टेक्स्ट सेट हो गया', false);
      $('resultGrid').appendChild(div);
      setStatus('✅ तैयार!', 'ok');
    })
    .catch(e => setStatus('❌ ' + e.message, 'err'))
    .finally(() => toggleButtons(false));
}

// --- Helpers ---
function setStatus(msg, type = '') {
  const bar = $('statusBar');
  bar.className = 'status ' + type;
  bar.innerHTML = (type === '' ? '<span class="spinner"></span>' : '') + msg;
}

// 🔥 अपडेटेड थंब कार्ड (अब हर जगह दोनों डाउनलोड बटन 100% दिखेंगे)
function createThumbCard(wmUrl, rawUrl, pdfUrl, label, isVector = false) {
  const div = document.createElement('div');
  div.className = 'thumb';
  
  // अगर सर्वर से rawUrl (बिना वॉटरमार्क) नहीं आया है, तो बैकअप के तौर पर wmUrl (वॉटरमार्क वाली) ही डाउनलोड होगी
  const downloadRawUrl = rawUrl || wmUrl;
  
  let buttonsHtml = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 8px;">
      <a href="${wmUrl}" download class="btn small" style="text-align: center; font-size: 11px; padding: 6px; background: #475569;">⬇️ Watermark</a>
      
      <a href="${downloadRawUrl}" download class="btn small primary" style="text-align: center; font-size: 11px; padding: 6px; background: #fbbf24; color: #000;">⬇️ बिना WM</a>
      
      <button onclick="shareImage('${downloadRawUrl}')" class="btn small" style="text-align: center; font-size: 11px; padding: 6px; background: #3b82f6;">📤 शेयर</button>
      
      ${isVector && pdfUrl ? `<a href="${pdfUrl}" download class="btn small primary" style="text-align: center; font-size: 11px; padding: 6px; background: #10b981; color: #fff;">⬇️ PDF</a>` : ''}
    </div>
  `;

  div.innerHTML = `
    <a href="${wmUrl}" target="_blank"><img src="${wmUrl}" /></a>
    <p>${label}</p>
    ${buttonsHtml}
  `;
  return div;
}

// 🔥 showThumb को भी अपडेट कर दिया गया है
function showThumb(url, label) {
  const div = createThumbCard(url, url, null, label, false);
  $('resultGrid').appendChild(div);
}

// 🔥 शेयर करने का फंक्शन (नया जोड़ा गया है)
async function shareImage(url) {
  try {
    // इमेज को फेच करके फाइल में बदलें
    const response = await fetch(url);
    const blob = await response.blob();
    const file = new File([blob], 'design.png', { type: blob.type });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: 'AI Design Studio',
        text: 'मेरा AI डिज़ाइन देखिए!'
      });
    } else {
      // अगर शेयर सपोर्ट नहीं है तो डाउनलोड कर दें
      const a = document.createElement('a');
      a.href = url;
      a.download = 'design.png';
      a.click();
    }
  } catch (error) {
    console.log('शेयर करने में समस्या:', error);
    alert('इमेज शेयर नहीं हो पाई, कृपया डाउनलोड करें।');
  }
}

function clearGrid() {
  $('resultGrid').innerHTML = '';
  $('layerResults').innerHTML = '';
  $('downloadBar').classList.add('hidden');
}

function toggleButtons(disable) {
  document.querySelectorAll('.btn').forEach(b => b.disabled = disable);
}

// ==========================================
// 1. FULL AUTO
// ==========================================
async function runAuto() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('FULL AUTO चल रहा है...'); toggleButtons(true);

  const fd = new FormData();
  fd.append('image', currentFile);
  fd.append('prompt', $('promptInput').value || 'luxury gold background');
  fd.append('aspect', $('aspectSelect').value);
  const cs = getCustomSize();
  fd.append('customW', cs.w);
  fd.append('customH', cs.h);
  fd.append('use3d', $('use3dText').checked ? 'true' : 'false');

  // 🔥 नाम + पोज़िशन (textX/textY) + स्टाइल सब एक साथ भेजें, ताकि नाम ठीक वहीं छपे जहाँ एडिटर में रखा है
  await appendTextSettings(fd);

  try {
    const r = await fetch('/api/auto', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    // 🔥 अब कटआउट का बिना-वॉटरमार्क (transparent) वर्ज़न भी डाउनलोड हो सकता है
    if (data.steps.cutPreview) {
      $('resultGrid').appendChild(createThumbCard(data.steps.cutPreview, data.steps.cutRaw, null, '✂️ कटआउट (transparent)', false));
    }
    if (data.steps.finalPreview) {
      // 🔥 यहाँ नए कार्ड फंक्शन का इस्तेमाल हुआ है ताकि दोनों डाउनलोड बटन आ जाएँ
      const div = createThumbCard(data.steps.finalPreview, data.steps.finalRaw, null, '✅ Final', false);
      $('resultGrid').appendChild(div);
    }

    // 🔥 अलग-अलग लेयर्स (सब एक ही साइज़ की PNG, एक के ऊपर एक ठीक बैठती हैं - Photoshop/Canva में सीधे डालिए)
    if (data.steps.layerBg) $('resultGrid').appendChild(createThumbCard(data.steps.layerBg, data.steps.layerBg, null, '🧩 लेयर 1: बैकग्राउंड', false));
    if (data.steps.layerCut) $('resultGrid').appendChild(createThumbCard(data.steps.layerCut, data.steps.layerCut, null, '🧩 लेयर 2: कटआउट (transparent)', false));
    if (data.steps.layerText) $('resultGrid').appendChild(createThumbCard(data.steps.layerText, data.steps.layerText, null, '🧩 लेयर 3: नाम (transparent)', false));
    if (data.steps.layerBg && data.steps.layerCut && data.steps.size) addShareCard(data.steps); // क्लाइंट को भेजने का लिंक

    $('downloadFull').href = data.steps.finalRaw;
    $('downloadPreview').href = data.steps.finalPreview;
    $('downloadBar').classList.remove('hidden');
    const srcMap = { gemini: 'Gemini ✅', pollinations: 'Pollinations (Gemini फेल)', recraft: 'Recraft (Gemini फेल)', gradient: 'सादा ग्रेडिएंट (सब फेल)' };
    setStatus('✅ तैयार! बैकग्राउंड: ' + (srcMap[data.steps.bgSource] || '-') + (($('nameInput').value) ? '' : ' | ⚠️ नाम खाली था'), 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  } finally {
    toggleButtons(false);
  }
}

// ==========================================
// 2. SPLIT + TRACE (SAM + Vector) - फाइनल सही कोड
// ==========================================
async function runSplitAndTrace() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('SAM लेयर्स को अलग कर रहा है...'); toggleButtons(true);
  
  const fd = new FormData(); 
  fd.append('image', currentFile);
  
  try {
    // 🔥 सीधे Render वाले SAM सर्वर और सही एंडपॉइंट पर रिक्वेस्ट भेजने के लिए
    const r = await fetch(`${SAM_BACKEND_URL}/split-layers`, { 
      method: 'POST', 
      body: fd 
    });
    
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    
    const grid = $('layerResults');
    data.results.forEach(res => {
      // 🔥 बिना वॉटरमार्क वाली इमेज और वेक्टर PDF सही से पास हो रहे हैं
      const div = createThumbCard(res.previewPng, res.rawPng, res.vectorPdf, `लेयर ${res.layerNumber}`, true);
      grid.appendChild(div);
    });
    
    setStatus('✅ लेयर्स तैयार!', 'ok');
  } catch (e) { 
    setStatus('❌ ' + e.message, 'err'); 
  } finally { 
    toggleButtons(false); 
  }
}



// ==========================================
// 3. VARIATIONS (5 डिज़ाइन)
// ==========================================
async function runVariations() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('5 नए डिज़ाइन बन रहे हैं (इसमें 1-2 मिनट लग सकते हैं)...'); toggleButtons(true);
  
  const fd = new FormData();
  fd.append('image', currentFile);
  fd.append('aspect', $('aspectSelect').value);
  const cs = getCustomSize();
  fd.append('customW', cs.w);
  fd.append('customH', cs.h);

  fd.append('prompt', $('promptInput').value); // आपका थीम/प्रॉम्प्ट हर ऑटो-डिज़ाइन में जुड़ेगा

  // 🔥 पहले सिर्फ नाम जा रहा था; अब पोज़िशन, रंग, साइज़, स्टाइल सब जा रहा है ताकि नाम हर डिज़ाइन में सही छपे
  await appendTextSettings(fd);

  try {
    const r = await fetch('/api/variations', { method: 'POST', body: fd });
    const data = await r.json();
    
    if (data.error) throw new Error(data.error);
    
    // 🔥 यहाँ हमने कोड बदला है ताकि wmUrl और rawUrl दोनों सही से पास हो जाएँ
    if (data.variations && data.variations.length > 0) {
      data.variations.forEach((item, i) => {
        // अब सर्वर से item.wmUrl (वॉटरमार्क वाली) और item.rawUrl (बिना वॉटरमार्क वाली) आ रहा है
        const div = createThumbCard(item.wmUrl, item.rawUrl, null, `✨ डिज़ाइन ${i + 1}`, false);
        $('resultGrid').appendChild(div);
      });
      setStatus(`✅ ${data.variations.length} डिज़ाइन तैयार!`, 'ok');
    } else {
      setStatus('❌ कोई डिज़ाइन नहीं बन पाया, फिर से कोशिश करें।', 'err');
    }
    
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  } finally {
    toggleButtons(false);
  }
}

// ==========================================
// 4. VECTOR ONLY
// ==========================================
async function runVector() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('वेक्टर बन रहा है...'); toggleButtons(true);
  const fd = new FormData(); fd.append('image', currentFile);
  try {
    const r = await fetch('/api/vectorize', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    $('downloadFull').href = d.url;
    $('downloadBar').classList.remove('hidden');
    setStatus('✅ वेक्टर PDF तैयार', 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  } finally {
    toggleButtons(false);
  }
}

// ==========================================
// 5. CUTOUT ONLY
// ==========================================
async function runCutout() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('कटिंग हो रही है...'); toggleButtons(true);
  const fd = new FormData(); fd.append('image', currentFile); fd.append('cutMode', $('cutModeSelect') ? $('cutModeSelect').value : 'auto');
  try {
    const r = await fetch('/api/cutout', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    
    // 🔥 यहाँ d.finalRaw पास किया गया है ताकि बिना वॉटरमार्क वाला बटन काम करे
    const div = createThumbCard(d.preview, d.finalRaw, null, '✂️ कटिंग', false);
    $('resultGrid').appendChild(div);
    
    setStatus('✅ हो गया', 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  } finally {
    toggleButtons(false);
  }
}

// ==========================================
// 6. HD ONLY
// ==========================================
async function runUpscale() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('HD बन रहा है...'); toggleButtons(true);
  const fd = new FormData(); fd.append('image', currentFile);
  try {
    const r = await fetch('/api/upscale', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    
    // 🔥 यहाँ d.finalRaw पास किया गया है ताकि बिना वॉटरमार्क वाला बटन काम करे
    const div = createThumbCard(d.preview, d.finalRaw, null, '🔼 HD', false);
    $('resultGrid').appendChild(div);
    
    setStatus('✅ हो गया', 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  } finally {
    toggleButtons(false);
  }
}

// ==========================================
// 🔗 क्लाइंट को भेजने वाला एडिट-लिंक
// ==========================================
function addShareCard(steps) {
  const div = document.createElement('div');
  div.className = 'thumb';
  div.innerHTML = `
    <p style="margin-bottom:8px;">🔗 क्लाइंट/साथी को एडिट-लिंक भेजें<br><span style="font-size:11px;opacity:.8;">वह नाम बदल सकेगा, 3D इफेक्ट लगा सकेगा, टेक्स्ट जोड़ सकेगा और डाउनलोड कर सकेगा</span></p>
    <button class="btn small primary" style="width:100%; background:#8b5cf6; color:#fff;">🔗 लिंक बनाएँ</button>
    <div class="shareOut" style="margin-top:8px; word-break:break-all; font-size:12px;"></div>
  `;
  const btn = div.querySelector('button');
  const out = div.querySelector('.shareOut');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'लिंक बन रहा है...';
    try {
      const link = await createShareLink(steps);
      out.innerHTML = '';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.readOnly = true; inp.value = link;
      inp.style.cssText = 'width:100%; padding:8px; font-size:12px;';
      inp.addEventListener('focus', () => inp.select());
      out.appendChild(inp);
      btn.textContent = '✅ लिंक तैयार (दोबारा भेजें)';
      if (navigator.share) { try { await navigator.share({ title: 'AI Design Studio - डिज़ाइन', url: link }); } catch (e) {} }
      else if (navigator.clipboard) { try { await navigator.clipboard.writeText(link); } catch (e) {} }
    } catch (e) {
      out.textContent = '❌ ' + e.message;
      btn.textContent = '🔗 फिर कोशिश करें';
    } finally { btn.disabled = false; }
  });
  $('resultGrid').appendChild(div);
}

async function createShareLink(steps) {
  const cw = editorContainer ? editorContainer.getBoundingClientRect().width : 340;
  const name = $('nameInput').value;
  const texts = name ? [{
    text: name,
    x: currentX, y: currentY,
    sizeFrac: (currentFontSize * 4) / (cw || 340), // फॉन्ट साइज़, canvas की चौड़ाई के अनुपात में
    color: $('textColorPicker').value,
    bold: isBold, italic: isItalic,
    font: $('fontFamilySelect') ? $('fontFamilySelect').value : 'Arial, sans-serif',
    angle: Number(currentAngle) || 0,
    effect3d: false
  }] : [];

  const r = await fetch('/api/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: name || 'डिज़ाइन',
      W: steps.size.W, H: steps.size.H,
      bg: steps.layerBg, cut: steps.layerCut, final: steps.finalRaw,
      texts
    })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return location.origin + d.url;
}

// ==========================================
// 🧩 पार्ट्स में बाँटना (फूल, पट्टी, अक्षर... सब अलग-अलग) + एडिटर में नया डिज़ाइन
// ==========================================
function getCanvasSize() {
  const a = $('aspectSelect').value;
  if (a === 'custom') {
    const cs = getCustomSize();
    if (cs.w && cs.h) return { W: Math.min(8000, cs.w), H: Math.min(8000, cs.h) };
    return { W: 2000, H: 3000 };
  }
  const m = { '2:3': [2000, 3000], '1:1': [2400, 2400], '3:2': [3000, 2000], card: [1050, 600], wedding: [1500, 2100], banner: [3600, 1200] };
  const v = m[a] || m['2:3'];
  return { W: v[0], H: v[1] };
}

function buildTextsForProject() {
  const cw = editorContainer ? editorContainer.getBoundingClientRect().width : 340;
  const name = $('nameInput').value;
  if (!name) return [];
  return [{
    text: name, x: currentX, y: currentY,
    sizeFrac: (currentFontSize * 4) / (cw || 340),
    color: $('textColorPicker').value, bold: isBold, italic: isItalic,
    font: $('fontFamilySelect') ? $('fontFamilySelect').value : 'Arial, sans-serif',
    angle: Number(currentAngle) || 0, effect3d: false
  }];
}

async function createPartsProject(data) {
  const { W, H } = getCanvasSize();
  // कटी हुई पूरी डिज़ाइन को canvas पर उसी तरह बैठाना जैसे FULL AUTO में बैठती है
  const s = Math.min(0.92 * W / data.cw, 0.74 * H / data.ch);
  const x0 = (W - data.cw * s) / 2;
  const y0 = Math.max(0, (H - data.ch * s) / 2 + 0.05 * H);
  const items = data.parts.map(p => ({
    url: p.url,
    cx: (x0 + (p.x + p.w / 2) * s) / W * 100,
    cy: (y0 + (p.y + p.h / 2) * s) / H * 100,
    wFrac: (p.w * s) / W, angle: 0, flip: false
  }));
  const r = await fetch('/api/project', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: $('nameInput').value || 'पार्ट्स डिज़ाइन', W, H, items, texts: buildTextsForProject(), useBgColor: true, bgColor: '#ffffff' })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return location.origin + d.url;
}

function addPartsEditorCard(data) {
  const div = document.createElement('div');
  div.className = 'thumb';
  div.innerHTML = `
    <p style="margin-bottom:8px;">🎨 इन ${data.parts.length} पार्ट्स से नया डिज़ाइन बनाएँ<br><span style="font-size:11px;opacity:.8;">हर पार्ट को खींचें, छोटा-बड़ा करें, घुमाएँ, कॉपी करें। AI बैकग्राउंड और नाम भी वहीं लगेगा।</span></p>
    <button class="btn small primary" style="width:100%; background:#8b5cf6; color:#fff;">🎨 एडिटर तैयार करें</button>
    <div class="editorOut" style="margin-top:8px; word-break:break-all; font-size:12px;"></div>
  `;
  const btn = div.querySelector('button');
  const out = div.querySelector('.editorOut');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'एडिटर बन रहा है...';
    try {
      const link = await createPartsProject(data);
      out.innerHTML = '';
      const a = document.createElement('a');
      a.href = link; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = '👉 एडिटर खोलें';
      a.className = 'btn small primary';
      a.style.cssText = 'display:block; text-align:center; background:#10b981; color:#fff; padding:10px; border-radius:8px; margin-bottom:6px; text-decoration:none;';
      out.appendChild(a);
      const inp = document.createElement('input');
      inp.type = 'text'; inp.readOnly = true; inp.value = link;
      inp.style.cssText = 'width:100%; padding:8px; font-size:12px;';
      inp.addEventListener('focus', () => inp.select());
      out.appendChild(inp);
      btn.textContent = '✅ तैयार';
    } catch (e) {
      out.textContent = '❌ ' + e.message;
      btn.textContent = '🎨 फिर कोशिश करें';
    } finally { btn.disabled = false; }
  });
  $('resultGrid').appendChild(div);
}

async function runSplitParts() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('कटिंग होकर पार्ट्स बन रहे हैं (1-2 मिनट लग सकते हैं)...'); toggleButtons(true);

  const fd = new FormData();
  fd.append('image', currentFile);
  fd.append('cutMode', $('cutModeSelect') ? $('cutModeSelect').value : 'auto');
  fd.append('hd', ($('splitHd') && $('splitHd').checked) ? 'true' : 'false');
  fd.append('gap', $('splitGap') ? $('splitGap').value : 'small');

  try {
    const r = await fetch('/api/split-parts', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    if (!data.parts || data.parts.length === 0) {
      setStatus('❌ कोई पार्ट नहीं मिला। कटिंग का तरीका बदलकर देखें।', 'err');
      return;
    }

    addPartsEditorCard(data);
    $('resultGrid').appendChild(createThumbCard(data.cutUrl, data.cutUrl, null, '✂️ पूरी कटी हुई डिज़ाइन', false));
    data.parts.forEach((p, i) => {
      $('resultGrid').appendChild(createThumbCard(p.url, p.url, null, `🧩 पार्ट ${i + 1}`, false));
    });
    setStatus(`✅ ${data.parts.length} पार्ट तैयार (${data.found} टुकड़े मिले)`, 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  } finally {
    toggleButtons(false);
  }
}

// पेज लोड होते ही एडिटर अपडेट करें
updateEditorText();

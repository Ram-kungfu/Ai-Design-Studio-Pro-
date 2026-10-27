// 🔗 आपका Python (SAM/लेयर) सर्वर. ध्यान दें: असली काम Node सर्वर (server.js) इसी से करवाता है
// (Render के मुख्य ऐप के Environment में SAM_SERVER_URL = इस लिंक + /split-layers होना चाहिए).
// यहाँ ब्राउज़र इसे सिर्फ "जगाने" (Render फ्री सर्वर सो जाता है) के लिए इस्तेमाल करता है.
const SAM_BACKEND_URL = "https://sam-server-new.onrender.com";

// सोए हुए SAM सर्वर को जगाना और तैयार होने तक इंतज़ार (ज़्यादा से ज़्यादा ~2 मिनट)
async function wakeSamServer(onStatus) {
  const started = Date.now();
  try { fetch(SAM_BACKEND_URL + '/health', { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); } catch (e) {}
  for (let i = 0; i < 24; i++) {
    try {
      const r = await fetch(SAM_BACKEND_URL + '/health', { cache: 'no-store' });
      if (r.ok) return true;
    } catch (e) { /* अभी सो रहा है / जाग रहा है */ }
    if (onStatus) onStatus(`⏳ SAM सर्वर जाग रहा है... ${Math.round((Date.now() - started) / 1000)} सेकंड (पहली बार 1-2 मिनट लग सकते हैं, पेज खुला रखें)`);
    await new Promise(res => setTimeout(res, 5000));
  }
  return false;
}

// नेटवर्क टूटने ("Failed to fetch") पर खुद-ब-खुद दोबारा कोशिश
async function fetchWithRetry(url, options, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, options); }
    catch (e) {
      if (i < tries - 1) {
        setStatus(`⚠️ कनेक्शन टूटा, फिर कोशिश (${i + 2}/${tries})... सर्वर जाग रहा हो सकता है, पेज खुला रखें`);
        await new Promise(res => setTimeout(res, 8000));
      }
    }
  }
  throw new Error('सर्वर से कनेक्शन नहीं हो पाया (Failed to fetch)। 1-2 मिनट बाद फिर कोशिश करें और पेज खुला रखें।');
}

// जवाब JSON न हो (जैसे Render का 502 पेज) तो समझने लायक संदेश
async function readJson(r) {
  const t = await r.text();
  try { return JSON.parse(t); }
  catch (e) { throw new Error(`सर्वर ने सही जवाब नहीं दिया (कोड ${r.status}). सर्वर जाग रहा या क्रैश हुआ हो सकता है, थोड़ी देर बाद फिर कोशिश करें।`); }
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
  fd.append('cutMode', $('cutModeSelect') ? $('cutModeSelect').value : 'auto'); 

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
if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault(); dropzone.classList.remove('drag');
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
}

function handleFile(file) {
  currentFile = file;
  const reader = new FileReader();
  reader.onload = ev => {
    if(previewImg) {
        previewImg.src = ev.target.result;
        previewImg.classList.remove('hidden');
    }
    const editorBg = $('editorBg');
    if(editorBg) {
        editorBg.src = ev.target.result;
        editorBg.style.display = 'block';
    }
    if(dropText) dropText.textContent = `✅ ${file.name}`;
  };
  reader.readAsDataURL(file);
}

// --- 🔥 Live Drag, Resize, Rotate Logic ---
const draggableText = $('draggableText');
const editorContainer = $('editorContainer');

if (draggableText && editorContainer) {
  draggableText.style.touchAction = 'none';

  draggableText.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('handle')) return;
    draggableText.classList.add('selected');
    isDragging = true;
    draggableText.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('pointerdown', (e) => {
    if (!draggableText.contains(e.target) && e.target !== draggableText) {
      draggableText.classList.remove('selected');
    }
  });

  document.addEventListener('pointermove', (e) => {
    const rect = editorContainer.getBoundingClientRect();
    const centerX = rect.left + (currentX / 100) * rect.width;
    const centerY = rect.top + (currentY / 100) * rect.height;

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

    if (isResizing) {
      let dist = Math.hypot(e.clientX - centerX, e.clientY - centerY);
      let scaleFactor = dist / startDist;
      let newSize = Math.round(startFontSize * scaleFactor);
      newSize = Math.max(2, Math.min(50, newSize));

      currentFontSize = newSize;
      if($('fontSizeSlider')) $('fontSizeSlider').value = currentFontSize;
      if($('fontSizeVal')) $('fontSizeVal').textContent = currentFontSize;
      updateEditorText();
    }

    if (isRotating) {
      let angleRad = Math.atan2(e.clientY - centerY, e.clientX - centerX);
      let angleDeg = (angleRad * 180) / Math.PI;

      currentAngle = Math.round(angleDeg + 90);

      if($('angleSlider')) $('angleSlider').value = currentAngle;
      if($('angleVal')) $('angleVal').textContent = currentAngle;
      updateEditorText();
    }
  });

  document.addEventListener('pointerup', () => {
    isDragging = false;
    isResizing = false;
    isRotating = false;
    if(draggableText) draggableText.style.cursor = 'grab';
  });
}

function setupHandles() {
  if (document.querySelector('.handle') || !draggableText) return;

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'handle resize';
  resizeHandle.style.touchAction = 'none';

  const rotateHandle = document.createElement('div');
  rotateHandle.className = 'handle rotate';
  rotateHandle.style.touchAction = 'none';

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
  if($('textColorSelect') && $('textColorPicker')) {
      const selectedColor = $('textColorSelect').value;
      $('textColorPicker').value = selectedColor;
      updateEditorText();
  }
}

function updateCurveValue() {
  if($('curveSlider') && $('curveVal')) {
      currentCurve = parseFloat($('curveSlider').value) || 0;
      $('curveVal').textContent = currentCurve;
      updateEditorText();
  }
}

function updateAngleValue() {
  if($('angleSlider') && $('angleVal')) {
      currentAngle = parseFloat($('angleSlider').value) || 0;
      $('angleVal').textContent = currentAngle;
      updateEditorText();
  }
}

function updateFontSize() {
  if($('fontSizeSlider') && $('fontSizeVal')) {
      currentFontSize = parseFloat($('fontSizeSlider').value) || 10;
      $('fontSizeVal').textContent = currentFontSize;
      updateEditorText();
  }
}

function toggleBold() {
  isBold = !isBold;
  if($('boldBtn')) {
      $('boldBtn').style.background = isBold ? '#fbbf24' : '#334155';
      $('boldBtn').style.color = isBold ? '#000' : '#fff';
  }
  updateEditorText();
}

function toggleItalic() {
  isItalic = !isItalic;
  if($('italicBtn')) {
      $('italicBtn').style.background = isItalic ? '#fbbf24' : '#334155';
      $('italicBtn').style.color = isItalic ? '#000' : '#fff';
  }
  updateEditorText();
}

function applyCMYK() {
  if(!$('cmykC') || !$('cmykM') || !$('cmykY') || !$('cmykK')) return;
  const c = parseFloat($('cmykC').value) / 100;
  const m = parseFloat($('cmykM').value) / 100;
  const y = parseFloat($('cmykY').value) / 100;
  const k = parseFloat($('cmykK').value) / 100;

  let r = Math.round(255 * (1 - c) * (1 - k));
  let g = Math.round(255 * (1 - m) * (1 - k));
  let b = Math.round(255 * (1 - y) * (1 - k));

  const hex = "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toUpperCase();
  if($('textColorPicker')) $('textColorPicker').value = hex;
  updateEditorText();
}

function calcCircleRadius(text, fontSizePx) {
  const approxTextWidth = text.length * fontSizePx * 0.6;
  let r = approxTextWidth / (2 * Math.PI);
  if (r < 10) r = 10; 
  return r;
}

function clearText() {
  if($('nameInput')) $('nameInput').value = '';
  updateEditorText();
}

function buildTextSvgParts() {
  if(!$('nameInput') || !$('textStyleSelect') || !$('textColorPicker')) return null;
  const rawName = $('nameInput').value; 
  if (!rawName) return null;

  const name = escapeHtml(rawName);
  const style = $('textStyleSelect').value;
  const color = $('textColorPicker').value;
  const fontWeight = isBold ? 'bold' : 'normal';
  const fontStyle = isItalic ? 'italic' : 'normal';
  
  const fontFamily = $('fontFamilySelect') ? $('fontFamilySelect').value : 'Arial, sans-serif';

  const w = 400;
  const h = 150;
  const pxY = h / 2;
  const fontSize = currentFontSize * 4;

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

  if (style === 'vertical') {
    svgContent = `
      <text x="${centerX}" y="${pxY}" text-anchor="middle" dominant-baseline="middle" 
            font-family="${fontFamily}" font-size="${fontSize}" 
            font-weight="${fontWeight}" font-style="${fontStyle}" 
            fill="${color}" transform="rotate(90 ${centerX} ${pxY})">
        ${name}
      </text>`;
  } 
  else {
    if (style === 'full_circle') {
      const r = calcCircleRadius(rawName, fontSize);
      pathD = `M ${centerX} ${pxY - r} a ${r},${r} 0 1,1 0,${r * 2} a ${r},${r} 0 1,1 0,${-r * 2}`;
    } 
    else if (style === 'round') {
      let controlY = pxY - (50 * 2); 
      pathD = `M ${startX} ${pxY} Q ${centerX} ${controlY} ${endX} ${pxY}`;
    } 
    else if (curveVal !== 0 && !isNaN(curveVal)) {
      let controlY = pxY - (curveVal * 1.5);
      pathD = `M ${startX} ${pxY} Q ${centerX} ${controlY} ${endX} ${pxY}`;
    } 
    else {
      pathD = `M ${startX} ${pxY} L ${endX} ${pxY}`;
    }

    svgContent = `
      <path id="livePath" d="${pathD}" fill="transparent" />
      <text font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" font-style="${fontStyle}" fill="${color}" pointer-events="none">
        <textPath href="#livePath" startOffset="50%" text-anchor="middle">${name}</textPath>
      </text>
    `;
  }

  return { svgContent, boxRotation, w, h };
}

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

    return { blob, wFrac: vbW / cw };
  } catch (e) {
    console.log('नाम की PNG नहीं बनी, सर्वर वाला तरीका चलेगा:', e.message);
    return null;
  }
}

function updateEditorText() {
  if (!draggableText) return;

  const parts = buildTextSvgParts();

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

  const oldSvg = draggableText.querySelector('svg');
  if (oldSvg) oldSvg.remove();
  draggableText.insertBefore(svgWrapper.firstElementChild, draggableText.firstChild);

  setupHandles();
}

if ($('aspectSelect')) {
    $('aspectSelect').addEventListener('change', function () {
      const box = $('customSizeBox');
      if (box) box.style.display = this.value === 'custom' ? 'block' : 'none';
    });
}

async function applyManualText() {
  if(!$('nameInput') || !$('textStyleSelect') || !$('textColorPicker')) return;
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
  
  if ($('fontFamilySelect')) {
    fd.append('fontFamily', $('fontFamilySelect').value);
  }

  const layer = await renderNameLayer();
  if (layer) {
    fd.append('nameImage', layer.blob, 'name.png');
    fd.append('nameWFrac', layer.wFrac);
  }

  fetch('/api/manual-text', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
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
  if(!bar) return;
  bar.className = 'status ' + type;
  bar.innerHTML = (type === '' ? '<span class="spinner"></span>' : '') + msg;
}

function createThumbCard(wmUrl, rawUrl, pdfUrl, label, isVector = false) {
  const div = document.createElement('div');
  div.className = 'thumb';
  
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

function showThumb(url, label) {
  const div = createThumbCard(url, url, null, label, false);
  if($('resultGrid')) $('resultGrid').appendChild(div);
}

async function shareImage(url) {
  try {
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
  if($('resultGrid')) $('resultGrid').innerHTML = '';
  if($('layerResults')) $('layerResults').innerHTML = '';
  if($('downloadBar')) $('downloadBar').classList.add('hidden');
}

function toggleButtons(disable) {
  document.querySelectorAll('.btn').forEach(b => b.disabled = disable);
}

// ==========================================
// 🔥 मैजिक फिक्स: एडिटर के लिए डेटा को सुरक्षित बनाना (x,y,w,h डिफ़ॉल्ट सेट करना)
// ==========================================
function createSafeEditorData(dataResults) {
  return {
    parts: dataResults.map(r => {
      return {
        url: r.rawPng || r.previewPng || r.vectorPdf || r.url || '',
        x: (r.x !== undefined) ? r.x : 0, 
        y: (r.y !== undefined) ? r.y : 0, 
        w: (r.w !== undefined) ? r.w : 500, 
        h: (r.h !== undefined) ? r.h : 500
      };
    }),
    cw: 500, 
    ch: 500
  };
}

// ==========================================
// 1. FULL AUTO
// ==========================================
async function runAuto() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('FULL AUTO चल रहा है...'); toggleButtons(true);

  const fd = new FormData();
  fd.append('image', currentFile);
  fd.append('prompt', $('promptInput') ? $('promptInput').value : 'luxury gold background');
  fd.append('aspect', $('aspectSelect') ? $('aspectSelect').value : '2:3');
  const cs = getCustomSize();
  fd.append('customW', cs.w);
  fd.append('customH', cs.h);
  fd.append('use3d', ($('use3dText') && $('use3dText').checked) ? 'true' : 'false');

  await appendTextSettings(fd);

  try {
    const r = await fetch('/api/auto', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    if (data.steps.cutPreview) {
      $('resultGrid').appendChild(createThumbCard(data.steps.cutPreview, data.steps.cutRaw, null, '✂️ कटआउट (transparent)', false));
    }
    if (data.steps.finalPreview) {
      const div = createThumbCard(data.steps.finalPreview, data.steps.finalRaw, null, '✅ Final', false);
      $('resultGrid').appendChild(div);
    }

    if (data.steps.layerBg) $('resultGrid').appendChild(createThumbCard(data.steps.layerBg, data.steps.layerBg, null, '🧩 लेयर 1: बैकग्राउंड', false));
    if (data.steps.layerCut) $('resultGrid').appendChild(createThumbCard(data.steps.layerCut, data.steps.layerCut, null, '🧩 लेयर 2: कटआउट (transparent)', false));
    if (data.steps.layerText) $('resultGrid').appendChild(createThumbCard(data.steps.layerText, data.steps.layerText, null, '🧩 लेयर 3: नाम (transparent)', false));
    
    if (data.steps.layerBg && data.steps.layerCut && data.steps.size) addShareCard(data.steps); 

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
// 2. SPLIT + TRACE (SAM + Vector) - 🔥 100% फिक्स
// ==========================================
async function runSplitAndTrace() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('SAM लेयर्स को अलग कर रहा है...'); toggleButtons(true);
  const fd = new FormData(); fd.append('image', currentFile);
  
  // 🔥 कस्टम कटिंग टेक्स्ट सर्वर के 'name' फील्ड में भेज रहे हैं (सिर्फ नाम काटने के लिए)
  if ($('customCutText') && $('customCutText').value.trim() !== '') {
    fd.append('name', $('customCutText').value);
  }

  try {
    await wakeSamServer(msg => setStatus(msg));
    setStatus('SAM लेयर्स को अलग कर रहा है... (कुछ मिनट लग सकते हैं, पेज खुला रखें)');
    const r = await fetchWithRetry('/api/split-and-trace', { method: 'POST', body: fd });
    const data = await readJson(r);
    if (data.error) throw new Error(data.error);
    
    const grid = $('layerResults');
    if (data.results) {
        data.results.forEach(res => {
          grid.appendChild(createThumbCard(res.previewPng, res.rawPng, res.vectorPdf, `लेयर ${res.layerNumber}`, true));
        });
        // 🔥 एडिटर बटन के लिए डेटा सुरक्षित तरीके से भेजना
        addPartsEditorCard(createSafeEditorData(data.results)); 
    }

    setStatus('✅ लेयर्स तैयार!', 'ok');
  } catch (e) { setStatus('❌ ' + e.message, 'err'); } finally { toggleButtons(false); }
}

// ==========================================
// 3. VARIATIONS (5 डिज़ाइन)
// ==========================================
async function runVariations() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('5 नए डिज़ाइन बन रहे हैं (इसमें 1-2 मिनट लग सकते हैं)...'); toggleButtons(true);
  
  const fd = new FormData();
  fd.append('image', currentFile);
  if($('aspectSelect')) fd.append('aspect', $('aspectSelect').value);
  const cs = getCustomSize();
  fd.append('customW', cs.w);
  fd.append('customH', cs.h);
  if($('promptInput')) fd.append('prompt', $('promptInput').value); 

  await appendTextSettings(fd);

  try {
    const r = await fetch('/api/variations', { method: 'POST', body: fd });
    const data = await r.json();
    
    if (data.error) throw new Error(data.error);
    
    if (data.variations && data.variations.length > 0) {
      data.variations.forEach((item, i) => {
        const div = createThumbCard(item.wmUrl, item.rawUrl, null, `✨ डिज़ाइन ${i + 1}`, false);
        $('resultGrid').appendChild(div);
      });

      addPartsEditorCard(createSafeEditorData(data.variations.map(v => ({ url: v.rawUrl }))));
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
    
    $('resultGrid').appendChild(createThumbCard(d.url, d.url, null, '✅ वेक्टर PDF तैयार', true));
    
    addPartsEditorCard(createSafeEditorData([{ url: d.url }]));

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
  const fd = new FormData(); 
  fd.append('image', currentFile); 
  if($('cutModeSelect')) fd.append('cutMode', $('cutModeSelect').value);
  
  // 🔥 कस्टम टेक्स्ट यहाँ भी भेजा जा रहा है
  if ($('customCutText') && $('customCutText').value.trim() !== '') {
    fd.append('name', $('customCutText').value);
  }

  try {
    const r = await fetch('/api/cutout', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    
    const div = createThumbCard(d.preview, d.finalRaw, null, '✂️ कटिंग', false);
    $('resultGrid').appendChild(div);
    
    addPartsEditorCard(createSafeEditorData([{ url: d.finalRaw }]));

    setStatus('✅ हो गया', 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  } finally {
    toggleButtons(false);
  }
}

// ==========================================
// 🔥 6. DIRECT VECTOR (सीधा कट + वेक्टर) - 🔥 100% फिक्स
// ==========================================
async function runDirectVector() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('सीधा कट + वेक्टर बन रहा है...'); toggleButtons(true);
  const fd = new FormData(); 
  fd.append('image', currentFile);
  
  try {
    if($('cutModeSelect')) fd.append('cutMode', $('cutModeSelect').value);
    
    // 🔥 कस्टम टेक्स्ट सर्वर के 'name' फील्ड में भेज रहे हैं (सिर्फ नाम काटने के लिए)
    if ($('customCutText') && $('customCutText').value.trim() !== '') {
      fd.append('name', $('customCutText').value);
    }

    const r = await fetchWithRetry('/api/direct-vector', { method: 'POST', body: fd });
    const data = await readJson(r);
    if (data.error) throw new Error(data.error);
    
    const grid = $('layerResults');
    if(data.results) {
        data.results.forEach(res => {
          grid.appendChild(createThumbCard(res.previewPng, res.rawPng, res.vectorPdf, 'कट + वेक्टर', true));
        });
        // 🔥 एडिटर बटन (सही तरीके से कॉल किया गया)
        addPartsEditorCard(createSafeEditorData(data.results));
    }

    setStatus('✅ कट + वेक्टर तैयार!', 'ok');
  } catch (e) { setStatus('❌ ' + e.message, 'err'); } finally { toggleButtons(false); }
}

// ==========================================
// 7. HD ONLY
// ==========================================
async function runUpscale() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('HD बन रहा है...'); toggleButtons(true);
  const fd = new FormData(); fd.append('image', currentFile);
  try {
    const r = await fetch('/api/upscale', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    
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
  const name = $('nameInput') ? $('nameInput').value : '';
  const texts = name ? [{
    text: name,
    x: currentX, y: currentY,
    sizeFrac: (currentFontSize * 4) / (cw || 340),
    color: $('textColorPicker') ? $('textColorPicker').value : '#000000',
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
  if(!$('aspectSelect')) return { W: 2000, H: 3000 };
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
  const name = $('nameInput') ? $('nameInput').value : '';
  if (!name) return [];
  return [{
    text: name, x: currentX, y: currentY,
    sizeFrac: (currentFontSize * 4) / (cw || 340),
    color: $('textColorPicker') ? $('textColorPicker').value : '#000000', bold: isBold, italic: isItalic,
    font: $('fontFamilySelect') ? $('fontFamilySelect').value : 'Arial, sans-serif',
    angle: Number(currentAngle) || 0, effect3d: false
  }];
}

async function createPartsProject(data) {
  const { W, H } = getCanvasSize();
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
    body: JSON.stringify({ title: $('nameInput') ? $('nameInput').value : 'पार्ट्स डिज़ाइन', W, H, items, texts: buildTextsForProject(), useBgColor: true, bgColor: '#ffffff' })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return location.origin + d.url;
}

function addPartsEditorCard(data) {
  const div = document.createElement('div');
  div.className = 'thumb';
  div.innerHTML = `
    <p style="margin-bottom:8px;">🎨 इन ${data.parts ? data.parts.length : 0} पार्ट्स से नया डिज़ाइन बनाएँ<br><span style="font-size:11px;opacity:.8;">हर पार्ट को खींचें, छोटा-बड़ा करें, घुमाएँ, कॉपी करें। AI बैकग्राउंड और नाम भी वहीं लगेगा।</span></p>
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
  if($('cutModeSelect')) fd.append('cutMode', $('cutModeSelect').value);
  fd.append('hd', ($('splitHd') && $('splitHd').checked) ? 'true' : 'false');
  if($('splitGap')) fd.append('gap', $('splitGap').value);

  // 🔥 अलग-अलग पार्ट्स में भी कस्टम टेक्स्ट काम करेगा
  if ($('customCutText') && $('customCutText').value.trim() !== '') {
    fd.append('name', $('customCutText').value);
  }

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
    setStatus(`✅ ${data.parts.length} पार्ट तैयार (${data.found || data.parts.length} टुकड़े मिले)`, 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  } finally {
    toggleButtons(false);
  }
}

// पेज लोड होते ही एडिटर अपडेट करें
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateEditorText);
} else {
    updateEditorText();
      }

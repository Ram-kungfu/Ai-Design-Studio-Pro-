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

  const rotateHandle = document.createElement('div');
  rotateHandle.className = 'handle rotate';

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
  currentCurve = $('curveSlider').value;
  $('curveVal').textContent = currentCurve;
  updateEditorText();
}

function updateAngleValue() {
  currentAngle = $('angleSlider').value;
  $('angleVal').textContent = currentAngle;
  updateEditorText();
}

function updateFontSize() {
  currentFontSize = $('fontSizeSlider').value;
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

// 🔥 टेक्स्ट और स्टाइल अपडेट करने का सही लॉजिक (सभी स्टाइल्स के साथ)
function updateEditorText() {
  if (!draggableText) return;
  
  const name = $('nameInput').value || 'RAHUL';
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
  let boxRotation = currentAngle;
  if (style === 'rotate') {
    boxRotation = currentAngle + 45; 
  }
  draggableText.style.transform = `translate(-50%, -50%) rotate(${boxRotation}deg)`;

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
      // पूरा गोल (Zero)
      const r = calcCircleRadius(name, fontSize);
      pathD = `M ${centerX} ${pxY - r} a ${r},${r} 0 1,1 0,${r * 2} a ${r},${r} 0 1,1 0,${-r * 2}`;
    } 
    else if (style === 'round' || (curveVal !== 0 && !isNaN(curveVal))) {
      // गोल या कर्व
      let cVal = (style === 'round') ? 50 : curveVal;
      let controlY = pxY - (cVal * 1.5);
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

  const svgWrapper = document.createElement('div');
  svgWrapper.innerHTML = `
    <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="pointer-events: none; overflow: visible;">
      ${svgContent}
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

function applyManualText() {
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

  fetch('/api/manual-text', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      showThumb(data.preview, '✅ टेक्स्ट सेट हो गया');
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

function showThumb(url, label) {
  const div = document.createElement('div');
  div.className = 'thumb';
  div.innerHTML = `<a href="${url}" target="_blank"><img src="${url}" /></a><p>${label}</p>`;
  $('resultGrid').appendChild(div);
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
  fd.append('name', $('nameInput').value);
  fd.append('aspect', $('aspectSelect').value);
  fd.append('customW', $('customW').value);
  fd.append('customH', $('customH').value);
  fd.append('use3d', $('use3dText').checked ? 'true' : 'false');
  fd.append('curve', currentCurve);
  fd.append('angle', currentAngle);
  fd.append('textColor', $('textColorPicker').value);
  fd.append('fontSize', currentFontSize);
  fd.append('isBold', isBold ? 'bold' : 'normal');
  fd.append('isItalic', isItalic ? 'italic' : 'normal');
  fd.append('textStyle', $('textStyleSelect').value);

  try {
    const r = await fetch('/api/auto', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    if (data.steps.cutPreview) showThumb(data.steps.cutPreview, '✂️ कटआउट');
    if (data.steps.finalPreview) showThumb(data.steps.finalPreview, '✅ Final');

    $('downloadFull').href = data.steps.finalRaw;
    $('downloadPreview').href = data.steps.finalPreview;
    $('downloadBar').classList.remove('hidden');
    setStatus('✅ तैयार!', 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  } finally {
    toggleButtons(false);
  }
}

// ==========================================
// 2. SPLIT + TRACE (SAM + Vector)
// ==========================================
async function runSplitAndTrace() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('SAM लेयर्स को अलग कर रहा है...'); toggleButtons(true);
  const fd = new FormData(); fd.append('image', currentFile);
  try {
    const r = await fetch('/api/split-and-trace', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    const grid = $('layerResults');
    data.results.forEach(res => {
      const div = document.createElement('div');
      div.className = 'thumb';
      div.innerHTML = `
        <img src="${res.previewPng}" />
        <p><b>लेयर ${res.layerNumber}</b></p>
        <a href="${res.previewPng}" class="btn small" download>⬇️ Watermark</a>
        ${res.vectorPdf ? `<a href="${res.vectorPdf}" class="btn primary small" download>⬇️ Vector PDF</a>` : ''}
      `;
      grid.appendChild(div);
    });
    setStatus('✅ लेयर्स तैयार!', 'ok');
  } catch (e) { setStatus('❌ ' + e.message, 'err'); } finally { toggleButtons(false); }
}

// ==========================================
// 3. VARIATIONS (4 डिज़ाइन)
// ==========================================
async function runVariations() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('4 नए डिज़ाइन बन रहे हैं...'); toggleButtons(true);
  const fd = new FormData();
  fd.append('image', currentFile);
  fd.append('name', $('nameInput').value);
  fd.append('aspect', $('aspectSelect').value);

  try {
    const r = await fetch('/api/variations', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    data.variations.forEach((url, i) => showThumb(url, `✨ डिज़ाइन ${i + 1}`));
    setStatus('✅ 4 डिज़ाइन तैयार!', 'ok');
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
  const fd = new FormData(); fd.append('image', currentFile); fd.append('person', 'true');
  try {
    const r = await fetch('/api/cutout', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    showThumb(d.preview, '✂️ कटिंग');
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
    showThumb(d.preview, '🔼 HD');
    setStatus('✅ हो गया', 'ok');
  } catch (e) {
    setStatus('❌ ' + e.message, 'err');
  } finally {
    toggleButtons(false);
  }
}

// पेज लोड होते ही एडिटर अपडेट करें
updateEditorText();

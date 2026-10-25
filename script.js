const $ = id => document.getElementById(id);
let currentFile = null;

// ड्रैग एंड ड्रॉप और स्लाइडर्स के लिए वेरिएबल्स
let currentX = 50, currentY = 20;
let isDragging = false;
let currentCurve = 0;
let currentAngle = 0;

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
    
    // एडिटर में इमेज दिखाएँ
    const editorBg = $('editorBg');
    editorBg.src = ev.target.result;
    editorBg.style.display = 'block'; 
    
    dropText.textContent = `✅ ${file.name}`;
  };
  reader.readAsDataURL(file);
}

// --- 🔥 Live Drag & Drop Logic ---
const draggableText = $('draggableText');
const editorContainer = $('editorContainer');

if (draggableText && editorContainer) {
  draggableText.addEventListener('pointerdown', (e) => {
    isDragging = true;
    draggableText.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const rect = editorContainer.getBoundingClientRect();
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;
    
    x = Math.max(0, Math.min(x, rect.width));
    y = Math.max(0, Math.min(y, rect.height));

    currentX = (x / rect.width) * 100;
    currentY = (y / rect.height) * 100;

    draggableText.style.left = currentX + '%';
    draggableText.style.top = currentY + '%';
    draggableText.style.transform = 'translate(-50%, -50%)';
  });

  document.addEventListener('pointerup', () => {
    isDragging = false;
    draggableText.style.cursor = 'grab';
  });
}

// 🔥 स्लाइडर्स अपडेट करने वाले फंक्शन्स
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

// एडिटर में टेक्स्ट अपडेट करें (Curve, Angle और Horizontal सहित)
function updateEditorText() {
  if (!draggableText) return;
  const name = $('nameInput').value || 'RAHUL';
  const style = $('textStyleSelect').value;
  const color = $('textColorSelect').value;
  
  draggableText.textContent = name;
  draggableText.style.color = color;

  // एंगल और स्टाइल के हिसाब से घुमाएँ
  let rotateStr = `rotate(${currentAngle}deg)`; 
  if (style === 'vertical') {
    draggableText.style.writingMode = 'vertical-rl';
  } else {
    draggableText.style.writingMode = 'horizontal-tb';
  }

  draggableText.style.transform = `translate(-50%, -50%) ${rotateStr}`;
}

// कस्टम साइज़ बॉक्स दिखाना/छिपाना
document.getElementById('aspectSelect').addEventListener('change', function() {
  const box = document.getElementById('customSizeBox');
  if (this.value === 'custom') {
    box.style.display = 'block';
  } else {
    box.style.display = 'none';
  }
});

// ✅ मैन्युअल टेक्स्ट फिट करें
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
  fd.append('textColor', $('textColorSelect').value);
  
  // 🔥 Curve और Angle डेटा जोड़ें
  fd.append('curve', currentCurve);
  fd.append('angle', currentAngle);

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
// 1. FULL AUTO (3D टेक्स्ट, कस्टम साइज़, Curve & Angle के साथ)
// ==========================================
async function runAuto() {
  if (!currentFile) return alert('फ़ोटो अपलोड करें');
  clearGrid(); setStatus('FULL AUTO चल रहा है...'); toggleButtons(true);
  
  const fd = new FormData();
  fd.append('image', currentFile);
  fd.append('prompt', $('promptInput').value || 'luxury gold background');
  fd.append('name', $('nameInput').value);
  fd.append('aspect', $('aspectSelect').value);
  
  // कस्टम साइज़ और 3D डेटा जोड़ें
  fd.append('customW', $('customW').value);
  fd.append('customH', $('customH').value);
  fd.append('use3d', $('use3dText').checked ? 'true' : 'false');
  
  // 🔥 Curve और Angle डेटा जोड़ें
  fd.append('curve', currentCurve);
  fd.append('angle', currentAngle);

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
  clearGrid(); setStatus('SAM लेयर्स को अलग कर रहा है और वेक्टर बना रहा है... (इसमें 1-2 मिनट लग सकते हैं)'); toggleButtons(true);
  
  const fd = new FormData();
  fd.append('image', currentFile);
  
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
    setStatus('✅ लेयर्स और वेक्टर तैयार!', 'ok');
  } catch (e) { 
    setStatus('❌ ' + e.message, 'err'); 
  } finally { 
    toggleButtons(false); 
  }
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
    data.variations.forEach((url, i) => showThumb(url, `✨ डिज़ाइन ${i+1}`));
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

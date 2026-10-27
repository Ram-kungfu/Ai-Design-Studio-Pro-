import io
import os
import gc
import time
import base64
import threading
from typing import Optional

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps

app = FastAPI(title="Layer Splitter (rembg + OpenCV)")

# ब्राउज़र से सीधे /health जाँचने (जगाने) के लिए CORS खुला
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ============================================================
# 🎛️ प्लान के हिसाब से सेटिंग: Render के Environment में सिर्फ एक वैल्यू बदलनी है
#    SERVER_PLAN = free      → फ्री / Starter ($7, 512MB RAM)   [अभी यही]
#    SERVER_PLAN = standard  → Standard ($25, 2GB RAM)
#    SERVER_PLAN = pro       → Pro ($85, 4GB RAM) या ऊपर
# ============================================================
PLANS = {
    #            मॉडल       बड़ी साइड(px)  ज़्यादा से ज़्यादा लेयर्स
    "free":     {"model": "silueta", "max_side": 1280, "max_layers": 8},
    "standard": {"model": "u2net",   "max_side": 2000, "max_layers": 25},
    "pro":      {"model": "u2net",   "max_side": 3200, "max_layers": 60},
}
PLAN = os.environ.get("SERVER_PLAN", "free").strip().lower()
if PLAN == "starter":
    PLAN = "free"   # Starter में RAM उतनी ही (512MB) है, सिर्फ CPU तेज़ और सर्वर सोता नहीं
_preset = PLANS.get(PLAN, PLANS["free"])

# चाहें तो अलग-अलग भी बदल सकते हैं (ये प्लान वाली वैल्यू को दबा देती हैं):
#   REMBG_MODEL  (silueta = छोटा ~43MB | u2net = बड़ा ~176MB, बेहतर क्वालिटी)
#   MAX_SIDE     (इससे बड़ी इमेज पहले छोटी की जाती है, मेमोरी बचाने के लिए)
#   MAX_LAYERS   (0 = जितने मिलें सब; पर नीचे HARD_MAX_LAYERS की सीमा रहेगी)
MODEL_NAME = os.environ.get("REMBG_MODEL", _preset["model"])
MAX_SIDE = int(os.environ.get("MAX_SIDE", _preset["max_side"]))
MAX_LAYERS = int(os.environ.get("MAX_LAYERS", _preset["max_layers"]))

HARD_MAX_LAYERS = 100   # सुरक्षा सीमा
HARD_MAX_SIDE = 4000

_session = None
_session_lock = threading.Lock()
_work_lock = threading.Lock()   # एक समय में सिर्फ एक इमेज प्रोसेस हो (मेमोरी का धमाका न हो)


def get_session():
    """rembg का मॉडल सिर्फ एक बार लोड करें (हर रिक्वेस्ट पर नहीं)."""
    global _session
    if _session is None:
        with _session_lock:
            if _session is None:
                from rembg import new_session
                print(f"[sam] मॉडल लोड हो रहा है: {MODEL_NAME}", flush=True)
                _session = new_session(MODEL_NAME)
                print("[sam] मॉडल तैयार", flush=True)
    return _session


@app.on_event("startup")
def preload_model():
    # सर्वर चालू होते ही मॉडल पीछे से लोड कर लो, ताकि पहली रिक्वेस्ट धीमी न हो
    threading.Thread(target=lambda: get_session(), daemon=True).start()


@app.get("/")
@app.get("/health")
def health():
    return {
        "status": "ok", "plan": PLAN, "model": MODEL_NAME, "model_ready": _session is not None,
        "max_side": MAX_SIDE, "max_layers": MAX_LAYERS,
    }


def has_real_transparency(img_rgba: Image.Image) -> bool:
    """अगर इमेज पहले से कटी हुई (transparent PNG) है तो दोबारा बैकग्राउंड हटाने की ज़रूरत नहीं."""
    alpha = np.array(img_rgba.getchannel("A"))
    return float((alpha < 250).mean()) > 0.01


def split_cutout(cutout: Image.Image, max_layers: int = None, min_pct: float = 0.2):
    """कटी हुई इमेज (RGBA) से हर अलग हिस्से की पूरे-साइज़ वाली PNG बनाकर लौटाता है.
    max_layers: कितने हिस्से तक (0/None = प्लान वाली सीमा). min_pct: इमेज के कितने % से छोटे टुकड़े कचरा माने जाएँ."""
    limit = MAX_LAYERS if max_layers is None else max_layers
    if limit <= 0:
        limit = HARD_MAX_LAYERS
    limit = min(limit, HARD_MAX_LAYERS)
    img_np = np.array(cutout.convert("RGBA"))
    h, w = img_np.shape[:2]
    alpha = img_np[:, :, 3]
    _, mask = cv2.threshold(alpha, 10, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_area = max(100, int((min_pct / 100.0) * w * h))  # बहुत छोटे कचरे हटाओ
    big = [c for c in contours if cv2.contourArea(c) >= min_area]
    if not big and contours:
        big = [max(contours, key=cv2.contourArea)]  # कुछ भी न बचे तो सबसे बड़ा हिस्सा रखो
    big = sorted(big, key=cv2.contourArea, reverse=True)[:limit]

    layers = []
    for cnt in big:
        layer_mask = np.zeros((h, w), dtype=np.uint8)
        cv2.drawContours(layer_mask, [cnt], -1, 255, thickness=cv2.FILLED)
        result = img_np.copy()
        result[layer_mask == 0] = 0   # इस हिस्से के बाहर सब पारदर्शी
        buf = io.BytesIO()
        Image.fromarray(result).save(buf, format="PNG")
        layers.append(base64.b64encode(buf.getvalue()).decode("utf-8"))
        del layer_mask, result
    return layers, w, h


def _side(max_side):
    return MAX_SIDE if not max_side else max(256, min(int(max_side), HARD_MAX_SIDE))


def load_and_cut(contents: bytes, max_side=None) -> Image.Image:
    """इमेज खोलो, ज़रूरत से बड़ी हो तो छोटी करो, बैकग्राउंड हटाओ (पहले से कटी हो तो छोड़ दो). लॉक के अंदर बुलाएँ."""
    side = _side(max_side)
    img = Image.open(io.BytesIO(contents))
    img = ImageOps.exif_transpose(img).convert("RGBA")
    if max(img.size) > side:
        img.thumbnail((side, side), Image.LANCZOS)
    if has_real_transparency(img):
        return img
    from rembg import remove
    return remove(img, session=get_session())


# async नहीं, साधारण def: भारी काम अलग थ्रेड में चलता है, इसलिए /health तुरंत जवाब देता रहता है
@app.post("/split-layers")
def split_layers(
    file: UploadFile = File(...),
    max_layers: Optional[int] = None,   # वैकल्पिक: लिंक के अंत में ?max_layers=30
    max_side: Optional[int] = None,     # वैकल्पिक: ?max_side=2000
    min_pct: float = 0.2,               # वैकल्पिक: ?min_pct=0.05 (और छोटे टुकड़े भी रखने के लिए)
):
    t0 = time.time()
    try:
        contents = file.file.read()
        with _work_lock:
            cutout = load_and_cut(contents, max_side)                 # 1. बैकग्राउंड हटाएं
            layers, w, h = split_cutout(cutout, max_layers, min_pct)  # 2. हर हिस्सा अलग करें
            del cutout
            gc.collect()

        print(f"[sam] {len(layers)} लेयर्स, {w}x{h}, {time.time() - t0:.1f}s", flush=True)
        return JSONResponse({
            "success": True,
            "total_layers": len(layers),
            "layers": layers,
            "width": w,
            "height": h,
        })
    except Exception as e:
        gc.collect()
        print(f"[sam] ERROR: {e}", flush=True)
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


# ------------------------------------------------------------------
# पुराने वर्ज़न वाले दो पते (ताकि पहले की कोई स्क्रिप्ट इन्हें सीधे बुलाती हो तो चलती रहे).
# ध्यान: इनमें असली वेक्टर नहीं बनता (वह Vectorizer.AI से मुख्य ऐप में बनता है), इसलिए vectorPdf खाली (None) लौटता है.
# ------------------------------------------------------------------
def _png_data_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")


@app.post("/api/split-and-trace")
def split_and_trace_script_format(
    file: UploadFile = File(...),
    max_layers: Optional[int] = None,
    max_side: Optional[int] = None,
    min_pct: float = 0.2,
):
    try:
        contents = file.file.read()
        with _work_lock:
            cutout = load_and_cut(contents, max_side)
            layers, w, h = split_cutout(cutout, max_layers, min_pct)
            del cutout
            gc.collect()
        results = []
        for i, b64 in enumerate(layers, start=1):
            url = "data:image/png;base64," + b64
            results.append({"layerNumber": i, "previewPng": url, "rawPng": url, "vectorPdf": None})
        return JSONResponse({"results": results})
    except Exception as e:
        gc.collect()
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/direct-vector")
def direct_vector(file: UploadFile = File(...), max_side: Optional[int] = None):
    try:
        contents = file.file.read()
        with _work_lock:
            cutout = load_and_cut(contents, max_side)
            url = _png_data_url(cutout)
            del cutout
            gc.collect()
        return JSONResponse({"results": [{"layerNumber": 1, "previewPng": url, "rawPng": url, "vectorPdf": None}]})
    except Exception as e:
        gc.collect()
        return JSONResponse({"error": str(e)}, status_code=500)


if __name__ == "__main__":
    # Render द्वारा दिया गया पोर्ट लें, नहीं तो 10000 इस्तेमाल करें
    port = int(os.environ.get("PORT", 10000))
    uvicorn.run(app, host="0.0.0.0", port=port)

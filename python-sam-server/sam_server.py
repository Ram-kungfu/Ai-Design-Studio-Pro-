from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import io, base64
from PIL import Image
import cv2
import numpy as np
from rembg import remove, new_session
import uvicorn
import os
import multiprocessing

app = FastAPI(title="SAM Layer Splitter")

# 🔥 हल्का मॉडल (u2netp) - 512MB रैम के लिए
print("Loading U2Netp Model...")
session = new_session("u2netp")  
print("Model Loaded Successfully!")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/split-layers")
async def split_layers(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        input_image = Image.open(io.BytesIO(contents)).convert("RGBA")
        cutout = remove(input_image, session=session)
        img_np = np.array(cutout)
        alpha_channel = img_np[:, :, 3]
        _, mask = cv2.threshold(alpha_channel, 10, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        layers_base64 = []
        for i, cnt in enumerate(contours):
            if cv2.contourArea(cnt) < 500: continue
            layer = np.zeros_like(img_np)
            cv2.drawContours(layer, [cnt], -1, (255, 255, 255, 255), thickness=cv2.FILLED)
            result_layer = cv2.bitwise_and(img_np, layer)
            final_img = Image.fromarray(result_layer)
            buffered = io.BytesIO()
            final_img.save(buffered, format="PNG")
            img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")
            layers_base64.append(img_str)

        return JSONResponse({"success": True, "total_layers": len(layers_base64), "layers": layers_base64})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)

@app.post("/api/split-and-trace")
async def split_and_trace_script_format(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        input_image = Image.open(io.BytesIO(contents)).convert("RGBA")
        cutout = remove(input_image, session=session)
        img_np = np.array(cutout)
        alpha_channel = img_np[:, :, 3]
        _, mask = cv2.threshold(alpha_channel, 10, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        results = []
        layer_number = 1
        for i, cnt in enumerate(contours):
            if cv2.contourArea(cnt) < 500: continue
            layer = np.zeros_like(img_np)
            cv2.drawContours(layer, [cnt], -1, (255, 255, 255, 255), thickness=cv2.FILLED)
            result_layer = cv2.bitwise_and(img_np, layer)
            final_img = Image.fromarray(result_layer)
            buffered = io.BytesIO()
            final_img.save(buffered, format="PNG")
            img_b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")
            img_data_url = f"data:image/png;base64,{img_b64}"
            results.append({
                "layerNumber": layer_number,
                "previewPng": img_data_url,
                "rawPng": img_data_url,
                "vectorPdf": img_data_url
            })
            layer_number += 1
        return JSONResponse({"results": results})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/api/direct-vector")
async def direct_vector(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        input_image = Image.open(io.BytesIO(contents)).convert("RGBA")
        cutout = remove(input_image, session=session)
        buffered = io.BytesIO()
        cutout.save(buffered, format="PNG")
        img_b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")
        img_data_url = f"data:image/png;base64,{img_b64}"
        results = [{"previewPng": img_data_url, "rawPng": img_data_url, "vectorPdf": img_data_url}]
        return JSONResponse({"results": results})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

def start_server():
    port = int(os.environ.get("PORT", 10000))
    uvicorn.run("sam_server:app", host="0.0.0.0", port=port)

if __name__ == "__main__":
    multiprocessing.freeze_support()
    start_server()

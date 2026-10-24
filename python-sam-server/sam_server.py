from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
import io, base64
from PIL import Image
import cv2
import numpy as np
from rembg import remove
import uvicorn

app = FastAPI(title="SAM Layer Splitter")

@app.post("/split-layers")
async def split_layers(file: UploadFile = File(...)):
    try:
        contents = await file.read()
        input_image = Image.open(io.BytesIO(contents)).convert("RGBA")
        
        # 1. बैकग्राउंड हटाएं
        cutout = remove(input_image)
        
        # 2. OpenCV से हर हिस्से को ढूँढें
        img_np = np.array(cutout)
        alpha_channel = img_np[:, :, 3]
        _, mask = cv2.threshold(alpha_channel, 10, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        layers_base64 = []
        for i, cnt in enumerate(contours):
            if cv2.contourArea(cnt) < 500: continue # छोटे कचरे छोड़ें
                
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

import os

if __name__ == "__main__":
    # Render द्वारा दिया गया पोर्ट लें, नहीं तो 10000 इस्तेमाल करें
    port = int(os.environ.get("PORT", 10000))
    uvicorn.run(app, host="0.0.0.0", port=port)

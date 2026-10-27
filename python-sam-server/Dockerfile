FROM python:3.10-slim

# सिस्टम लाइब्रेरीज़ (OpenCV और Rembg के लिए)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# मेमोरी बचाने की सेटिंग + मॉडल की फोल्डर
ENV PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=1 \
    U2NET_HOME=/app/.u2net

WORKDIR /app

# पहले requirements.txt (torch/torchvision हटा दिए - इस कोड में इनका इस्तेमाल है ही नहीं, बस बिल्ड भारी और धीमा करते थे)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# दोनों मॉडल अभी (बिल्ड के समय) ही डाउनलोड कर लो, ताकि हर बार जागने पर डाउनलोड न हो
# और बाद में प्लान बदलने (SERVER_PLAN=standard/pro) पर दोबारा बिल्ड न करना पड़े
RUN python -c "from rembg import new_session; [new_session(m) for m in ('silueta', 'u2net')]"

# बाकी कोड
COPY . .

# Render के PORT पर चलाएँ
CMD ["sh", "-c", "uvicorn sam_server:app --host 0.0.0.0 --port ${PORT:-10000}"]

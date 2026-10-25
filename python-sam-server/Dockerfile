FROM python:3.10-slim

# सिस्टम लाइब्रेरीज़ इंस्टॉल करें (OpenCV और Rembg के लिए ज़रूरी)
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# पहले requirements.txt कॉपी करें और इंस्टॉल करें
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# बाकी कोड कॉपी करें
COPY . .

# Render के पोर्ट पर चलाएँ
CMD ["uvicorn", "sam_server:app", "--host", "0.0.0.0", "--port", "10000"]

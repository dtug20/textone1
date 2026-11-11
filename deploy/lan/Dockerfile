FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 HF_HOME=/models OMP_NUM_THREADS=2
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip ffmpeg libglib2.0-0 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt
COPY *.py ./
CMD ["uvicorn", "speech_app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8801", "--workers", "1", "--limit-concurrency", "8"]

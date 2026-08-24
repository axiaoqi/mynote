FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MYNOTE_INSTANCE_PATH=/app/instance

WORKDIR /app

ARG PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r requirements.txt

COPY app.py wsgi.py ./
COPY mynote ./mynote
COPY static ./static
COPY templates ./templates

RUN mkdir -p /app/instance/uploads

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/', timeout=3).read(1)" || exit 1

CMD ["waitress-serve", "--listen=0.0.0.0:5000", "--threads=4", "wsgi:application"]

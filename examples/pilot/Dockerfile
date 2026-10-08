FROM python:3.12.11-slim
WORKDIR /app
COPY app.py /app/app.py
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=3s CMD ["python", "-c", "import app; assert app.greeting('world')"]
CMD ["python", "-c", "from app import greeting; print(greeting('world'))"]

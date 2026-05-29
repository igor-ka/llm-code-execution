# Backend service image. Note: this container talks to the host Docker daemon
# (socket mounted in docker-compose) to launch sandbox containers.
FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir .

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

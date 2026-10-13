# Game server: FastAPI app serving the static game and the multiplayer WebSocket.
# Build context is the project root (see docker-compose.yml); ignore rules: Dockerfile.dockerignore.
# Plain HTTP: TLS is nginx's job (docker/nginx/nginx.conf). ORBITA_MAPS picks the maps a container hosts.
FROM python:3.12-slim

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

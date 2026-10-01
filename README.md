# ModelSpace

Upload and inspect 3D models in the browser, including Meta Quest 3 WebXR.

## Features

- Upload `.glb` / `.gltf` / `.obj`, or `.zip` / `.rar` packages
- Desktop viewer: scale, exposure, rotation, position (saved per model)
- Animation play/pause for animated GLB/GLTF
- Meta Quest 3 immersive VR (requires HTTPS)
- Optional texture downscaling after upload (VRAM saver)

## Setup

```bash
python -m venv venv
# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt
copy .env.example .env   # or: cp .env.example .env
```

Edit `.env` — at least set a real `SECRET_KEY` for anything beyond local play.

### HTTPS certs (Quest 3)

```bash
mkdir certs
openssl req -x509 -newkey rsa:4096 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj "/CN=localhost"
```

### Run

```bash
python run.py            # http://localhost:5000
python run.py --https    # https://localhost:5443  (needed for Quest VR)
```

On Quest, open `https://<your-lan-ip>:5443` and accept the self-signed cert warning.

### RAR support

Needs the system `unrar` binary on PATH. Prefer `.zip` if UnRAR is not installed.

### Tests

```bash
pytest tests/test_smoke.py -v
```

## Notes

- Uploaded models live in `uploads/` (gitignored)
- Production: use `wsgi.py` behind a reverse proxy with real TLS
- Do not commit `.env`, `certs/`, or `uploads/`

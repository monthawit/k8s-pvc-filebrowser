# K8s PVC File Browser

A web-based file manager for Kubernetes PVC (Persistent Volume Claims). Upload, download, preview, and manage files on your PVC through a clean, Instagram-inspired UI. Supports S3-compatible storage, custom branding, and flexible permission management.

## Features

| Feature | Details |
|---|---|
| **Authentication** | Username/password login, configurable via env/ConfigMap/Secret |
| **Custom Branding** | Company logo + name on login page and sidebar |
| **File Upload** | Files and folders, drag-and-drop, progress bar, up to 50 GB |
| **File Download** | Single file or folder (as ZIP) |
| **File Preview** | Images, video, audio, PDF, text/code (syntax highlighted) |
| **File Operations** | Move, copy, rename, delete, create folder (multi-select supported) |
| **Permissions** | chmod with octal mode, chown with UID/GID, recursive option |
| **S3 Storage** | Browse, preview, download, copy S3 objects to PVC |
| **System Info** | UID/GID display, copy-able shell commands for permission management |
| **Kubernetes Ready** | amd64, kubeadm, Rancher, OKD, OpenShift |

---

## Quick Start

### 1. Build the Container Image

```bash
# Clone the repo
git clone https://github.com/your-org/k8s-pvc-filebrowser.git
cd k8s-pvc-filebrowser

# Build for amd64 (standard x86-64 Kubernetes nodes)
docker build -t k8s-pvc-filebrowser:latest .

# Or build multi-platform (if needed)
docker buildx build --platform linux/amd64 -t k8s-pvc-filebrowser:latest .

# Push to your registry
docker tag k8s-pvc-filebrowser:latest ghcr.io/your-org/k8s-pvc-filebrowser:latest
docker push ghcr.io/your-org/k8s-pvc-filebrowser:latest
```

### 2. Run Locally with Docker

```bash
docker run -d \
  -p 3000:3000 \
  -v /path/to/your/data:/data \
  -e APP_USERNAME=admin \
  -e APP_PASSWORD=yourpassword \
  -e COMPANY_NAME="My Company" \
  --name filebrowser \
  k8s-pvc-filebrowser:latest
```

Open http://localhost:3000

---

## Configuration Reference

All configuration is done via **environment variables**, which can come from Kubernetes ConfigMap, Secret, or `.env` file.

### Authentication

| Variable | Default | Description |
|---|---|---|
| `APP_USERNAME` | `admin` | Login username |
| `APP_PASSWORD` | `admin` | Login password — **change this!** |
| `SESSION_SECRET` | random UUID | Session signing key — set a strong random string |

### Branding

| Variable | Default | Description |
|---|---|---|
| `COMPANY_NAME` | `PVC File Browser` | Shown on login page and sidebar |
| `LOGO_URL` | *(none)* | URL of company logo (external or internal) |

**Alternative — mount a logo file:**
```yaml
# In deployment.yaml, add to volumeMounts:
- name: logo
  mountPath: /app/public/logo.png
  subPath: logo.png

# Add to volumes:
- name: logo
  configMap:
    name: filebrowser-logo
    items:
      - key: logo.png
        path: logo.png
```

Then create the ConfigMap from your logo file:
```bash
kubectl create configmap filebrowser-logo \
  --from-file=logo.png=./my-company-logo.png \
  -n filebrowser
```

Supported logo formats: `logo.png`, `logo.svg`, `logo.jpg`

### Storage

| Variable | Default | Description |
|---|---|---|
| `DATA_PATH` | `/data` | Mount path of the PVC inside the container |
| `MAX_FILE_SIZE` | `53687091200` | Max upload size in bytes (default 50 GB) |

### S3 Compatible Storage (optional)

| Variable | Description |
|---|---|
| `S3_ENDPOINT` | Endpoint URL (e.g. `http://minio:9000`). Leave empty for AWS S3. |
| `S3_ACCESS_KEY` | Access key ID |
| `S3_SECRET_KEY` | Secret access key |
| `S3_BUCKET` | Default bucket name |
| `S3_REGION` | Region (default `us-east-1`) |
| `S3_PATH_STYLE` | Set `true` for MinIO/self-hosted S3 |

S3 can also be configured through the UI (S3 Storage → Configure S3). Config is stored in `/data/.pvcbrowser-s3.json`.

---

## Deploy to Kubernetes

### Step 1 — Edit the manifests

```bash
# Set your image in deployment.yaml
sed -i 's|ghcr.io/your-org/k8s-pvc-filebrowser:latest|your-registry/image:tag|' kubernetes/deployment.yaml

# Set your domain in ingress.yaml
sed -i 's|filebrowser.example.com|filebrowser.yourdomain.com|' kubernetes/ingress.yaml

# Edit credentials in secret.yaml
nano kubernetes/secret.yaml

# Set your StorageClass in pvc.yaml (e.g. longhorn, nfs-client, cephfs)
nano kubernetes/pvc.yaml
```

### Step 2 — Apply manifests

```bash
kubectl apply -f kubernetes/namespace.yaml
kubectl apply -f kubernetes/pvc.yaml
kubectl apply -f kubernetes/configmap.yaml
kubectl apply -f kubernetes/secret.yaml
kubectl apply -f kubernetes/deployment.yaml
kubectl apply -f kubernetes/service.yaml
kubectl apply -f kubernetes/ingress.yaml
```

### Step 3 — Verify

```bash
kubectl get all -n filebrowser
kubectl logs -n filebrowser deployment/filebrowser
```

---

## OpenShift / OKD Deployment

OpenShift runs containers as arbitrary non-root UIDs. Two deployment modes:

### Mode 1 — Non-root (default, recommended)

Remove `runAsUser`, `runAsGroup`, `fsGroup` from `securityContext` in `deployment.yaml`. File browsing, upload, download, preview all work. The **chown** feature will not work (no root).

```yaml
# deployment.yaml — remove these lines for OpenShift:
securityContext: {}
```

### Mode 2 — Root (enables chown/chmod)

```bash
# Grant anyuid SCC to the default service account
oc adm policy add-scc-to-serviceaccount anyuid -z default -n filebrowser
```

Then set in `deployment.yaml`:
```yaml
securityContext:
  runAsUser: 0
```

### OpenShift Route

Use the Route manifest (commented out in `ingress.yaml`) instead of Ingress:

```yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: filebrowser
  namespace: filebrowser
spec:
  host: filebrowser.apps.cluster.example.com
  to:
    kind: Service
    name: filebrowser
  port:
    targetPort: http
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
```

---

## UID / GID & Permissions Guide

### Get the current user ID in the container

```bash
kubectl exec -n filebrowser deployment/filebrowser -- id
# uid=1000(node) gid=1000(node) groups=1000(node)
```

### Get UID/GID of files on the PVC

```bash
kubectl exec -n filebrowser deployment/filebrowser -- stat -c "%u %g %a %n" /data/yourfile.txt
# 1000 1000 644 /data/yourfile.txt

kubectl exec -n filebrowser deployment/filebrowser -- ls -lan /data/
```

### Set permissions via the UI

1. Right-click any file or folder → **Permissions**
2. Enter octal mode (e.g. `777`, `755`, `644`) → **Apply chmod**
3. Enter UID and GID → **Apply chown**
4. Enable **Recursive** for directories

### Common permission scenarios

| Mode | Use Case |
|---|---|
| `777` | Shared files accessible by all users/pods |
| `755` | Web files (read by others, write by owner only) |
| `644` | Config/data files (read by others) |
| `600` | Secrets (owner only) |

### Fix permissions for a specific UID/GID

From the System Info panel in the UI, copy and run:
```bash
# In the pod:
find /data -exec chown 1000:1000 {} \;
find /data -exec chmod 755 {} \;
```

---

## S3 Storage Setup

### Via environment variables (recommended for production)

```yaml
# configmap.yaml
S3_ENDPOINT: "http://minio.minio.svc.cluster.local:9000"
S3_BUCKET: "my-bucket"
S3_REGION: "us-east-1"
S3_PATH_STYLE: "true"

# secret.yaml
S3_ACCESS_KEY: "minioadmin"
S3_SECRET_KEY: "minioadmin"
```

### Via UI

Click **S3 Storage** in the sidebar → **Configure S3** → fill in details → **Save & Connect**.

### Supported S3-compatible services

- **AWS S3** — Leave endpoint empty, set region
- **MinIO** — Set endpoint + `S3_PATH_STYLE=true`
- **Ceph RGW** — Set endpoint + `S3_PATH_STYLE=true`
- **Cloudflare R2** — Set endpoint (e.g. `https://accountid.r2.cloudflarestorage.com`)
- **Backblaze B2** — Set S3-compatible endpoint

---

## Uploading Large Files

The default limit is **50 GB**. For large uploads with nginx ingress, ensure:

```yaml
# ingress.yaml annotations:
nginx.ingress.kubernetes.io/proxy-body-size: "0"       # No limit
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

---

## Security Notes

- Credentials are stored in a Kubernetes **Secret** (base64 encoded)
- Sessions use httpOnly cookies and expire after 24 hours
- All file paths are validated to prevent directory traversal
- Login is rate-limited (20 attempts per 15 minutes)
- Set `SESSION_SECRET` to a long random string in production
- Run behind TLS (nginx ingress with cert-manager, or OpenShift Route edge termination)
- Do **not** expose this service publicly without authentication and TLS

---

## File Structure

```
k8s-pvc-filebrowser/
├── server.js            # Express backend (API + static serving)
├── package.json
├── Dockerfile
├── .dockerignore
├── public/
│   ├── index.html       # Single-page application shell
│   ├── css/
│   │   └── style.css    # Instagram-style UI
│   └── js/
│       └── app.js       # Frontend SPA logic
└── kubernetes/
    ├── namespace.yaml
    ├── pvc.yaml
    ├── configmap.yaml   # Non-sensitive config
    ├── secret.yaml      # Credentials
    ├── deployment.yaml
    ├── service.yaml
    └── ingress.yaml
```

## Development

```bash
# Install dependencies
npm install

# Run locally (data goes to /tmp/filebrowser-dev)
DATA_PATH=/tmp/filebrowser-dev \
APP_USERNAME=admin \
APP_PASSWORD=admin \
node server.js
```

Open http://localhost:3000

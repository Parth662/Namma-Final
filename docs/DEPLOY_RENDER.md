# Deploying Namma Space to Render (render.com)

This guide walks you through deploying the complete Namma Space full-stack architecture to [Render](https://dashboard.render.com/).

---

## 1. Architecture on Render

```
                                  +---------------------------------------+
                                  |         Render Static Site            |
                                  |          (namma-frontend)             |
                                  |   https://namma-frontend.onrender.com |
                                  +-------------------+-------------------+
                                                      |
                                                      | HTTPS & WSS (Socket.IO)
                                                      v
+-----------------------+         +-------------------+-------------------+
|  MongoDB Atlas (M0)   | <-----> |       Render Web Service (Node)       |
|    (Free Cluster)     |         |             (namma-api)               |
+-----------------------+         |     https://namma-api.onrender.com    |
                                  +---------+-------------------+---------+
                                            |                   |
                     Private Redis Network  |                   | HTTP (Port 5002)
                                            v                   v
                                  +---------+---------+ +-------+-----------------+
                                  |   Render Redis    | |   Python 3D Engine      |
                                  |   (namma-redis)   | |    (namma-python)       |
                                  |    (BullMQ)       | | (Docker / Colab Remote) |
                                  +-------------------+ +-------------------------+
```

| Component | Render Service Type | Plan | Build Command | Start / Publish |
| :--- | :--- | :---: | :--- | :--- |
| **Frontend** | Static Site | **Free** | `npm install --legacy-peer-deps && npm run build:web` | Publish Directory: `dist` |
| **Backend API** | Web Service (Node) | **Free** | `npm install --omit=dev` | `npm start` |
| **Redis** | Redis (Managed) | **Free** | Managed by Render | Internal connection string |
| **Python Engine** | Private Service (Docker) | **Starter** / Free | Dockerfile build | `python main.py` |
| **Database** | MongoDB Atlas (External) | **Free** | Managed by MongoDB Atlas | `mongodb+srv://...` |

---

## 2. Step 1: Create a Free MongoDB Atlas Database

Render does not offer managed MongoDB directly. Use MongoDB Atlas's perpetual free tier (M0):

1. Go to [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas) and log in / sign up.
2. Click **Create Deployment** $\rightarrow$ select **M0 (Free)**.
3. Under **Security Quickstart**:
   - Create a database user (e.g. `namma_admin` and set a strong password).
   - Under **Network Access**, click **Add IP Address** $\rightarrow$ select **Allow Access from Anywhere (`0.0.0.0/0`)** (required for cloud web services).
4. Click **Connect** $\rightarrow$ **Drivers** $\rightarrow$ copy your connection string:
   ```
   mongodb+srv://namma_admin:<password>@cluster0.xxxxx.mongodb.net/digital_twin_db?retryWrites=true&w=majority
   ```
   *(Replace `<password>` with your database user password).*

---

## 3. Step 2: One-Click Deploy via Render Blueprint (Recommended)

Namma Space includes a pre-configured [`render.yaml`](../render.yaml) blueprint file at the repository root.

1. Log in to [dashboard.render.com](https://dashboard.render.com/).
2. In the top right, click **New +** $\rightarrow$ **Blueprint**.
3. Connect your GitHub repository:
   - Select **`Parth662/Namma-Final`**.
4. Render will scan `render.yaml` and display the 4 services to create:
   - `namma-frontend` (Static Site)
   - `namma-api` (Web Service)
   - `namma-redis` (Redis)
   - `namma-python` (Private Docker Service)
5. Fill in the required environment variable:
   - **`MONGODB_URI`**: Paste your MongoDB Atlas connection string from Step 1.
6. Click **Apply**.
7. Render will now provision Redis, build and deploy the Node backend, compile the Expo web bundle, and launch the Python container automatically!

---

## 4. Alternative: Manual Service Setup (If Not Using Blueprint)

If you prefer to configure each service individually in the Render UI:

### A. Deploy Redis
1. In Render Dashboard, click **New +** $\rightarrow$ **Redis**.
2. Name: `namma-redis`.
3. Plan: **Free**.
4. Click **Create Redis**. Once created, copy the **Internal Redis URL** (`redis://red-...:6379`).

### B. Deploy Node.js Backend API
1. Click **New +** $\rightarrow$ **Web Service**.
2. Connect repo `Parth662/Namma-Final`.
3. Settings:
   - **Name:** `namma-api`
   - **Region:** Choose closest to your users (e.g., Singapore / Oregon / Frankfurt).
   - **Branch:** `main`
   - **Root Directory:** `namma/backend`
   - **Runtime:** `Node`
   - **Build Command:** `npm install --omit=dev`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
4. Environment Variables:
   - `NODE_ENV` = `production`
   - `PORT` = `10000`
   - `RUN_WORKER_IN_SERVER` = `true` *(runs BullMQ worker inside the API instance)*
   - `MONGODB_URI` = `<your-mongodb-atlas-uri>`
   - `REDIS_URL` = `<internal-redis-url-from-step-A>`
   - `JWT_SECRET` = `<any-random-32-char-string>`
   - `RECON_ENGINE_URL` = `http://127.0.0.1:5002` *(or your Colab/RunPod GPU URL)*
5. Click **Create Web Service**.

### C. Deploy Expo Web Frontend
1. Click **New +** $\rightarrow$ **Static Site**.
2. Connect repo `Parth662/Namma-Final`.
3. Settings:
   - **Name:** `namma-frontend`
   - **Branch:** `main`
   - **Root Directory:** `namma/frontend`
   - **Build Command:** `npm install --legacy-peer-deps && npm run build:web`
   - **Publish Directory:** `dist`
4. Environment Variables:
   - `EXPO_PUBLIC_API_URL` = `https://namma-api.onrender.com` *(use your actual backend URL from Step B)*
5. Click **Create Static Site**.

---

## 5. Python 3D Photogrammetry on Render Free Tier vs Remote GPU

- **Render Free Web Services (512 MB RAM):**
  COLMAP CPU Structure-from-Motion on multi-frame video requires 1.5–3 GB of working memory. On Render's 512 MB free tier, large real-world scans will exceed the RAM quota.
  
- **Best Production Approaches:**
  1. **Option A (Zero-Cost GPU via Google Colab):**
     Launch the free remote GPU engine using our [`colab/engine_server.py`](../colab/engine_server.py) (see [docs/COLAB_ENGINE.md](./COLAB_ENGINE.md)). Set `RECON_ENGINE_URL` in `namma-api` to your Colab public URL.
  2. **Option B (Render Starter Plan):**
     Deploy `namma-python` on Render's **Starter** plan ($7/mo with 2 GB RAM).
  3. **Option C (Demo / Showcase Mode):**
     Set `MOCK_RECONSTRUCTION=1` in `namma-python` for instant, lightweight testing and demonstration of the full interactive 3D digital twin viewer, POIs, floor plans, and navigation graphs.

---

## 6. Verification Checklist

Once Render finishes deploying:

- [ ] **Health Check:** Open `https://<your-api>.onrender.com/api/health`. You should receive:
  ```json
  {
    "status": "ok",
    "service": "3d-location-reconstruction-backend",
    "dependencies": {
      "mongodb": "connected",
      "redis": "connected",
      "pythonService": "connected"
    }
  }
  ```
- [ ] **Frontend Live:** Open `https://<your-frontend>.onrender.com`. The Namma Space UI should load cleanly.
- [ ] **Demo Mode Twin:** Open the 3D viewer in Demo Mode to verify Three.js WebGL rendering, point cloud display, structural shell wireframe, and POI markers over public HTTPS.

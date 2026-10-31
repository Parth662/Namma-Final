# Worker Architecture & Scaling Guide (`docs/WORKER_SCALING.md`)

## Overview

The 3D reconstruction pipeline decouples the Node.js API server from the heavy photogrammetry workload using **BullMQ** on Redis.

```
+--------------------+        +---------------------+        +-----------------------------------+
|  Express API Node  | -----> |   Redis (BullMQ)    | <----  | Dedicated Worker Process (Node)   |
| (HTTP & Socket.IO) |        | 3d-reconstruction-q |        | Concurrency: WORKER_CONCURRENCY   |
+--------------------+        +---------------------+        +-----------------+-----------------+
                                                                               | HTTP POST
                                                                               v
                                                             +-----------------------------------+
                                                             | Python 3D Photogrammetry Engine   |
                                                             | (FastAPI, COLMAP, Open3D, Trimesh)|
                                                             +-----------------------------------+
```

---

## Running the Dedicated Worker

To run the worker in an isolated, dedicated process:
```bash
cd namma/backend
npm run worker
```

### Configuration
Configured in `namma/backend/.env`:
```ini
WORKER_CONCURRENCY=1
JOB_TIMEOUT_MS=600000
```

---

## Hardware Limitations: Laptops vs Cloud Instances

### 1. Laptop / Development Machine Limitations
> [!WARNING]
> On development laptops (e.g., 8 GB – 16 GB RAM, shared Intel UHD Graphics / Integrated GPU):
> - **`WORKER_CONCURRENCY` MUST BE SET TO 1.**
> - COLMAP SIFT feature extraction and Open3D Poisson surface meshing utilize multithreading and peak at ~4–6 GB RAM per reconstruction.
> - Running 2 or more concurrent photogrammetry jobs on an 8 GB system will trigger an Out Of Memory (OOM) operating system crash or blue screen.

### 2. Multi-Worker Cloud Deployment (Horizontal Scaling)
In production cloud environments with dedicated compute nodes:
- Each cloud instance can run a dedicated worker connected to the central Redis cluster.
- Hardware requirements per concurrent job slot:
  - **CPU:** 4 vCPUs
  - **RAM:** 8 GB dedicated RAM per worker slot
  - **GPU:** Optional NVIDIA GPU with CUDA for 10x faster feature extraction
- Command to run N worker processes via PM2 or systemd:
  ```bash
  # Using PM2 to manage 2 workers on a 16GB / 8-core instance
  pm2 start src/workers/reconstruction.worker.js -i 2 --name "recon-worker"
  ```

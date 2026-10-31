# Photorealistic Digital Twin / 3D Location Reconstruction Platform Backend

High-performance backend for capturing real-world location video and transforming it into an interactive 3D digital twin.

## 🚀 Architecture Overview

```
Client / Mobile App
       ↓
  Node.js API (Express + Socket.IO)
       ↓
MongoDB (Projects, Jobs, Users)  +  Redis / BullMQ (Reconstruction Queue)
       ↓
3D Processing Worker (Node.js BullMQ Consumer)
       ↓
Python Reconstruction Service (FastAPI + OpenCV + COLMAP + Open3D)
       ↓
Optimized 3D Digital Twin (GLB / GLTF + LODs + Metadata)
       ↓
Interactive 3D Viewer
```

## 📂 Backend Structure

```
backend/
├── src/
│   ├── app.js                          # Express App initialization & middlewares
│   ├── server.js                       # Server entrypoint with Socket.IO & Graceful Shutdown
│   │
│   ├── config/
│   │   ├── database.js                 # MongoDB connection using Mongoose
│   │   ├── redis.js                    # Redis client with ioredis
│   │   └── environment.js              # Environment variable configurations
│   │
│   ├── models/
│   │   ├── User.js                     # User model with bcrypt password hashing
│   │   ├── Project.js                  # Digital Twin Project model (status, bounds, metadata)
│   │   └── ReconstructionJob.js        # 3D Reconstruction Job tracking
│   │
│   ├── routes/
│   │   ├── auth.routes.js              # Auth endpoints (/register, /login, /me)
│   │   ├── project.routes.js           # Project CRUD, upload, reconstruct, status, model
│   │   ├── upload.routes.js            # Video upload route
│   │   └── reconstruction.routes.js   # Reconstruction queueing and status routes
│   │
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── project.controller.js
│   │   ├── upload.controller.js
│   │   └── reconstruction.controller.js
│   │
│   ├── services/
│   │   ├── storage.service.js          # Hierarchical project storage management
│   │   ├── reconstruction.service.js   # BullMQ queue management
│   │   └── python.service.js           # FastAPI 3D engine client
│   │
│   ├── workers/
│   │   └── reconstruction.worker.js    # BullMQ reconstruction background worker
│   │
│   ├── middleware/
│   │   ├── auth.middleware.js          # JWT Bearer token authentication
│   │   ├── upload.middleware.js        # Multer streaming video upload validation
│   │   └── error.middleware.js         # Centralized error handler
│   │
│   └── sockets/
│       └── progress.socket.js          # Real-time WebSocket progress emitter
│
├── uploads/                            # Ingested raw video files
├── storage/                            # Permanent digital twin assets & pipeline data
├── processing/                         # Intermediate frame & COLMAP reconstruction data
├── outputs/                            # Exported 3D assets & models
├── .env.example
├── package.json
└── test_phase1_phase2.js
```

## 🛠️ Implemented API Endpoints (Phase 1 & Phase 2)

### Authentication
- `POST /api/auth/register` - Create account (name, email, password)
- `POST /api/auth/login` - Login and obtain JWT
- `GET /api/auth/me` - Get current authenticated user profile

### Projects
- `POST /api/projects` - Create location reconstruction project
- `GET /api/projects` - List all user projects
- `GET /api/projects/:id` - Get project details & latest job
- `DELETE /api/projects/:id` - Delete project and clean up storage

### Video Upload
- `POST /api/projects/:id/upload` - Stream and store MP4/MOV/WebM video with MIME & size validation

### Reconstruction (BullMQ Queuing)
- `POST /api/projects/:id/reconstruct` - Enqueue 3D reconstruction job to BullMQ (returns immediately)
- `GET /api/projects/:id/status` - Check current reconstruction stage and failure diagnostics

### 3D Digital Twin Viewer
- `GET /api/projects/:id/metadata` - Bounds, coordinates, vertices, triangles, and scale metadata
- `GET /api/projects/:id/model` - Launch 3D view payload (GLB url, thumbnail, bounding box)

### Health
- `GET /api/health` - Health check (MongoDB, Redis, Python service)

## 🏃 Quick Start

1. Install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   ```

3. Run integration tests:
   ```bash
   npm test
   ```

4. Start development server:
   ```bash
   npm start
   ```

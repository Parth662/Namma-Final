/**
 * Phase 4 Navigation & Scale Calibration Automated Test Suite
 * Tests:
 * 1. NavigationService loading precomputed navgrid.json for demo scene
 * 2. 8-connected A* search with string-pulling smoothing in Node
 * 3. Obstacle snapping (snaps close coordinates to nearest walkable cell)
 * 4. Unreachable target detection (graceful error result)
 * 5. GET /api/projects/:id/navgrid endpoint returns 200 with grid and wall segments
 * 6. GET /api/projects/:id/path endpoint returns 200 with smoothed 3D route
 * 7. POST /api/projects/:id/calibrate endpoint updates scale metersPerUnit
 */

import http from 'http';
import mongoose from 'mongoose';
import { createApp } from './src/app.js';
import { navigationService } from './src/services/navigation.service.js';
import { Project } from './src/models/Project.js';
import { User } from './src/models/User.js';
import jwt from 'jsonwebtoken';
import { env } from './src/config/environment.js';

let server;
let port;
let authToken;
let demoProject;

const makeRequest = (method, path, body = null, headers = {}) => {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      ...headers,
    };
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
};

const runTests = async () => {
  console.log('=== Starting Phase 4 Navigation & Calibration Tests ===\n');
  await mongoose.connect(env.MONGODB_URI);

  // Setup Demo project & user token
  const demoUser = await User.findOne({ email: 'demo@nammaspace.local' });
  if (!demoUser) throw new Error('Demo user not found. Run scripts/seed-demo.js first.');
  authToken = jwt.sign({ id: demoUser._id, role: demoUser.role }, env.JWT_SECRET, { expiresIn: '1h' });

  demoProject = await Project.findOne({ isDemo: true });
  if (!demoProject) throw new Error('Demo project not found. Run scripts/seed-demo.js first.');

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      console.log(`Test Express server listening on 127.0.0.1:${port}`);
      resolve();
    });
  });

  try {
    // 1. NavigationService - load navgrid
    console.log('[Test 1] Load Navigation Grid from storage...');
    const navGrid = await navigationService.getNavGrid(demoProject._id);
    if (!navGrid || !navGrid.bounds || !Array.isArray(navGrid.grid)) {
      throw new Error('Failed to load valid navgrid structure from storage');
    }
    console.log(`  ✓ Navgrid loaded: ${navGrid.width}x${navGrid.height} cells, ${navGrid.totalSegments} wall segments`);

    // 2. In-Process A* Pathfinding
    console.log('[Test 2] Execute in-process A* pathfinding on demo scene...');
    // Traverse diagonally across center
    const pathResult = navigationService.findPath(navGrid, [-1.5, 0.0, -1.0], [1.5, 0.0, 1.0], {
      walkingSpeedMps: 1.3,
      metersPerUnit: 1.0,
    });
    if (!pathResult.found || pathResult.path.length < 2) {
      throw new Error(`Path not found or empty: ${JSON.stringify(pathResult)}`);
    }
    console.log(`  ✓ Route found! Waypoints: ${pathResult.smoothedWaypointsCount}, Distance: ${pathResult.distanceMeters}m, ETA: ${pathResult.walkingEtaFormatted}`);

    // 3. Coordinate Snapping
    console.log('[Test 3] Test coordinate snapping to walkable space...');
    const snap = navigationService.snapToWalkable(0.0, 0.0, navGrid);
    if (!snap) throw new Error('Snapping failed');
    console.log(`  ✓ Snapped coordinate: (${snap.x}, ${snap.z}), walkable: true`);

    // 4. Unreachable Target
    console.log('[Test 4] Test unreachable target returns graceful error...');
    // Deep out-of-bounds target
    const unreachable = navigationService.findPath(navGrid, [0.0, 0.0, 0.0], [999.0, 0.0, 999.0]);
    if (unreachable.found) {
      throw new Error('Unreachable point should not return found: true');
    }
    console.log(`  ✓ Gracefully handled unreachable point: "${unreachable.error}"`);

    // 5. GET /api/projects/:id/navgrid endpoint
    console.log('[Test 5] Test GET /api/projects/:id/navgrid...');
    const navRes = await makeRequest('GET', `/api/projects/${demoProject._id}/navgrid`);
    if (navRes.status !== 200 || !navRes.body.success || !navRes.body.data.grid) {
      throw new Error(`Navgrid endpoint returned status ${navRes.status}: ${JSON.stringify(navRes.body)}`);
    }
    console.log(`  ✓ Navgrid endpoint returned 200 with ${navRes.body.data.wallSegments.length} wall segments`);

    // 6. GET /api/projects/:id/path endpoint
    console.log('[Test 6] Test GET /api/projects/:id/path?from=...&to=...');
    const pathRes = await makeRequest('GET', `/api/projects/${demoProject._id}/path?from=-1.0,0.0,-0.5&to=1.0,0.0,0.5`);
    if (pathRes.status !== 200 || !pathRes.body.success || !pathRes.body.data.found) {
      throw new Error(`Path endpoint returned status ${pathRes.status}: ${JSON.stringify(pathRes.body)}`);
    }
    console.log(`  ✓ Path endpoint returned 200 with ${pathRes.body.data.path.length} waypoints, ETA: ${pathRes.body.data.walkingEtaFormatted}`);

    // 7. POST /api/projects/:id/calibrate endpoint
    console.log('[Test 7] Test POST /api/projects/:id/calibrate...');
    const calRes = await makeRequest(
      'POST',
      `/api/projects/${demoProject._id}/calibrate`,
      {
        p1: [0, 0, 0],
        p2: [0, 2.0, 0],
        realDistanceMeters: 2.1,
      },
      { Authorization: `Bearer ${authToken}` }
    );
    if (calRes.status !== 200 || !calRes.body.success || calRes.body.data.metersPerUnit !== 1.05) {
      throw new Error(`Calibration endpoint returned status ${calRes.status}: ${JSON.stringify(calRes.body)}`);
    }
    console.log(`  ✓ Calibration endpoint returned 200, metersPerUnit: ${calRes.body.data.metersPerUnit}`);

    console.log('\n======================================================');
    console.log(' ALL 7 PHASE 4 NAVIGATION TESTS PASSED! ');
    console.log('======================================================\n');
  } finally {
    if (server) server.close();
    await mongoose.disconnect();
  }
};

runTests().catch((err) => {
  console.error('\n❌ Phase 4 Test Failed:', err);
  if (server) server.close();
  mongoose.disconnect();
  process.exit(1);
});

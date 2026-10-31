/**
 * Phase 5 Points of Interest (POI) & Ranked Search Test Suite
 * Tests:
 * 1. Public retrieval of POIs for demo project (unauthenticated)
 * 2. Category filtering (?category=emergency)
 * 3. Text search (?q=robotics) with text index ranking
 * 4. Partial substring fallback search (?q=print)
 * 5. POI Creation with automatic walkable navPoint snapping
 * 6. Out-of-bounds POI coordinate validation (400 rejection)
 * 7. POI Update and Deletion lifecycle
 * 8. Unauthorized modification prevention
 */

import http from 'http';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from './src/app.js';
import { Project } from './src/models/Project.js';
import { User } from './src/models/User.js';
import { POI } from './src/models/POI.js';
import { env } from './src/config/environment.js';

let server;
let port;
let authToken;
let demoProject;

const makeRequest = (method, path, body = null, headers = {}) => {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
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
  console.log('=== Starting Phase 5 POI & Search Tests ===\n');
  await mongoose.connect(env.MONGODB_URI);

  const demoUser = await User.findOne({ email: 'demo@nammaspace.local' });
  if (!demoUser) throw new Error('Demo user not found. Run scripts/seed-demo.js');
  authToken = jwt.sign({ id: demoUser._id, role: demoUser.role }, env.JWT_SECRET, { expiresIn: '1h' });

  demoProject = await Project.findOne({ isDemo: true });
  if (!demoProject) throw new Error('Demo project not found. Run scripts/seed-demo.js');

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      console.log(`Test Express server listening on 127.0.0.1:${port}`);
      resolve();
    });
  });

  try {
    // 1. Unauthenticated read of Demo POIs
    console.log('[Test 1] Public retrieval of demo POIs without auth header...');
    const listRes = await makeRequest('GET', `/api/projects/${demoProject._id}/pois`);
    if (listRes.status !== 200 || !listRes.body.success || listRes.body.count < 7) {
      throw new Error(`Expected at least 7 POIs, got: ${JSON.stringify(listRes.body)}`);
    }
    console.log(`  ✓ Public retrieval succeeded: returned ${listRes.body.count} POIs`);

    // 2. Category filtering
    console.log('[Test 2] Filter POIs by category (?category=emergency)...');
    const catRes = await makeRequest('GET', `/api/projects/${demoProject._id}/pois?category=emergency`);
    if (catRes.status !== 200 || !catRes.body.success || catRes.body.count < 1) {
      throw new Error(`Category filter failed: ${JSON.stringify(catRes.body)}`);
    }
    if (catRes.body.data[0].category !== 'emergency') {
      throw new Error(`Category mismatch: ${catRes.body.data[0].category}`);
    }
    console.log(`  ✓ Found ${catRes.body.count} emergency POI: "${catRes.body.data[0].name}"`);

    // 3. Ranked text search
    console.log('[Test 3] Ranked multi-field search (?q=robotics)...');
    const searchRes = await makeRequest('GET', `/api/projects/${demoProject._id}/pois?q=robotics`);
    if (searchRes.status !== 200 || !searchRes.body.success || searchRes.body.count < 1) {
      throw new Error(`Text search failed: ${JSON.stringify(searchRes.body)}`);
    }
    const topResult = searchRes.body.data[0];
    if (!topResult.name.includes('Robotics')) {
      throw new Error(`Expected top result to be Robotics, got: ${topResult.name}`);
    }
    console.log(`  ✓ Top ranked match: "${topResult.name}" (category: ${topResult.category})`);

    // 4. Substring / prefix fallback search
    console.log('[Test 4] Substring search (?q=print)...');
    const subRes = await makeRequest('GET', `/api/projects/${demoProject._id}/pois?q=print`);
    if (subRes.status !== 200 || !subRes.body.success || subRes.body.count < 1) {
      throw new Error(`Substring search failed: ${JSON.stringify(subRes.body)}`);
    }
    console.log(`  ✓ Found match for "print": "${subRes.body.data[0].name}"`);

    // 5. POI Creation with walkable navPoint snapping
    console.log('[Test 5] Create new POI with automatic navPoint snapping...');
    const createRes = await makeRequest(
      'POST',
      `/api/projects/${demoProject._id}/pois`,
      {
        name: 'Conference Room Beta',
        category: 'room',
        description: 'Acoustic glass boardroom for executive presentations.',
        tags: ['conference', 'meeting', 'room', 'boardroom'],
        position: { x: 0.5, y: 0.4, z: -0.5 },
        icon: 'users',
        color: '#14b8a6',
      },
      { Authorization: `Bearer ${authToken}` }
    );
    if (createRes.status !== 201 || !createRes.body.success) {
      throw new Error(`POI creation failed: ${JSON.stringify(createRes.body)}`);
    }
    const createdPoi = createRes.body.data;
    if (!createdPoi.navPoint || typeof createdPoi.navPoint.x !== 'number') {
      throw new Error(`navPoint was not snapped: ${JSON.stringify(createdPoi)}`);
    }
    console.log(`  ✓ POI created (ID: ${createdPoi._id}) with snapped navPoint: (${createdPoi.navPoint.x}, ${createdPoi.navPoint.z})`);

    // 6. Out-of-bounds rejection
    console.log('[Test 6] Out-of-bounds POI position rejected with 400...');
    const outBoundsRes = await makeRequest(
      'POST',
      `/api/projects/${demoProject._id}/pois`,
      {
        name: 'Moon Base Outpost',
        category: 'other',
        position: { x: 999.0, y: 0.0, z: 999.0 },
      },
      { Authorization: `Bearer ${authToken}` }
    );
    if (outBoundsRes.status !== 400 || outBoundsRes.body.success) {
      throw new Error(`Expected 400 rejection, got ${outBoundsRes.status}: ${JSON.stringify(outBoundsRes.body)}`);
    }
    console.log(`  ✓ Correctly rejected out-of-bounds POI: "${outBoundsRes.body.error}"`);

    // 7. Update POI
    console.log('[Test 7] Update created POI name and description...');
    const updateRes = await makeRequest(
      'PUT',
      `/api/projects/${demoProject._id}/pois/${createdPoi._id}`,
      {
        name: 'Conference Room Beta (Renamed)',
        description: 'Updated presentation studio description.',
      },
      { Authorization: `Bearer ${authToken}` }
    );
    if (updateRes.status !== 200 || updateRes.body.data.name !== 'Conference Room Beta (Renamed)') {
      throw new Error(`Update failed: ${JSON.stringify(updateRes.body)}`);
    }
    console.log(`  ✓ Updated POI name: "${updateRes.body.data.name}"`);

    // 8. Delete POI
    console.log('[Test 8] Delete created POI...');
    const delRes = await makeRequest(
      'DELETE',
      `/api/projects/${demoProject._id}/pois/${createdPoi._id}`,
      null,
      { Authorization: `Bearer ${authToken}` }
    );
    if (delRes.status !== 200 || !delRes.body.success) {
      throw new Error(`Delete failed: ${JSON.stringify(delRes.body)}`);
    }
    console.log(`  ✓ Deleted POI successfully (ID: ${delRes.body.poiId})`);

    // 9. Unauthorized modification prevention
    console.log('[Test 9] Verify unauthenticated write is rejected with 401...');
    const unauthRes = await makeRequest(
      'POST',
      `/api/projects/${demoProject._id}/pois`,
      { name: 'Hacker POI', position: { x: 0, y: 0, z: 0 } }
    );
    if (unauthRes.status !== 401) {
      throw new Error(`Expected 401, got ${unauthRes.status}`);
    }
    console.log(`  ✓ Correctly rejected unauthenticated modification with 401`);

    console.log('\n======================================================');
    console.log(' ALL 9 PHASE 5 POI & SEARCH TESTS PASSED! ');
    console.log('======================================================\n');
  } finally {
    if (server) server.close();
    await mongoose.disconnect();
  }
};

runTests().catch((err) => {
  console.error('\n❌ Phase 5 Test Failed:', err);
  if (server) server.close();
  mongoose.disconnect();
  process.exit(1);
});

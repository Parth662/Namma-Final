import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createApp } from './src/app.js';
import { connectDatabase, disconnectDatabase } from './src/config/database.js';
import { closeRedisConnection } from './src/config/redis.js';
import { User } from './src/models/User.js';
import { Project } from './src/models/Project.js';
import { ReconstructionJob } from './src/models/ReconstructionJob.js';

const PORT = 5099;

const runTests = async () => {
  console.log('--- Starting Phase 1 & Phase 2 Integration Tests ---');
  await connectDatabase();

  const app = createApp();
  const server = app.listen(PORT);
  const baseUrl = `http://localhost:${PORT}`;

  try {
    // Clean up test data
    await User.deleteMany({ email: /test.*@example\.com/ });
    await Project.deleteMany({ name: /Test Twin Project.*/ });

    // 1. Health check
    console.log('Testing GET /api/health ...');
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'ok');
    assert.strictEqual(healthData.dependencies.mongodb, 'connected');
    console.log('✓ Health check passed');

    // 2. Auth: Register
    console.log('Testing POST /api/auth/register ...');
    const registerPayload = {
      name: 'Architect Bob',
      email: `test_${Date.now()}@example.com`,
      password: 'SecurePassword123!',
    };
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registerPayload),
    });
    assert.strictEqual(regRes.status, 201);
    const regData = await regRes.json();
    assert.strictEqual(regData.success, true);
    assert(regData.token, 'Token must be returned');
    assert.strictEqual(regData.user.name, 'Architect Bob');
    const token = regData.token;
    console.log('✓ User registration passed');

    // 3. Auth: Login
    console.log('Testing POST /api/auth/login ...');
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: registerPayload.email,
        password: registerPayload.password,
      }),
    });
    assert.strictEqual(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.strictEqual(loginData.success, true);
    assert(loginData.token);
    console.log('✓ User login passed');

    // 4. Auth: Get Current User
    console.log('Testing GET /api/auth/me ...');
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(meRes.status, 200);
    const meData = await meRes.json();
    assert.strictEqual(meData.user.email, registerPayload.email.toLowerCase());
    console.log('✓ Get profile /me passed');

    // 5. Projects: Create Project (Phase 2)
    console.log('Testing POST /api/projects ...');
    const projectPayload = {
      name: 'Test Twin Project - College Campus',
      description: 'Central library and quadrangle area capture',
      locationName: 'North Campus Quad',
      latitude: 37.7749,
      longitude: -122.4194,
    };
    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(projectPayload),
    });
    assert.strictEqual(createProjectRes.status, 201);
    const createProjectData = await createProjectRes.json();
    assert.strictEqual(createProjectData.success, true);
    const project = createProjectData.data;
    assert.strictEqual(project.name, projectPayload.name);
    assert.strictEqual(project.status, 'created');
    assert.strictEqual(project.progress, 0);
    console.log('✓ Project creation passed');

    // 6. Projects: List projects
    console.log('Testing GET /api/projects ...');
    const listRes = await fetch(`${baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json();
    assert(Array.isArray(listData.data));
    assert(listData.count >= 1);
    console.log('✓ Projects listing passed');

    // 7. Projects: Get project by ID
    console.log(`Testing GET /api/projects/${project._id} ...`);
    const getByIdRes = await fetch(`${baseUrl}/api/projects/${project._id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(getByIdRes.status, 200);
    const getByIdData = await getByIdRes.json();
    assert.strictEqual(getByIdData.data._id, project._id);
    console.log('✓ Get project by ID passed');

    // 8. Projects: Video Upload (Phase 2)
    console.log(`Testing POST /api/projects/${project._id}/upload ...`);
    // Create a mock mp4 file using a small test buffer or ffmpeg
    const testVideoPath = path.resolve('./uploads/temp_test.mp4');
    fs.writeFileSync(testVideoPath, Buffer.from('FAKE-MP4-STREAM-CONTENT-HEADER-FOR-TESTING'));

    const formData = new FormData();
    const fileBlob = new Blob([fs.readFileSync(testVideoPath)], { type: 'video/mp4' });
    formData.append('video', fileBlob, 'campus_capture.mp4');

    const uploadRes = await fetch(`${baseUrl}/api/projects/${project._id}/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    if (fs.existsSync(testVideoPath)) fs.unlinkSync(testVideoPath);

    assert.strictEqual(uploadRes.status, 200);
    const uploadData = await uploadRes.json();
    assert.strictEqual(uploadData.success, true);
    assert.strictEqual(uploadData.data.status, 'uploaded');
    assert.strictEqual(uploadData.data.projectId, project._id);

    // Verify file on disk
    const expectedDiskFile = path.resolve(`./uploads/${project._id}/source/video.mp4`);
    assert(fs.existsSync(expectedDiskFile), 'Uploaded video.mp4 must exist on disk at uploads/<id>/source/video.mp4');
    console.log('✓ Video upload & storage verification passed');

    // 9. Reconstruct trigger test (enqueuing to BullMQ as per Section 7)
    console.log(`Testing POST /api/projects/${project._id}/reconstruct ...`);
    const reconRes = await fetch(`${baseUrl}/api/projects/${project._id}/reconstruct`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    assert.strictEqual(reconRes.status, 200);
    const reconData = await reconRes.json();
    assert.strictEqual(reconData.success, true);
    assert.strictEqual(reconData.status, 'queued');
    assert(reconData.jobId);
    console.log('✓ Reconstruction enqueuing (BullMQ) passed');

    // 10. Status endpoint (Section 20 & 26)
    console.log(`Testing GET /api/projects/${project._id}/status ...`);
    const statusRes = await fetch(`${baseUrl}/api/projects/${project._id}/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert(statusData.status === 'queued' || statusData.status === 'processing');
    console.log('✓ Reconstruction status check passed');

    // 10b. Cancel endpoint (Step 2.10)
    console.log(`Testing POST /api/projects/${project._id}/cancel ...`);
    const cancelRes = await fetch(`${baseUrl}/api/projects/${project._id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(cancelRes.status, 200);
    const cancelData = await cancelRes.json();
    assert.strictEqual(cancelData.success, true);
    assert.strictEqual(cancelData.status, 'cancelled');
    console.log('✓ Project cancellation endpoint passed');

    // 11. Delete Project
    console.log(`Testing DELETE /api/projects/${project._id} ...`);
    const delRes = await fetch(`${baseUrl}/api/projects/${project._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(delRes.status, 200);
    assert(!fs.existsSync(expectedDiskFile), 'Project files must be removed on deletion');
    console.log('✓ Project deletion & cleanup passed');

    console.log('\n======================================================');
    console.log(' ALL PHASE 1 & PHASE 2 TESTS PASSED SUCCESSFULLY! ');
    console.log('======================================================\n');
  } catch (err) {
    console.error('Test failed with error:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await disconnectDatabase();
    await closeRedisConnection();
  }
};

runTests();

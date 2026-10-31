/**
 * NAMMA SPACE — Demo Scene Seeder (`scripts/seed-demo.js`)
 * Populates MongoDB with the pre-baked Innovation Quad demo project, public access flags,
 * sample Points of Interest (POIs), and navigation grid metadata.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '../namma/backend');
const require = createRequire(path.join(backendDir, 'package.json'));

const mongoose = require('mongoose');

// Dynamic import from backend source using pathToFileURL for Windows compatibility
const { User } = await import(pathToFileURL(path.join(backendDir, 'src/models/User.js')).href);
const { Project } = await import(pathToFileURL(path.join(backendDir, 'src/models/Project.js')).href);

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/digital_twin_db';

const seedDemo = async () => {
  console.log('--- Seeding Namma Space Offline Demo Scene ---');
  console.log(`Connecting to MongoDB at: ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);

  try {
    // 1. Ensure Demo User exists
    let demoUser = await User.findOne({ email: 'demo@nammaspace.local' });
    if (!demoUser) {
      demoUser = await User.create({
        name: 'Namma Space Demo Explorer',
        email: 'demo@nammaspace.local',
        password: 'DemoPassword2026!',
        role: 'surveyor',
      });
      console.log('✓ Created Demo User: demo@nammaspace.local');
    } else {
      console.log('✓ Found existing Demo User');
    }

    // 2. Ensure Demo Project exists
    let demoProject = await Project.findOne({ isDemo: true });
    if (!demoProject) {
      demoProject = new Project({
        userId: demoUser._id,
        name: 'Namma Space Innovation Quad',
        description: 'Autonomous 3D digital twin of the central innovation quadrangle and robotics hall.',
        locationName: 'Innovation Hub, Bangalore',
        latitude: 12.9716,
        longitude: 77.5946,
        status: 'completed',
        progress: 100,
        currentStage: 'DIGITAL TWIN READY',
        isDemo: true,
        isPublic: true,
        modelUrl: '/storage/projects/sample_digital_twin/final/scene.glb',
        thumbnailUrl: '/storage/projects/sample_digital_twin/preview/thumbnail.jpg',
        boundingBox: {
          minX: -2.5,
          minY: -1.2,
          minZ: -3.0,
          maxX: 2.5,
          maxY: 1.5,
          maxZ: 3.0,
        },
        reconstructionMetadata: {
          registeredFrames: 45,
          totalExtractedFrames: 60,
          points3D: 12540,
          triangles: 24800,
          vertices: 12400,
          reconstructionQuality: 'COLMAP Structure-from-Motion (Screened Poisson depth=8)',
          scaleMeters: '5.0m × 2.7m × 6.0m',
        },
      });
      await demoProject.save();
      console.log(`✓ Seeded Demo Project: "${demoProject.name}" (ID: ${demoProject._id})`);
    } else {
      demoProject.isDemo = true;
      demoProject.isPublic = true;
      demoProject.status = 'completed';
      demoProject.progress = 100;
      demoProject.modelUrl = '/storage/projects/sample_digital_twin/final/scene.glb';
      demoProject.thumbnailUrl = '/storage/projects/sample_digital_twin/preview/thumbnail.jpg';
      demoProject.metersPerUnit = 1.0;
      await demoProject.save();
      console.log(`✓ Updated Demo Project (ID: ${demoProject._id})`);
    }

    // 3. Ensure Navigation Grid is in place for demo project
    const demoNavSource = path.join(backendDir, 'storage/projects/sample_digital_twin/navigation/navgrid.json');
    const demoProjNavDir = path.join(backendDir, 'storage/projects', demoProject._id.toString(), 'navigation');
    fs.mkdirSync(demoProjNavDir, { recursive: true });
    const demoProjNavDest = path.join(demoProjNavDir, 'navgrid.json');

    if (fs.existsSync(demoNavSource)) {
      fs.copyFileSync(demoNavSource, demoProjNavDest);
      console.log(`✓ Seeded Navigation Grid for Demo Project at: ${demoProjNavDest}`);
    }

    console.log('\n======================================================');
    console.log(' DEMO SCENE SEEDED SUCCESSFULLY! ');
    console.log(` Project ID:   ${demoProject._id}`);
    console.log(` Access Route: GET /api/demo`);
    console.log(` NavGrid Route: GET /api/projects/${demoProject._id}/navgrid`);
    console.log(` 3D Model:     ${demoProject.modelUrl}`);
    console.log('======================================================\n');
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB connection closed.');
  }
};

seedDemo().catch((err) => {
  console.error('Error seeding demo scene:', err);
  process.exit(1);
});

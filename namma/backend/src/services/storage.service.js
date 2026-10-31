import fs from 'fs';
import path from 'path';
import { env } from '../config/environment.js';

class StorageService {
  constructor() {
    this.uploadDir = env.UPLOAD_DIR;
    this.storageDir = env.STORAGE_DIR;
    this.processingDir = env.PROCESSING_DIR;
    this.outputDir = env.OUTPUT_DIR;
    this.initDirectories();
  }

  initDirectories() {
    [this.uploadDir, this.storageDir, this.processingDir, this.outputDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  getProjectStoragePaths(projectId) {
    const id = projectId.toString();
    const projectStorage = path.join(this.storageDir, 'projects', id);
    const sourceDir = path.join(projectStorage, 'source');
    const framesDir = path.join(projectStorage, 'frames');
    const reconstructionDir = path.join(projectStorage, 'reconstruction');
    const colmapDir = path.join(reconstructionDir, 'colmap');
    const sparseDir = path.join(colmapDir, 'sparse');
    const denseDir = path.join(colmapDir, 'dense');
    const pointcloudDir = path.join(reconstructionDir, 'pointcloud');
    const meshDir = path.join(reconstructionDir, 'mesh');
    const texturesDir = path.join(reconstructionDir, 'textures');
    const optimizedDir = path.join(reconstructionDir, 'optimized');
    const lod0Dir = path.join(optimizedDir, 'lod0');
    const lod1Dir = path.join(optimizedDir, 'lod1');
    const lod2Dir = path.join(optimizedDir, 'lod2');
    const finalDir = path.join(projectStorage, 'final');
    const previewDir = path.join(projectStorage, 'preview');

    const uploadsProjectDir = path.join(this.uploadDir, id, 'source');
    const processingProjectDir = path.join(this.processingDir, id);

    return {
      projectStorage,
      sourceDir,
      framesDir,
      reconstructionDir,
      colmapDir,
      sparseDir,
      denseDir,
      pointcloudDir,
      meshDir,
      texturesDir,
      optimizedDir,
      lod0Dir,
      lod1Dir,
      lod2Dir,
      finalDir,
      previewDir,
      uploadsProjectDir,
      processingProjectDir,
    };
  }

  ensureProjectDirectories(projectId) {
    const paths = this.getProjectStoragePaths(projectId);
    Object.values(paths).forEach((dirPath) => {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    });
    return paths;
  }

  getVideoDestinationPath(projectId, filename = 'video.mp4') {
    const paths = this.ensureProjectDirectories(projectId);
    return path.join(paths.uploadsProjectDir, filename);
  }

  getFinalModelPath(projectId, filename = 'scene.glb') {
    const paths = this.ensureProjectDirectories(projectId);
    return path.join(paths.finalDir, filename);
  }

  getThumbnailPath(projectId, filename = 'thumbnail.jpg') {
    const paths = this.ensureProjectDirectories(projectId);
    return path.join(paths.previewDir, filename);
  }

  deleteProjectFiles(projectId) {
    const paths = this.getProjectStoragePaths(projectId);
    [paths.projectStorage, path.join(this.uploadDir, projectId.toString()), paths.processingProjectDir].forEach((dir) => {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

export const storageService = new StorageService();

import { env } from '../config/environment.js';

class PythonService {
  constructor() {
    this.baseUrl = env.PYTHON_SERVICE_URL;
  }

  async checkHealth() {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { method: 'GET' });
      if (!res.ok) return { online: false, error: `Status ${res.status}` };
      const data = await res.json();
      return { online: true, ...data };
    } catch (error) {
      return { online: false, error: error.message };
    }
  }

  async requestReconstruction(params) {
    const url = `${this.baseUrl}/api/reconstruct`;
    console.log(`[PythonService] Requesting 3D reconstruction at: ${url}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: params.signal,
      });

      const data = await res.json();
      return { status: res.status, ...data };
    } catch (error) {
      console.error(`[PythonService] Connection failed to ${url}:`, error.message);
      return {
        status: 503,
        success: false,
        error: `Failed to contact Python 3D reconstruction engine at ${url}: ${error.message}`,
      };
    }
  }

  async cancelReconstruction({ jobId, projectId }) {
    const url = `${this.baseUrl}/api/reconstruct/cancel`;
    console.log(`[PythonService] Requesting job cancellation at: ${url}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, projectId }),
      });
      return await res.json();
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async analyzeCaptureCoach(videoPath) {
    const url = `${this.baseUrl}/api/coach/analyze`;
    console.log(`[PythonService] Requesting Capture Coach analysis at: ${url}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPath }),
      });
      return await res.json();
    } catch (error) {
      console.error(`[PythonService] Capture Coach analysis failed:`, error.message);
      return { success: false, error: error.message, hopeless: false };
    }
  }

  async transformGeoJson(params) {
    const url = `${this.baseUrl}/api/geo/transform`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      return await res.json();
    } catch (error) {
      console.error(`[PythonService] Geo transform error:`, error.message);
      return { success: false, error: error.message };
    }
  }
}

export const pythonService = new PythonService();

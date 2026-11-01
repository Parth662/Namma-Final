import { Platform } from 'react-native';
import Constants from 'expo-constants';

let cachedToken = null;

export const getBackendBaseUrl = () => {
  // 1. Explicit override if provided and non-empty
  const overrideUrl = process.env.EXPO_PUBLIC_API_URL;
  if (overrideUrl && overrideUrl.trim() !== '') {
    let clean = overrideUrl.includes(':5002') ? overrideUrl.replace(':5002', ':5001') : overrideUrl;
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = `https://${clean}`;
    }
    return clean.replace(/\/+$/, '');
  }

  // 2. On Web:
  if (typeof window !== 'undefined' && window.location && window.location.hostname) {
    const hostname = window.location.hostname || 'localhost';
    const isHttps = window.location.protocol === 'https:';

    if (isHttps) {
      // Production Render deployment auto-fallback
      if (hostname.includes('.onrender.com')) {
        return `https://${hostname.replace('-frontend', '-api')}`;
      }
      return `https://${hostname}`;
    }

    return `http://${hostname}:5001`;
  }

  // 3. On Native / Expo Go: derive host from Constants.expoConfig?.hostUri (strip the port)
  const hostUri = Constants.expoConfig?.hostUri || Constants.manifest2?.extra?.expoGo?.debuggerHost || Constants.manifest?.debuggerHost;
  if (hostUri) {
    const laptopIp = hostUri.split(':')[0];
    if (laptopIp) {
      return `http://${laptopIp}:5001`;
    }
  }

  // 4. Android Emulator fallback
  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:5001';
  }

  // 5. Default fallback
  return 'http://localhost:5001';
};

// Print resolved base URL at app startup (console)
try {
  const initialBaseUrl = getBackendBaseUrl();
  console.log(`[Namma Client] Resolved backend base URL: ${initialBaseUrl}`);
} catch (e) {
  console.warn('[Namma Client] Error resolving initial base URL:', e);
}

export const setAuthToken = (token) => {
  cachedToken = token;
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      if (token) {
        window.localStorage.setItem('namma_auth_token', token);
      } else {
        window.localStorage.removeItem('namma_auth_token');
      }
    } catch {}
  }
};

export const getAuthToken = () => {
  if (cachedToken) return cachedToken;
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      cachedToken = window.localStorage.getItem('namma_auth_token');
    } catch {}
  }
  return cachedToken;
};

export const clearAuthToken = () => {
  setAuthToken(null);
};

export const autoLoginSurveyor = async () => {
  const baseUrl = getBackendBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/api/auth/register-surveyor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    if (json.success && json.data?.token) {
      setAuthToken(json.data.token);
      return json.data.token;
    }
  } catch (e) {
    console.warn('[ApiClient] Auto-login surveyor warning:', e);
  }
  return null;
};

export const apiFetch = async (endpoint, options = {}) => {
  const baseUrl = getBackendBaseUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${baseUrl}${cleanEndpoint}`;

  const headers = { ...options.headers };
  const token = getAuthToken();

  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (netErr) {
    return {
      ok: false,
      status: 0,
      error: `Network error: unable to connect to ${url}`,
    };
  }

  // 401 Unauthorized handling - retry once after auto-login if surveyor
  if (response.status === 401 && !options._isRetry) {
    clearAuthToken();
    const newToken = await autoLoginSurveyor();
    if (newToken) {
      return apiFetch(endpoint, { ...options, _isRetry: true });
    }
  }

  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    data: data?.data !== undefined ? data.data : data,
    raw: data,
    error: data?.error || (!response.ok ? `HTTP ${response.status}` : null),
  };
};

export const demoApi = {
  getDemoScene: () => apiFetch('/api/demo'),
};

export const projectsApi = {
  getProjects: () => apiFetch('/api/projects'),
  getProject: (id) => apiFetch(`/api/projects/${id}`),
  getModel: (id) => apiFetch(`/api/projects/${id}/model`),
  getNavGrid: (id) => apiFetch(`/api/projects/${id}/navgrid`),
  getPath: (id, from, to) => {
    const f = `${from.x},${from.y || 0},${from.z}`;
    const t = `${to.x},${to.y || 0},${to.z}`;
    return apiFetch(`/api/projects/${id}/path?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`);
  },
  calibrate: (id, p1, p2, realDistanceMeters) =>
    apiFetch(`/api/projects/${id}/calibrate`, {
      method: 'POST',
      body: JSON.stringify({ p1, p2, realDistanceMeters }),
    }),
  cancelReconstruction: (id) =>
    apiFetch(`/api/projects/${id}/cancel`, {
      method: 'POST',
    }),
  patchGeo: (id, { lat, lng, headingDegrees }) =>
    apiFetch(`/api/projects/${id}/geo`, {
      method: 'PATCH',
      body: JSON.stringify({ lat, lng, headingDegrees }),
    }),
  getFloorplan: (id, { wgs84 = false } = {}) =>
    apiFetch(`/api/projects/${id}/floorplan${wgs84 ? '?wgs84=true' : ''}`),
  getMetrics: (id) => apiFetch(`/api/projects/${id}/metrics`),
};

export const poisApi = {
  getPOIs: (projectId, { q, category } = {}) => {
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (category) params.append('category', category);
    const qs = params.toString();
    return apiFetch(`/api/projects/${projectId}/pois${qs ? `?${qs}` : ''}`);
  },
  getPOI: (projectId, poiId) => apiFetch(`/api/projects/${projectId}/pois/${poiId}`),
  createPOI: (projectId, poiData) =>
    apiFetch(`/api/projects/${projectId}/pois`, {
      method: 'POST',
      body: JSON.stringify(poiData),
    }),
  updatePOI: (projectId, poiId, poiData) =>
    apiFetch(`/api/projects/${projectId}/pois/${poiId}`, {
      method: 'PUT',
      body: JSON.stringify(poiData),
    }),
  deletePOI: (projectId, poiId) =>
    apiFetch(`/api/projects/${projectId}/pois/${poiId}`, {
      method: 'DELETE',
    }),
};


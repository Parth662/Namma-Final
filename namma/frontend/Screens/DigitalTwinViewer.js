import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  Platform,
  ScrollView,
  useWindowDimensions,
  ActivityIndicator,
  NativeModules,
} from 'react-native';
import Constants from 'expo-constants';
import { WebView } from 'react-native-webview';

const getBackendHost = () => {
  if (process.env.EXPO_PUBLIC_BACKEND_URL) {
    return process.env.EXPO_PUBLIC_BACKEND_URL;
  }
  if (Platform.OS === 'web') return 'http://localhost:5001';
  const hostUri = Constants?.expoConfig?.hostUri || Constants?.manifest2?.extra?.expoGo?.debuggerHost || Constants?.manifest?.debuggerHost;
  if (hostUri) {
    const ip = hostUri.split(':')[0];
    if (ip && ip !== 'localhost' && ip !== '127.0.0.1') {
      return `http://${ip}:5001`;
    }
  }
  const scriptURL = NativeModules?.SourceCode?.scriptURL;
  if (scriptURL) {
    const address = scriptURL.split('://')[1]?.split('/')[0]?.split(':')[0];
    if (address && address !== 'localhost' && address !== '127.0.0.1') {
      return `http://${address}:5001`;
    }
  }
  if (Platform.OS === 'android') return 'http://10.0.2.2:5001';
  return 'http://localhost:5001';
};

export default function DigitalTwinViewer({ onClose, onOpenMap, projectData }) {
  const webViewRef = useRef(null);
  const { width: windowWidth } = useWindowDimensions();
  const isMobile = windowWidth < 768;

  const [activeTab, setActiveTab] = useState('model'); // 'model' | 'pointcloud' | 'wireframe'
  const [showMetadata, setShowMetadata] = useState(!isMobile);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState(null);

  const sampleProject = projectData || {};

  useEffect(() => {
    if (sampleProject.status === 'failed' || sampleProject.error) {
      setLoading(false);
      setErrorState({
        code: sampleProject.error?.code || 'INSUFFICIENT_RECONSTRUCTION_QUALITY',
        reason: sampleProject.error?.reason || sampleProject.reason || 'Reconstruction process failed.',
        suggestion:
          sampleProject.error?.suggestion ||
          sampleProject.suggestion ||
          'Please record the location again with slow, steady camera motion and overlapping angles.',
      });
    }
  }, [sampleProject]);

  const sendToWebView = (message) => {
    if (webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify(message));
    }
  };

  const handleModeChange = (mode) => {
    setActiveTab(mode);
    sendToWebView({ type: 'SET_MODE', mode });
  };

  const handleReset = () => {
    sendToWebView({ type: 'RESET' });
  };

  const backendHost = getBackendHost();
  let rawModelUrl = sampleProject.modelUrl || (sampleProject.model && sampleProject.model.url) || '';
  if (rawModelUrl.startsWith('/')) {
    rawModelUrl = `${backendHost}${rawModelUrl}`;
  } else if (rawModelUrl.includes('localhost:5001') && Platform.OS !== 'web') {
    rawModelUrl = rawModelUrl.replace('http://localhost:5001', backendHost);
  }

  const threeHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body, html { width: 100%; height: 100%; overflow: hidden; background: #070b14; }
          #canvas-container { width: 100%; height: 100%; touch-action: none; }
          #loading-box {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            color: #38bdf8; font-family: sans-serif; font-size: 14px; text-align: center;
          }
        </style>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js"></script>
      </head>
      <body>
        <div id="loading-box">Loading 3D Photogrammetry Model...</div>
        <div id="canvas-container"></div>
        <script>
          const container = document.getElementById('canvas-container');
          const loadingBox = document.getElementById('loading-box');
          const width = window.innerWidth;
          const height = window.innerHeight;

          const scene = new THREE.Scene();
          scene.background = new THREE.Color(0x070b14);

          const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 1000);
          let spherical = { radius: 10, theta: Math.PI / 4, phi: Math.PI / 3.2 };
          let target = new THREE.Vector3(0, 0, 0);

          function updateCamera() {
            camera.position.x = target.x + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
            camera.position.y = target.y + spherical.radius * Math.cos(spherical.phi);
            camera.position.z = target.z + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
            camera.lookAt(target);
          }
          updateCamera();

          const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
          renderer.setSize(width, height);
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
          renderer.shadowMap.enabled = true;
          container.appendChild(renderer.domElement);

          // Lighting
          const ambient = new THREE.HemisphereLight(0xffffff, 0x1e293b, 1.2);
          scene.add(ambient);
          const sun = new THREE.DirectionalLight(0xfff5e6, 1.6);
          sun.position.set(15, 25, 15);
          scene.add(sun);
          const fill = new THREE.DirectionalLight(0x38bdf8, 0.5);
          fill.position.set(-15, 12, -15);
          scene.add(fill);

          const grid = new THREE.GridHelper(30, 30, 0x0ea5e9, 0x1e293b);
          grid.position.y = -0.01;
          scene.add(grid);

          let loadedModel = null;
          let pointCloudMesh = null;
          let currentMode = 'model';

          const modelUrl = ${JSON.stringify(rawModelUrl)};

          if (modelUrl) {
            const loader = new THREE.GLTFLoader();
            loader.load(
              modelUrl,
              (gltf) => {
                loadingBox.style.display = 'none';
                loadedModel = gltf.scene;

                const box = new THREE.Box3().setFromObject(loadedModel);
                const size = box.getSize(new THREE.Vector3());
                const center = box.getCenter(new THREE.Vector3());

                loadedModel.position.x = -center.x;
                loadedModel.position.y = -box.min.y;
                loadedModel.position.z = -center.z;

                const pointPositions = [];
                const pointColors = [];

                loadedModel.traverse((child) => {
                  if (child.isMesh) {
                    child.castShadow = true;
                    if (child.material) child.material.side = THREE.DoubleSide;
                    if (child.geometry && child.geometry.attributes.position) {
                      const pos = child.geometry.attributes.position;
                      const col = child.geometry.attributes.color;
                      for (let i = 0; i < pos.count; i++) {
                        pointPositions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
                        if (col) {
                          pointColors.push(col.getX(i), col.getY(i), col.getZ(i));
                        } else {
                          pointColors.push(0.8, 0.8, 0.8);
                        }
                      }
                    }
                  }
                });

                if (pointPositions.length > 0) {
                  const ptGeo = new THREE.BufferGeometry();
                  ptGeo.setAttribute('position', new THREE.Float32BufferAttribute(pointPositions, 3));
                  ptGeo.setAttribute('color', new THREE.Float32BufferAttribute(pointColors, 3));
                  const ptMat = new THREE.PointsMaterial({ size: 0.08, vertexColors: true, transparent: true });
                  pointCloudMesh = new THREE.Points(ptGeo, ptMat);
                  pointCloudMesh.position.copy(loadedModel.position);
                  pointCloudMesh.visible = false;
                  scene.add(pointCloudMesh);
                }

                scene.add(loadedModel);

                const maxDim = Math.max(size.x, size.y, size.z, 1.0);
                const fov = camera.fov * (Math.PI / 180);
                spherical.radius = Math.max(3.5, Math.abs(maxDim / Math.sin(fov / 2)) * 0.95);
                target.set(0, size.y / 2, 0);
                updateCamera();

                window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'MODEL_LOADED',
                  size: size
                }));
              },
              undefined,
              (err) => {
                loadingBox.textContent = 'Failed to load photogrammetric model (.GLB)';
                loadingBox.style.color = '#ef4444';
              }
            );
          } else {
            loadingBox.textContent = 'No 3D model asset available.';
          }

          function applyMode(mode) {
            currentMode = mode;
            if (!loadedModel) return;
            if (mode === 'model') {
              loadedModel.visible = true;
              setWire(loadedModel, false);
              if (pointCloudMesh) pointCloudMesh.visible = false;
            } else if (mode === 'pointcloud') {
              loadedModel.visible = false;
              if (pointCloudMesh) pointCloudMesh.visible = true;
            } else if (mode === 'wireframe') {
              loadedModel.visible = true;
              setWire(loadedModel, true);
              if (pointCloudMesh) pointCloudMesh.visible = false;
            }
          }

          function setWire(grp, w) {
            grp.traverse((c) => {
              if (c.isMesh && c.material) c.material.wireframe = w;
            });
          }

          let isDragging = false, prevX = 0, prevY = 0, pinchDist = null;
          function getTouchDist(t1, t2) {
            const dx = t1.clientX - t2.clientX;
            const dy = t1.clientY - t2.clientY;
            return Math.sqrt(dx * dx + dy * dy);
          }

          container.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
              pinchDist = getTouchDist(e.touches[0], e.touches[1]);
              isDragging = false;
              return;
            }
            isDragging = true;
            prevX = e.touches[0].clientX;
            prevY = e.touches[0].clientY;
          });

          container.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && pinchDist !== null) {
              const d = getTouchDist(e.touches[0], e.touches[1]);
              const delta = pinchDist - d;
              spherical.radius = Math.max(1.5, Math.min(65, spherical.radius + delta * 0.05));
              pinchDist = d;
              updateCamera();
              return;
            }
            if (!isDragging || !e.touches[0]) return;
            const dx = e.touches[0].clientX - prevX;
            const dy = e.touches[0].clientY - prevY;

            spherical.theta -= dx * 0.009;
            spherical.phi = Math.max(0.08, Math.min(Math.PI / 2 - 0.02, spherical.phi - dy * 0.009));
            updateCamera();

            prevX = e.touches[0].clientX;
            prevY = e.touches[0].clientY;
          });

          container.addEventListener('touchend', () => {
            isDragging = false;
            pinchDist = null;
          });

          function animate() {
            requestAnimationFrame(animate);
            renderer.render(scene, camera);
          }
          animate();

          window.addEventListener('message', (event) => {
            try {
              const data = JSON.parse(event.data);
              if (data.type === 'SET_MODE') applyMode(data.mode);
              if (data.type === 'RESET' && loadedModel) {
                const box = new THREE.Box3().setFromObject(loadedModel);
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z, 1.0);
                spherical.radius = Math.max(3.5, maxDim * 2.2);
                target.set(0, size.y / 2, 0);
                updateCamera();
              }
            } catch (e) {}
          });
        </script>
      </body>
    </html>
  `;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <TouchableOpacity style={styles.backBtn} onPress={onClose}>
              <Text style={styles.backBtnText}>‹ Back</Text>
            </TouchableOpacity>
            <View style={styles.headerTitleWrap}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {sampleProject.name || 'Photogrammetric Digital Twin'}
              </Text>
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                {sampleProject.locationName || '3D Reconstructed Environment'}
              </Text>
            </View>
          </View>
          <View style={styles.headerRight}>
            {onOpenMap && (
              <TouchableOpacity style={styles.mapNavBtn} onPress={onOpenMap}>
                <Text style={styles.mapNavBtnText}>🗺️ Map</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.hudToggleBtn, showMetadata && styles.hudToggleBtnActive]}
              onPress={() => setShowMetadata(!showMetadata)}
            >
              <Text style={styles.hudToggleText}>📊 Metrics</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Viewport */}
        <View style={styles.viewport}>
          {!errorState ? (
            <WebView
              ref={webViewRef}
              originWhitelist={['*']}
              source={{ html: threeHtml }}
              style={styles.webView}
              javaScriptEnabled
              domStorageEnabled
              onLoadEnd={() => setLoading(false)}
            />
          ) : (
            <View style={styles.errorOverlay}>
              <View style={styles.errorCard}>
                <Text style={styles.errorIcon}>⚠️</Text>
                <Text style={styles.errorTitle}>Reconstruction Issue</Text>
                <Text style={styles.errorCodeBadge}>{errorState.code}</Text>
                <Text style={styles.errorReason}>{errorState.reason}</Text>
                <View style={styles.errorTipBox}>
                  <Text style={styles.errorTipTitle}>💡 Recommendation:</Text>
                  <Text style={styles.errorTipText}>{errorState.suggestion}</Text>
                </View>
                <TouchableOpacity style={styles.errorActionBtn} onPress={onClose}>
                  <Text style={styles.errorActionBtnText}>Record New Video</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Mode Switcher Tabs */}
          {!errorState && (
            <View style={styles.modePillContainer}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modeScrollContent}>
                <TouchableOpacity
                  style={[styles.modePill, activeTab === 'model' && styles.modePillActive]}
                  onPress={() => handleModeChange('model')}
                >
                  <Text style={[styles.modePillText, activeTab === 'model' && styles.modePillTextActive]}>
                    🏛️ 3D Mesh
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modePill, activeTab === 'pointcloud' && styles.modePillActive]}
                  onPress={() => handleModeChange('pointcloud')}
                >
                  <Text style={[styles.modePillText, activeTab === 'pointcloud' && styles.modePillTextActive]}>
                    ✨ Point Cloud
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modePill, activeTab === 'wireframe' && styles.modePillActive]}
                  onPress={() => handleModeChange('wireframe')}
                >
                  <Text style={[styles.modePillText, activeTab === 'wireframe' && styles.modePillTextActive]}>
                    📐 Wireframe
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          )}

          {/* Center Model Control */}
          {!errorState && (
            <View style={styles.orbitControlsDeck}>
              <TouchableOpacity style={styles.orbitBtn} onPress={handleReset}>
                <Text style={styles.orbitBtnText}>🔄 Center Model</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Metadata Card */}
          {showMetadata && !errorState && (
            <View style={styles.hudCard}>
              <Text style={styles.hudTitle}>Reconstruction Metrics</Text>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Points:</Text>
                <Text style={styles.statVal}>{sampleProject.metadata?.points3D || sampleProject.stats?.pointCount || '—'}</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Triangles:</Text>
                <Text style={styles.statVal}>{sampleProject.metadata?.triangles || sampleProject.stats?.triangles || '—'}</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Registered Cameras:</Text>
                <Text style={styles.statVal}>{sampleProject.metadata?.registeredFrames || sampleProject.stats?.cameraPoses || '—'}</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Engine:</Text>
                <Text style={styles.statValHighlight}>COLMAP SfM + Open3D MVS</Text>
              </View>
            </View>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#070b14' },
  container: { flex: 1, backgroundColor: '#070b14' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#0f172a',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  backBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#1e293b',
    borderRadius: 8,
    marginRight: 10,
  },
  backBtnText: { color: '#e2e8f0', fontSize: 14, fontWeight: '600' },
  headerTitleWrap: { flex: 1 },
  headerTitle: { color: '#f8fafc', fontSize: 15, fontWeight: '700' },
  headerSubtitle: { color: '#94a3b8', fontSize: 11 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mapNavBtn: { backgroundColor: '#0284c7', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  mapNavBtnText: { color: '#ffffff', fontSize: 11, fontWeight: '600' },
  hudToggleBtn: { backgroundColor: '#1e293b', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8 },
  hudToggleBtnActive: { backgroundColor: '#334155' },
  hudToggleText: { color: '#e2e8f0', fontSize: 11, fontWeight: '600' },
  viewport: { flex: 1, position: 'relative', backgroundColor: '#070b14' },
  webView: { flex: 1, backgroundColor: '#070b14' },
  modePillContainer: { position: 'absolute', top: 12, left: 12, zIndex: 10 },
  modeScrollContent: { gap: 6 },
  modePill: {
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modePillActive: { backgroundColor: '#0284c7', borderColor: '#38bdf8' },
  modePillText: { color: '#94a3b8', fontSize: 11, fontWeight: '600' },
  modePillTextActive: { color: '#ffffff', fontWeight: '700' },
  orbitControlsDeck: { position: 'absolute', bottom: 16, right: 16, zIndex: 10 },
  orbitBtn: {
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  orbitBtnText: { color: '#e2e8f0', fontSize: 11, fontWeight: '600' },
  hudCard: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.90)',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
    width: 200,
    zIndex: 10,
  },
  hudTitle: { color: '#f8fafc', fontSize: 11, fontWeight: '700', marginBottom: 6 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  statLabel: { color: '#94a3b8', fontSize: 10 },
  statVal: { color: '#f8fafc', fontSize: 10, fontWeight: '600' },
  statValHighlight: { color: '#38bdf8', fontSize: 10, fontWeight: '700' },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#070b14',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    zIndex: 20,
  },
  errorCard: {
    backgroundColor: '#0f172a',
    borderRadius: 14,
    padding: 20,
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  errorIcon: { fontSize: 32, marginBottom: 8 },
  errorTitle: { color: '#f8fafc', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  errorCodeBadge: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    color: '#f87171',
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginBottom: 8,
  },
  errorReason: { color: '#cbd5e1', fontSize: 13, textAlign: 'center', lineHeight: 18, marginBottom: 12 },
  errorTipBox: { backgroundColor: '#1e293b', padding: 10, borderRadius: 8, width: '100%', marginBottom: 16 },
  errorTipTitle: { color: '#38bdf8', fontSize: 11, fontWeight: '700', marginBottom: 2 },
  errorTipText: { color: '#94a3b8', fontSize: 11, lineHeight: 16 },
  errorActionBtn: { backgroundColor: '#0284c7', paddingVertical: 10, borderRadius: 8, width: '100%', alignItems: 'center' },
  errorActionBtnText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
});

import React, { useState, useEffect, useRef } from 'react';
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
} from 'react-native';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

export default function DigitalTwinViewer({ onClose, onOpenMap, projectData }) {
  const containerRef = useRef(null);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isMobile = windowWidth < 768;
  const isSmallMobile = windowWidth < 420;

  const [activeTab, setActiveTab] = useState('model'); // 'model' | 'pointcloud' | 'wireframe'
  const [showMetadata, setShowMetadata] = useState(!isMobile);
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingStage, setLoadingStage] = useState('Initializing 3D Viewer...');
  const [errorState, setErrorState] = useState(null);
  const [exportingGLB, setExportingGLB] = useState(false);
  const [exportNotice, setExportNotice] = useState(null);
  const [modelStats, setModelStats] = useState(null);

  // Scene references
  const sceneRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const animationFrameRef = useRef(null);
  const loadedModelRef = useRef(null);
  const pointCloudMeshRef = useRef(null);

  // Orbit navigation references
  const isDraggingRef = useRef(false);
  const previousPointerPositionRef = useRef({ x: 0, y: 0 });
  const pinchStartDistanceRef = useRef(null);
  const cameraSphericalRef = useRef({ radius: 10, theta: Math.PI / 4, phi: Math.PI / 3.2 });
  const cameraTargetRef = useRef(new THREE.Vector3(0, 0, 0));

  const resolvedProject = projectData || {};

  // Check if project has already failed before rendering 3D scene
  useEffect(() => {
    if (resolvedProject.status === 'failed' || resolvedProject.error) {
      setLoading(false);
      setErrorState({
        code: resolvedProject.error?.code || 'INSUFFICIENT_RECONSTRUCTION_QUALITY',
        reason: resolvedProject.error?.reason || resolvedProject.reason || 'Reconstruction process failed.',
        suggestion:
          resolvedProject.error?.suggestion ||
          resolvedProject.suggestion ||
          'Please record the location again with slow, steady camera motion and overlapping angles.',
      });
    }
  }, [resolvedProject]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !containerRef.current) return;
    if (errorState) return;

    const container = containerRef.current;
    const width = container.clientWidth || windowWidth || 800;
    const height = container.clientHeight || windowHeight || 500;

    // 1. Scene setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b14);
    scene.fog = new THREE.FogExp2(0x070b14, 0.02);
    sceneRef.current = scene;

    // 2. Camera setup
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 1000);
    cameraRef.current = camera;
    updateCameraPosition();

    // 3. Renderer setup
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 4. Lighting without obscuring reconstruction geometry
    const ambientLight = new THREE.HemisphereLight(0xffffff, 0x1e293b, 1.2);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfff5e6, 1.6);
    sunLight.position.set(15, 25, 15);
    sunLight.castShadow = true;
    scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0x38bdf8, 0.5);
    fillLight.position.set(-15, 12, -15);
    scene.add(fillLight);

    const underLight = new THREE.DirectionalLight(0x64748b, 0.4);
    underLight.position.set(0, -15, 0);
    scene.add(underLight);

    // Coordinate grid plane
    const gridHelper = new THREE.GridHelper(30, 30, 0x0ea5e9, 0x1e293b);
    gridHelper.position.y = -0.01;
    scene.add(gridHelper);

    // 5. Load Real Reconstructed GLB Model
    loadPhotogrammetryAsset(scene, camera);

    // 6. Window resize handler
    const handleResize = () => {
      if (!container || !renderer || !camera) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    // 7. Pointer and Gesture Controls
    const getTouchDistance = (t1, t2) => {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const dom = renderer.domElement;
    const onPointerDown = (e) => {
      if (e.touches && e.touches.length === 2) {
        pinchStartDistanceRef.current = getTouchDistance(e.touches[0], e.touches[1]);
        return;
      }
      isDraggingRef.current = true;
      const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? 0;
      const clientY = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? 0;
      previousPointerPositionRef.current = { x: clientX, y: clientY };
    };

    const onPointerMove = (e) => {
      if (e.touches && e.touches.length === 2 && pinchStartDistanceRef.current !== null) {
        const currentDist = getTouchDistance(e.touches[0], e.touches[1]);
        const delta = pinchStartDistanceRef.current - currentDist;
        cameraSphericalRef.current.radius = Math.max(1.5, Math.min(80, cameraSphericalRef.current.radius + delta * 0.05));
        pinchStartDistanceRef.current = currentDist;
        updateCameraPosition();
        return;
      }

      if (!isDraggingRef.current) return;
      const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? 0;
      const clientY = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? 0;
      const deltaX = clientX - previousPointerPositionRef.current.x;
      const deltaY = clientY - previousPointerPositionRef.current.y;

      const sensitivity = isMobile ? 0.009 : 0.007;
      cameraSphericalRef.current.theta -= deltaX * sensitivity;
      cameraSphericalRef.current.phi = Math.max(0.08, Math.min(Math.PI / 2 - 0.02, cameraSphericalRef.current.phi - deltaY * sensitivity));
      updateCameraPosition();

      previousPointerPositionRef.current = { x: clientX, y: clientY };
    };

    const onPointerUp = () => {
      isDraggingRef.current = false;
      pinchStartDistanceRef.current = null;
    };

    const onWheel = (e) => {
      e.preventDefault();
      cameraSphericalRef.current.radius = Math.max(1.5, Math.min(80, cameraSphericalRef.current.radius + e.deltaY * 0.02));
      updateCameraPosition();
    };

    dom.addEventListener('mousedown', onPointerDown);
    dom.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('touchstart', onPointerDown, { passive: true });
    dom.addEventListener('touchmove', onPointerMove, { passive: true });
    window.addEventListener('touchend', onPointerUp, { passive: true });

    // 8. Render loop
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      window.removeEventListener('resize', handleResize);
      dom.removeEventListener('mousedown', onPointerDown);
      dom.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('touchstart', onPointerDown);
      dom.removeEventListener('touchmove', onPointerMove);
      window.removeEventListener('touchend', onPointerUp);
      renderer.dispose();
    };
  }, [errorState]);

  const updateCameraPosition = () => {
    if (!cameraRef.current) return;
    const { radius, theta, phi } = cameraSphericalRef.current;
    const target = cameraTargetRef.current;

    cameraRef.current.position.x = target.x + radius * Math.sin(phi) * Math.sin(theta);
    cameraRef.current.position.y = target.y + radius * Math.cos(phi);
    cameraRef.current.position.z = target.z + radius * Math.sin(phi) * Math.cos(theta);
    cameraRef.current.lookAt(target.x, target.y, target.z);
  };

  // Load the genuine Photogrammetry GLB model
  const loadPhotogrammetryAsset = (scene, camera) => {
    setLoading(true);
    setLoadingStage('Downloading 3D Digital Twin (.GLB)...');
    setLoadingProgress(10);

    let rawUrl = resolvedProject.modelUrl || (resolvedProject.model && resolvedProject.model.url);
    if (!rawUrl) {
      setLoading(false);
      setErrorState({
        code: 'NO_MODEL_URL',
        reason: 'No photogrammetry 3D model asset path was provided for this project.',
        suggestion: 'Please record and reconstruct a video first to produce an authentic 3D digital twin.',
      });
      return;
    }

    // Resolve URL to backend host if relative
    let fullUrl = rawUrl;
    if (rawUrl.startsWith('/')) {
      const backendHost = 'http://localhost:5001';
      fullUrl = `${backendHost}${rawUrl}`;
    }

    const loader = new GLTFLoader();

    loader.load(
      fullUrl,
      (gltf) => {
        setLoadingStage('Optimizing and framing reconstructed geometry...');
        setLoadingProgress(90);

        const model = gltf.scene;
        loadedModelRef.current = model;

        // Auto-center geometry based on real metric bounds
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        // Center model at origin
        model.position.x = -center.x;
        model.position.y = -box.min.y; // Sit on ground plane
        model.position.z = -center.z;

        // Ensure materials have two-sided rendering & shadows
        let totalVertices = 0;
        let totalTriangles = 0;
        const pointPositions = [];
        const pointColors = [];

        model.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            if (child.material) {
              child.material.side = THREE.DoubleSide;
            }
            if (child.geometry) {
              const posAttr = child.geometry.attributes.position;
              const colAttr = child.geometry.attributes.color;
              if (posAttr) {
                totalVertices += posAttr.count;
                for (let i = 0; i < posAttr.count; i++) {
                  pointPositions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
                  if (colAttr) {
                    pointColors.push(colAttr.getX(i), colAttr.getY(i), colAttr.getZ(i));
                  } else {
                    pointColors.push(0.8, 0.8, 0.8);
                  }
                }
              }
              if (child.geometry.index) {
                totalTriangles += child.geometry.index.count / 3;
              } else if (posAttr) {
                totalTriangles += posAttr.count / 3;
              }
            }
          }
        });

        // Build Point Cloud representation from actual model points
        if (pointPositions.length > 0) {
          const ptGeo = new THREE.BufferGeometry();
          ptGeo.setAttribute('position', new THREE.Float32BufferAttribute(pointPositions, 3));
          ptGeo.setAttribute('color', new THREE.Float32BufferAttribute(pointColors, 3));
          const ptMat = new THREE.PointsMaterial({
            size: isMobile ? 0.08 : 0.05,
            vertexColors: true,
            transparent: true,
            opacity: 0.95,
          });
          const ptMesh = new THREE.Points(ptGeo, ptMat);
          ptMesh.position.copy(model.position);
          ptMesh.visible = false;
          scene.add(ptMesh);
          pointCloudMeshRef.current = ptMesh;
        }

        scene.add(model);

        // Frame camera to real model scale
        const maxDim = Math.max(size.x, size.y, size.z, 1.0);
        const fov = camera.fov * (Math.PI / 180);
        const cameraDist = Math.abs(maxDim / Math.sin(fov / 2)) * 0.95;

        cameraSphericalRef.current.radius = Math.max(3.5, cameraDist);
        cameraTargetRef.current.set(0, size.y / 2, 0);
        updateCameraPosition();

        setModelStats({
          vertices: (resolvedProject.metadata?.vertices || totalVertices).toLocaleString(),
          triangles: (resolvedProject.metadata?.triangles || Math.round(totalTriangles)).toLocaleString(),
          points3D: (resolvedProject.metadata?.points3D || totalVertices).toLocaleString(),
          bounds: `${size.x.toFixed(2)}m × ${size.y.toFixed(2)}m × ${size.z.toFixed(2)}m`,
          format: 'Photogrammetric glTF 2.0 (.GLB)',
          cameraPoses: resolvedProject.metadata?.registeredFrames || resolvedProject.stats?.cameraPoses || 'Registered',
        });

        setLoading(false);
      },
      (xhr) => {
        if (xhr.total > 0) {
          const pct = Math.round((xhr.loaded / xhr.total) * 100);
          setLoadingProgress(pct);
        }
      },
      (error) => {
        console.error('[DigitalTwinViewer] Error loading GLB asset:', error);
        setLoading(false);
        setErrorState({
          code: 'MODEL_LOAD_FAILED',
          reason: `Could not load photogrammetric GLB model from ${fullUrl}.`,
          suggestion: 'Ensure the backend is online and the 3D reconstruction successfully completed.',
        });
      }
    );
  };

  // Switch between Solid Mesh, Point Cloud, and Wireframe
  const handleModeChange = (mode) => {
    setActiveTab(mode);
    if (!loadedModelRef.current) return;

    if (mode === 'model') {
      loadedModelRef.current.visible = true;
      setGroupWireframe(loadedModelRef.current, false);
      if (pointCloudMeshRef.current) pointCloudMeshRef.current.visible = false;
    } else if (mode === 'pointcloud') {
      loadedModelRef.current.visible = false;
      if (pointCloudMeshRef.current) pointCloudMeshRef.current.visible = true;
    } else if (mode === 'wireframe') {
      loadedModelRef.current.visible = true;
      setGroupWireframe(loadedModelRef.current, true);
      if (pointCloudMeshRef.current) pointCloudMeshRef.current.visible = false;
    }
  };

  const setGroupWireframe = (group, isWireframe) => {
    group.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material.wireframe = isWireframe;
      }
    });
  };

  const handleResetOrbit = () => {
    if (!loadedModelRef.current) return;
    const box = new THREE.Box3().setFromObject(loadedModelRef.current);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1.0);
    cameraSphericalRef.current = { radius: Math.max(3.5, maxDim * 2.2), theta: Math.PI / 4, phi: Math.PI / 3.2 };
    cameraTargetRef.current.set(0, size.y / 2, 0);
    updateCameraPosition();
  };

  const handleExportGLB = () => {
    if (!loadedModelRef.current) return;
    setExportingGLB(true);
    const exporter = new GLTFExporter();
    exporter.parse(
      loadedModelRef.current,
      (gltf) => {
        const blob = new Blob([gltf], { type: 'model/gltf-binary' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${resolvedProject.name || 'digital_twin'}.glb`;
        link.click();
        setExportingGLB(false);
        setExportNotice('✓ Photogrammetric 3D GLB successfully saved!');
        setTimeout(() => setExportNotice(null), 4000);
      },
      (error) => {
        console.error('Export error:', error);
        setExportingGLB(false);
      },
      { binary: true }
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* Top Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <TouchableOpacity style={styles.backBtn} onPress={onClose} accessibilityLabel="Back to camera">
              <Text style={styles.backBtnText}>‹ Back</Text>
            </TouchableOpacity>
            <View style={styles.headerTitleWrap}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {resolvedProject.name || 'Photogrammetric Digital Twin'}
              </Text>
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                {resolvedProject.locationName || '3D Reconstructed Environment'}
              </Text>
            </View>
          </View>
          <View style={styles.headerRight}>
            <TouchableOpacity
              style={[styles.arExportBtn, exportingGLB && styles.arExportBtnDisabled]}
              onPress={handleExportGLB}
              disabled={exportingGLB || loading || !!errorState}
            >
              <Text style={styles.arExportBtnText}>
                {exportingGLB ? '⏳ Saving...' : isMobile ? '📦 GLB' : '📦 Export GLB'}
              </Text>
            </TouchableOpacity>
            {onOpenMap && (
              <TouchableOpacity style={styles.mapNavBtn} onPress={onOpenMap}>
                <Text style={styles.mapNavBtnText}>{isMobile ? '🗺️ Map' : '🗺️ View on Map'}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.hudToggleBtn, showMetadata && styles.hudToggleBtnActive]}
              onPress={() => setShowMetadata(!showMetadata)}
            >
              <Text style={styles.hudToggleText}>{isMobile ? '📊 Info' : '📊 Metrics'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Viewport */}
        <View style={styles.viewport}>
          {Platform.OS === 'web' && (
            <div
              ref={containerRef}
              style={{
                width: '100%',
                height: '100%',
                cursor: 'grab',
                outline: 'none',
                touchAction: 'none',
              }}
            />
          )}

          {/* Loading Indicator */}
          {loading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color="#38bdf8" />
              <Text style={styles.loadingTitle}>{loadingStage}</Text>
              {loadingProgress > 0 && <Text style={styles.loadingProgressText}>{loadingProgress}%</Text>}
            </View>
          )}

          {/* Diagnostic Error Modal (Never show fake geometry on failure) */}
          {errorState && (
            <View style={styles.errorOverlay}>
              <View style={styles.errorCard}>
                <View style={styles.errorIconWrap}>
                  <Text style={styles.errorIcon}>⚠️</Text>
                </View>
                <Text style={styles.errorTitle}>Reconstruction Issue</Text>
                <Text style={styles.errorCodeBadge}>{errorState.code}</Text>
                <Text style={styles.errorReason}>{errorState.reason}</Text>
                <View style={styles.errorTipBox}>
                  <Text style={styles.errorTipTitle}>💡 Recommendation for Photogrammetry:</Text>
                  <Text style={styles.errorTipText}>{errorState.suggestion}</Text>
                </View>
                <View style={styles.errorActions}>
                  <TouchableOpacity style={styles.errorActionBtn} onPress={onClose}>
                    <Text style={styles.errorActionBtnText}>Record New Video</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}

          {/* Toast Notification */}
          {exportNotice && (
            <View style={styles.toastContainer}>
              <Text style={styles.toastText}>{exportNotice}</Text>
            </View>
          )}

          {/* Mode Switcher Tabs */}
          {!loading && !errorState && (
            <View style={styles.modePillContainer}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modeScrollContent}>
                <TouchableOpacity
                  style={[styles.modePill, activeTab === 'model' && styles.modePillActive]}
                  onPress={() => handleModeChange('model')}
                >
                  <Text style={[styles.modePillText, activeTab === 'model' && styles.modePillTextActive]}>
                    🏛️ 3D Photogrammetry Mesh
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modePill, activeTab === 'pointcloud' && styles.modePillActive]}
                  onPress={() => handleModeChange('pointcloud')}
                >
                  <Text style={[styles.modePillText, activeTab === 'pointcloud' && styles.modePillTextActive]}>
                    ✨ Dense Point Cloud
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modePill, activeTab === 'wireframe' && styles.modePillActive]}
                  onPress={() => handleModeChange('wireframe')}
                >
                  <Text style={[styles.modePillText, activeTab === 'wireframe' && styles.modePillTextActive]}>
                    📐 Wireframe Geometry
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          )}

          {/* Orbit Reset Control */}
          {!loading && !errorState && (
            <View style={styles.orbitControlsDeck}>
              <TouchableOpacity style={styles.orbitBtn} onPress={handleResetOrbit}>
                <Text style={styles.orbitBtnText}>🔄 Center Model</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Metadata Card */}
          {showMetadata && !loading && !errorState && (
            <View style={styles.hudCard}>
              <Text style={styles.hudTitle}>Photogrammetric Metrics</Text>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Reconstructed Points:</Text>
                <Text style={styles.statVal}>{modelStats?.points3D || '—'}</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Mesh Triangles:</Text>
                <Text style={styles.statVal}>{modelStats?.triangles || '—'}</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Registered Cameras:</Text>
                <Text style={styles.statVal}>{modelStats?.cameraPoses || '—'}</Text>
              </View>
              <View style={styles.statRow}>
                <Text style={styles.statLabel}>Physical Bounds:</Text>
                <Text style={styles.statVal}>{modelStats?.bounds || '—'}</Text>
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
  safeArea: {
    flex: 1,
    backgroundColor: '#070b14',
  },
  container: {
    flex: 1,
    backgroundColor: '#070b14',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  backBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#1e293b',
    borderRadius: 8,
    marginRight: 12,
  },
  backBtnText: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '600',
  },
  headerTitleWrap: {
    flex: 1,
  },
  headerTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '700',
  },
  headerSubtitle: {
    color: '#94a3b8',
    fontSize: 12,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  arExportBtn: {
    backgroundColor: '#10b981',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  arExportBtnDisabled: {
    opacity: 0.6,
  },
  arExportBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  mapNavBtn: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  mapNavBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  hudToggleBtn: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  hudToggleBtnActive: {
    backgroundColor: '#334155',
  },
  hudToggleText: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
  },
  viewport: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#070b14',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(7, 11, 20, 0.88)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  loadingTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
  },
  loadingProgressText: {
    color: '#38bdf8',
    fontSize: 14,
    marginTop: 8,
    fontWeight: '700',
  },
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(7, 11, 20, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    zIndex: 25,
  },
  errorCard: {
    backgroundColor: '#0f172a',
    borderRadius: 16,
    padding: 24,
    maxWidth: 500,
    width: '100%',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  errorIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  errorIcon: {
    fontSize: 26,
  },
  errorTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  errorCodeBadge: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    color: '#f87171',
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    marginBottom: 12,
  },
  errorReason: {
    color: '#cbd5e1',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  errorTipBox: {
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    padding: 14,
    borderRadius: 10,
    width: '100%',
    marginBottom: 20,
  },
  errorTipTitle: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  errorTipText: {
    color: '#94a3b8',
    fontSize: 12,
    lineHeight: 18,
  },
  errorActions: {
    width: '100%',
  },
  errorActionBtn: {
    backgroundColor: '#0284c7',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  errorActionBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  toastContainer: {
    position: 'absolute',
    top: 20,
    alignSelf: 'center',
    backgroundColor: '#10b981',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    zIndex: 30,
  },
  toastText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 13,
  },
  modePillContainer: {
    position: 'absolute',
    top: 16,
    left: 16,
    zIndex: 10,
  },
  modeScrollContent: {
    gap: 8,
  },
  modePill: {
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modePillActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  modePillText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  modePillTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  orbitControlsDeck: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    zIndex: 10,
  },
  orbitBtn: {
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  orbitBtnText: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
  },
  hudCard: {
    position: 'absolute',
    top: 16,
    right: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.90)',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    width: 250,
    zIndex: 10,
  },
  hudTitle: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 10,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  statLabel: {
    color: '#94a3b8',
    fontSize: 11,
  },
  statVal: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '600',
  },
  statValHighlight: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
  },
});

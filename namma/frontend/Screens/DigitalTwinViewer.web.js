import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  Platform,
  ScrollView,
  TextInput,
  useWindowDimensions,
  ActivityIndicator,
} from 'react-native';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { getBackendBaseUrl, projectsApi, poisApi } from '../src/api/client';

export default function DigitalTwinViewer({ onClose, onOpenMap, projectData }) {
  const containerRef = useRef(null);
  const miniMapCanvasRef = useRef(null);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isMobile = windowWidth < 768;

  const [activeTab, setActiveTab] = useState('model'); // 'model' | 'pointcloud' | 'wireframe'
  const [viewMode, setViewMode] = useState('orbit'); // 'orbit' | 'walk'
  const [showMetadata, setShowMetadata] = useState(false);
  const [showPOIPanel, setShowPOIPanel] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingStage, setLoadingStage] = useState('Initializing 3D Viewer...');
  const [errorState, setErrorState] = useState(null);
  const [exportingGLB, setExportingGLB] = useState(false);
  const [notice, setNotice] = useState(null);
  const [modelStats, setModelStats] = useState(null);

  // Navigation & POI states
  const [navGrid, setNavGrid] = useState(null);
  const [pois, setPois] = useState([]);
  const [poiSearchQuery, setPoiSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [activeRoute, setActiveRoute] = useState(null);
  const [isAddingPOI, setIsAddingPOI] = useState(false);
  const [newPOICoords, setNewPOICoords] = useState(null);
  const [newPOIName, setNewPOIName] = useState('');
  const [newPOICategory, setNewPOICategory] = useState('landmark');
  const [newPOIDesc, setNewPOIDesc] = useState('');

  // Calibration states
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibPoints, setCalibPoints] = useState([]);
  const [realDistanceInput, setRealDistanceInput] = useState('2.0');

  // Scene references
  const sceneRef = useRef(null);
  const rendererRef = useRef(null);
  const cameraRef = useRef(null);
  const animationFrameRef = useRef(null);
  const loadedModelRef = useRef(null);
  const pointCloudMeshRef = useRef(null);
  const poiMarkersGroupRef = useRef(null);
  const routeLineRef = useRef(null);
  const routeParticleRef = useRef(null);

  // Orbit controls state
  const isDraggingRef = useRef(false);
  const previousPointerPositionRef = useRef({ x: 0, y: 0 });
  const cameraSphericalRef = useRef({ radius: 8, theta: Math.PI / 4, phi: Math.PI / 3.2 });
  const cameraTargetRef = useRef(new THREE.Vector3(0, 0, 0));

  // Walkthrough controls state
  const walkKeysRef = useRef({ w: false, a: false, s: false, d: false });
  const walkYawRef = useRef(0);
  const walkPitchRef = useRef(0);
  const walkPosRef = useRef(new THREE.Vector3(0, 1.6, 2));

  const [resolvedProjectState, setResolvedProjectState] = useState(projectData || null);
  const resolvedProject = resolvedProjectState || projectData || {};
  const projectId = resolvedProject._id || resolvedProject.id || 'demo';

  const showToast = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3500);
  };

  const handleLoadDemo = async () => {
    try {
      setLoading(true);
      setErrorState(null);
      setLoadingStage('Loading offline pre-baked demo digital twin...');
      const baseUrl = getBackendBaseUrl();
      const res = await fetch(`${baseUrl}/api/demo`);
      const json = await res.json();
      if (json.success && json.data) {
        setResolvedProjectState(json.data);
      }
    } catch (e) {
      console.warn('Fallback to local demo asset:', e);
      setResolvedProjectState({
        _id: 'sample_digital_twin',
        name: 'Namma Space Innovation Quad (Offline Demo)',
        modelUrl: '/storage/projects/sample_digital_twin/final/scene.glb',
        isDemo: true,
      });
    }
  };

  // Fetch NavGrid and POIs
  useEffect(() => {
    const fetchSpatialData = async () => {
      const pid = resolvedProject._id || resolvedProject.id;
      if (!pid) return;

      try {
        const navRes = await projectsApi.getNavGrid(pid);
        if (navRes.ok && navRes.data) {
          setNavGrid(navRes.data);
        }
      } catch (e) {
        console.warn('Could not load navgrid:', e);
      }

      try {
        const poiRes = await poisApi.getPOIs(pid);
        if (poiRes.ok && Array.isArray(poiRes.data)) {
          setPois(poiRes.data);
        }
      } catch (e) {
        console.warn('Could not load POIs:', e);
      }
    };

    fetchSpatialData();
  }, [resolvedProject._id, resolvedProject.id]);

  // Main Three.js Scene Setup & Render Loop
  useEffect(() => {
    if (Platform.OS !== 'web' || !containerRef.current) return;
    if (errorState) return;

    const container = containerRef.current;
    const width = container.clientWidth || windowWidth || 800;
    const height = container.clientHeight || windowHeight || 500;

    // 1. Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b14);
    scene.fog = new THREE.FogExp2(0x070b14, 0.02);
    sceneRef.current = scene;

    // 2. Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 1000);
    cameraRef.current = camera;
    updateCamera();

    // 3. Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 4. Lights
    const ambientLight = new THREE.HemisphereLight(0xffffff, 0x1e293b, 1.3);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfff5e6, 1.5);
    sunLight.position.set(15, 25, 15);
    sunLight.castShadow = true;
    scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0x38bdf8, 0.5);
    fillLight.position.set(-15, 12, -15);
    scene.add(fillLight);

    // Floor grid plane
    const gridHelper = new THREE.GridHelper(30, 30, 0x0ea5e9, 0x1e293b);
    gridHelper.position.y = 0.0;
    scene.add(gridHelper);

    // Group for POI markers
    const poiGroup = new THREE.Group();
    scene.add(poiGroup);
    poiMarkersGroupRef.current = poiGroup;

    // Load Model
    loadPhotogrammetryAsset(scene, camera);

    // Keyboard handlers for Walkthrough (WASD)
    const onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd'].includes(k)) {
        walkKeysRef.current[k] = true;
      }
    };
    const onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd'].includes(k)) {
        walkKeysRef.current[k] = false;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // Pointer event handlers
    const dom = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const mouseVector = new THREE.Vector2();

    const onPointerDown = (e) => {
      isDraggingRef.current = true;
      const clientX = e.clientX ?? 0;
      const clientY = e.clientY ?? 0;
      previousPointerPositionRef.current = { x: clientX, y: clientY };

      // Handle Raycasting for Adding POI or Calibration
      if ((isAddingPOI || isCalibrating) && loadedModelRef.current) {
        const rect = dom.getBoundingClientRect();
        mouseVector.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        mouseVector.y = -((clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouseVector, camera);
        const intersects = raycaster.intersectObject(loadedModelRef.current, true);

        if (intersects.length > 0) {
          const pt = intersects[0].point;
          if (isAddingPOI) {
            setNewPOICoords({ x: Number(pt.x.toFixed(2)), y: Number(pt.y.toFixed(2)), z: Number(pt.z.toFixed(2)) });
          } else if (isCalibrating) {
            setCalibPoints((prev) => {
              if (prev.length >= 2) return [pt];
              return [...prev, pt];
            });
          }
        }
      }
    };

    const onPointerMove = (e) => {
      if (!isDraggingRef.current) return;
      const clientX = e.clientX ?? 0;
      const clientY = e.clientY ?? 0;
      const deltaX = clientX - previousPointerPositionRef.current.x;
      const deltaY = clientY - previousPointerPositionRef.current.y;

      if (viewMode === 'orbit') {
        const sensitivity = 0.007;
        cameraSphericalRef.current.theta -= deltaX * sensitivity;
        cameraSphericalRef.current.phi = Math.max(0.08, Math.min(Math.PI / 2 - 0.02, cameraSphericalRef.current.phi - deltaY * sensitivity));
      } else {
        // Walkthrough mouselook
        const sensitivity = 0.005;
        walkYawRef.current -= deltaX * sensitivity;
        walkPitchRef.current = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, walkPitchRef.current - deltaY * sensitivity));
      }

      previousPointerPositionRef.current = { x: clientX, y: clientY };
    };

    const onPointerUp = () => {
      isDraggingRef.current = false;
    };

    const onWheel = (e) => {
      e.preventDefault();
      if (viewMode === 'orbit') {
        cameraSphericalRef.current.radius = Math.max(1.5, Math.min(80, cameraSphericalRef.current.radius + e.deltaY * 0.02));
      }
    };

    dom.addEventListener('mousedown', onPointerDown);
    dom.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    dom.addEventListener('wheel', onWheel, { passive: false });

    // Animation Loop
    let lastTime = performance.now();
    let routeAnimT = 0;

    const animate = (time) => {
      animationFrameRef.current = requestAnimationFrame(animate);
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      // Update Walkthrough physics & collision
      if (viewMode === 'walk') {
        updateWalkPosition(dt);
      } else {
        updateCamera();
      }

      // Animate Route Particle
      if (routeParticleRef.current && activeRoute && activeRoute.path.length >= 2) {
        routeAnimT = (routeAnimT + dt * 0.4) % 1.0;
        const totalWaypoints = activeRoute.path.length - 1;
        const currentProgress = routeAnimT * totalWaypoints;
        const idx = Math.floor(currentProgress);
        const subT = currentProgress - idx;
        const p1 = activeRoute.path[idx];
        const p2 = activeRoute.path[Math.min(idx + 1, totalWaypoints)];
        if (p1 && p2) {
          routeParticleRef.current.position.set(
            p1.x + (p2.x - p1.x) * subT,
            (p1.y || 0) + 0.1,
            p1.z + (p2.z - p1.z) * subT
          );
        }
      }

      // Render 3D Scene
      renderer.render(scene, camera);

      // Render 2D Mini-Map
      renderMiniMap();
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      dom.removeEventListener('mousedown', onPointerDown);
      dom.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
      dom.removeEventListener('wheel', onWheel);

      // Deep GPU memory disposal on unmount to prevent leaks
      scene.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((mat) => {
              if (mat.map) mat.map.dispose();
              mat.dispose();
            });
          } else {
            if (child.material.map) child.material.map.dispose();
            child.material.dispose();
          }
        }
      });

      renderer.dispose();
    };
  }, [errorState, resolvedProject.modelUrl, viewMode, isAddingPOI, isCalibrating, activeRoute]);

  // Update Orbit Camera
  const updateCamera = () => {
    if (!cameraRef.current || viewMode !== 'orbit') return;
    const { radius, theta, phi } = cameraSphericalRef.current;
    const target = cameraTargetRef.current;

    cameraRef.current.position.x = target.x + radius * Math.sin(phi) * Math.sin(theta);
    cameraRef.current.position.y = target.y + radius * Math.cos(phi);
    cameraRef.current.position.z = target.z + radius * Math.sin(phi) * Math.cos(theta);
    cameraRef.current.lookAt(target.x, target.y, target.z);
  };

  // Walkthrough position update with NavGrid collision checks
  const updateWalkPosition = (dt) => {
    if (!cameraRef.current) return;
    const speed = 2.5; // m/s
    const moveDist = speed * dt;

    const yaw = walkYawRef.current;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    let dx = 0;
    let dz = 0;

    if (walkKeysRef.current.w) {
      dx += fwd.x * moveDist;
      dz += fwd.z * moveDist;
    }
    if (walkKeysRef.current.s) {
      dx -= fwd.x * moveDist;
      dz -= fwd.z * moveDist;
    }
    if (walkKeysRef.current.d) {
      dx += right.x * moveDist;
      dz += right.z * moveDist;
    }
    if (walkKeysRef.current.a) {
      dx -= right.x * moveDist;
      dz -= right.z * moveDist;
    }

    // Collision check against navGrid
    const newX = walkPosRef.current.x + dx;
    const newZ = walkPosRef.current.z + dz;

    let canMoveX = true;
    let canMoveZ = true;

    if (navGrid && navGrid.origin && navGrid.resolution) {
      const colX = Math.floor((newX - navGrid.origin[0]) / navGrid.resolution);
      const rowZ = Math.floor((newZ - navGrid.origin[1]) / navGrid.resolution);
      const curCol = Math.floor((walkPosRef.current.x - navGrid.origin[0]) / navGrid.resolution);
      const curRow = Math.floor((walkPosRef.current.z - navGrid.origin[1]) / navGrid.resolution);

      if (navGrid.grid) {
        if (navGrid.grid[curRow] && navGrid.grid[curRow][colX] !== 0) canMoveX = false;
        if (navGrid.grid[rowZ] && navGrid.grid[rowZ][curCol] !== 0) canMoveZ = false;
      }
    }

    if (canMoveX) walkPosRef.current.x = newX;
    if (canMoveZ) walkPosRef.current.z = newZ;

    // Apply eye height above floor (1.6m)
    walkPosRef.current.y = 1.6;

    cameraRef.current.position.copy(walkPosRef.current);
    const lookTarget = new THREE.Vector3()
      .copy(walkPosRef.current)
      .add(new THREE.Vector3(
        -Math.sin(walkYawRef.current) * Math.cos(walkPitchRef.current),
        Math.sin(walkPitchRef.current),
        -Math.cos(walkYawRef.current) * Math.cos(walkPitchRef.current)
      ));
    cameraRef.current.lookAt(lookTarget);
  };

  // Re-render 2D Mini-Map
  const renderMiniMap = () => {
    const canvas = miniMapCanvasRef.current;
    if (!canvas || !navGrid || !navGrid.bounds) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const b = navGrid.bounds;
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanZ = Math.max(1, b.maxZ - b.minZ);

    const toMapX = (x) => ((x - b.minX) / spanX) * (w - 20) + 10;
    const toMapY = (z) => ((z - b.minZ) / spanZ) * (h - 20) + 10;

    // Draw grid background
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, w, h);

    // Draw Wall Segments
    if (Array.isArray(navGrid.wallSegments)) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const seg of navGrid.wallSegments) {
        ctx.moveTo(toMapX(seg.start[0]), toMapY(seg.start[1]));
        ctx.lineTo(toMapX(seg.end[0]), toMapY(seg.end[1]));
      }
      ctx.stroke();
    }

    // Draw Active Navigation Route
    if (activeRoute && Array.isArray(activeRoute.path)) {
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < activeRoute.path.length; i++) {
        const pt = activeRoute.path[i];
        const mx = toMapX(pt.x);
        const my = toMapY(pt.z);
        if (i === 0) ctx.moveTo(mx, my);
        else ctx.lineTo(mx, my);
      }
      ctx.stroke();
    }

    // Draw POIs
    for (const poi of pois) {
      const px = toMapX(poi.position.x);
      const py = toMapY(poi.position.z);
      ctx.fillStyle = poi.color || '#ec4899';
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw Camera Position & Heading Cone
    const camPos = viewMode === 'walk' ? walkPosRef.current : cameraRef.current?.position || new THREE.Vector3();
    const cx = toMapX(camPos.x);
    const cy = toMapY(camPos.z);

    const heading = viewMode === 'walk' ? walkYawRef.current : cameraSphericalRef.current.theta + Math.PI;

    ctx.fillStyle = 'rgba(56, 189, 248, 0.4)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, 14, heading - 0.4, heading + 0.4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  };

  // Re-build 3D POI billboard markers in Three.js
  useEffect(() => {
    const group = poiMarkersGroupRef.current;
    if (!group) return;

    // Clear old markers
    while (group.children.length > 0) {
      group.remove(group.children[0]);
    }

    for (const poi of pois) {
      const marker = new THREE.Group();
      marker.position.set(poi.position.x, poi.position.y || 0.4, poi.position.z);

      // Sphere beacon
      const color = poi.color || '#3b82f6';
      const sphereGeo = new THREE.SphereGeometry(0.12, 16, 16);
      const sphereMat = new THREE.MeshBasicMaterial({ color });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      marker.add(sphere);

      // Floor connection line
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, -(poi.position.y || 0.4), 0),
      ]);
      const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
      const stem = new THREE.Line(lineGeo, lineMat);
      marker.add(stem);

      group.add(marker);
    }
  }, [pois]);

  // Load Photogrammetry Asset
  const loadPhotogrammetryAsset = (scene, camera) => {
    setLoading(true);
    setLoadingStage('Downloading 3D Digital Twin (.GLB)...');
    setLoadingProgress(15);

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

    const backendHost = getBackendBaseUrl();
    const fullUrl = rawUrl.startsWith('/') ? `${backendHost}${rawUrl}` : rawUrl;

    const loader = new GLTFLoader();
    loader.load(
      fullUrl,
      (gltf) => {
        setLoadingStage('Optimizing geometry...');
        setLoadingProgress(90);

        const model = gltf.scene;
        loadedModelRef.current = model;

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        model.position.x = -center.x;
        model.position.y = -box.min.y;
        model.position.z = -center.z;

        let totalVertices = 0;
        let totalTriangles = 0;
        const pointPositions = [];
        const pointColors = [];

        model.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            if (child.material) child.material.side = THREE.DoubleSide;
            if (child.geometry) {
              const posAttr = child.geometry.attributes.position;
              const colAttr = child.geometry.attributes.color;
              if (posAttr) {
                totalVertices += posAttr.count;
                for (let i = 0; i < posAttr.count; i++) {
                  pointPositions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
                  if (colAttr) pointColors.push(colAttr.getX(i), colAttr.getY(i), colAttr.getZ(i));
                  else pointColors.push(0.8, 0.8, 0.8);
                }
              }
              if (child.geometry.index) totalTriangles += child.geometry.index.count / 3;
              else if (posAttr) totalTriangles += posAttr.count / 3;
            }
          }
        });

        if (pointPositions.length > 0) {
          const ptGeo = new THREE.BufferGeometry();
          ptGeo.setAttribute('position', new THREE.Float32BufferAttribute(pointPositions, 3));
          ptGeo.setAttribute('color', new THREE.Float32BufferAttribute(pointColors, 3));
          const ptMat = new THREE.PointsMaterial({ size: 0.05, vertexColors: true, transparent: true, opacity: 0.95 });
          const ptMesh = new THREE.Points(ptGeo, ptMat);
          ptMesh.position.copy(model.position);
          ptMesh.visible = false;
          scene.add(ptMesh);
          pointCloudMeshRef.current = ptMesh;
        }

        scene.add(model);

        const maxDim = Math.max(size.x, size.y, size.z, 1.0);
        cameraSphericalRef.current.radius = Math.max(3.5, maxDim * 2.0);
        cameraTargetRef.current.set(0, size.y / 2, 0);
        updateCamera();

        setModelStats({
          vertices: (resolvedProject.metadata?.vertices || totalVertices).toLocaleString(),
          triangles: (resolvedProject.metadata?.triangles || Math.round(totalTriangles)).toLocaleString(),
          bounds: `${size.x.toFixed(2)}m × ${size.y.toFixed(2)}m × ${size.z.toFixed(2)}m`,
          cameraPoses: resolvedProject.metadata?.registeredFrames || 'Registered',
        });

        setLoading(false);
      },
      (xhr) => {
        if (xhr.total > 0) setLoadingProgress(Math.round((xhr.loaded / xhr.total) * 100));
      },
      (err) => {
        console.error('GLB Load Error:', err);
        setLoading(false);
        setErrorState({
          code: 'MODEL_LOAD_FAILED',
          reason: `Could not load 3D digital twin asset.`,
          suggestion: 'Check server connection or try the offline demo scene.',
        });
      }
    );
  };

  // Fly-to POI Camera Animation
  const handleFlyToPOI = (poi) => {
    if (!cameraRef.current) return;
    const targetPos = new THREE.Vector3(poi.position.x, (poi.position.y || 0) + 0.8, poi.position.z + 1.8);
    cameraTargetRef.current.set(poi.position.x, poi.position.y || 0.4, poi.position.z);
    walkPosRef.current.set(poi.position.x, 1.6, poi.position.z + 1.2);

    let start = performance.now();
    const startPos = cameraRef.current.position.clone();

    const animateFly = (now) => {
      const progress = Math.min((now - start) / 1000, 1.0);
      const ease = 0.5 - Math.cos(progress * Math.PI) / 2;
      cameraRef.current.position.lerpVectors(startPos, targetPos, ease);
      cameraRef.current.lookAt(cameraTargetRef.current);
      if (progress < 1.0) requestAnimationFrame(animateFly);
    };
    requestAnimationFrame(animateFly);
    showToast(`Navigated to: ${poi.name}`);
  };

  // Route calculation and 3D glowing path visualization
  const handleNavigateToPOI = async (poi) => {
    const curPos = viewMode === 'walk' ? walkPosRef.current : cameraRef.current.position;
    const fromCoord = { x: Number(curPos.x.toFixed(2)), y: 0.0, z: Number(curPos.z.toFixed(2)) };
    const toCoord = poi.navPoint || poi.position;

    try {
      const res = await projectsApi.getPath(projectId, fromCoord, toCoord);
      if (res.ok && res.data && res.data.found) {
        setActiveRoute({
          ...res.data,
          destinationPoi: poi,
        });

        // Add 3D line to scene
        if (routeLineRef.current) sceneRef.current.remove(routeLineRef.current);
        if (routeParticleRef.current) sceneRef.current.remove(routeParticleRef.current);

        const pts3D = res.data.path.map((p) => new THREE.Vector3(p.x, (p.y || 0) + 0.05, p.z));
        const lineGeo = new THREE.BufferGeometry().setFromPoints(pts3D);
        const lineMat = new THREE.LineBasicMaterial({ color: 0x10b981, linewidth: 3 });
        const line = new THREE.Line(lineGeo, lineMat);
        sceneRef.current.add(line);
        routeLineRef.current = line;

        // Animated guidance sphere
        const partGeo = new THREE.SphereGeometry(0.1, 16, 16);
        const partMat = new THREE.MeshBasicMaterial({ color: 0x34d399 });
        const part = new THREE.Mesh(partGeo, partMat);
        sceneRef.current.add(part);
        routeParticleRef.current = part;

        showToast(`Route to ${poi.name}: ${res.data.distanceMeters}m (${res.data.walkingEtaFormatted} walk)`);
      } else {
        showToast('No walkable path could be calculated to this point.');
      }
    } catch (e) {
      console.warn('Path error:', e);
    }
  };

  const handleClearRoute = () => {
    setActiveRoute(null);
    if (routeLineRef.current) {
      sceneRef.current.remove(routeLineRef.current);
      routeLineRef.current = null;
    }
    if (routeParticleRef.current) {
      sceneRef.current.remove(routeParticleRef.current);
      routeParticleRef.current = null;
    }
  };

  // Submit New POI
  const handleSavePOI = async () => {
    if (!newPOIName.trim() || !newPOICoords) return;
    try {
      const res = await poisApi.createPOI(projectId, {
        name: newPOIName.trim(),
        category: newPOICategory,
        description: newPOIDesc.trim(),
        position: newPOICoords,
      });
      if (res.ok && res.data) {
        setPois((prev) => [...prev, res.data]);
        setIsAddingPOI(false);
        setNewPOICoords(null);
        setNewPOIName('');
        setNewPOIDesc('');
        showToast(`✓ POI "${res.data.name}" added successfully!`);
      } else {
        showToast(res.error || 'Failed to save POI');
      }
    } catch (e) {
      showToast('Error saving POI');
    }
  };

  // Calibration submit
  const handleSaveCalibration = async () => {
    if (calibPoints.length < 2) return;
    const realMeters = Number(realDistanceInput);
    if (isNaN(realMeters) || realMeters <= 0) return;

    try {
      const [p1, p2] = calibPoints;
      const res = await projectsApi.calibrate(projectId, [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z], realMeters);
      if (res.ok && res.data) {
        setIsCalibrating(false);
        setCalibPoints([]);
        showToast(`✓ Metric scale calibrated: 1 unit = ${res.data.metersPerUnit}m`);
      }
    } catch (e) {
      showToast('Calibration failed');
    }
  };

  const filteredPOIs = pois.filter((p) => {
    const matchesCat = selectedCategory === 'all' || p.category === selectedCategory;
    const matchesSearch =
      !poiSearchQuery.trim() ||
      p.name.toLowerCase().includes(poiSearchQuery.toLowerCase()) ||
      (p.tags && p.tags.some((t) => t.toLowerCase().includes(poiSearchQuery.toLowerCase())));
    return matchesCat && matchesSearch;
  });

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* Top Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <TouchableOpacity style={styles.backBtn} onPress={onClose}>
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
            <TouchableOpacity style={styles.demoHeaderBtn} onPress={handleLoadDemo}>
              <Text style={styles.demoHeaderBtnText}>🎮 Demo</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.arExportBtn, viewMode === 'walk' && styles.arExportBtnActive]}
              onPress={() => setViewMode(viewMode === 'orbit' ? 'walk' : 'orbit')}
            >
              <Text style={styles.arExportBtnText}>
                {viewMode === 'orbit' ? '🚶 Walkthrough' : '🛸 Orbit'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.hudToggleBtn, showPOIPanel && styles.hudToggleBtnActive]}
              onPress={() => setShowPOIPanel(!showPOIPanel)}
            >
              <Text style={styles.hudToggleText}>📍 POIs ({pois.length})</Text>
            </TouchableOpacity>
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
          <div ref={containerRef} style={{ width: '100%', height: '100%', cursor: 'grab', outline: 'none' }} />

          {/* Active Navigation Banner */}
          {activeRoute && (
            <View style={styles.activeRouteBanner}>
              <Text style={styles.activeRouteText}>
                🚶 Route to {activeRoute.destinationPoi?.name} • {activeRoute.distanceMeters}m ({activeRoute.walkingEtaFormatted})
              </Text>
              <TouchableOpacity onPress={handleClearRoute} style={styles.clearRouteBtn}>
                <Text style={styles.clearRouteBtnText}>✕ Clear</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Mini-Map 2D Overlay */}
          {navGrid && (
            <View style={styles.miniMapWrapper}>
              <canvas ref={miniMapCanvasRef} width={160} height={160} style={{ borderRadius: 8, border: '1px solid #334155' }} />
              <Text style={styles.miniMapLabel}>2D NAVIGATION RADAR</Text>
            </View>
          )}

          {/* Mode Tabs */}
          {!loading && !errorState && (
            <View style={styles.modePillContainer}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.modeScrollContent}>
                <TouchableOpacity
                  style={[styles.modePill, activeTab === 'model' && styles.modePillActive]}
                  onPress={() => {
                    setActiveTab('model');
                    if (loadedModelRef.current) loadedModelRef.current.visible = true;
                    if (pointCloudMeshRef.current) pointCloudMeshRef.current.visible = false;
                  }}
                >
                  <Text style={[styles.modePillText, activeTab === 'model' && styles.modePillTextActive]}>🏛️ Mesh</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modePill, activeTab === 'pointcloud' && styles.modePillActive]}
                  onPress={() => {
                    setActiveTab('pointcloud');
                    if (loadedModelRef.current) loadedModelRef.current.visible = false;
                    if (pointCloudMeshRef.current) pointCloudMeshRef.current.visible = true;
                  }}
                >
                  <Text style={[styles.modePillText, activeTab === 'pointcloud' && styles.modePillTextActive]}>✨ Point Cloud</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modePill, isAddingPOI && styles.modePillActive]}
                  onPress={() => {
                    setIsAddingPOI(!isAddingPOI);
                    setIsCalibrating(false);
                    if (!isAddingPOI) showToast('Click anywhere on the 3D surface to place a POI');
                  }}
                >
                  <Text style={[styles.modePillText, isAddingPOI && styles.modePillTextActive]}>➕ Add POI</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modePill, isCalibrating && styles.modePillActive]}
                  onPress={() => {
                    setIsCalibrating(!isCalibrating);
                    setIsAddingPOI(false);
                    setCalibPoints([]);
                    if (!isCalibrating) showToast('Click 2 points on the model to calibrate scale');
                  }}
                >
                  <Text style={[styles.modePillText, isCalibrating && styles.modePillTextActive]}>📐 Calibrate</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          )}

          {/* Add POI Modal */}
          {newPOICoords && (
            <View style={styles.dialogCard}>
              <Text style={styles.dialogTitle}>📍 Add Point of Interest</Text>
              <Text style={styles.dialogSubtitle}>Position: ({newPOICoords.x}, {newPOICoords.y}, {newPOICoords.z})</Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="POI Name (e.g. Conference Room A)"
                placeholderTextColor="#64748b"
                value={newPOIName}
                onChangeText={setNewPOIName}
              />
              <TextInput
                style={styles.dialogInput}
                placeholder="Category (room, equipment, emergency, entrance)"
                placeholderTextColor="#64748b"
                value={newPOICategory}
                onChangeText={setNewPOICategory}
              />
              <TextInput
                style={styles.dialogInput}
                placeholder="Description"
                placeholderTextColor="#64748b"
                value={newPOIDesc}
                onChangeText={setNewPOIDesc}
              />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <TouchableOpacity style={styles.dialogPrimaryBtn} onPress={handleSavePOI}>
                  <Text style={styles.dialogPrimaryBtnText}>Save POI</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.dialogSecondaryBtn} onPress={() => setNewPOICoords(null)}>
                  <Text style={styles.dialogSecondaryBtnText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Calibration Modal */}
          {isCalibrating && calibPoints.length === 2 && (
            <View style={styles.dialogCard}>
              <Text style={styles.dialogTitle}>📐 Metric Scale Calibration</Text>
              <Text style={styles.dialogSubtitle}>
                Model distance: {calibPoints[0].distanceTo(calibPoints[1]).toFixed(3)} units
              </Text>
              <TextInput
                style={styles.dialogInput}
                placeholder="Real distance in meters (e.g. 2.0)"
                placeholderTextColor="#64748b"
                value={realDistanceInput}
                onChangeText={setRealDistanceInput}
                keyboardType="numeric"
              />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <TouchableOpacity style={styles.dialogPrimaryBtn} onPress={handleSaveCalibration}>
                  <Text style={styles.dialogPrimaryBtnText}>Apply Metric Scale</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.dialogSecondaryBtn} onPress={() => setIsCalibrating(false)}>
                  <Text style={styles.dialogSecondaryBtnText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* POI Panel Drawer */}
          {showPOIPanel && (
            <View style={styles.poiDrawer}>
              <View style={styles.poiDrawerHeader}>
                <Text style={styles.poiDrawerTitle}>📍 Points of Interest</Text>
                <TouchableOpacity onPress={() => setShowPOIPanel(false)}>
                  <Text style={{ color: '#94a3b8', fontSize: 16 }}>✕</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.poiSearchInput}
                placeholder="Search POIs..."
                placeholderTextColor="#64748b"
                value={poiSearchQuery}
                onChangeText={setPoiSearchQuery}
              />
              <ScrollView style={{ flex: 1 }}>
                {filteredPOIs.map((poi) => (
                  <View key={poi._id || poi.name} style={styles.poiCard}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={styles.poiName}>{poi.name}</Text>
                      <Text style={[styles.poiCategoryBadge, { backgroundColor: poi.color || '#3b82f6' }]}>
                        {poi.category}
                      </Text>
                    </View>
                    {poi.description ? <Text style={styles.poiDesc}>{poi.description}</Text> : null}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                      <TouchableOpacity style={styles.poiActionBtn} onPress={() => handleFlyToPOI(poi)}>
                        <Text style={styles.poiActionBtnText}>👁️ Fly To</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.poiActionBtn, { backgroundColor: '#10b981' }]} onPress={() => handleNavigateToPOI(poi)}>
                        <Text style={styles.poiActionBtnText}>🚶 Route Here</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Toast Notification */}
          {notice && (
            <View style={styles.toastContainer}>
              <Text style={styles.toastText}>{notice}</Text>
            </View>
          )}

          {/* Loading Indicator */}
          {loading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color="#38bdf8" />
              <Text style={styles.loadingTitle}>{loadingStage}</Text>
              {loadingProgress > 0 && <Text style={styles.loadingProgressText}>{loadingProgress}%</Text>}
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
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  backBtn: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#1e293b' },
  backBtnText: { color: '#f8fafc', fontWeight: '700' },
  headerTitleWrap: { maxWidth: 260 },
  headerTitle: { color: '#f8fafc', fontSize: 14, fontWeight: '700' },
  headerSubtitle: { color: '#94a3b8', fontSize: 11 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  demoHeaderBtn: { backgroundColor: 'rgba(16, 185, 129, 0.15)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#10b981' },
  demoHeaderBtnText: { color: '#34d399', fontSize: 12, fontWeight: '700' },
  arExportBtn: { backgroundColor: '#0284c7', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  arExportBtnActive: { backgroundColor: '#10b981' },
  arExportBtnText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  hudToggleBtn: { backgroundColor: '#1e293b', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  hudToggleBtnActive: { backgroundColor: '#38bdf8' },
  hudToggleText: { color: '#ffffff', fontSize: 12, fontWeight: '600' },
  viewport: { flex: 1, position: 'relative' },
  modePillContainer: { position: 'absolute', top: 14, left: 14, zIndex: 10 },
  modeScrollContent: { gap: 8 },
  modePill: { backgroundColor: 'rgba(15, 23, 42, 0.85)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: '#334155' },
  modePillActive: { backgroundColor: '#0284c7', borderColor: '#38bdf8' },
  modePillText: { color: '#94a3b8', fontSize: 11, fontWeight: '600' },
  modePillTextActive: { color: '#ffffff', fontWeight: '700' },
  miniMapWrapper: { position: 'absolute', bottom: 16, left: 16, zIndex: 10, backgroundColor: 'rgba(11, 17, 32, 0.85)', padding: 6, borderRadius: 10, borderWidth: 1, borderColor: '#1e293b' },
  miniMapLabel: { color: '#64748b', fontSize: 9, fontWeight: '700', textAlign: 'center', marginTop: 4 },
  activeRouteBanner: { position: 'absolute', top: 14, alignSelf: 'center', backgroundColor: 'rgba(16, 185, 129, 0.95)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, zIndex: 15, flexDirection: 'row', alignItems: 'center', gap: 12 },
  activeRouteText: { color: '#ffffff', fontWeight: '700', fontSize: 12 },
  clearRouteBtn: { backgroundColor: 'rgba(0, 0, 0, 0.2)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  clearRouteBtnText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  toastContainer: { position: 'absolute', top: 60, alignSelf: 'center', backgroundColor: '#0ea5e9', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, zIndex: 25 },
  toastText: { color: '#ffffff', fontWeight: '700', fontSize: 12 },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(7, 11, 20, 0.9)', justifyContent: 'center', alignItems: 'center', zIndex: 30 },
  loadingTitle: { color: '#38bdf8', marginTop: 12, fontSize: 14, fontWeight: '600' },
  loadingProgressText: { color: '#94a3b8', marginTop: 4, fontSize: 12 },
  poiDrawer: { position: 'absolute', top: 0, right: 0, bottom: 0, width: 300, backgroundColor: 'rgba(15, 23, 42, 0.95)', borderLeftWidth: 1, borderLeftColor: '#1e293b', zIndex: 20, padding: 16 },
  poiDrawerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  poiDrawerTitle: { color: '#f8fafc', fontSize: 14, fontWeight: '700' },
  poiSearchInput: { backgroundColor: '#1e293b', color: '#f8fafc', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, fontSize: 12, marginBottom: 12 },
  poiCard: { backgroundColor: 'rgba(30, 41, 59, 0.5)', padding: 10, borderRadius: 8, marginBottom: 8, borderWidth: 1, borderColor: '#334155' },
  poiName: { color: '#f8fafc', fontSize: 12, fontWeight: '700', flex: 1 },
  poiCategoryBadge: { color: '#ffffff', fontSize: 9, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, textTransform: 'uppercase' },
  poiDesc: { color: '#94a3b8', fontSize: 11, marginTop: 4 },
  poiActionBtn: { backgroundColor: '#0284c7', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  poiActionBtnText: { color: '#ffffff', fontSize: 10, fontWeight: '700' },
  dialogCard: { position: 'absolute', top: '35%', alignSelf: 'center', width: 320, backgroundColor: '#0f172a', padding: 18, borderRadius: 12, borderWidth: 1, borderColor: '#38bdf8', zIndex: 25 },
  dialogTitle: { color: '#f8fafc', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  dialogSubtitle: { color: '#64748b', fontSize: 11, marginBottom: 12 },
  dialogInput: { backgroundColor: '#1e293b', color: '#f8fafc', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, fontSize: 12, marginBottom: 8 },
  dialogPrimaryBtn: { flex: 1, backgroundColor: '#0284c7', paddingVertical: 8, borderRadius: 6, alignItems: 'center' },
  dialogPrimaryBtnText: { color: '#ffffff', fontWeight: '700', fontSize: 12 },
  dialogSecondaryBtn: { flex: 1, backgroundColor: '#334155', paddingVertical: 8, borderRadius: 6, alignItems: 'center' },
  dialogSecondaryBtnText: { color: '#94a3b8', fontWeight: '600', fontSize: 12 },
});

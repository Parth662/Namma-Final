import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Modal,
  Platform,
  ActivityIndicator,
  Alert,
  useWindowDimensions,
  NativeModules,
} from 'react-native';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import DigitalTwinViewer from './DigitalTwinViewer';
import GeospatialMapScreen from './GeospatialMapScreen';
import { io } from 'socket.io-client';
import { getBackendBaseUrl, getAuthToken, setAuthToken, autoLoginSurveyor, projectsApi } from '../src/api/client';

let cachedAuthToken = null;

const getBackendHost = () => {
  return getBackendBaseUrl();
};

export default function CameraScreen() {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isMobile = windowWidth < 768;
  const isSmallMobile = windowWidth < 420;
  const isDesktop = windowWidth >= 1024;

  const [cameraActive, setCameraActive] = useState(false);
  const [facing, setFacing] = useState('back');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedVideoUri, setRecordedVideoUri] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showViewer, setShowViewer] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null); // 'uploading' | 'success' | 'error'

  // Digital twin conversion state from real recorded video
  const [extractedFrames, setExtractedFrames] = useState([]);
  const [isExtractingFrames, setIsExtractingFrames] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [conversionStage, setConversionStage] = useState('INITIALIZING');
  const [conversionProgress, setConversionProgress] = useState(0);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [queuePosition, setQueuePosition] = useState(null);
  const [estimatedEta, setEstimatedEta] = useState(null);
  const [userTwinData, setUserTwinData] = useState(null);
  const [conversionError, setConversionError] = useState(null);

  const cameraRef = useRef(null);
  const timerRef = useRef(null);
  const webVideoRef = useRef(null);
  const webStreamRef = useRef(null);
  const webMediaRecorderRef = useRef(null);
  const webRecordedChunksRef = useRef([]);
  const recordedVideoBlobRef = useRef(null);
  const socketRef = useRef(null);
  const pollIntervalRef = useRef(null);

  // Native permissions
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicrophonePermission] = useMicrophonePermissions();

  // Timer for recording
  useEffect(() => {
    if (isRecording) {
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording]);

  // Clean up web camera stream if unmounted
  useEffect(() => {
    return () => {
      if (webStreamRef.current) {
        webStreamRef.current.getTracks().forEach((track) => track.stop());
        webStreamRef.current = null;
      }
      if (Platform.OS === 'web' && webVideoRef.current?.srcObject) {
        const stream = webVideoRef.current.srcObject;
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Auto-bind camera stream to web video element whenever camera is active
  useEffect(() => {
    if (Platform.OS === 'web' && cameraActive && webVideoRef.current && webStreamRef.current) {
      if (webVideoRef.current.srcObject !== webStreamRef.current) {
        webVideoRef.current.srcObject = webStreamRef.current;
      }
      webVideoRef.current.muted = true;
      webVideoRef.current.play().catch((e) => {
        if (e.name !== 'AbortError') console.warn('Preview autoplay note:', e);
      });
    }
  }, [cameraActive]);

  const formatTimer = (totalSeconds) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleStartCamera = async () => {
    if (Platform.OS === 'web') {
      try {
        if (!navigator?.mediaDevices?.getUserMedia) {
          Alert.alert('Browser Error', 'Camera is not supported on this browser context.');
          return;
        }

        let stream = null;
        // 1. Try with preferred constraints + audio
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: facing === 'back' ? { ideal: 'environment' } : 'user',
              width: { ideal: 1280 },
            },
            audio: true,
          });
        } catch (audioErr) {
          console.warn('Audio acquisition failed, falling back to video only:', audioErr);
          // 2. Fallback to video only (in case mic is denied or not connected)
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: facing === 'back' ? { ideal: 'environment' } : 'user',
                width: { ideal: 1280 },
              },
              audio: false,
            });
          } catch (resErr) {
            console.warn('Ideal video constraints failed, trying basic video:', resErr);
            // 3. Fallback to basic video
            stream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
          }
        }

        webStreamRef.current = stream;
        setCameraActive(true);

        setTimeout(() => {
          if (webVideoRef.current) {
            webVideoRef.current.srcObject = stream;
            webVideoRef.current.muted = true;
            webVideoRef.current.play().catch((e) => console.warn('Play error:', e));
          }
        }, 100);
      } catch (err) {
        console.error('Camera access error:', err);
        Alert.alert(
          'Permission Error',
          'Please allow camera access in your browser to record your room for 3D reconstruction.'
        );
      }
      return;
    }

    // Native platform
    if (!cameraPermission?.granted) {
      const camResult = await requestCameraPermission();
      if (!camResult.granted) {
        Alert.alert('Permission Required', 'Camera permission is required to capture locations.');
        return;
      }
    }

    if (!micPermission?.granted) {
      await requestMicrophonePermission();
    }

    setCameraActive(true);
  };

  const handleStopCamera = () => {
    if (isRecording) {
      handleStopRecording();
    }
    if (webStreamRef.current) {
      webStreamRef.current.getTracks().forEach((track) => track.stop());
      webStreamRef.current = null;
    }
    if (Platform.OS === 'web' && webVideoRef.current?.srcObject) {
      const stream = webVideoRef.current.srcObject;
      stream.getTracks().forEach((track) => track.stop());
      webVideoRef.current.srcObject = null;
    }
    setCameraActive(false);
  };

  const toggleFacing = async () => {
    const nextFacing = facing === 'back' ? 'front' : 'back';
    setFacing(nextFacing);

    if (Platform.OS === 'web' && cameraActive) {
      if (webStreamRef.current) {
        webStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (webVideoRef.current?.srcObject) {
        webVideoRef.current.srcObject.getTracks().forEach((track) => track.stop());
      }
      try {
        let stream = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: nextFacing === 'back' ? { ideal: 'environment' } : 'user' },
            audio: false,
          });
        } catch (e) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        webStreamRef.current = stream;
        if (webVideoRef.current) {
          webVideoRef.current.srcObject = stream;
          webVideoRef.current.muted = true;
          webVideoRef.current.play().catch(() => {});
        }
      } catch (err) {
        console.warn('Facing flip error:', err);
      }
    }
  };

  const handleStartRecording = async () => {
    if (!cameraActive) {
      Alert.alert('Camera Offline', 'Please start the camera before recording.');
      return;
    }

    setRecordedVideoUri(null);
    setUploadStatus(null);

    if (Platform.OS === 'web') {
      const stream = webStreamRef.current || webVideoRef.current?.srcObject;
      if (!stream || !stream.active || stream.getVideoTracks().length === 0) {
        Alert.alert('Camera Error', 'Camera stream is not active. Please restart the camera.');
        return;
      }

      try {
        webRecordedChunksRef.current = [];

        // Determine supported MIME type dynamically
        const candidateTypes = [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm',
          'video/mp4;codecs=avc1,mp4a.40.2',
          'video/mp4',
        ];
        let chosenMime = '';
        if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
          for (const type of candidateTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
              chosenMime = type;
              break;
            }
          }
        }

        let mediaRecorder;
        try {
          mediaRecorder = chosenMime ? new MediaRecorder(stream, { mimeType: chosenMime }) : new MediaRecorder(stream);
        } catch (optionsErr) {
          console.warn('MediaRecorder with mimeType failed, falling back to default:', optionsErr);
          mediaRecorder = new MediaRecorder(stream);
        }

        webMediaRecorderRef.current = mediaRecorder;

        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            webRecordedChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = () => {
          const finalMime = mediaRecorder.mimeType || chosenMime || 'video/webm';
          const blob = new Blob(webRecordedChunksRef.current, { type: finalMime });
          recordedVideoBlobRef.current = blob;
          const url = URL.createObjectURL(blob);
          setRecordedVideoUri(url);
          extractFramesFromBlob(blob);
        };

        mediaRecorder.onerror = (recErr) => {
          console.error('MediaRecorder error event:', recErr);
          setIsRecording(false);
          Alert.alert('Recording Error', 'An error occurred during video recording.');
        };

        mediaRecorder.start(500); // 500ms time slice
        setIsRecording(true);
      } catch (err) {
        console.error('Start recording error:', err);
        setIsRecording(false);
        Alert.alert('Recording Error', err.message || 'Failed to start browser video recorder.');
      }
      return;
    }

    // Native platform recordAsync
    try {
      if (cameraRef.current) {
        setIsRecording(true);
        // Pass mute: true if microphone is not granted to avoid crash
        const isMuted = !micPermission?.granted;
        const videoRecordPromise = cameraRef.current.recordAsync({
          maxDuration: 120, // 2 minutes max
          ...(isMuted ? { mute: true } : {}),
        });
        videoRecordPromise
          .then((result) => {
            if (result?.uri) {
              setRecordedVideoUri(result.uri);
            }
          })
          .catch((e) => {
            console.error('Record error:', e);
            Alert.alert('Recording Error', e.message || 'Failed to record video on device.');
          })
          .finally(() => {
            setIsRecording(false);
          });
      }
    } catch (err) {
      setIsRecording(false);
      Alert.alert('Recording Error', err.message || 'Failed to start recording.');
    }
  };

  const extractFramesFromBlob = (blob) => {
    setIsExtractingFrames(true);
    if (typeof document === 'undefined') {
      setIsExtractingFrames(false);
      return;
    }
    const tempVideo = document.createElement('video');
    tempVideo.src = URL.createObjectURL(blob);
    tempVideo.muted = true;
    tempVideo.playsInline = true;

    const safetyTimeout = setTimeout(() => {
      setIsExtractingFrames(false);
    }, 10000);

    tempVideo.onerror = (e) => {
      console.warn('tempVideo decode error:', e);
      clearTimeout(safetyTimeout);
      setIsExtractingFrames(false);
    };

    tempVideo.onloadeddata = async () => {
      try {
        let duration = tempVideo.duration;
        if (!Number.isFinite(duration) || isNaN(duration) || duration <= 0) {
          duration = recordingSeconds > 0 ? recordingSeconds : 5;
        }
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 360;
        const ctx = canvas.getContext('2d');
        const frameCount = 8;
        const step = duration / (frameCount + 1);
        const frames = [];
        const angleLabels = [
          'North Wall (Main)',
          'North-West Corner',
          'West Wall (Left)',
          'South-West Corner',
          'South Wall (Entrance)',
          'East Wall (Right)',
          'Walkable Floor Surface',
          'Ceiling Enclosure',
        ];

        for (let i = 1; i <= frameCount; i++) {
          const rawTime = i * step;
          const time = Number.isFinite(rawTime) ? Math.min(Math.max(rawTime, 0.05), Math.max(duration - 0.05, 0.1)) : (i * 0.5);
          if (Number.isFinite(time)) {
            tempVideo.currentTime = time;
            await new Promise((res) => {
              let timer;
              const handler = () => {
                clearTimeout(timer);
                tempVideo.removeEventListener('seeked', handler);
                res();
              };
              timer = setTimeout(handler, 400);
              tempVideo.addEventListener('seeked', handler);
            });
          }

          ctx.drawImage(tempVideo, 0, 0, canvas.width, canvas.height);
          let sample = ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
          let brightness = (sample[0] + sample[1] + sample[2]) / 3;

          // If frame captured pitch-black, retry once with small seek forward to avoid dark camera opening
          if (brightness < 12 && Number.isFinite(time) && duration > 1.5) {
            const retryTime = Math.min(time + 0.5, Math.max(0.2, duration - 0.1));
            tempVideo.currentTime = retryTime;
            await new Promise((res) => {
              let timer = setTimeout(res, 400);
              const handler = () => { clearTimeout(timer); tempVideo.removeEventListener('seeked', handler); res(); };
              tempVideo.addEventListener('seeked', handler);
            });
            ctx.drawImage(tempVideo, 0, 0, canvas.width, canvas.height);
            sample = ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
          }

          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          frames.push({
            index: i,
            time: (Number.isFinite(time) ? time.toFixed(1) : i) + 's',
            angle: angleLabels[i - 1] || `Perspective ${i}`,
            dataUrl,
            r: sample[0] / 255,
            g: sample[1] / 255,
            b: sample[2] / 255,
          });
        }
        setExtractedFrames(frames);
      } catch (e) {
        console.error('Frame extract error:', e);
      } finally {
        clearTimeout(safetyTimeout);
        setIsExtractingFrames(false);
      }
    };
    tempVideo.load();
  };

  const createDemoRoomFrames = () => {
    const angleLabels = [
      'North Wall (Main Window)',
      'North-West Corner',
      'West Wall (Living & Art)',
      'South-West Corner',
      'South Wall (Entrance Door)',
      'East Wall (Feature Wall & Sconces)',
      'Walkable Hardwood Floor',
      'Ceiling & Recessed Downlights',
    ];

    const frames = [];
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');

      const wallStyles = [
        { bg: '#cbd5e1', accent: '#38bdf8', label: '🪟 North Window Wall' },
        { bg: '#94a3b8', accent: '#0ea5e9', label: '📐 North-West Corner' },
        { bg: '#e2e8f0', accent: '#b45309', label: '📚 West Interior Wall' },
        { bg: '#64748b', accent: '#d97706', label: '📐 South-West Corner' },
        { bg: '#cbd5e1', accent: '#334155', label: '🚪 South Entrance Door' },
        { bg: '#1e293b', accent: '#f59e0b', label: '🖼️ East Gallery Wall' },
        { bg: '#78350f', accent: '#b45309', label: '🪵 Walkable Floor' },
        { bg: '#f1f5f9', accent: '#0284c7', label: '💡 Overhead Ceiling' },
      ];

      for (let i = 1; i <= 8; i++) {
        const s = wallStyles[i - 1];
        ctx.fillStyle = s.bg;
        ctx.fillRect(0, 0, 480, 360);

        ctx.fillStyle = s.accent;
        ctx.fillRect(40, 40, 400, 280);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(s.label, 240, 180);

        ctx.font = '13px sans-serif';
        ctx.fillText(`Keyframe ${i} • 3D Room Reconstruction`, 240, 215);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        frames.push({
          index: i,
          time: `${(i * 1.5).toFixed(1)}s`,
          angle: angleLabels[i - 1],
          dataUrl,
          r: 0.8,
          g: 0.8,
          b: 0.8,
        });
      }
    }
    return frames;
  };

  const handleUploadVideoFile = () => {
    if (typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,image/*';
    input.multiple = true;
    input.onchange = (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      const videoFile = files.find((f) => f.type.startsWith('video/'));
      if (videoFile) {
        recordedVideoBlobRef.current = videoFile;
        const url = URL.createObjectURL(videoFile);
        setRecordedVideoUri(url);
        setRecordingSeconds(15);
        extractFramesFromBlob(videoFile);
      } else {
        const imageFiles = files.filter((f) => f.type.startsWith('image/')).slice(0, 8);
        const readPromises = imageFiles.map((file, idx) => {
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (re) => {
              resolve({
                index: idx + 1,
                time: `${(idx * 1.2).toFixed(1)}s`,
                angle: `Perspective ${idx + 1}`,
                dataUrl: re.target.result,
                r: 0.8,
                g: 0.8,
                b: 0.8,
              });
            };
            reader.readAsDataURL(file);
          });
        });

        Promise.all(readPromises).then((frames) => {
          setExtractedFrames(frames);
          setRecordedVideoUri('user_uploaded_room_photos');
          setRecordingSeconds(frames.length * 2);
        });
      }
    };
    input.click();
  };

  const handleLoadSampleRoom = () => {
    setRecordedVideoUri('sample_location_recording.mp4');
    setRecordingSeconds(15);

    const backendHost = getBackendHost();
    const sampleTwin = {
      id: 'sample_digital_twin',
      name: 'Namma Space Demo Quad (Reference Scene)',
      locationName: 'Pre-baked Reference Model',
      latitude: 12.9716,
      longitude: 77.5946,
      status: 'completed',
      source: 'demo',
      isDemo: true,
      modelUrl: `${backendHost}/storage/projects/sample_digital_twin/final/scene.glb`,
      thumbnailUrl: `${backendHost}/storage/projects/sample_digital_twin/preview/thumbnail.jpg`,
      boundingBox: { minX: -2.5, minY: -1.2, minZ: -3.0, maxX: 2.5, maxY: 1.5, maxZ: 3.0 },
      metadata: {
        registeredFrames: 45,
        totalExtractedFrames: 60,
        points3D: 12540,
        triangles: 10124,
        vertices: 5284,
        reconstructionQuality: 'Reference Photogrammetry Demo Scene',
        scaleMeters: '5.0m × 2.7m × 6.0m',
      },
      stats: {
        triangles: '10,124',
        vertices: '5,284',
        pointCount: '12,540 pts',
        cameraPoses: 45,
        scaleMeters: '5.0m × 2.7m × 6.0m',
        reconstructionQuality: 'Reference Photogrammetry Demo Scene',
      },
    };
    setUserTwinData(sampleTwin);
    return sampleTwin;
  };

  const cleanupMonitoring = () => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const handleCancelReconstruction = async () => {
    cleanupMonitoring();
    if (activeProjectId) {
      try {
        const backendHost = getBackendHost();
        const token = cachedAuthToken;
        await fetch(`${backendHost}/api/projects/${activeProjectId}/cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        console.warn('Cancel error:', err);
      }
    }
    setIsConverting(false);
    setActiveProjectId(null);
    setConversionProgress(0);
    setConversionStage('CANCELLED');
    setQueuePosition(null);
    setEstimatedEta(null);
  };

  const handleStartConversion = async () => {
    setIsConverting(true);
    setConversionProgress(10);
    setConversionStage('PREPARING VIDEO FOR 3D RECONSTRUCTION...');
    setConversionError(null);
    setQueuePosition(null);
    setEstimatedEta(null);

    const hasBlob = !!recordedVideoBlobRef.current;
    const hasUri = !!recordedVideoUri;
    if (!hasBlob && !hasUri) {
      setIsConverting(false);
      setConversionError({
        code: 'NO_VIDEO_RECORDED',
        reason: 'No raw video recording was found to reconstruct.',
        suggestion: 'Please record a video using the live camera or upload a video file.',
      });
      return;
    }

    const backendHost = getBackendHost();

    try {
      // 1. Get or create auth token
      const getFreshToken = async () => {
        setConversionStage('AUTHENTICATING WITH RECONSTRUCTION SERVER...');
        console.log('[DigitalTwin] Authenticating with backend at:', `${backendHost}/api/auth/register`);
        const uniqueEmail = `surveyor_${Date.now()}_${Math.floor(Math.random() * 10000)}@digitaltwin.app`;
        const regRes = await fetch(`${backendHost}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Location Surveyor', email: uniqueEmail, password: 'SecurePassword123!' }),
        });
        const regData = await regRes.json().catch(() => ({}));
        if (!regRes.ok || !regData.success || !regData.token) {
          const detail = regData.error || regData.detail || `HTTP ${regRes.status}`;
          throw new Error(`Server authentication failed on ${backendHost} (${detail}). Ensure backend is on port 5001.`);
        }
        cachedAuthToken = regData.token;
        if (typeof localStorage !== 'undefined') localStorage.setItem('dt_token', regData.token);
        return regData.token;
      };

      let token = cachedAuthToken || (typeof localStorage !== 'undefined' ? localStorage.getItem('dt_token') : null);
      if (!token) {
        token = await getFreshToken();
      }

      // 2. Create project in database (with auto-retry on 401 expired token)
      setConversionProgress(20);
      setConversionStage('INITIALIZING PROJECT IN DATABASE...');
      const createProjectPayload = {
        name: `Surveyed Site ${new Date().toLocaleTimeString()}`,
        description: 'Photogrammetric Structure-from-Motion Digital Twin',
        locationName: 'Surveyed Real-World Location',
      };

      let projRes = await fetch(`${backendHost}/api/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(createProjectPayload),
      });

      // If token expired (401), automatically clear stale token, re-authenticate, and retry
      if (projRes.status === 401) {
        console.warn('[DigitalTwin] Token expired/invalid. Re-authenticating...');
        if (typeof localStorage !== 'undefined') localStorage.removeItem('dt_token');
        cachedAuthToken = null;
        token = await getFreshToken();
        projRes = await fetch(`${backendHost}/api/projects`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(createProjectPayload),
        });
      }

      const projData = await projRes.json().catch(() => ({}));
      if (!projRes.ok || !projData.success) {
        throw new Error(projData.error || `Failed to initialize project (HTTP ${projRes.status})`);
      }
      const projectId = projData.data._id;
      setActiveProjectId(projectId);

      // 3. Upload raw video
      setConversionProgress(35);
      setConversionStage('STREAMING VIDEO TO RECONSTRUCTION STORAGE...');

      if (Platform.OS === 'web') {
        const formData = new FormData();
        let blobToUpload = recordedVideoBlobRef.current;
        if (!blobToUpload && recordedVideoUri && recordedVideoUri.startsWith('blob:')) {
          try {
            const fetchResp = await fetch(recordedVideoUri);
            blobToUpload = await fetchResp.blob();
          } catch (e) {
            console.warn('Fetch blob from URI failed:', e);
          }
        }
        const mime = (blobToUpload?.type && blobToUpload.type.startsWith('video/')) ? blobToUpload.type : 'video/mp4';
        const ext = mime.includes('mp4') ? 'mp4' : mime.includes('mov') ? 'mov' : 'webm';
        if (!blobToUpload) {
          blobToUpload = new Blob(['sample demo video data'], { type: 'video/mp4' });
        }
        // Use standard File constructor so web browsers explicitly transmit the correct video MIME type
        const fileToUpload = typeof File !== 'undefined'
          ? new File([blobToUpload], `source_video.${ext}`, { type: mime })
          : blobToUpload;
        formData.append('video', fileToUpload, `source_video.${ext}`);

        const uploadRes = await fetch(`${backendHost}/api/projects/${projectId}/upload`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        });
        const uploadData = await uploadRes.json();
        if (!uploadData.success) throw new Error(uploadData.error || 'Failed to upload video');
      } else {
        // Native mobile Android & iOS: use FileSystem.uploadAsync for direct zero-memory background streaming
        console.log('[DigitalTwin] Native uploadAsync to:', `${backendHost}/api/projects/${projectId}/upload`);
        const uploadResult = await FileSystem.uploadAsync(
          `${backendHost}/api/projects/${projectId}/upload`,
          recordedVideoUri,
          {
            fieldName: 'video',
            httpMethod: 'POST',
            uploadType: FileSystem.FileSystemUploadType.MULTIPART,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        let uploadData = {};
        try {
          uploadData = JSON.parse(uploadResult.body);
        } catch (e) {
          uploadData = {};
        }

        if (uploadResult.status < 200 || uploadResult.status >= 300 || !uploadData.success) {
          throw new Error(uploadData.error || `Video upload failed (HTTP ${uploadResult.status})`);
        }
      }

      // 4. Trigger Photogrammetry Reconstruction Pipeline
      setConversionProgress(45);
      setConversionStage('STARTING PHOTOGRAMMETRY PIPELINE (COLMAP SfM)...');
      const reconRes = await fetch(`${backendHost}/api/projects/${projectId}/reconstruct`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const reconData = await reconRes.json();
      if (!reconData.success) throw new Error(reconData.error || 'Failed to enqueue reconstruction');

      // Helper to finalize digital twin and launch viewer
      const handleReconSuccess = async () => {
        cleanupMonitoring();
        setConversionProgress(100);
        setConversionStage('DIGITAL TWIN READY!');

        try {
          const modelRes = await fetch(`${backendHost}/api/projects/${projectId}/model`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const modelData = await modelRes.json();

          setUserTwinData({
            id: projectId,
            name: projData.data.name,
            status: 'completed',
            source: modelData.source || 'photogrammetry',
            isDemo: Boolean(modelData.isDemo),
            modelUrl: modelData.model?.url
              ? modelData.model.url.startsWith('http')
                ? modelData.model.url
                : `${backendHost}${modelData.model.url}`
              : null,
            thumbnailUrl: modelData.model?.thumbnail
              ? modelData.model.thumbnail.startsWith('http')
                ? modelData.model.thumbnail
                : `${backendHost}${modelData.model.thumbnail}`
              : null,
            bounds: modelData.bounds,
            metadata: modelData.metadata,
            stats: {
              triangles: (modelData.metadata?.triangles || 0).toLocaleString(),
              vertices: (modelData.metadata?.vertices || 0).toLocaleString(),
              pointCount: `${(modelData.metadata?.points3D || 0).toLocaleString()} pts`,
              cameraPoses: modelData.metadata?.registeredFrames || 0,
              scaleMeters: modelData.metadata?.scaleMeters || 'Metric Scale',
              reconstructionQuality: modelData.metadata?.reconstructionQuality || 'COLMAP SfM + Open3D MVS',
            },
          });
          setIsConverting(false);
          setShowViewer(true);
        } catch (e) {
          console.warn('Failed to load final model:', e);
        }
      };

      // 5. Connect Socket.IO for real-time stage updates, queue position, and ETA
      try {
        const socket = io(backendHost, {
          transports: ['websocket', 'polling'],
          reconnectionAttempts: 5,
        });
        socketRef.current = socket;

        socket.on('connect', () => {
          socket.emit('subscribe:job', { projectId });
        });

        socket.on('job:stage', (payload) => {
          if (!payload || (payload.projectId && payload.projectId !== projectId)) return;
          if (payload.stage) setConversionStage(payload.message || payload.stage.toUpperCase());
          if (typeof payload.progress === 'number') setConversionProgress(payload.progress);
          if (payload.etaFormatted) setEstimatedEta(payload.etaFormatted);
          if (payload.queuePosition !== undefined) setQueuePosition(payload.queuePosition);
        });

        socket.on('queue:position', (payload) => {
          if (!payload || (payload.projectId && payload.projectId !== projectId)) return;
          setQueuePosition(payload.position);
        });

        socket.on('job:completed', () => {
          handleReconSuccess();
        });

        socket.on('job:failed', (payload) => {
          cleanupMonitoring();
          setIsConverting(false);
          const isQuality = payload?.code && (payload.code.startsWith('REJECTED_') || payload.code.startsWith('INSUFFICIENT_'));
          setConversionError({
            title: payload?.title || (isQuality ? 'Reconstruction Quality Issue' : 'Server processing error'),
            code: payload?.code || (isQuality ? 'INSUFFICIENT_RECONSTRUCTION_QUALITY' : 'SERVER_PROCESSING_ERROR'),
            reason: payload?.reason || '3D reconstruction encountered an error.',
            suggestion: payload?.suggestion || (payload?.logPath ? `Server log: ${payload.logPath}` : 'Please inspect server logs for details.'),
            logPath: payload?.logPath,
          });
        });
      } catch (sockErr) {
        console.warn('[Socket.IO] Init warning:', sockErr);
      }

      // 6. Polling Fallback (in case WebSockets are blocked)
      pollIntervalRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`${backendHost}/api/projects/${projectId}/status`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const statusData = await statusRes.json();

          if (statusData.status === 'processing' || statusData.status === 'queued') {
            setConversionProgress(Math.max(45, statusData.progress || 50));
            setConversionStage(statusData.currentStage || 'PROCESSING STRUCTURE FROM MOTION...');
            if (statusData.queuePosition !== undefined) setQueuePosition(statusData.queuePosition);
            if (statusData.estimatedRemainingSec) {
              const sec = Math.round(statusData.estimatedRemainingSec);
              setEstimatedEta(sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);
            }
          } else if (statusData.status === 'completed') {
            handleReconSuccess();
          } else if (statusData.status === 'failed' || statusData.status === 'rejected') {
            cleanupMonitoring();
            setIsConverting(false);
            const errObj = statusData.error || {};
            const code = statusData.code || errObj.code || (statusData.status === 'rejected' ? 'INSUFFICIENT_RECONSTRUCTION_QUALITY' : 'SERVER_PROCESSING_ERROR');
            const isQuality = code.startsWith('REJECTED_') || code.startsWith('INSUFFICIENT_');
            setConversionError({
              title: statusData.title || errObj.title || (isQuality ? 'Reconstruction Quality Issue' : 'Server processing error'),
              code,
              reason: statusData.reason || errObj.reason || '3D reconstruction encountered an error.',
              suggestion: statusData.suggestion || errObj.suggestion || (statusData.logPath || errObj.logPath ? `Server log: ${statusData.logPath || errObj.logPath}` : 'Please inspect server logs.'),
              logPath: statusData.logPath || errObj.logPath,
            });
          }
        } catch (pollErr) {
          console.warn('Poll error:', pollErr);
        }
      }, 2000);
    } catch (err) {
      console.error('Reconstruction initiation error:', err);
      setIsConverting(false);
      const isNetworkError =
        err.name === 'TypeError' ||
        err.message?.toLowerCase().includes('fetch') ||
        err.message?.toLowerCase().includes('network') ||
        err.message?.toLowerCase().includes('failed to fetch') ||
        err.message?.toLowerCase().includes('abort');

      setConversionError({
        isNetworkError,
        title: isNetworkError ? `Can't reach the server at ${backendHost}` : 'Reconstruction Initiation Failed',
        url: backendHost,
        code: isNetworkError ? 'NETWORK_ERROR' : 'PIPELINE_INITIATION_FAILED',
        reason: isNetworkError
          ? `Could not connect to the backend server at ${backendHost}. ${err.message || ''}`.trim()
          : (err.message || 'Could not communicate with the 3D reconstruction server.'),
        suggestion: isNetworkError
          ? `Please ensure the Node API backend is running on ${backendHost} and firewall rules permit access.`
          : `Please verify the backend server is running on ${backendHost}.`,
      });
    }
  };

  const handleStopRecording = () => {
    if (!isRecording) return;
    setIsRecording(false);

    if (Platform.OS === 'web') {
      if (webMediaRecorderRef.current && webMediaRecorderRef.current.state !== 'inactive') {
        webMediaRecorderRef.current.stop();
      }
      return;
    }

    if (cameraRef.current) {
      cameraRef.current.stopRecording();
    }
  };

  if (showMap) {
    return (
      <GeospatialMapScreen
        projectData={userTwinData}
        onClose={() => setShowMap(false)}
        onLaunch3DView={() => {
          setShowMap(false);
          setShowViewer(true);
        }}
      />
    );
  }

  if (showViewer) {
    return (
      <DigitalTwinViewer
        projectData={userTwinData}
        onClose={() => setShowViewer(false)}
        onOpenMap={() => {
          setShowViewer(false);
          setShowMap(true);
        }}
      />
    );
  }

  return (
    <View style={styles.safeArea}>
      <View style={styles.container}>
        {/* Top App Header - Responsive for Mobile & Desktop */}
        <View style={styles.header}>
          <View style={styles.titleWrap}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {isMobile ? 'Spatial 3D Capture' : 'Spatial 3D Digital Twin Capture'}
            </Text>
            {!isSmallMobile && (
              <Text style={styles.headerSubtitle} numberOfLines={1}>
                {isMobile ? 'Photogrammetry Studio' : 'Convert Real Locations into Navigable 3D Models'}
              </Text>
            )}
          </View>
          <View style={styles.headerRightButtons}>
            <TouchableOpacity
              style={styles.mapHeaderBtn}
              onPress={() => setShowMap(true)}
              accessibilityLabel="View Geospatial Map"
            >
              <Text style={styles.mapHeaderBtnText}>{isMobile ? '🗺️ Map' : '🗺️ Map View'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.launchViewerBtn}
              onPress={() => {
                if (!userTwinData) {
                  handleLoadSampleRoom();
                }
                setShowViewer(true);
              }}
              accessibilityLabel="Launch 3D View"
            >
              <Text style={styles.launchViewerBtnText}>{isMobile ? '🌐 3D' : '🌐 3D View'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.guideButton}
              onPress={() => setShowGuide(true)}
              accessibilityLabel="Open User Guide"
            >
              <Text style={styles.guideButtonText}>📖 Guide</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Workstation Frame for Desktop or Full-Bleed for Mobile */}
        <View style={[styles.mainLayout, isDesktop && styles.mainLayoutDesktop]}>
          {/* Live Viewport Area */}
          <View style={[styles.viewportContainer, isDesktop && styles.viewportContainerDesktop]}>
            {cameraActive ? (
              Platform.OS === 'web' ? (
                <View style={styles.webCameraContainer}>
                  <video
                    ref={webVideoRef}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      borderRadius: 16,
                    }}
                    autoPlay
                    playsInline
                    muted
                  />
                </View>
              ) : (
                <CameraView
                  ref={cameraRef}
                  style={styles.cameraView}
                  facing={facing}
                  mode="video"
                />
              )
            ) : (
              <View style={styles.placeholderContainer}>
                <Text style={styles.placeholderIcon}>📹</Text>
                <Text style={styles.placeholderTitle}>3D Room Reconstruction Studio</Text>
                <Text style={styles.placeholderText}>
                  Record your room with the live camera, upload recorded video frames, or launch an instant photogrammetric room twin!
                </Text>
                <View style={styles.placeholderButtonCol}>
                  <TouchableOpacity style={styles.startCameraButton} onPress={handleStartCamera}>
                    <Text style={styles.startCameraButtonText}>▶ Start Live Camera Recording</Text>
                  </TouchableOpacity>
                  <View style={styles.placeholderSecondaryRow}>
                    <TouchableOpacity style={styles.uploadRoomButton} onPress={handleUploadVideoFile}>
                      <Text style={styles.uploadRoomButtonText}>📁 Upload Room Video / Photos</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.demoRoomButton} onPress={handleLoadSampleRoom}>
                      <Text style={styles.demoRoomButtonText}>🎬 Try Demo Room Video</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            )}

            {/* Viewfinder Overlays when Camera is Active */}
            {cameraActive && (
              <>
                {/* Top HUD Badges */}
                <View style={styles.topHud}>
                  <View style={[styles.hudBadge, isRecording ? styles.hudBadgeRecording : styles.hudBadgeLive]}>
                    <View style={[styles.statusDot, isRecording && styles.statusDotRecording]} />
                    <Text style={styles.hudBadgeText}>
                      {isRecording ? `REC ${formatTimer(recordingSeconds)}` : 'LIVE VIEW'}
                    </Text>
                  </View>
                  <TouchableOpacity style={styles.hudSmallBtn} onPress={toggleFacing}>
                    <Text style={styles.hudSmallBtnText}>🔄 Flip ({facing})</Text>
                  </TouchableOpacity>
                </View>

                {/* Composition Grid Lines for steady framing */}
                <View style={styles.gridOverlay} pointerEvents="none">
                  <View style={styles.gridLineH1} />
                  <View style={styles.gridLineH2} />
                  <View style={styles.gridLineV1} />
                  <View style={styles.gridLineV2} />
                </View>

                {/* Live Guidance Tip Banner */}
                <View style={styles.bottomHudTip} pointerEvents="none">
                  <Text style={styles.bottomHudTipText}>
                    {isRecording
                      ? '🚶 Move slowly • Maintain 70% visual overlap • Keep camera steady'
                      : '💡 Stand 2-5m from surfaces and sweep around in a smooth loop'}
                  </Text>
                </View>
              </>
            )}
          </View>

          {/* Bottom Control Deck - Touch Optimized */}
          <View style={styles.controlDeck}>
            {cameraActive ? (
              <View style={styles.activeControlsRow}>
                {/* Stop Camera Button */}
                <TouchableOpacity style={styles.secondaryActionBtn} onPress={handleStopCamera}>
                  <Text style={styles.secondaryActionBtnText}>⏹ Stop</Text>
                </TouchableOpacity>

                {/* Shutter Record / Stop Button */}
                <TouchableOpacity
                  style={[
                    styles.shutterOuter,
                    isRecording ? styles.shutterOuterRecording : null,
                  ]}
                  onPress={isRecording ? handleStopRecording : handleStartRecording}
                  accessibilityLabel={isRecording ? "Stop Recording" : "Start Recording"}
                >
                  <View
                    style={[
                      styles.shutterInner,
                      isRecording ? styles.shutterInnerRecording : null,
                    ]}
                  />
                </TouchableOpacity>

                {/* Camera Facing Toggle */}
                <TouchableOpacity style={styles.secondaryActionBtn} onPress={toggleFacing}>
                  <Text style={styles.secondaryActionBtnText}>🔄 Flip</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.inactiveControlsRow}>
                <TouchableOpacity style={styles.primaryActionBtn} onPress={handleStartCamera}>
                  <Text style={styles.primaryActionBtnText}>📷 Open Live Camera</Text>
                </TouchableOpacity>
                <View style={styles.inactiveSecondaryRow}>
                  <TouchableOpacity style={styles.uploadSecondaryBtn} onPress={handleUploadVideoFile}>
                    <Text style={styles.uploadSecondaryBtnText}>📁 Upload Room Video</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.demoSecondaryBtn} onPress={handleLoadSampleRoom}>
                    <Text style={styles.demoSecondaryBtnText}>🎬 Try Demo Room</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Recorded Clip Review Card */}
            {recordedVideoUri && (
              <View style={[styles.reviewCard, isDesktop && styles.reviewCardDesktop]}>
                <View style={styles.reviewCardHeader}>
                  <Text style={styles.reviewTitle}>✅ Video Captured ({formatTimer(recordingSeconds)})</Text>
                  <TouchableOpacity onPress={() => { setRecordedVideoUri(null); setExtractedFrames([]); }}>
                    <Text style={styles.reviewDismiss}>✕</Text>
                  </TouchableOpacity>
                </View>

                {/* Real Extracted Frames from user's video */}
                {isExtractingFrames ? (
                  <View style={styles.extractingIndicator}>
                    <ActivityIndicator size="small" color="#0ea5e9" />
                    <Text style={styles.extractingText}>Sampling keyframes from your recorded video...</Text>
                  </View>
                ) : extractedFrames.length > 0 ? (
                  <View style={styles.framesSection}>
                    <View style={styles.framesHeaderRow}>
                      <Text style={styles.framesTitle}>🎞️ Extracted Video Keyframes ({extractedFrames.length})</Text>
                      <Text style={styles.framesSubtitle}>Ready for 3D Photogrammetry</Text>
                    </View>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.framesScroll}>
                      {extractedFrames.map((f, i) => (
                        <View key={i} style={styles.frameThumbCard}>
                          {Platform.OS === 'web' && (
                            <img
                              src={f.dataUrl}
                              alt={`Pose ${f.index}`}
                              style={{
                                width: isMobile ? 70 : 88,
                                height: isMobile ? 50 : 60,
                                borderRadius: 6,
                                objectFit: 'cover',
                                border: '1px solid #334155',
                              }}
                            />
                          )}
                          <Text style={styles.frameTimestamp}>Frame {f.index} ({f.time})</Text>
                        </View>
                      ))}
                    </ScrollView>
                  </View>
                ) : (
                  <Text style={styles.reviewDesc}>
                    Video captured successfully. Ready to convert what you recorded into a 3D digital twin!
                  </Text>
                )}

                {/* Conversion CTA Button */}
                <TouchableOpacity
                  style={styles.convertCtaBtn}
                  onPress={handleStartConversion}
                >
                  <Text style={styles.convertCtaBtnText}>
                    {userTwinData ? '✓ 3D Digital Twin Ready! (Re-convert)' : '⚡ Convert Recorded Video into 3D Twin'}
                  </Text>
                </TouchableOpacity>

                <View style={styles.reviewBtnRow}>
                  <TouchableOpacity
                    style={styles.retakeBtn}
                    onPress={() => {
                      setRecordedVideoUri(null);
                      setExtractedFrames([]);
                      setUserTwinData(null);
                    }}
                  >
                    <Text style={styles.retakeBtnText}>Retake</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.convertToMapBtn}
                    onPress={() => setShowMap(true)}
                  >
                    <Text style={styles.convertToMapBtnText}>🗺️ Map</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.viewTwinBtn}
                    onPress={() => setShowViewer(true)}
                  >
                    <Text style={styles.viewTwinBtnText}>🏛️ 3D Twin</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        </View>

        {/* Photogrammetry Conversion Progress Modal - Responsive */}
        <Modal visible={isConverting} animationType="fade" transparent={true}>
          <View style={styles.modalOverlay}>
            <View style={[styles.conversionModalCard, isMobile && styles.conversionModalCardMobile]}>
              <Text style={styles.conversionTitle}>⚡ Photogrammetric 3D Reconstruction</Text>
              <Text style={styles.conversionSubtitle}>
                Converting your recorded camera video into a navigable 3D digital twin
              </Text>

              {/* Extracted Frame Strips */}
              {extractedFrames.length > 0 && Platform.OS === 'web' && (
                <View style={styles.conversionPreviewRow}>
                  {extractedFrames.slice(0, 5).map((f, i) => (
                    <img
                      key={i}
                      src={f.dataUrl}
                      alt="Pose"
                      style={{
                        width: isMobile ? 44 : 56,
                        height: isMobile ? 32 : 40,
                        borderRadius: 6,
                        border: '1px solid #00f0ff',
                        objectFit: 'cover',
                      }}
                    />
                  ))}
                </View>
              )}

              {/* Standardized Stages Stepper */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginVertical: 10, justifyContent: 'center' }}>
                {['PROBING', 'FRAMES', 'FEATURES', 'MATCHING', 'SFM', 'MESHING', 'EXPORT'].map((stg) => {
                  const upperStage = (conversionStage || '').toUpperCase();
                  const isCurrent = upperStage.includes(stg);
                  const isPast = conversionProgress >= 95 || (stg === 'PROBING' && conversionProgress >= 20) || (stg === 'FRAMES' && conversionProgress >= 35) || (stg === 'FEATURES' && conversionProgress >= 50) || (stg === 'MATCHING' && conversionProgress >= 65) || (stg === 'SFM' && conversionProgress >= 78) || (stg === 'MESHING' && conversionProgress >= 88);
                  const active = isCurrent || isPast;
                  return (
                    <View
                      key={stg}
                      style={{
                        paddingHorizontal: 6,
                        paddingVertical: 3,
                        borderRadius: 4,
                        backgroundColor: isCurrent ? 'rgba(14, 165, 233, 0.3)' : isPast ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                        borderWidth: 1,
                        borderColor: isCurrent ? '#0ea5e9' : isPast ? '#10b981' : 'rgba(255, 255, 255, 0.1)',
                      }}
                    >
                      <Text style={{ fontSize: 9, fontWeight: '700', color: isCurrent ? '#38bdf8' : isPast ? '#34d399' : '#64748b' }}>
                        {isPast && !isCurrent ? `✓ ${stg}` : stg}
                      </Text>
                    </View>
                  );
                })}
              </View>

              {/* Real-Time Queue Position & ETA Status Row */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingHorizontal: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {queuePosition !== null && queuePosition > 0 ? (
                    <Text style={{ color: '#f59e0b', fontSize: 11, fontWeight: '700' }}>
                      📋 Queue Position: #{queuePosition}
                    </Text>
                  ) : (
                    <Text style={{ color: '#10b981', fontSize: 11, fontWeight: '700' }}>
                      ⚡ Active Host Slot
                    </Text>
                  )}
                </View>
                {estimatedEta ? (
                  <Text style={{ color: '#38bdf8', fontSize: 11, fontWeight: '700' }}>
                    ⏱️ ETA: {estimatedEta}
                  </Text>
                ) : null}
              </View>

              {/* Stage Badge & Progress Bar */}
              <View style={styles.stageBox}>
                <Text style={styles.stageNameText} numberOfLines={1}>STAGE: {conversionStage}</Text>
                <Text style={styles.stagePercentText}>{conversionProgress}%</Text>
              </View>

              <View style={styles.progressBarTrack}>
                <View style={[styles.progressBarFill, { width: `${conversionProgress}%` }]} />
              </View>

              {conversionProgress === 100 ? (
                <View style={styles.conversionDoneRow}>
                  <Text style={styles.conversionDoneTitle}>🎉 3D Digital Twin Ready!</Text>
                  <Text style={styles.conversionDoneDesc}>
                    Your recorded physical environment has been reconstructed into authentic 3D geometry, dense point cloud, and textures!
                  </Text>
                  <TouchableOpacity
                    style={styles.launchConvertedBtn}
                    onPress={() => {
                      setIsConverting(false);
                      setShowViewer(true);
                    }}
                  >
                    <Text style={styles.launchConvertedBtnText}>🏛️ Launch Converted 3D Digital Twin</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.launchMapBtn}
                    onPress={() => {
                      setIsConverting(false);
                      setShowMap(true);
                    }}
                  >
                    <Text style={styles.launchMapBtnText}>🗺️ View Converted Footprint on Map</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View>
                  <View style={styles.conversionRunningRow}>
                    <ActivityIndicator color="#0ea5e9" size="small" />
                    <Text style={styles.conversionRunningText}>
                      COLMAP Feature Extraction & Open3D Dense Synthesis Running...
                    </Text>
                  </View>
                  {/* Cancel Reconstruction Button */}
                  <TouchableOpacity
                    style={{
                      marginTop: 14,
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: 'rgba(239, 68, 68, 0.5)',
                      backgroundColor: 'rgba(239, 68, 68, 0.1)',
                      alignItems: 'center',
                    }}
                    onPress={handleCancelReconstruction}
                  >
                    <Text style={{ color: '#f87171', fontWeight: '700', fontSize: 12 }}>
                      ✕ Cancel Reconstruction
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        </Modal>

        {/* Diagnostic Reconstruction Error Modal */}
        <Modal visible={!!conversionError} animationType="fade" transparent={true}>
          <View style={styles.modalOverlay}>
            <View style={[styles.conversionModalCard, { borderColor: '#ef4444' }]}>
              <View style={{ alignItems: 'center', marginBottom: 12 }}>
                <Text style={{ fontSize: 32, marginBottom: 6 }}>
                  {conversionError?.isNetworkError ? '🌐' : (conversionError?.title === 'Server processing error' ? '⚙️' : '⚠️')}
                </Text>
                <Text style={styles.conversionTitle}>
                  {conversionError?.title || (conversionError?.isNetworkError ? `Can't reach the server at ${conversionError?.url || getBackendHost()}` : 'Reconstruction Quality Issue')}
                </Text>
                <Text style={{ backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#f87171', fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, marginTop: 4 }}>
                  {conversionError?.code || 'INSUFFICIENT_RECONSTRUCTION_QUALITY'}
                </Text>
              </View>
              <Text style={{ color: '#cbd5e1', fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 16 }}>
                {conversionError?.reason}
              </Text>
              <View style={{ backgroundColor: '#1e293b', padding: 12, borderRadius: 8, width: '100%', marginBottom: 16 }}>
                <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: '700', marginBottom: 4 }}>
                  {conversionError?.isNetworkError
                    ? '🌐 Connection Help:'
                    : (conversionError?.title === 'Server processing error' ? '⚙️ Diagnostic Info / Log Location:' : '💡 Photogrammetry Recommendation:')}
                </Text>
                <Text style={{ color: '#94a3b8', fontSize: 12, lineHeight: 18 }}>
                  {conversionError?.suggestion}
                </Text>
              </View>
              <TouchableOpacity
                style={{ backgroundColor: '#0284c7', paddingVertical: 12, borderRadius: 8, width: '100%', alignItems: 'center' }}
                onPress={() => setConversionError(null)}
              >
                <Text style={{ color: '#ffffff', fontSize: 14, fontWeight: '700' }}>
                  {conversionError?.isNetworkError ? 'Dismiss' : (conversionError?.title === 'Server processing error' ? 'Dismiss' : 'Record New Footage')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* User Guide & Tutorial Modal - Responsive */}
        <Modal visible={showGuide} animationType="slide" transparent={true}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalCard, isMobile && styles.modalCardMobile]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalHeaderTitle}>📍 3D Reconstruction Guide</Text>
                <TouchableOpacity onPress={() => setShowGuide(false)} style={styles.modalCloseBtn}>
                  <Text style={styles.modalCloseBtnText}>✕</Text>
                </TouchableOpacity>
              </View>

              <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={false}>
                <Text style={styles.guideIntro}>
                  This platform transforms real-world video into an interactive, photorealistic 3D digital
                  twin. Follow these photogrammetry guidelines for best results:
                </Text>

                {/* Step 1 */}
                <View style={styles.stepCard}>
                  <View style={styles.stepNumberBadge}>
                    <Text style={styles.stepNumber}>1</Text>
                  </View>
                  <View style={styles.stepContent}>
                    <Text style={styles.stepTitle}>Plan Your Capture Path</Text>
                    <Text style={styles.stepText}>
                      Walk in a continuous perimeter loop around the location, building, or objects. Keep the
                      subject centered in the viewfinder.
                    </Text>
                  </View>
                </View>

                {/* Step 2 */}
                <View style={styles.stepCard}>
                  <View style={styles.stepNumberBadge}>
                    <Text style={styles.stepNumber}>2</Text>
                  </View>
                  <View style={styles.stepContent}>
                    <Text style={styles.stepTitle}>Move Slowly & Smoothly</Text>
                    <Text style={styles.stepText}>
                      Walk at a slow, steady pace. Avoid quick jerks, rapid panning, or running. Blurry frames
                      are rejected by the photogrammetry engine.
                    </Text>
                  </View>
                </View>

                {/* Step 3 */}
                <View style={styles.stepCard}>
                  <View style={styles.stepNumberBadge}>
                    <Text style={styles.stepNumber}>3</Text>
                  </View>
                  <View style={styles.stepContent}>
                    <Text style={styles.stepTitle}>70% - 80% Visual Overlap</Text>
                    <Text style={styles.stepText}>
                      Photogrammetry (COLMAP) matches identical visual keypoints across consecutive angles. Every
                      surface detail should appear in multiple frames.
                    </Text>
                  </View>
                </View>

                {/* Step 4 */}
                <View style={styles.stepCard}>
                  <View style={styles.stepNumberBadge}>
                    <Text style={styles.stepNumber}>4</Text>
                  </View>
                  <View style={styles.stepContent}>
                    <Text style={styles.stepTitle}>Lighting & Surfaces</Text>
                    <Text style={styles.stepText}>
                      Record under balanced daylight or diffused lighting. Avoid direct sunlight glare, pitch-black
                      shadows, mirrors, and completely flat white walls.
                    </Text>
                  </View>
                </View>

                {/* Step 5 */}
                <View style={styles.stepCard}>
                  <View style={styles.stepNumberBadge}>
                    <Text style={styles.stepNumber}>5</Text>
                  </View>
                  <View style={styles.stepContent}>
                    <Text style={styles.stepTitle}>Reconstruct & Launch 3D View</Text>
                    <Text style={styles.stepText}>
                      Record 15–60 seconds, tap "Stop", and click "Convert". Once processed, click
                      "Launch 3D View" to navigate your full 3D spatial twin!
                    </Text>
                  </View>
                </View>

                <View style={styles.doDontBox}>
                  <Text style={styles.doText}>✓ DO: Circle objects from multiple angles</Text>
                  <Text style={styles.doText}>✓ DO: Hold camera with two hands for stability</Text>
                  <Text style={styles.dontText}>✕ DON'T: Spin in place like a panorama</Text>
                  <Text style={styles.dontText}>✕ DON'T: Shake or tilt camera rapidly</Text>
                </View>
              </ScrollView>

              <TouchableOpacity style={styles.modalActionBtn} onPress={() => setShowGuide(false)}>
                <Text style={styles.modalActionBtnText}>Got It, Start Scanning</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0b0f19',
  },
  container: {
    flex: 1,
    backgroundColor: '#0b0f19',
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'android' ? 36 : 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  titleWrap: {
    flexShrink: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#f8fafc',
    letterSpacing: 0.3,
  },
  headerSubtitle: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 1,
  },
  headerRightButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  mapHeaderBtn: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderColor: '#10b981',
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 16,
  },
  mapHeaderBtnText: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '700',
  },
  launchViewerBtn: {
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 16,
  },
  launchViewerBtnText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  guideButton: {
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    borderColor: '#38bdf8',
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 16,
  },
  guideButtonText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '600',
  },
  mainLayout: {
    flex: 1,
    width: '100%',
  },
  mainLayoutDesktop: {
    maxWidth: 1080,
    alignSelf: 'center',
  },
  viewportContainer: {
    flex: 1,
    marginTop: 10,
    marginBottom: 10,
    backgroundColor: '#020617',
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1,
    borderColor: '#1e293b',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewportContainerDesktop: {
    minHeight: 460,
  },
  webCameraContainer: {
    width: '100%',
    height: '100%',
    borderRadius: 18,
    overflow: 'hidden',
  },
  cameraView: {
    width: '100%',
    height: '100%',
  },
  placeholderContainer: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  placeholderIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  placeholderTitle: {
    color: '#f1f5f9',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
  },
  placeholderText: {
    color: '#64748b',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 18,
  },
  startCameraButton: {
    backgroundColor: '#0ea5e9',
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 22,
    shadowColor: '#0ea5e9',
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 4,
  },
  startCameraButtonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 14,
  },
  placeholderButtonCol: {
    width: '100%',
    alignItems: 'center',
    gap: 10,
  },
  placeholderSecondaryRow: {
    flexDirection: 'row',
    gap: 8,
    width: '100%',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  uploadRoomButton: {
    backgroundColor: '#1e293b',
    borderColor: '#38bdf8',
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  uploadRoomButtonText: {
    color: '#38bdf8',
    fontWeight: '600',
    fontSize: 13,
  },
  demoRoomButton: {
    backgroundColor: '#1e293b',
    borderColor: '#10b981',
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  demoRoomButtonText: {
    color: '#10b981',
    fontWeight: '600',
    fontSize: 13,
  },
  topHud: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 10,
  },
  hudBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: 'rgba(15, 23, 42, 0.82)',
    borderWidth: 1,
  },
  hudBadgeLive: {
    borderColor: '#10b981',
  },
  hudBadgeRecording: {
    borderColor: '#ef4444',
    backgroundColor: 'rgba(239, 68, 68, 0.25)',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10b981',
    marginRight: 6,
  },
  statusDotRecording: {
    backgroundColor: '#ef4444',
  },
  hudBadgeText: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  hudSmallBtn: {
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  hudSmallBtnText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '600',
  },
  gridOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5,
  },
  gridLineH1: {
    position: 'absolute',
    top: '33.33%',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  gridLineH2: {
    position: 'absolute',
    top: '66.66%',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  gridLineV1: {
    position: 'absolute',
    left: '33.33%',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  gridLineV2: {
    position: 'absolute',
    left: '66.66%',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  bottomHudTip: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    backgroundColor: 'rgba(15, 23, 42, 0.88)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
    zIndex: 10,
  },
  bottomHudTipText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '500',
    textAlign: 'center',
  },
  controlDeck: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  activeControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    width: '100%',
    paddingHorizontal: 12,
  },
  inactiveControlsRow: {
    width: '100%',
    paddingHorizontal: 12,
  },
  primaryActionBtn: {
    backgroundColor: '#0ea5e9',
    paddingVertical: 13,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: '#0ea5e9',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 3,
  },
  primaryActionBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  inactiveSecondaryRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    width: '100%',
  },
  uploadSecondaryBtn: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderColor: '#38bdf8',
    borderWidth: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
  },
  uploadSecondaryBtnText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '600',
  },
  demoSecondaryBtn: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderColor: '#10b981',
    borderWidth: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
  },
  demoSecondaryBtnText: {
    color: '#10b981',
    fontSize: 12,
    fontWeight: '600',
  },
  secondaryActionBtn: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#334155',
  },
  secondaryActionBtnText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '600',
  },
  shutterOuter: {
    width: 70,
    height: 70,
    borderRadius: 35,
    borderWidth: 4,
    borderColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  shutterOuterRecording: {
    borderColor: '#ef4444',
  },
  shutterInner: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#ef4444',
  },
  shutterInnerRecording: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: '#ef4444',
  },
  reviewCard: {
    marginTop: 10,
    width: '100%',
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  reviewCardDesktop: {
    maxWidth: 800,
    alignSelf: 'center',
  },
  reviewCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  reviewTitle: {
    color: '#10b981',
    fontWeight: '700',
    fontSize: 13,
  },
  reviewDismiss: {
    color: '#94a3b8',
    fontSize: 15,
    padding: 4,
  },
  reviewDesc: {
    color: '#94a3b8',
    fontSize: 12,
    marginBottom: 8,
  },
  reviewBtnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  retakeBtn: {
    flex: 1,
    backgroundColor: '#334155',
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
  },
  retakeBtnText: {
    color: '#e2e8f0',
    fontWeight: '600',
    fontSize: 12,
  },
  convertToMapBtn: {
    flex: 1.5,
    backgroundColor: '#10b981',
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
  },
  convertToMapBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  viewTwinBtn: {
    flex: 1.5,
    backgroundColor: '#0ea5e9',
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
  },
  viewTwinBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 14,
  },
  modalCard: {
    width: '100%',
    maxWidth: 620,
    maxHeight: '85%',
    backgroundColor: '#0f172a',
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalCardMobile: {
    width: '94%',
    padding: 14,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  modalHeaderTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#f8fafc',
  },
  modalCloseBtn: {
    padding: 4,
  },
  modalCloseBtnText: {
    color: '#94a3b8',
    fontSize: 17,
    fontWeight: '600',
  },
  modalScroll: {
    marginTop: 12,
  },
  guideIntro: {
    color: '#cbd5e1',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 12,
  },
  stepCard: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    alignItems: 'flex-start',
  },
  stepNumberBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#0ea5e9',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
    marginTop: 2,
  },
  stepNumber: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  stepContent: {
    flex: 1,
  },
  stepTitle: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  stepText: {
    color: '#94a3b8',
    fontSize: 11,
    lineHeight: 15,
  },
  doDontBox: {
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    marginBottom: 14,
  },
  doText: {
    color: '#34d399',
    fontSize: 11,
    marginBottom: 3,
    fontWeight: '500',
  },
  dontText: {
    color: '#f87171',
    fontSize: 11,
    marginBottom: 3,
    fontWeight: '500',
  },
  modalActionBtn: {
    backgroundColor: '#0ea5e9',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  modalActionBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  extractingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 8,
    padding: 8,
    backgroundColor: 'rgba(14, 165, 233, 0.1)',
    borderRadius: 8,
  },
  extractingText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '500',
  },
  framesSection: {
    marginVertical: 6,
  },
  framesHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  framesTitle: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
  },
  framesSubtitle: {
    color: '#64748b',
    fontSize: 10,
  },
  framesScroll: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  frameThumbCard: {
    marginRight: 6,
    alignItems: 'center',
  },
  frameTimestamp: {
    color: '#94a3b8',
    fontSize: 9,
    marginTop: 2,
  },
  convertCtaBtn: {
    backgroundColor: '#0284c7',
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
    marginVertical: 6,
  },
  convertCtaBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  conversionModalCard: {
    width: '100%',
    maxWidth: 540,
    backgroundColor: '#0f172a',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#334155',
  },
  conversionModalCardMobile: {
    width: '94%',
    padding: 14,
  },
  conversionTitle: {
    color: '#38bdf8',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 3,
  },
  conversionSubtitle: {
    color: '#94a3b8',
    fontSize: 11,
    marginBottom: 10,
  },
  conversionPreviewRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
    justifyContent: 'center',
  },
  stageBox: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 5,
  },
  stageNameText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '600',
    flexShrink: 1,
    marginRight: 8,
  },
  stagePercentText: {
    color: '#00f0ff',
    fontSize: 11,
    fontWeight: '700',
  },
  progressBarTrack: {
    height: 7,
    backgroundColor: '#1e293b',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 14,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#0ea5e9',
    borderRadius: 4,
  },
  conversionRunningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  conversionRunningText: {
    color: '#94a3b8',
    fontSize: 11,
  },
  conversionDoneRow: {
    alignItems: 'center',
    paddingTop: 2,
  },
  conversionDoneTitle: {
    color: '#10b981',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 3,
  },
  conversionDoneDesc: {
    color: '#cbd5e1',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 15,
    marginBottom: 12,
  },
  launchConvertedBtn: {
    width: '100%',
    backgroundColor: '#0ea5e9',
    paddingVertical: 11,
    borderRadius: 9,
    alignItems: 'center',
    marginBottom: 6,
  },
  launchConvertedBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  launchMapBtn: {
    width: '100%',
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    paddingVertical: 9,
    borderRadius: 9,
    alignItems: 'center',
  },
  launchMapBtnText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '600',
  },
});

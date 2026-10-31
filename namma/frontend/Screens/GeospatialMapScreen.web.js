import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  Platform,
  useWindowDimensions,
} from 'react-native';
import L from 'leaflet';

export default function GeospatialMapScreen({ onClose, onLaunch3DView, projectData }) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const { width: windowWidth } = useWindowDimensions();
  const isMobile = windowWidth < 768;
  const isSmallMobile = windowWidth < 420;

  const [mapLayer, setMapLayer] = useState('satellite'); // 'satellite' | 'streets'
  const [selectedTwin, setSelectedTwin] = useState(null);
  const [showLegend, setShowLegend] = useState(!isMobile);

  const defaultProject = projectData || {
    id: 'proj_campus_01',
    name: 'College Campus & Central Quad',
    locationName: 'North Quadrangle, Block 4',
    latitude: 37.7749,
    longitude: -122.4194,
    status: 'completed',
    areaMeters: '620 m²',
    triangles: '142,850',
    scaleMeters: '27.2m × 22.8m × 11.5m',
    recordedDuration: '00:36',
    frameCount: 64,
  };

  useEffect(() => {
    // Inject Leaflet CSS on Web
    if (typeof document !== 'undefined') {
      if (!document.getElementById('leaflet-css')) {
        const link = document.createElement('link');
        link.id = 'leaflet-css';
        link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(link);
      }
    }

    if (!mapContainerRef.current) return;

    const lat = defaultProject.latitude || 37.7749;
    const lng = defaultProject.longitude || -122.4194;

    // Initialize Leaflet Map
    const map = L.map(mapContainerRef.current, {
      center: [lat, lng],
      zoom: 18,
      zoomControl: true,
    });
    mapInstanceRef.current = map;

    // Tile Layers: Esri Satellite & CartoDB Voyager
    const satelliteLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Esri, Maxar, Earthstar Geographics',
        maxZoom: 20,
      }
    );

    satelliteLayer.addTo(map);

    // 1. Calculate Reconstructed Area Bounding Polygon Footprint on the map
    const latOffset = 0.00015;
    const lngOffset = 0.00018;
    const polygonBounds = [
      [lat - latOffset, lng - lngOffset],
      [lat - latOffset, lng + lngOffset],
      [lat + latOffset, lng + lngOffset],
      [lat + latOffset, lng - lngOffset],
    ];

    const footprintPolygon = L.polygon(polygonBounds, {
      color: '#00f0ff',
      weight: 2,
      opacity: 0.9,
      fillColor: '#0ea5e9',
      fillOpacity: 0.28,
      dashArray: '4, 6',
    }).addTo(map);

    footprintPolygon.bindTooltip(
      `<b>📍 ${defaultProject.name}</b><br/>Reconstructed 3D Footprint (${defaultProject.scaleMeters})`,
      { permanent: false, direction: 'top' }
    );

    // 2. Camera Walkthrough Trajectory on the Map (Path taken while recording)
    const trajectoryPoints = [];
    const pointsCount = 16;
    for (let i = 0; i <= pointsCount; i++) {
      const angle = (i / pointsCount) * Math.PI * 2;
      const rLat = latOffset * 0.75 * Math.sin(angle);
      const rLng = lngOffset * 0.75 * Math.cos(angle);
      trajectoryPoints.push([lat + rLat, lng + rLng]);
    }

    const walkPath = L.polyline(trajectoryPoints, {
      color: '#38bdf8',
      weight: 3,
      opacity: 0.85,
    }).addTo(map);

    walkPath.bindTooltip('🚶 Video Walkthrough Path (70% Overlap)', { sticky: true });

    // 3. Custom Pulsing 3D Digital Twin Marker Pin
    const customIcon = L.divIcon({
      className: 'custom-twin-marker',
      html: `
        <div style="
          position: relative;
          width: 38px;
          height: 38px;
          background: #0ea5e9;
          border: 3px solid #ffffff;
          border-radius: 50%;
          box-shadow: 0 0 16px #00f0ff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          cursor: pointer;
        ">
          🌐
          <div style="
            position: absolute;
            width: 58px;
            height: 58px;
            border-radius: 50%;
            border: 2px solid #00f0ff;
            animation: pulse-ring 2s infinite;
          "></div>
        </div>
      `,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
    });

    const marker = L.marker([lat, lng], { icon: customIcon }).addTo(map);

    marker.on('click', () => {
      setSelectedTwin(defaultProject);
    });

    setSelectedTwin(defaultProject);

    return () => {
      map.remove();
    };
  }, []);

  const switchLayer = (layerType) => {
    setMapLayer(layerType);
    if (!mapInstanceRef.current) return;
    const map = mapInstanceRef.current;

    map.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) {
        map.removeLayer(layer);
      }
    });

    if (layerType === 'satellite') {
      L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 20 }
      ).addTo(map);
    } else {
      L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        { maxZoom: 20 }
      ).addTo(map);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* Header Bar - Responsive for Mobile & Desktop */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <TouchableOpacity style={styles.backBtn} onPress={onClose} accessibilityLabel="Back to camera">
              <Text style={styles.backBtnText}>‹ Back</Text>
            </TouchableOpacity>
            <View style={styles.titleWrap}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {isMobile ? 'Geospatial Map' : 'Geospatial Digital Twin Map'}
              </Text>
              {!isSmallMobile && (
                <Text style={styles.headerSubtitle} numberOfLines={1}>
                  Anchored Spatial Coordinates
                </Text>
              )}
            </View>
          </View>

          {/* Map Layer Switcher */}
          <View style={styles.layerSwitchRow}>
            <TouchableOpacity
              style={[styles.layerBtn, mapLayer === 'satellite' && styles.layerBtnActive]}
              onPress={() => switchLayer('satellite')}
            >
              <Text style={[styles.layerBtnText, mapLayer === 'satellite' && styles.layerBtnTextActive]}>
                🛰️ {isMobile ? 'Sat' : 'Satellite'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.layerBtn, mapLayer === 'streets' && styles.layerBtnActive]}
              onPress={() => switchLayer('streets')}
            >
              <Text style={[styles.layerBtnText, mapLayer === 'streets' && styles.layerBtnTextActive]}>
                🗺️ {isMobile ? 'Street' : 'Streets'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Map Viewport Area */}
        <View style={styles.mapViewport}>
          <div
            ref={mapContainerRef}
            style={{
              width: '100%',
              height: '100%',
              zIndex: 1,
            }}
          />

          {/* Map Legend Overlay (Positioned to never overlap Leaflet zoom controls) */}
          {showLegend ? (
            <View style={[styles.legendCard, isMobile && styles.legendCardMobile]}>
              <View style={styles.legendHeaderRow}>
                <Text style={styles.legendTitle}>Map Legend</Text>
                {isMobile && (
                  <TouchableOpacity onPress={() => setShowLegend(false)} style={styles.legendCloseBtn}>
                    <Text style={styles.legendCloseBtnText}>✕</Text>
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendBox, { backgroundColor: 'rgba(14, 165, 233, 0.4)', borderColor: '#00f0ff' }]} />
                <Text style={styles.legendLabel}>Reconstructed 3D Footprint</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendLine, { backgroundColor: '#38bdf8' }]} />
                <Text style={styles.legendLabel}>Video Capture Walk Path</Text>
              </View>
              <View style={styles.legendItem}>
                <Text style={{ fontSize: 13, marginRight: 6 }}>🌐</Text>
                <Text style={styles.legendLabel}>3D Digital Twin Pin</Text>
              </View>
            </View>
          ) : (
            <TouchableOpacity style={styles.legendTogglePill} onPress={() => setShowLegend(true)}>
              <Text style={styles.legendTogglePillText}>🗺️ Legend</Text>
            </TouchableOpacity>
          )}

          {/* Selected Twin Bottom Card - Responsive width and grid */}
          {selectedTwin && (
            <View style={[styles.twinCardWrapper, isMobile && styles.twinCardWrapperMobile]}>
              <View style={styles.twinCard}>
                <View style={styles.twinCardHeader}>
                  <View style={styles.twinHeaderLeft}>
                    {selectedTwin.frames?.[0]?.dataUrl && (
                      <img
                        src={selectedTwin.frames[0].dataUrl}
                        alt="Thumbnail"
                        style={{
                          width: isMobile ? 42 : 52,
                          height: isMobile ? 42 : 52,
                          borderRadius: 8,
                          objectFit: 'cover',
                          border: '2px solid #0ea5e9',
                        }}
                      />
                    )}
                    <View style={styles.twinTitleWrap}>
                      <Text style={styles.twinName} numberOfLines={1}>{selectedTwin.name}</Text>
                      <Text style={styles.twinLocation} numberOfLines={1}>📍 {selectedTwin.locationName}</Text>
                    </View>
                  </View>
                  <View style={styles.statusPill}>
                    <Text style={styles.statusPillText}>● 3D Ready</Text>
                  </View>
                </View>

                {/* Responsive 4-col (desktop) or 2x2 (mobile) stats grid */}
                <View style={[styles.statsGrid, isMobile && styles.statsGridMobile]}>
                  <View style={[styles.statBox, isMobile && styles.statBoxMobile]}>
                    <Text style={styles.statLabel}>Coordinates</Text>
                    <Text style={styles.statVal}>{selectedTwin.latitude.toFixed(4)}°, {selectedTwin.longitude.toFixed(4)}°</Text>
                  </View>
                  <View style={[styles.statBox, isMobile && styles.statBoxMobile]}>
                    <Text style={styles.statLabel}>Captured Area</Text>
                    <Text style={styles.statVal}>{selectedTwin.scaleMeters}</Text>
                  </View>
                  <View style={[styles.statBox, isMobile && styles.statBoxMobile]}>
                    <Text style={styles.statLabel}>Mesh Quality</Text>
                    <Text style={styles.statVal}>{selectedTwin.triangles} Tris</Text>
                  </View>
                  <View style={[styles.statBox, isMobile && styles.statBoxMobile]}>
                    <Text style={styles.statLabel}>Walk Duration</Text>
                    <Text style={styles.statVal}>{selectedTwin.recordedDuration} ({selectedTwin.frameCount} poses)</Text>
                  </View>
                </View>

                <View style={styles.twinActionRow}>
                  <TouchableOpacity
                    style={styles.launch3DBtn}
                    onPress={() => {
                      if (onLaunch3DView) {
                        onLaunch3DView();
                      }
                    }}
                  >
                    <Text style={styles.launch3DBtnText}>🏛️ Launch 3D Digital Twin View</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </View>

        {/* Bottom Bar Info */}
        <View style={styles.bottomBar}>
          <Text style={styles.bottomBarText} numberOfLines={1}>
            🌍 Physical Location Anchored on Global High-Resolution Satellite Map
          </Text>
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
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    backgroundColor: '#0b0f19',
    zIndex: 10,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 1,
  },
  backBtn: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  backBtnText: {
    color: '#38bdf8',
    fontWeight: '700',
    fontSize: 13,
  },
  titleWrap: {
    flexShrink: 1,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f8fafc',
  },
  headerSubtitle: {
    fontSize: 11,
    color: '#94a3b8',
  },
  layerSwitchRow: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    borderRadius: 18,
    padding: 3,
    borderWidth: 1,
    borderColor: '#334155',
  },
  layerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  layerBtnActive: {
    backgroundColor: '#0ea5e9',
  },
  layerBtnText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  layerBtnTextActive: {
    color: '#ffffff',
  },
  mapViewport: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#070b14',
  },
  legendCard: {
    position: 'absolute',
    top: 80,
    left: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.94)',
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    zIndex: 999,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  legendCardMobile: {
    top: 75,
    left: 10,
    padding: 8,
  },
  legendHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  legendCloseBtn: {
    paddingLeft: 8,
  },
  legendCloseBtnText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: 'bold',
  },
  legendTogglePill: {
    position: 'absolute',
    top: 80,
    left: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#334155',
    zIndex: 999,
  },
  legendTogglePillText: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '600',
  },
  legendTitle: {
    color: '#38bdf8',
    fontSize: 11,
    fontWeight: '700',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
  },
  legendBox: {
    width: 14,
    height: 14,
    borderWidth: 1,
    borderRadius: 2,
    marginRight: 6,
  },
  legendLine: {
    width: 14,
    height: 3,
    borderRadius: 1,
    marginRight: 6,
  },
  legendLabel: {
    color: '#cbd5e1',
    fontSize: 10,
    fontWeight: '500',
  },
  twinCardWrapper: {
    position: 'absolute',
    bottom: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 999,
    paddingHorizontal: 16,
  },
  twinCardWrapperMobile: {
    bottom: 12,
    paddingHorizontal: 10,
  },
  twinCard: {
    width: '100%',
    maxWidth: 640,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 18,
  },
  twinCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  twinHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 1,
  },
  twinTitleWrap: {
    flexShrink: 1,
  },
  twinName: {
    color: '#f8fafc',
    fontSize: 15,
    fontWeight: '700',
  },
  twinLocation: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 1,
  },
  statusPill: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderColor: '#10b981',
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
  },
  statusPillText: {
    color: '#10b981',
    fontSize: 10,
    fontWeight: '700',
  },
  statsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(30, 41, 59, 0.6)',
    borderRadius: 10,
    padding: 8,
    marginBottom: 10,
  },
  statsGridMobile: {
    flexWrap: 'wrap',
    gap: 6,
  },
  statBox: {
    alignItems: 'center',
    flex: 1,
  },
  statBoxMobile: {
    flexBasis: '47%',
    paddingVertical: 4,
  },
  statLabel: {
    color: '#64748b',
    fontSize: 9,
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  statVal: {
    color: '#f1f5f9',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 1,
  },
  twinActionRow: {
    width: '100%',
  },
  launch3DBtn: {
    backgroundColor: '#0ea5e9',
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
    shadowColor: '#0ea5e9',
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  launch3DBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  bottomBar: {
    backgroundColor: '#0b0f19',
    paddingVertical: 7,
    paddingHorizontal: 14,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    zIndex: 10,
  },
  bottomBarText: {
    color: '#64748b',
    fontSize: 11,
  },
});

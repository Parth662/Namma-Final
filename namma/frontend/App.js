// Safety polyfill for React Native runtime (Hermes/JSC) to prevent ReferenceError on native devices
if (typeof globalThis !== 'undefined' && typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({ getContext: () => null, style: {} }),
    createElementNS: () => ({ style: {} }),
    documentElement: { style: {} },
    getElementById: () => null,
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet } from 'react-native';
import CameraScreen from './Screens/CameraScreen';

export default function App() {
  return (
    <View style={styles.safeArea}>
      <StatusBar style="light" />
      <CameraScreen />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0b0f19',
  },
});

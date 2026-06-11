'use client';

import { useEffect, useRef } from 'react';

interface PlanetariumLayerProps {
  mapCenter: { lat: number; lng: number };
  opacity: number; // 0–100
}

export default function PlanetariumLayer({ mapCenter, opacity }: PlanetariumLayerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const prevRef   = useRef(mapCenter);

  useEffect(() => {
    const dlat = Math.abs(mapCenter.lat - prevRef.current.lat);
    const dlng = Math.abs(mapCenter.lng - prevRef.current.lng);
    if (dlat > 0.3 || dlng > 0.3) {
      prevRef.current = mapCenter;
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'SET_LOCATION', lat: mapCenter.lat, lng: mapCenter.lng },
        '*'
      );
    }
  }, [mapCenter]);

  const { lat, lng } = mapCenter;
  const src = `/planetarium-test.html?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&overlay=1`;

  return (
    <iframe
      ref={iframeRef}
      src={src}
      title="Planetarium overlay"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        border: 'none',
        pointerEvents: 'none',
        opacity: opacity / 100,
        transition: 'opacity 0.3s ease',
        zIndex: 10,
        background: 'transparent',
      }}
      allow="geolocation"
    />
  );
}

/**
 * LeafletMap (§4.2) - Leaflet in a WebView over OpenStreetMap tiles.
 *
 * No API key and no billing account, which is why it was chosen over Google
 * Maps for a two-day build. OSM's tile usage policy requires the attribution
 * shown at the bottom right, so it is not optional and is not removed.
 *
 * The HTML is generated locally and loaded with `originWhitelist=['*']` and no
 * remote script: only the tile images come from the network.
 */
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Text } from 'react-native-paper';

export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  label: string;
  /** Marker colour - category or status driven. */
  color?: string;
  /** Rendered in the popup under the label; already-safe text only. */
  sublabel?: string;
}

export interface LeafletMapProps {
  markers: MapMarker[];
  height?: number;
  /** Falls back to fitting all markers when not given. */
  center?: { lat: number; lon: number };
  zoom?: number;
  onMarkerPress?: (id: string) => void;
}

/** Prevents a label with a quote or a tag breaking (or escaping) the HTML. */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildHtml = (markers: MapMarker[], center?: { lat: number; lon: number }, zoom = 13): string => {
  const safeMarkers = markers
    .filter((marker) => Number.isFinite(marker.lat) && Number.isFinite(marker.lon))
    .map((marker) => ({
      id: marker.id,
      lat: marker.lat,
      lon: marker.lon,
      label: escapeHtml(marker.label),
      sublabel: marker.sublabel ? escapeHtml(marker.sublabel) : '',
      color: marker.color ?? '#1F5FA8',
    }));

  const focus = center ?? safeMarkers[0] ?? { lat: 6.9271, lon: 79.8612 };

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    html, body, #map { height: 100%; margin: 0; padding: 0; background: #E8EAED; }
    .cl-pin {
      width: 18px; height: 18px; border-radius: 9px;
      border: 3px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.45);
    }
    .leaflet-control-attribution { font-size: 10px; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    (function () {
      var markers = ${JSON.stringify(safeMarkers)};
      var map = L.map('map', { zoomControl: true, attributionControl: true })
        .setView([${focus.lat}, ${focus.lon}], ${zoom});

      // OSM tile usage policy: attribution must stay visible.
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);

      var bounds = [];
      markers.forEach(function (m) {
        var icon = L.divIcon({
          className: '',
          html: '<div class="cl-pin" style="background:' + m.color + '"></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9]
        });
        var marker = L.marker([m.lat, m.lon], { icon: icon }).addTo(map);
        marker.bindPopup('<b>' + m.label + '</b>' + (m.sublabel ? '<br/>' + m.sublabel : ''));
        marker.on('click', function () {
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'marker', id: m.id }));
          }
        });
        bounds.push([m.lat, m.lon]);
      });

      if (bounds.length > 1) {
        map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
      }
    })();
  </script>
</body>
</html>`;
};

export const LeafletMap: React.FC<LeafletMapProps> = ({
  markers,
  height = 240,
  center,
  zoom,
  onMarkerPress,
}) => {
  const html = useMemo(() => buildHtml(markers, center, zoom), [markers, center, zoom]);

  if (markers.length === 0) {
    return (
      <View style={[styles.placeholder, { height }]}>
        <Text variant="bodySmall">No location to show yet</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { height }]}>
      <WebView
        originWhitelist={['*']}
        source={{ html }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        // The map is decorative context; a blank tile must not block the screen.
        renderError={() => (
          <View style={styles.placeholder}>
            <Text variant="bodySmall">Map unavailable offline</Text>
          </View>
        )}
        onMessage={(event) => {
          try {
            const payload = JSON.parse(event.nativeEvent.data) as { type: string; id: string };
            if (payload.type === 'marker') onMarkerPress?.(payload.id);
          } catch {
            // A malformed message from the page is ignored rather than thrown.
          }
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { borderRadius: 12, overflow: 'hidden', backgroundColor: '#E8EAED' },
  webview: { flex: 1, backgroundColor: 'transparent' },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E8EAED',
    borderRadius: 12,
  },
});

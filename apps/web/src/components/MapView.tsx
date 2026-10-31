import { useEffect, useRef, useState } from 'react';
import { Map as MLMap, NavigationControl, Popup, type GeoJSONSource, type MapLayerMouseEvent } from 'maplibre-gl';
import { Scan } from 'lucide-react';
import type { MapData } from '../lib/api';
import { Button, catColor, Spinner } from './ui';

// OpenFreeMap: free OpenStreetMap vector tiles, no API key (https://openfreemap.org).
const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const BD_CENTER: [number, number] = [90.35, 23.7];

function circle(lat: number, lon: number, km: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lon + (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (km / 111.32) * Math.sin(a)]);
  }
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [pts] } };
}

interface Props {
  data?: MapData; loading: boolean; catOrder: string[];
  onSelect: (id: string) => void;
  pickMode: boolean; onPick: (lat: number, lon: number) => void;
  radius: { lat: number; lon: number; km: number } | null;
  onSearchArea: (bbox: string) => void; areaActive: boolean; onClearArea: () => void;
  focus: { lat: number; lon: number } | null;
}

export function MapView({ data, loading, catOrder, onSelect, pickMode, onPick, radius, onSearchArea, areaActive, onClearArea, focus }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const [moved, setMoved] = useState(false);
  const cb = useRef({ onSelect, onPick, pickMode });
  cb.current = { onSelect, onPick, pickMode };

  useEffect(() => {
    const m = new MLMap({ container: el.current!, style: STYLE, center: BD_CENTER, zoom: 6.3, attributionControl: { compact: true } });
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    m.on('error', (e) => console.warn('[map]', e.error?.message ?? e));
    if (import.meta.env.DEV) (window as unknown as { __map: MLMap }).__map = m; // handy for debugging in the browser console
    m.on('load', () => {
      m.addSource('biz', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterRadius: 45, clusterMaxZoom: 15 });
      m.addSource('radius', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': '#3b6cf6', 'fill-opacity': 0.08 } });
      m.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': '#3b6cf6', 'line-width': 2, 'line-dasharray': [2, 2] } });
      m.addLayer({ id: 'clusters', type: 'circle', source: 'biz', filter: ['has', 'point_count'],
        paint: { 'circle-color': ['step', ['get', 'point_count'], '#7ea2fa', 100, '#3b6cf6', 1000, '#1f43c4'], 'circle-opacity': 0.85,
          'circle-radius': ['step', ['get', 'point_count'], 14, 100, 19, 1000, 25], 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });
      m.addLayer({ id: 'cluster-count', type: 'symbol', source: 'biz', filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 11, 'text-font': ['Noto Sans Bold'] }, paint: { 'text-color': '#fff' } });
      m.addLayer({ id: 'points', type: 'circle', source: 'biz', filter: ['!', ['has', 'point_count']],
        paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 7], 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' } });

      m.on('click', 'clusters', async (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        const zoom = await (m.getSource('biz') as GeoJSONSource).getClusterExpansionZoom(f.properties.cluster_id as number);
        m.easeTo({ center: (f.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom });
      });
      m.on('click', 'points', (e: MapLayerMouseEvent) => { if (!cb.current.pickMode) { const id = e.features?.[0]?.properties.id; if (id) cb.current.onSelect(String(id)); } });
      const popup = new Popup({ closeButton: false, offset: 8 });
      m.on('mouseenter', 'points', (e: MapLayerMouseEvent) => {
        m.getCanvas().style.cursor = 'pointer';
        const f = e.features?.[0];
        if (f) popup.setLngLat((f.geometry as unknown as { coordinates: [number, number] }).coordinates).setText(String(f.properties.name ?? 'Business')).addTo(m);
      });
      m.on('mouseleave', 'points', () => { m.getCanvas().style.cursor = ''; popup.remove(); });
      m.on('mouseenter', 'clusters', () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', 'clusters', () => { m.getCanvas().style.cursor = ''; });
      m.on('click', (e) => { if (cb.current.pickMode) cb.current.onPick(e.lngLat.lat, e.lngLat.lng); });
      m.on('moveend', () => setMoved(true));
      setReady(true);
    });
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  // data
  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !data) return;
    (m.getSource('biz') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: data.points.map(([id, lon, lat, cat, name]) => ({ type: 'Feature', properties: { id, cat, name, color: catColor(cat, catOrder) }, geometry: { type: 'Point', coordinates: [lon, lat] } })),
    });
  }, [ready, data, catOrder]);

  // radius circle + fit
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    (m.getSource('radius') as GeoJSONSource).setData({ type: 'FeatureCollection', features: radius ? [circle(radius.lat, radius.lon, radius.km)] : [] });
    if (radius) {
      const dLat = radius.km / 111.32, dLon = radius.km / (111.32 * Math.cos((radius.lat * Math.PI) / 180));
      m.fitBounds([[radius.lon - dLon, radius.lat - dLat], [radius.lon + dLon, radius.lat + dLat]], { padding: 40, duration: 600 });
    }
  }, [ready, radius]);

  useEffect(() => { if (ready && focus && map.current) map.current.flyTo({ center: [focus.lon, focus.lat], zoom: Math.max(map.current.getZoom(), 15) }); }, [ready, focus]);
  useEffect(() => { if (map.current) map.current.getCanvas().style.cursor = pickMode ? 'crosshair' : ''; }, [pickMode]);

  const searchArea = () => {
    const b = map.current?.getBounds();
    if (!b) return;
    onSearchArea([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(5)).join(','));
    setMoved(false);
  };

  return (
    <div className="relative h-full w-full">
      <div ref={el} className="h-full w-full" />
      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center gap-2">
        {pickMode && <div className="pointer-events-auto rounded-full bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg">Click on the map to set the radius centre</div>}
        {!pickMode && moved && !radius && (
          <Button size="sm" className="pointer-events-auto shadow-md" onClick={searchArea}><Scan className="size-3.5" /> Search this area</Button>
        )}
        {!pickMode && areaActive && <Button size="sm" variant="ghost" className="pointer-events-auto bg-white/90 shadow-md dark:bg-slate-900/90" onClick={onClearArea}>Clear map area</Button>}
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-2 rounded-md bg-white/90 px-2 py-1 text-xs text-slate-600 shadow dark:bg-slate-900/90 dark:text-slate-300">
        {loading ? <Spinner className="size-3" /> : null}
        {data ? (data.truncated ? `Showing top ${data.points.length.toLocaleString()} of ${data.total.toLocaleString()} (filter or zoom in to narrow)` : `${data.total.toLocaleString()} on map`) : 'Loading map…'}
      </div>
    </div>
  );
}

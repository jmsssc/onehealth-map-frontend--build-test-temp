import { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, GeoJSON, Popup, CircleMarker, Pane } from 'react-leaflet';
import NutsMapperV5 from '../NUTSMapper/nuts_mapper_v5';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import ViewportMonitor from "./ViewportMonitor.tsx";
import * as turf from '@turf/turf';
import './Map.css'
import {
    Layers,
} from 'lucide-react';
import ModelSelector from "./InterfaceInputs/ModelSelector.tsx";
import AntdTimelineSelector from "./AntdTimelineSelector.tsx";
import OptimismLevelSelector from "./InterfaceInputs/OptimismSelector.tsx";
import GeneralCard from "./Multiuse/GeneralCard.tsx";
import {viewingMode} from "../../stores/ViewingModeStore.ts";
import AdaptiveGridLayer from "./AdaptiveGridLayer.tsx";
import {COLOR_SCHEMES, DataExtremes, NutsGeoJSON, OutbreakData, ProcessingStats, ViewportBounds} from "./types.ts";
import {getColorFromGradient} from "./gradientUtilities.ts";
import DebugStatsPanel from "./DebugStatsPanel.tsx";
import ControlBar from "./InterfaceInputs/ControlBar.tsx";

const MIN_ZOOM = 3.4;
const MAX_ZOOM = 7;

const hexToRgb = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
};

const rgbToHex = (r: number, g: number, b: number) => {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
};

const interpolateColor = (color1: string, color2: string, factor: number) => {
    const c1 = hexToRgb(color1);
    const c2 = hexToRgb(color2);

    if (!c1 || !c2) return color1;

    const r = Math.round(c1.r + factor * (c2.r - c1.r));
    const g = Math.round(c1.g + factor * (c2.g - c1.g));
    const b = Math.round(c1.b + factor * (c2.b - c1.b));

    return rgbToHex(r, g, b);
};

const DynamicLegend = ({ extremes,  unit = "°C" }: { extremes: DataExtremes, unit?: string }) => {
    if (!extremes) return null;

    const scheme = COLOR_SCHEMES.default;
    const steps = 10;
    const gradientStops = [];

    for (let i = 0; i <= steps; i++) {
        const factor = i / steps;
        const color = interpolateColor(scheme.low, scheme.high, factor);
        const value = extremes.min + (extremes.max - extremes.min) * factor;
        gradientStops.push({ color, value, factor });
    }

    return (
        <div className="dynamic-legend">
            <h4 className="legend-title">Data Range</h4>
            <div className="legend-gradient">
                <div
                    className="gradient-bar"
                    style={{
                        background: `linear-gradient(to top, ${scheme.low}, ${scheme.high})`
                    }}
                />
                <div className="legend-labels">
                    <span className="legend-max">{extremes.max.toFixed(1)}{unit}</span>
                    <span className="legend-mid">{((extremes.min + extremes.max) / 2).toFixed(1)}{unit}</span>
                    <span className="legend-min">{extremes.min.toFixed(1)}{unit}</span>
                </div>
            </div>
        </div>
    );
};

const EnhancedClimateMap = ({onMount=() => true}) => {
    const [nutsGeoJSON, setNutsGeoJSON] = useState<NutsGeoJSON | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [stats, setStats] = useState<ProcessingStats>({ processed: 0, skipped: 0, errors: 0 });
    const [outbreaks, setOutbreaks] = useState<OutbreakData[]>([]);
    const [temperatureData, setTemperatureData] = useState<any[]>([]);
    const [viewport, setViewport] = useState<ViewportBounds | null>(null);
    const [resolutionLevel, setResolutionLevel] = useState<number>(1);
    const [selectedModel, setSelectedModel] = useState<string>('temperature');
    const [selectedOptimism, setSelectedOptimism] = useState<string>('optimistic');
    const [currentYear, setCurrentYear] = useState<number>(2025);
    const [currentMonth, setCurrentMonth] = useState<number>(1);
    const [map, setMap] = useState<L.Map | null>(null);
    const [dataExtremes, setDataExtremes] = useState<DataExtremes | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        onMount();
    })

    const getOptimismLevels = () => ['optimistic', 'realistic', 'pessimistic']

    const calculateExtremes = (data: any[], calculatePercentiles: boolean = true): DataExtremes => {
        if (!data || data.length === 0) return { min: 0, max: 0 };

        const temperatures = data.map(point => point.temperature).filter(temp => !isNaN(temp));

        if (temperatures.length === 0) return { min: 0, max: 0 };

        if (calculatePercentiles) {
            const sortedTemps = [...temperatures].sort((a, b) => a - b);

            const p5Index = Math.floor((25 / 100) * (sortedTemps.length - 1));
            const p95Index = Math.floor((75 / 100) * (sortedTemps.length - 1));

            return {
                min: sortedTemps[p5Index],
                max: sortedTemps[p95Index]
            };
        } else {
            return {
                min: Math.min(...temperatures),
                max: Math.max(...temperatures)
            };
        }
    };

    const loadTemperatureData = async (year: number) => {
        try {
            const dataPath = year.toString() + "_data_january_05res.csv"
            console.log("DataPath:", dataPath)
            const response = await fetch(dataPath);
            const text = await response.text();
            const rows = text.split('\n').slice(1).filter(row => row.trim() !== '');

            const sampleRate = 1;
            const dataPoints = [];

            for (let i = 0; i < rows.length; i++) {
                if (i % Math.floor(1/sampleRate) === 0) {
                    const row = rows[i];
                    const values = row.split(',');
                    if (values.length >= 4) {
                        const temperature = parseFloat(values[3]) || 0;
                        const lat = parseFloat(values[1]) || 0;
                        const lng = parseFloat(values[2]) || 0;
                        if (i%100000 === 0) {
                            console.log("Lat:", lat, "Long: ", lng, "Temp:", temperature);
                        }

                        if (!isNaN(lat) && !isNaN(lng) && !isNaN(temperature)) {
                            dataPoints.push({
                                point: turf.point([lng, lat]),
                                temperature: temperature,
                                lat: lat,
                                lng: lng
                            });
                        }
                    }
                }
            }

            setTemperatureData([...dataPoints]);
            const extremes = calculateExtremes(dataPoints);
            setDataExtremes(extremes);
        } catch (err: any) {
            setError('Failed to load temperature data: ' + err.message);
        }
    }

    useEffect(() => {
        loadTemperatureData(currentYear);
    }, [currentYear]);

    useEffect(() => {
        fetch('/data/outbreaks.csv')
            .then(response => response.text())
            .then(csvData => {
                const parsedOutbreaks = parseCSVToOutbreaks(csvData);
                setOutbreaks(parsedOutbreaks);
            })
            .catch((err: Error) => {
                console.error('Error loading outbreaks data:', err);
                setError(err.message);
            });
    }, []);

    const parseCSVToOutbreaks = (csvData: string): OutbreakData[] => {
        const lines = csvData.trim().split('\n');
        const headers = lines[0].split(',');

        return lines.slice(1).map((line, index) => {
            const values = line.split(',');
            const outbreak: any = {};

            headers.forEach((header, i) => {
                let value = values[i];
                if (header === 'latitude' || header === 'longitude' || header === 'cases') {
                    outbreak[header] = parseFloat(value);
                } else {
                    outbreak[header] = value;
                }
            });

            if (!outbreak.id) {
                outbreak.id = `outbreak-${index}`;
            }

            return outbreak as OutbreakData;
        });
    };

    const loadNutsData = () => {
        setLoading(true);
        setError(null);

        fetch('/data/nutsRegions.csv')
            .then(response => response.text())
            .then(csvData => {
                processCSVData(csvData);
                setLoading(false);
            })
            .catch((err: Error) => {
                console.error('Error loading NUTS data:', err);
                setError(err.message);
                setLoading(false);
            });
    };

    const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setLoading(true);
        setError(null);

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const csvData = e.target?.result as string;
                processCSVData(csvData);
            } catch (err: any) {
                console.error('Error processing uploaded file:', err);
                setError(err.message);
                setLoading(false);
            }
        };
        reader.onerror = (err) => {
            console.error('File reading error:', err);
            setError('Error reading file');
            setLoading(false);
        };
        reader.readAsText(file);
    };

    const processCSVData = (csvData: string) => {
        try {
            const nutsMapper = new NutsMapperV5();
            const geoJSON = nutsMapper.parseNutsCSV(csvData);
            setNutsGeoJSON(geoJSON as NutsGeoJSON);
            setStats(nutsMapper.getStats());

            if (geoJSON && geoJSON.features) {
                const intensities = geoJSON.features
                    .map(feature => feature.properties.intensity)
                    .filter((intensity): intensity is number => intensity !== null && !isNaN(intensity));

                if (intensities.length > 0) {
                    const extremes = {
                        min: Math.min(...intensities),
                        max: Math.max(...intensities)
                    };
                    setDataExtremes(extremes);
                }
            }
        } catch (err: any) {
            console.error('Error processing CSV data:', err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleViewportChange = useCallback((newViewport: any) => {
        if (newViewport) {
            const bounds = newViewport.bounds;
            const zoom = newViewport.zoom;

            setViewport(prevViewport => {
                if (!prevViewport ||
                    Math.abs(bounds.getNorth() - prevViewport.north) > 0.1 ||
                    Math.abs(bounds.getSouth() - prevViewport.south) > 0.1 ||
                    Math.abs(bounds.getEast() - prevViewport.east) > 0.1 ||
                    Math.abs(bounds.getWest() - prevViewport.west) > 0.1 ||
                    Math.abs(zoom - prevViewport.zoom) > 0.1) {

                    return {
                        north: bounds.getNorth(),
                        south: bounds.getSouth(),
                        east: bounds.getEast(),
                        west: bounds.getWest(),
                        zoom: zoom
                    };
                }
                return prevViewport;
            });

            let newResolution = 1;
            if (zoom < 2.5) newResolution = 4.5;
            else if (zoom < 4.5) newResolution = 3.5;
            else if (zoom < 6) newResolution = 2.5;
            else if (zoom < 8) newResolution = 1.5;
            else newResolution = 1;

            setResolutionLevel(prevResolution => {
                if (prevResolution !== newResolution) {
                    return newResolution;
                }
                return prevResolution;
            });
        }
    }, []);

    const handleModelSelect = (modelId: string) => {
        setSelectedModel(modelId);
    };

    const style = (feature: GeoJSON.Feature) => {
        if (!feature || !feature.properties) return {};

        return {
            fillColor: dataExtremes ? getColorFromGradient(feature.properties.intensity || 0, dataExtremes, '#8b5cf6', '#cccccc') : "blue",
            weight: 1,
            opacity: 1,
            color: 'white',
            dashArray: '3',
            fillOpacity: 0.7
        };
    };

    const highlightFeature = (e: L.LeafletMouseEvent) => {
        const layer = e.target as L.Path;
        layer.setStyle({
            weight: 3,
            color: '#666',
            dashArray: '',
            fillOpacity: 0.9
        });

        if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
            layer.bringToFront();
        }
    };

    const resetHighlight = (e: L.LeafletMouseEvent) => {
        if (nutsGeoJSON) {
            const geoJSONLayer = e.target as L.Path & { feature: GeoJSON.Feature };
            geoJSONLayer.setStyle(style(geoJSONLayer.feature));
        }
    };

    const onEachFeature = (feature: GeoJSON.Feature, layer: L.Layer) => {
        layer.on({
            mouseover: highlightFeature,
            mouseout: resetHighlight
        });

        if (feature.properties) {
            const { NUTS_ID, intensity } = feature.properties;
            const popupContent = `
        <div class="nuts-popup">
          <h4>NUTS Region: ${NUTS_ID}</h4>
          <p>Value: ${intensity !== null ? `${intensity.toFixed(1)}°C` : 'N/A'}</p>
        </div>
      `;
            (layer as L.Layer & { bindPopup: (content: string) => void }).bindPopup(popupContent);
        }
    };

    return (
        <div className="climate-map-container">
            <div className="header-section center">
                <GeneralCard style={{ width: 'fit-content' }}>
                    <div className="logo-section">
                        <h1 className="map-title">
                            <span className="title-one">One</span>
                            <span className="title-health">Health</span>
                            <span className="title-platform">Platform</span>
                            <small className="tertiary"><i>&nbsp;{viewingMode.isExpert && "Expert Mode"}</i></small>
                        </h1>
                    </div>

                    <ModelSelector
                        selectedModel={selectedModel}
                        onModelSelect={handleModelSelect}
                    />
                    &nbsp;
                    with&nbsp;
                    <OptimismLevelSelector
                        availableOptimismLevels={getOptimismLevels()}
                        selectedOptimism={selectedOptimism}
                        setOptimism={setSelectedOptimism}
                    />
                </GeneralCard>

                <AntdTimelineSelector
                    year={currentYear}
                    month={currentMonth}
                    onYearChange={setCurrentYear}
                    onMonthChange={setCurrentMonth}
                />
            </div>

            <div className="map-content-wrapper">
                <div className="map-content">
                    <MapContainer
                        className="full-height-map"
                        center={[10, 12]}
                        zoom={5}
                        minZoom={MIN_ZOOM}
                        maxZoom={MAX_ZOOM}
                        ref={setMap}
                        zoomControl={false}
                    >
                        <TileLayer
                            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                        />

                        <Pane name="gridPane" style={{ zIndex: 1550, opacity: 0.5 }}>
                            {temperatureData.length > 0 && viewport && dataExtremes && (
                                <div>
                                    <AdaptiveGridLayer
                                        dataPoints={[...temperatureData]}
                                        viewport={viewport}
                                        resolutionLevel={resolutionLevel}
                                        extremes={dataExtremes}
                                    />
                                </div>
                            )}
                        </Pane>

                        <Pane name="geoJsonPane" style={{ zIndex: 200 }}>
                            {nutsGeoJSON && nutsGeoJSON.features && nutsGeoJSON.features.length > 0 && (
                                <GeoJSON
                                    data={nutsGeoJSON}
                                    // eslint-disable-next-line @typescript-eslint/no-misused-promises
                                    style={(f) => f ? style(f) : {}}
                                    onEachFeature={onEachFeature}
                                />
                            )}
                        </Pane>

                        <Pane name="markersPane" style={{ zIndex: 500 }}>
                            {outbreaks.map(outbreak => (
                                <CircleMarker
                                    key={outbreak.id}
                                    center={[outbreak.latitude, outbreak.longitude]}
                                    radius={10}
                                    pathOptions={{
                                        fillColor: "#8A2BE2",
                                        color: '#000',
                                        weight: 1,
                                        opacity: 1,
                                        fillOpacity: 0.8
                                    }}
                                >
                                    <Popup className="outbreak-popup">
                                        <div>
                                            <h3>{outbreak.category}</h3>
                                            <p><strong>Location:</strong> {outbreak.location}</p>
                                            <p><strong>Date:</strong> {outbreak.date}</p>
                                            <p><strong>Cases:</strong> {outbreak.cases}</p>
                                            {outbreak.notes && <p><strong>Notes:</strong> {outbreak.notes}</p>}
                                        </div>
                                    </Popup>
                                </CircleMarker>
                            ))}
                        </Pane>

                        <ViewportMonitor onViewportChange={handleViewportChange} />
                    </MapContainer>

                    <ControlBar map={map} />
                </div>

                <div className="legend-sidebar">
                    {dataExtremes && (
                        <DynamicLegend
                            extremes={dataExtremes}
                            unit="°C"
                        />
                    )}
                </div>
            </div>

            <div className="map-bottom-bar">
                <div className="control-section">
                    <button
                        onClick={loadNutsData}
                        disabled={loading}
                        className="primary-button"
                    >
                        <Layers size={18} />
                        {loading ? 'Loading...' : 'Load NUTS Regions'}
                    </button>

                    <button
                        onClick={handleUploadClick}
                        disabled={loading}
                        className="secondary-button"
                    >
                        Upload NUTS CSV
                    </button>

                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileUpload}
                        accept=".csv"
                        style={{ display: 'none' }}
                    />
                </div>

                {error && (
                    <div className="error-message">
                        <p>{error}</p>
                    </div>
                )}

                {viewport && (
                    <DebugStatsPanel
                        stats={stats}
                        temperatureDataCount={temperatureData.length}
                        currentResolution={resolutionLevel}
                        viewport={viewport}
                    />
                )}
            </div>
        </div>
    );
};

export default EnhancedClimateMap;
export type DevelopmentType = 'residential' | 'data-center' | 'park' | 'commercial';
export type Stage = 'discover' | 'design' | 'protect';
export interface Requirements {
  location: string;
  capacity: number;
  budget: number;
  floors: number;
  monthlyRate: number;
  occupancy: number;
  expenseRatio: number;
  parking: number;
  setback: number;
}
export interface Site {
  id: string;
  name: string;
  area: string;
  lat: number;
  lng: number;
  width: number;
  depth: number;
  landCost: number;
  metrics: Record<string, number>;
  risks: string[];
  context: string;
  amenities: {
    schools: number;
    restaurants: number;
    parks: number;
    transit: number;
    population: number;
  };
  provenance: string;
}
export interface Design {
  id: string;
  name: string;
  strategy: string;
  width: number;
  depth: number;
  floors: number;
  green: number;
  parking: number;
  setback: number;
  rotation: number;
}
export interface Sensor {
  id: string;
  projectId: string;
  name: string;
  type: string;
  zone: string;
  x: number;
  z: number;
  floor: number;
  value: number;
  threshold: number;
  unit: string;
  source: string;
  deviceId: string | null;
  lastSeen: string | null;
  updatedAt: string;
}
export interface Incident {
  id: string;
  projectId: string;
  sensorId: string;
  kind: string;
  zone: string;
  severity: string;
  status: string;
  message: string;
  recommendation: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}
export interface Project {
  id: string;
  name: string;
  brief: string;
  type: DevelopmentType;
  stage: Stage;
  requirements: Requirements;
  sites: Site[];
  selectedSiteId: string | null;
  designs: Design[];
  approvedDesignId: string | null;
  weights: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  sensors: Sensor[];
  incidents: Incident[];
  messages: { id: string; role: string; content: string; createdAt: string }[];
  simulations: { id: string; kind: string; summary: string; createdAt: string }[];
}
export interface AmenityResult {
  source: 'OpenStreetMap / Overpass' | 'Illustrative fallback';
  fetchedAt: string;
  message: string;
  points: { id: number; name: string; type: string; lat: number; lng: number }[];
}

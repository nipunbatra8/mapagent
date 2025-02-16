import { ToolConfig } from "@dainprotocol/service-sdk";
import { z } from "zod";
import { DainResponse, MapUIBuilder, AlertUIBuilder, CardUIBuilder } from "@dainprotocol/utils";
import { defineDAINService } from "@dainprotocol/service-sdk";
import * as fs from "fs";
import * as path from "path";
import { parse } from "csv-parse/sync";

interface Coordinate {
  lat: number;
  lon: number;
  soldierId: string;
  squadId: string;
}

// Haversine distance calculation (unchanged)
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaPhi = toRad(lat2 - lat1);
  const deltaLambda = toRad(lon2 - lon1);
  const a = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c * 3.28084;
}

// Calculate squad centroid (unchanged)
function calculateSquadCentroid(coords: Coordinate[]): [number, number] {
  if (!coords.length) return [0, 0];
  const sumLat = coords.reduce((acc, c) => acc + c.lat, 0);
  const sumLon = coords.reduce((acc, c) => acc + c.lon, 0);
  return [sumLat / coords.length, sumLon / coords.length];
}

// Flag squad stragglers (unchanged)
function flagSquadStragglers(coords: Coordinate[], thresholdFeet: number): string[] {
  const squadGroups = coords.reduce((acc, coord) => {
    if (!acc[coord.squadId]) acc[coord.squadId] = [];
    acc[coord.squadId].push(coord);
    return acc;
  }, {} as Record<string, Coordinate[]>);

  const stragglers: string[] = [];
  
  // Debug logging
  console.log(`Checking stragglers with threshold: ${thresholdFeet} feet`);
  
  Object.entries(squadGroups).forEach(([squadId, squadCoords]) => {
    const [centLat, centLon] = calculateSquadCentroid(squadCoords);
    console.log(`Squad ${squadId} centroid: [${centLat}, ${centLon}]`);
    
    squadCoords.forEach((coord) => {
      const distFeet = haversineDistance(coord.lat, coord.lon, centLat, centLon);
      console.log(`Soldier ${coord.soldierId} distance: ${distFeet.toFixed(2)} feet`);
      
      if (distFeet > thresholdFeet) {
        console.log(`Flagging soldier ${coord.soldierId} as straggler`);
        stragglers.push(coord.soldierId);
      }
    });
  });

  console.log(`Found ${stragglers.length} stragglers:`, stragglers);
  return stragglers;
}

// New function to read a specific row from each CSV
async function readRowFromCSVs(rowIndex: number): Promise<Coordinate[]> {
  const dirPath = __dirname;
  const files = fs.readdirSync(dirPath).filter(file => file.match(/soldier_\d+\.csv/));
  const coordinates: Coordinate[] = [];

  for (const file of files) {
    const squadId = file.match(/soldier_(\d+)\.csv/)?.[1] || "unknown";
    const csvPath = path.resolve(dirPath, file);
    
    try {
      const fileContent = fs.readFileSync(csvPath, "utf8");
      const records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
      });

      // Process all rows to get positions for this squad
      records.forEach((row: any, idx: number) => {
        const lat = parseFloat(row["latitude"]);
        const lon = parseFloat(row["longitude"]);
        if (!isNaN(lat) && !isNaN(lon)) {
          coordinates.push({
            lat,
            lon,
            soldierId: `${squadId}-${idx + 1}`,
            squadId
          });
        }
      });
    } catch (error) {
      console.error(`Error reading file ${file}:`, error);
    }
  }

  // Filter coordinates to only include those from the current row index
  const currentCoords = coordinates.filter((_, index) => Math.floor(index / 5) === rowIndex);
  console.log(`Row ${rowIndex} coordinates:`, currentCoords);
  
  return currentCoords;
}

// Function to create map UI
function createMapUI(coords: Coordinate[], stragglers: string[], centroid: [number, number]) {
  // Generate squad colors
  const squadSet = new Set(coords.map(c => c.squadId));
  const squads = Array.from(squadSet);
  const squadColors = squads.reduce((acc, squad, i) => {
    const hue = (360 / squads.length) * i;
    acc[squad] = `hsl(${hue}, 70%, 50%)`;
    return acc;
  }, {} as Record<string, string>);

  // Create markers
  const markers = coords.map((c) => {
    const isStraggler = stragglers.includes(c.soldierId);
    console.log(`Creating marker for soldier ${c.soldierId}, straggler: ${isStraggler}`);
    return {
      latitude: c.lat,
      longitude: c.lon,
      color: squadColors[c.squadId],
      text: isStraggler ? "⚠️" : "🪖",
      title: `Soldier ${c.soldierId}`,
      description: `Squad ${c.squadId}${isStraggler ? ' (STRAGGLER - ${distanceToCenter.toFixed(2)} ft from center)' : ''}`,
    };
  });

  return new MapUIBuilder()
    .setRenderMode("page")
    .setInitialView(centroid[0], centroid[1], 18)
    .setMapStyle("mapbox://styles/mapbox/streets-v12")
    .addMarkers(markers)
    .build();
}

export const liveMapTool: ToolConfig = {
  id: "live-map",
  name: "Live Squad Map",
  description: "Shows live updates of squad positions from CSV files",
  input: z.object({
    thresholdFeet: z.number().default(45).describe("Distance threshold in feet for stragglers"),
  }),
  output: z.object({
    processId: z.string(),
    stragglers: z.array(z.string()),
  }),
  handler: async ({ thresholdFeet }, agentInfo, { app }) => {
    try {
      // Create a continuous process
      const processId = await app.processes!.createProcess(
        agentInfo,
        "recurring",
        "Live Squad Tracker",
        "Updating squad positions every 3 seconds"
      );

      let currentRow = 0;

      // Start background process
      (async () => {
        while (true) {
          try {
            // Read current row from all CSVs
            const coordinates = await readRowFromCSVs(currentRow);
            
            if (coordinates.length === 0) {
              await app.processes!.failProcess(processId, "No more data available");
              break;
            }

            // Process the data
            const stragglers = flagSquadStragglers(coordinates, thresholdFeet);
            const centroid = calculateSquadCentroid(coordinates);
            
            // Create map UI
            const mapUI = createMapUI(coordinates, stragglers, centroid);
            
            // Create a card to hold the map
            const cardUI = new CardUIBuilder()
              .title(`Squad Positions - Update ${currentRow + 1}`)
              .addChild(mapUI)
              .build();

            // Add the process update (status only)
            await app.processes!.addUpdate(processId, {
              percentage: 100,
              text: `Updated positions for ${coordinates.length} soldiers (Row ${currentRow + 1})`
            });

            // Add the UI separately as a result
            await app.processes!.addResult(processId, {
              text: "Latest map update",
              data: {
                stragglers,
                coordinates: coordinates.length,
                currentRow: currentRow + 1
              },
              ui: cardUI
            });

            // Increment row counter
            currentRow++;
            
            // Wait for 3 seconds
            await new Promise(resolve => setTimeout(resolve, 3000));
          } catch (error) {
            console.error("Error updating map:", error);
            await app.processes!.failProcess(processId, `Failed to update map: ${error.message}`);
            break;
          }
        }
      })();

      return new DainResponse({
        text: "Started live squad tracking",
        data: { 
          processId,
          stragglers: [] // Initial empty array of stragglers
        },
        ui: new AlertUIBuilder()
          .setRenderMode("inline")
          .variant("success")
          .title("Live Tracking Started")
          .message(`Started tracking process with ID: ${processId}`)
          .build()
      });
    } catch (error) {
      return {
        text: `Error starting live tracking: ${error.message}`,
        data: { error: error.message },
        ui: new AlertUIBuilder()
          .setRenderMode("inline")
          .variant("error")
          .title("Startup Error")
          .message(error.message)
          .build()
      };
    }
  },
};

export const dainService = defineDAINService({
  metadata: {
    title: "Live Squad Position Tracker",
    description: "Real-time tracking of multiple squad positions with straggler detection",
    version: "1.0.0",
    author: "Military Mapping Team",
    tags: ["mapping", "csv", "military", "position-tracking", "real-time"]
  },
  identity: {
    apiKey: process.env.DAIN_API_KEY
  },
  tools: [liveMapTool],
});

dainService.startNode({ port: 2022 }).then(() => {
  console.log("Live Squad Tracking Service is running on port 2022");
});
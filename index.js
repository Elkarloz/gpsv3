// index.js
import net from "net";
import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const TCP_PORT = parseInt(process.env.TCP_PORT || "6808", 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

// --- Mongoose models ---
const deviceSchema = new mongoose.Schema({
  imei: { type: String, required: true, unique: true },
  lastSeenAt: Date,
  lastIp: String,
  lastPort: Number,
  connected: { type: Boolean, default: false }
});
const Device = mongoose.model("Device", deviceSchema);

// --- In-memory map of connected sockets by IMEI ---
const socketsByImei = new Map(); // imei -> socket

// --- Helper to build LEN field as 4-digit string ---
function buildLenField(payload) {
  const l = String(payload.length).padStart(4, "0");
  return l;
}

// --- Helper to send raw payload to socket safely ---
function safeWrite(socket, data) {
  try {
    socket.write(data);
    console.log("Sent to socket:", data);
  } catch (err) {
    console.error("Error writing to socket:", err);
  }
}

// --- TCP server ---
const tcpServer = net.createServer((socket) => {
  const remoteAddress = socket.remoteAddress + ":" + socket.remotePort;
  console.log(`\n🔌 New TCP connection from ${remoteAddress}`);
  console.log(`   Waiting for GPS device data... (connection tests will close immediately)`);

  // IMPORTANT: Keep connection alive - don't close after LK response
  // Set TCP keepalive to maintain persistent connection
  socket.setKeepAlive(true, 60000); // Keep alive every 60 seconds
  socket.setNoDelay(true); // Disable Nagle algorithm for faster response
  socket.setTimeout(0); // Disable timeout - keep connection open indefinitely

  let buffer = "";
  let deviceImei = null;
  let connectionStartTime = Date.now();

  socket.on("data", async (chunk) => {
    // Log raw data received (both hex and ascii for debugging)
    const hexData = chunk.toString('hex').toUpperCase();
    const asciiData = chunk.toString('utf8');
    console.log(`📥 Raw data received from ${remoteAddress} (${chunk.length} bytes):`);
    console.log(`   HEX: ${hexData.substring(0, 100)}${hexData.length > 100 ? '...' : ''}`);
    console.log(`   ASCII: ${asciiData.substring(0, 100)}${asciiData.length > 100 ? '...' : ''}`);
    
    // Check if data is in HEX format (common with GPS devices)
    // If it starts with hex characters and doesn't contain '[' in ASCII, it might be HEX
    let dataToProcess = asciiData;
    
    // Try to detect if it's HEX: if it's all hex chars and even length, try converting
    const hexPattern = /^[0-9A-Fa-f\s]+$/;
    if (hexPattern.test(asciiData.replace(/[\s\n\r]/g, '')) && asciiData.replace(/[\s\n\r]/g, '').length % 2 === 0) {
      // Might be HEX, try converting
      try {
        const hexString = asciiData.replace(/[\s\n\r]/g, '');
        const converted = Buffer.from(hexString, 'hex').toString('utf8');
        if (converted.includes('[') && converted.includes(']')) {
          console.log(`   🔄 Detected HEX format, converted to: ${converted.substring(0, 100)}`);
          dataToProcess = converted;
        }
      } catch (e) {
        // Not valid HEX, use original
      }
    }
    
    buffer += dataToProcess;
    
    // Protocol messages look like: [3G*IMEI*LEN*...]
    // We'll parse full bracketed messages if they come
    // Some devices send full message per packet; others may stream.
    let startIdx = buffer.indexOf("[");
    let endIdx = buffer.indexOf("]");
    
    // If no brackets found, log what we have
    if (startIdx === -1 || endIdx === -1) {
      console.log(`⚠️ No complete message found yet. Buffer length: ${buffer.length}`);
      console.log(`   Buffer content: ${buffer.substring(0, 200)}`);
    }
    
    while (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const message = buffer.slice(startIdx + 1, endIdx); // without brackets
      buffer = buffer.slice(endIdx + 1);
      console.log(`📨 Parsed message from ${remoteAddress}:`, message);

      // Basic parse
      const parts = message.split("*"); // e.g. ["3G","351258...","0009","LK,0,0,21"]
      if (parts.length >= 4) {
        const proto = parts[0]; // likely "3G" or "CS"
        const imei = parts[1];
        const lenField = parts[2];
        const body = parts.slice(3).join("*"); // rest

        deviceImei = imei; // Track IMEI for this socket

        console.log(`📱 Device IMEI: ${imei}, Command: ${body.split(",")[0]}`);

        // Update DB + socket map
        try {
          await Device.findOneAndUpdate(
            { imei },
            {
              imei,
              lastSeenAt: new Date(),
              lastIp: socket.remoteAddress,
              lastPort: socket.remotePort,
              connected: true
            },
            { upsert: true, new: true }
          );
        } catch (err) {
          console.error("DB update error:", err);
        }

        // store socket by imei
        socketsByImei.set(imei, socket);

        // If Linkkeep (LK) -> reply with short LK ack
        // CRITICAL: Must reply to ALL LK commands to maintain connection
        if (body.startsWith("LK")) {
          const resp = `[3G*${imei}*0002*LK]`;
          safeWrite(socket, resp);
          console.log(`✅ Replied LK ack for IMEI ${imei}`);
        }

        // Handle UD (position data) - no reply needed
        if (body.startsWith("UD") || body.startsWith("UD_LTE") || body.startsWith("UD_WCDMA")) {
          console.log(`📍 Position data received from ${imei}`);
          // Parse position data here if needed
        }

        // Handle UD2 (blind spot data) - no reply needed
        if (body.startsWith("UD2")) {
          console.log(`📍 Blind spot data received from ${imei}`);
        }

        // Handle AL (alarm) - must reply
        if (body.startsWith("AL") || body.startsWith("AL_LTE")) {
          const resp = `[3G*${imei}*0002*AL]`;
          safeWrite(socket, resp);
          console.log(`🚨 Alarm received from ${imei}, replied confirmation`);
        }

        // Handle CONFIG - reply to stop constant sending
        if (body.startsWith("CONFIG")) {
          const resp = `[3G*${imei}*0008*CONFIG,1]`;
          safeWrite(socket, resp);
          console.log(`⚙️ CONFIG received from ${imei}, replied OK`);
        }

        // Handle TS (device status request)
        if (body.startsWith("TS")) {
          console.log(`📊 TS status request from ${imei}`);
          // Device will reply with status info
        }

        // Handle other commands
        if (body.startsWith("VERNO")) {
          console.log(`📋 Version request from ${imei}`);
        }

        // Log unknown commands for debugging
        const commandType = body.split(",")[0];
        if (!["LK", "UD", "UD2", "UD_LTE", "UD_WCDMA", "AL", "AL_LTE", "CONFIG", "TS", "VERNO"].some(c => body.startsWith(c))) {
          console.log(`⚠️ Unknown command from ${imei}: ${commandType}`);
        }
      } else {
        console.warn(`⚠️ Unexpected message format from ${remoteAddress}:`, message);
      }

      startIdx = buffer.indexOf("[");
      endIdx = buffer.indexOf("]");
    }
  });

  socket.on("close", () => {
    const connectionDuration = ((Date.now() - connectionStartTime) / 1000).toFixed(2);
    const hadData = buffer.length > 0;
    
    console.log(`\n🔌 Connection closed: ${remoteAddress}${deviceImei ? ` (IMEI: ${deviceImei})` : ""} - Duration: ${connectionDuration}s`);
    
    if (deviceImei) {
      // Real GPS device
      socketsByImei.delete(deviceImei);
      Device.findOneAndUpdate({ imei: deviceImei }, { connected: false }).catch(() => {});
      console.log(`🗑️ Removed socket mapping for IMEI ${deviceImei}`);
    } else if (!hadData && connectionDuration < 1) {
      // Likely a connection test (like Test-NetConnection, telnet, nc, etc.)
      console.log(`🧪 This appears to be a connection test (no data sent, closed quickly)`);
      console.log(`   ✅ Port is accessible - GPS devices will send data when they connect`);
    } else {
      console.log(`⚠️ Connection closed without identifying IMEI`);
      if (hadData) {
        console.log(`   Buffer at close: ${buffer.substring(0, 100)}${buffer.length > 100 ? '...' : ''}`);
      } else {
        console.log(`   No data received - GPS may not be configured correctly`);
      }
    }
  });

  socket.on("error", (err) => {
    console.error(`❌ Socket error from ${remoteAddress}:`, err.message);
  });

  socket.on("timeout", () => {
    console.warn(`⏱️ Socket timeout from ${remoteAddress} - but keeping connection open`);
    // Don't destroy the socket, just log the timeout
  });

  // Log when connection is established but no data received yet
  setTimeout(() => {
    if (!deviceImei && socket.readyState === 'open') {
      console.log(`⏳ Still waiting for data from ${remoteAddress} (5 seconds elapsed)`);
    }
  }, 5000);
});

tcpServer.on("error", (err) => {
  console.error("TCP Server error:", err);
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${TCP_PORT} is already in use!`);
  }
});

tcpServer.listen(TCP_PORT, HOST, () => {
  console.log(`✅ TCP server listening on ${HOST}:${TCP_PORT}`);
  console.log(`📡 Ready to accept GPS connections on port ${TCP_PORT}`);
});

// --- Express app for admin endpoints ---
const app = express();
app.use(express.json());

// simple health
app.get("/health", (req, res) => res.send({ ok: true }));

// Endpoint to check server status and connected devices
app.get("/status", async (req, res) => {
  const connectedDevices = Array.from(socketsByImei.keys());
  const deviceStatus = {};
  for (const [imei, socket] of socketsByImei.entries()) {
    deviceStatus[imei] = {
      connected: socket.readyState === "open",
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort
    };
  }
  
  // Get all devices from DB with last seen info
  let allDevices = [];
  try {
    allDevices = await Device.find({}).sort({ lastSeenAt: -1 }).limit(50);
  } catch (err) {
    console.error("Error fetching devices:", err);
  }
  
  res.send({
    tcpPort: TCP_PORT,
    httpPort: HTTP_PORT,
    host: HOST,
    connectedDevices: connectedDevices.length,
    currentlyConnected: connectedDevices,
    deviceStatus: deviceStatus,
    allDevices: allDevices.map(d => ({
      imei: d.imei,
      lastSeenAt: d.lastSeenAt,
      lastIp: d.lastIp,
      connected: d.connected
    })),
    serverTime: new Date().toISOString()
  });
});

// Endpoint to list all devices from database
app.get("/devices", async (req, res) => {
  try {
    const devices = await Device.find({}).sort({ lastSeenAt: -1 });
    res.send({ devices });
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

// Endpoint to send "change server" command to a device (if connected)
app.post("/change-server", async (req, res) => {
  const { imei, newIp, newPort } = req.body;
  if (!imei || !newIp || !newPort) {
    return res.status(400).send({ error: "imei, newIp and newPort required" });
  }

  const socket = socketsByImei.get(imei);
  if (!socket) {
    return res.status(404).send({ error: "device not connected to this server" });
  }

  // Build payload and LEN
  const payload = `IP,${newIp},${newPort}`;
  const len = buildLenField(payload);
  const cmd = `[3G*${imei}*${len}*${payload}]`;

  safeWrite(socket, cmd);

  // optional: after sending, instruct user to restart device
  return res.send({
    sent: true,
    cmd,
    note: "Device should reboot and reconnect to the new server. Wait 6-8 minutes and verify with /send-ts."
  });
});

// Endpoint to send TS (verify) command
// Ejemplo para enviar el comando TS:
// const tsCommand = `[3G*8800000015*0002*TS]`;
// socket.write(tsCommand);
// console.log("📤 Sent TS command to device");
app.post("/send-ts", async (req, res) => {
  const { imei } = req.body;
  if (!imei) return res.status(400).send({ error: "imei required" });
  const socket = socketsByImei.get(imei);
  if (!socket) return res.status(404).send({ error: "device not connected" });

  const tsCommand = `[3G*${imei}*0002*TS]`;
  safeWrite(socket, tsCommand);
  console.log(`📤 Sent TS command to device ${imei}`);
  return res.send({ sent: true, cmd: tsCommand });
});

// Endpoint to get server IP info (helpful for configuration)
app.get("/server-info", (req, res) => {
  res.send({
    tcpPort: TCP_PORT,
    httpPort: HTTP_PORT,
    host: HOST,
    note: "Make sure this IP and port are accessible from internet and firewall allows TCP connections on port " + TCP_PORT
  });
});

// Endpoint to send CR (real-time position) command
app.post("/send-cr", async (req, res) => {
  const { imei } = req.body;
  if (!imei) return res.status(400).send({ error: "imei required" });
  const socket = socketsByImei.get(imei);
  if (!socket) return res.status(404).send({ error: "device not connected" });

  const cmd = `[3G*${imei}*0002*CR]`;
  safeWrite(socket, cmd);
  return res.send({ 
    sent: true, 
    cmd,
    note: "Device will send position data every 20 seconds for 3 minutes"
  });
});

// connect to mongo and start express
async function start() {
  await mongoose.connect(process.env.MONGO_URI, { });
  console.log("Connected to MongoDB");
  app.listen(HTTP_PORT, () => {
    console.log(`HTTP admin API listening on port ${HTTP_PORT}`);
  });
}

start().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});


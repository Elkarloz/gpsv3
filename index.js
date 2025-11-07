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
  console.log("New TCP connection from", remoteAddress);

  let buffer = "";

  socket.on("data", async (chunk) => {
    buffer += chunk.toString();
    // Protocol messages look like: [3G*IMEI*LEN*...]
    // We'll parse full bracketed messages if they come
    // Some devices send full message per packet; others may stream.
    let startIdx = buffer.indexOf("[");
    let endIdx = buffer.indexOf("]");
    while (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const message = buffer.slice(startIdx + 1, endIdx); // without brackets
      buffer = buffer.slice(endIdx + 1);
      console.log("Raw message:", message);

      // Basic parse
      const parts = message.split("*"); // e.g. ["3G","351258...","0009","LK,0,0,21"]
      if (parts.length >= 4) {
        const proto = parts[0]; // likely "3G" or "CS"
        const imei = parts[1];
        const lenField = parts[2];
        const body = parts.slice(3).join("*"); // rest

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
        if (body.startsWith("LK")) {
          const resp = `[3G*${imei}*0002*LK]`;
          safeWrite(socket, resp);
          console.log("Replied LK ack for", imei);
        }

        // Optionally log other message types (e.g., UD, AL_LTE, etc.)
        if (body.startsWith("TS")) {
          console.log("TS request body:", body);
        }
        // You can add parsing for UD_LTE, AL_LTE, etc. here as needed.
      } else {
        console.warn("Unexpected message format:", message);
      }

      startIdx = buffer.indexOf("[");
      endIdx = buffer.indexOf("]");
    }
  });

  socket.on("close", () => {
    console.log("Connection closed:", remoteAddress);
    // Remove socket from map if present
    for (const [imei, s] of socketsByImei.entries()) {
      if (s === socket) {
        socketsByImei.delete(imei);
        Device.findOneAndUpdate({ imei }, { connected: false }).catch(() => {});
        console.log("Removed socket mapping for IMEI", imei);
        break;
      }
    }
  });

  socket.on("error", (err) => {
    console.error("Socket error", err);
  });
});

tcpServer.listen(TCP_PORT, HOST, () => {
  console.log(`TCP server listening on ${HOST}:${TCP_PORT}`);
});

// --- Express app for admin endpoints ---
const app = express();
app.use(express.json());

// simple health
app.get("/health", (req, res) => res.send({ ok: true }));

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
app.post("/send-ts", async (req, res) => {
  const { imei } = req.body;
  if (!imei) return res.status(400).send({ error: "imei required" });
  const socket = socketsByImei.get(imei);
  if (!socket) return res.status(404).send({ error: "device not connected" });

  const cmd = `[3G*${imei}*0002*TS]`;
  safeWrite(socket, cmd);
  return res.send({ sent: true, cmd });
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

